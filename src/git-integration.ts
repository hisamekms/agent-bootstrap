import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, mkdtemp, open, realpath, rm } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

export type GitIntegrationCode =
  | "invalid-input"
  | "unsafe-repository"
  | "invalid-object"
  | "invalid-candidate"
  | "stale-base"
  | "ambiguous-update"
  | "git-failed"
  | "output-limit"
  | "cleanup-failed";

export class GitIntegrationError extends Error {
  readonly code: GitIntegrationCode;
  readonly cleanupFailed: boolean;

  constructor(code: GitIntegrationCode, cleanupFailed = false) {
    super(
      `Local Git integration: ${code}${cleanupFailed ? "; cleanup failed" : ""}`,
    );
    this.name = "GitIntegrationError";
    this.code = code;
    this.cleanupFailed = cleanupFailed;
  }
}

export interface LocalGitIntegrationConfig {
  readonly binary: string;
  readonly repository: string;
  readonly stagingRoot: string;
  /** One local branch name, not a refspec, remote or nested ref. */
  readonly branch: string;
}

const fileLimit = 256 * 1024;
const outputLimit = 1024 * 1024;
const oidPattern = /^[a-f0-9]{40}$/;

function oid(value: unknown): string {
  if (typeof value !== "string" || !oidPattern.test(value))
    throw new GitIntegrationError("invalid-object");
  return value;
}

function filePath(value: unknown): string {
  // No directory traversal, dotfiles, pathspec syntax, platform aliases or Git
  // control paths. This initial integration supports one existing top-level file.
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value) ||
    value.endsWith(".") ||
    /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(value)
  )
    throw new GitIntegrationError("invalid-input");
  return value;
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw new GitIntegrationError("unsafe-repository");
  }
}

/** Trusted-host local boundary; it does not authorize a candidate. Callers must
 * durably record an independently authenticated human approval before advance.
 * No remotes, merges, branch checkouts, hooks, filters or user settings are used.
 * The repository and staging ancestors must remain under trusted host control.
 */
export class LocalGitIntegration {
  readonly #config: LocalGitIntegrationConfig;
  readonly #ref: string;

  constructor(config: LocalGitIntegrationConfig) {
    for (const path of [config.binary, config.repository, config.stagingRoot]) {
      if (
        typeof path !== "string" ||
        !isAbsolute(path) ||
        /[\0\r\n]/.test(path)
      )
        throw new GitIntegrationError("invalid-input");
    }
    if (
      typeof config.branch !== "string" ||
      !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(config.branch)
    )
      throw new GitIntegrationError("invalid-input");
    this.#config = { ...config };
    this.#ref = `refs/heads/${config.branch}`;
  }

  #git(
    args: readonly string[],
    worktree?: string,
    allowExitOne = false,
    transaction?: { input: string; validate: () => Promise<void> },
  ): Promise<Buffer> {
    const context = worktree
      ? ["-C", worktree]
      : [`--git-dir=${this.#config.repository}`];
    return new Promise((resolve, reject) => {
      let abortError: GitIntegrationError | undefined;
      let preparing = false;
      let commitSent = false;
      let transactionOutput = "";
      const child = execFile(
        this.#config.binary,
        [
          ...context,
          "--no-pager",
          "-c",
          "core.hooksPath=/dev/null",
          "-c",
          "core.attributesFile=/dev/null",
          "-c",
          "core.excludesFile=/dev/null",
          "-c",
          "core.fsmonitor=false",
          "-c",
          "core.untrackedCache=false",
          "-c",
          "core.protectHFS=true",
          "-c",
          "core.protectNTFS=true",
          "-c",
          "commit.gpgsign=false",
          "-c",
          "tag.gpgsign=false",
          ...args,
        ],
        {
          cwd: this.#config.repository,
          env: {
            PATH: "/usr/bin:/bin",
            GIT_CONFIG_NOSYSTEM: "1",
            GIT_CONFIG_SYSTEM: "/dev/null",
            GIT_CONFIG_GLOBAL: "/dev/null",
            GIT_ATTR_NOSYSTEM: "1",
            GIT_TERMINAL_PROMPT: "0",
            GIT_NO_REPLACE_OBJECTS: "1",
            GIT_NO_LAZY_FETCH: "1",
            GIT_ALLOW_PROTOCOL: "",
            GIT_OPTIONAL_LOCKS: "0",
            GIT_AUTHOR_NAME: "Agent Bootstrap",
            GIT_AUTHOR_EMAIL: "agent-bootstrap@localhost",
            GIT_COMMITTER_NAME: "Agent Bootstrap",
            GIT_COMMITTER_EMAIL: "agent-bootstrap@localhost",
            GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z",
            GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z",
          },
          timeout: 10_000,
          killSignal: "SIGKILL",
          maxBuffer: outputLimit,
          encoding: "buffer",
        },
        (error, stdout) => {
          if (
            transaction &&
            commitSent &&
            (error || !stdout.toString("utf8").includes("commit: ok\n"))
          )
            reject(new GitIntegrationError("ambiguous-update"));
          else if (abortError) reject(abortError);
          else if (
            error &&
            !(allowExitOne && (error as { code?: unknown }).code === 1)
          )
            reject(
              new GitIntegrationError(
                (error as NodeJS.ErrnoException).code ===
                  "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"
                  ? "output-limit"
                  : "git-failed",
              ),
            );
          else if (
            transaction &&
            (!preparing || !stdout.toString("utf8").includes("commit: ok\n"))
          )
            reject(new GitIntegrationError("git-failed"));
          else resolve(stdout);
        },
      );
      if (transaction) {
        child.stdin?.on("error", () => {
          /* Process completion reports a fixed diagnostic. */
        });
        child.stdout?.on("data", (chunk: Buffer) => {
          transactionOutput += chunk.toString("utf8");
          if (!preparing && transactionOutput.includes("prepare: ok\n")) {
            preparing = true;
            void transaction.validate().then(
              () => {
                // Once submitted, a missing acknowledgement cannot establish
                // whether this commit happened, even if a later writer moves
                // the ref again before it can be inspected.
                commitSent = true;
                child.stdin?.end("commit\n");
              },
              (error: unknown) => {
                abortError =
                  error instanceof GitIntegrationError
                    ? error
                    : new GitIntegrationError("git-failed");
                child.stdin?.end("abort\n");
              },
            );
          }
        });
        child.stdin?.write(transaction.input);
      }
    });
  }

  async #reference(ref: string): Promise<string | null> {
    const symbolic = (
      await this.#git(["symbolic-ref", "--quiet", ref], undefined, true)
    )
      .toString("utf8")
      .trim();
    if (symbolic) throw new GitIntegrationError("unsafe-repository");
    const entry = (
      await this.#git([
        "for-each-ref",
        "--format=%(refname)%00%(symref)%00%(objectname)%00",
        "--",
        ref,
      ])
    ).toString("utf8");
    if (entry === "") return null;
    const fields = entry.split("\0");
    if (
      fields.length !== 4 ||
      fields[0] !== ref ||
      fields[1] !== "" ||
      fields[3]?.trim() !== ""
    )
      throw new GitIntegrationError("unsafe-repository");
    return oid(fields[2]);
  }

  async #compareAndSwap(
    ref: string,
    next: string,
    previous: string | null,
  ): Promise<void> {
    // --no-deref alone can replace a symbolic ref whose referent matches the
    // old OID. Prepare locks this exact ref; inspect it while that lock is held
    // and commit only for a direct ref (or absence for candidate-pin creation).
    await this.#git(["update-ref", "--stdin"], undefined, false, {
      input: `start\noption no-deref\nupdate ${ref} ${next} ${previous ?? "0".repeat(40)}\nprepare\n`,
      validate: async () => {
        if ((await this.#reference(ref)) !== previous)
          throw new GitIntegrationError("stale-base");
      },
    });
  }

  async #pin(candidate: string): Promise<void> {
    const ref = `refs/agent-bootstrap/candidates/${candidate}`;
    const existing = await this.#reference(ref);
    if (existing === candidate) return;
    if (existing !== null) throw new GitIntegrationError("invalid-candidate");
    try {
      await this.#compareAndSwap(ref, candidate, null);
    } catch (error) {
      if (
        error instanceof GitIntegrationError &&
        error.code === "ambiguous-update"
      )
        throw error;
      // Another identical candidate preparation may have pinned it first.
      if ((await this.#reference(ref)) !== candidate) throw error;
    }
  }

  async #repository(): Promise<void> {
    try {
      const directory = await lstat(this.#config.repository);
      const config = await lstat(join(this.#config.repository, "config"));
      if (
        !directory.isDirectory() ||
        directory.isSymbolicLink() ||
        !config.isFile() ||
        config.isSymbolicLink() ||
        config.size > 4096
      )
        throw new GitIntegrationError("unsafe-repository");
      for (const path of [
        "objects/info/alternates",
        "objects/info/http-alternates",
        "info/grafts",
        "shallow",
        "config.worktree",
      ]) {
        if (await exists(join(this.#config.repository, path)))
          throw new GitIntegrationError("unsafe-repository");
      }
      // --no-includes prevents this initial inspection from loading arbitrary
      // include files. Reject all nonessential local configuration before other
      // Git operations; filters, credentials, remotes and extensions stay absent.
      const configuration = (
        await this.#git([
          "config",
          "--local",
          "--no-includes",
          "--null",
          "--list",
        ])
      ).toString("utf8");
      const allowed: Record<string, readonly string[]> = {
        "core.repositoryformatversion": ["0"],
        "core.filemode": ["true", "false"],
        "core.ignorecase": ["true", "false"],
        "core.precomposeunicode": ["true", "false"],
        "core.bare": ["true"],
        "core.logallrefupdates": ["true", "false"],
        "extensions.objectformat": ["sha1"],
      };
      const seen = new Set<string>();
      for (const entry of configuration.split("\0").filter(Boolean)) {
        const separator = entry.indexOf("\n");
        const key = entry.slice(0, separator);
        const value = entry.slice(separator + 1);
        if (
          separator < 1 ||
          !Object.hasOwn(allowed, key) ||
          !allowed[key]?.includes(value) ||
          seen.has(key)
        )
          throw new GitIntegrationError("unsafe-repository");
        seen.add(key);
      }
      if (
        !seen.has("core.bare") ||
        (await this.#git(["rev-parse", "--is-bare-repository"]))
          .toString("utf8")
          .trim() !== "true" ||
        (await this.#git(["rev-parse", "--show-object-format"]))
          .toString("utf8")
          .trim() !== "sha1"
      )
        throw new GitIntegrationError("unsafe-repository");
    } catch {
      throw new GitIntegrationError("unsafe-repository");
    }
  }

  async #commit(commit: string): Promise<void> {
    oid(commit);
    if (
      (await this.#git(["cat-file", "-t", commit])).toString("utf8").trim() !==
      "commit"
    )
      throw new GitIntegrationError("invalid-object");
  }

  async #file(
    commit: string,
    path: string,
  ): Promise<{ blob: string; mode: string }> {
    const entry = (
      await this.#git(["ls-tree", "-z", "--full-tree", commit, "--", path])
    ).toString("utf8");
    const match = /^(100644|100755) blob ([a-f0-9]{40})\t([^\0]+)\0$/.exec(
      entry,
    );
    if (!match || match[3] !== path)
      throw new GitIntegrationError("invalid-candidate");
    const blob = oid(match[2]);
    const sizeText = (await this.#git(["cat-file", "-s", blob]))
      .toString("utf8")
      .trim();
    if (!/^\d+$/.test(sizeText) || Number(sizeText) > fileLimit)
      throw new GitIntegrationError("invalid-candidate");
    return { blob, mode: match[1]! };
  }

  async head(): Promise<string> {
    await this.#repository();
    const commit = await this.#reference(this.#ref);
    if (commit === null) throw new GitIntegrationError("invalid-object");
    await this.#commit(commit);
    return commit;
  }

  /** Stable opaque target identity, including canonical repository and exact
   * direct ref. Approval owners must bind this alongside candidate and base. */
  async targetId(): Promise<string> {
    await this.#repository();
    await this.#reference(this.#ref);
    try {
      return createHash("sha256")
        .update(
          JSON.stringify([await realpath(this.#config.repository), this.#ref]),
        )
        .digest("hex");
    } catch {
      throw new GitIntegrationError("unsafe-repository");
    }
  }

  async snapshot(commit: string, path: string): Promise<Uint8Array> {
    oid(commit);
    filePath(path);
    await this.#repository();
    await this.#commit(commit);
    const file = await this.#file(commit, path);
    return this.#git(["cat-file", "blob", file.blob]);
  }

  async createCandidate(
    base: string,
    path: string,
    bytes: Uint8Array,
  ): Promise<string> {
    oid(base);
    filePath(path);
    if (!(bytes instanceof Uint8Array) || bytes.byteLength > fileLimit)
      throw new GitIntegrationError("invalid-input");
    const content = new Uint8Array(bytes);
    await this.#repository();
    await this.#commit(base);
    const file = await this.#file(base, path);
    let directory: string | undefined;
    let attempted = false;
    let candidate: string | undefined;
    let failure: GitIntegrationError | undefined;
    let cleanupFailed = false;
    try {
      await mkdir(this.#config.stagingRoot, { recursive: true, mode: 0o700 });
      const staging = await lstat(this.#config.stagingRoot);
      if (
        !staging.isDirectory() ||
        staging.isSymbolicLink() ||
        (staging.mode & 0o077) !== 0
      )
        throw new GitIntegrationError("unsafe-repository");
      directory = await mkdtemp(join(this.#config.stagingRoot, "candidate-"));
      const worktree = join(directory, "worktree");
      attempted = true;
      await this.#git([
        "worktree",
        "add",
        "--detach",
        "--no-checkout",
        "--",
        worktree,
        base,
      ]);
      // Populate the isolated index without checking out untrusted sibling paths
      // or invoking attribute filters. Materialize exactly the allowed file.
      await this.#git(["read-tree", base], worktree);
      const target = await open(
        join(worktree, path),
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_EXCL |
          constants.O_NOFOLLOW,
        file.mode === "100755" ? 0o700 : 0o600,
      );
      try {
        await target.writeFile(content);
      } finally {
        await target.close();
      }
      const blob = oid(
        (
          await this.#git(
            ["hash-object", "-w", "--no-filters", "--", path],
            worktree,
          )
        )
          .toString("utf8")
          .trim(),
      );
      await this.#git(
        ["update-index", "--cacheinfo", file.mode, blob, path],
        worktree,
      );
      const tree = oid(
        (await this.#git(["write-tree"], worktree)).toString("utf8").trim(),
      );
      candidate = oid(
        (
          await this.#git(
            [
              "commit-tree",
              tree,
              "-p",
              base,
              "-m",
              "Prepared single-file candidate",
            ],
            worktree,
          )
        )
          .toString("utf8")
          .trim(),
      );
      await this.#candidate(base, candidate);
      await this.#pin(candidate);
    } catch (error) {
      failure =
        error instanceof GitIntegrationError
          ? error
          : new GitIntegrationError("git-failed");
    } finally {
      if (directory && attempted) {
        try {
          await this.#git([
            "worktree",
            "remove",
            "--force",
            "--",
            join(directory, "worktree"),
          ]);
        } catch {
          cleanupFailed = true;
        }
      }
      if (directory) {
        try {
          await rm(directory, { recursive: true, force: true });
        } catch {
          cleanupFailed = true;
        }
      }
    }
    if (failure || cleanupFailed || !candidate)
      throw new GitIntegrationError(
        failure?.code ?? "cleanup-failed",
        cleanupFailed,
      );
    return candidate;
  }

  async #candidate(base: string, candidate: string): Promise<string> {
    oid(base);
    oid(candidate);
    await this.#commit(base);
    await this.#commit(candidate);
    const parents = (
      await this.#git(["rev-list", "--parents", "--max-count=1", candidate])
    )
      .toString("utf8")
      .trim();
    if (parents !== `${candidate} ${base}`)
      throw new GitIntegrationError("invalid-candidate");
    const changed = (
      await this.#git([
        "diff-tree",
        "--no-commit-id",
        "--name-status",
        "-r",
        "-z",
        "--no-renames",
        base,
        candidate,
      ])
    )
      .toString("utf8")
      .split("\0");
    if (changed.length !== 3 || changed[0] !== "M" || changed[2] !== "")
      throw new GitIntegrationError("invalid-candidate");
    const path = filePath(changed[1]);
    const original = await this.#file(base, path);
    const updated = await this.#file(candidate, path);
    if (original.mode !== updated.mode)
      throw new GitIntegrationError("invalid-candidate");
    return path;
  }

  async diff(base: string, candidate: string): Promise<Uint8Array> {
    oid(base);
    oid(candidate);
    await this.#repository();
    const path = await this.#candidate(base, candidate);
    return this.#git([
      "diff",
      "--no-ext-diff",
      "--no-textconv",
      "--no-renames",
      "--no-color",
      "--binary",
      "--full-index",
      "--src-prefix=a/",
      "--dst-prefix=b/",
      base,
      candidate,
      "--",
      path,
    ]);
  }

  async advance(base: string, candidate: string): Promise<void> {
    oid(base);
    oid(candidate);
    await this.#repository();
    await this.#candidate(base, candidate);
    if ((await this.head()) !== base)
      throw new GitIntegrationError("stale-base");
    try {
      await this.#compareAndSwap(this.#ref, candidate, base);
    } catch (error) {
      // Another host writer may win after head(): update-ref still performs the
      // actual old-OID compare-and-swap, so a stale approval cannot overwrite it.
      if (
        error instanceof GitIntegrationError &&
        error.code === "ambiguous-update"
      )
        throw error;
      const after = await this.head();
      if (after === candidate)
        throw new GitIntegrationError("ambiguous-update");
      if (after !== base) throw new GitIntegrationError("stale-base");
      throw new GitIntegrationError("git-failed");
    }
  }
}
