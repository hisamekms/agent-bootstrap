import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import {
  checkTreeCollisions,
  foldTreePath,
  isSafeSymlinkTarget,
  matchesTreePaths,
} from "./workspace-tree.ts";

export type GitIntegrationCode =
  | "invalid-input"
  | "unsafe-repository"
  | "invalid-object"
  | "invalid-candidate"
  | "stale-base"
  | "ambiguous-update"
  | "git-failed"
  | "output-limit"
  | "unsupported-entry"
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
const emptyTree = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
type FileExpectation = { readonly path: string };

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

const gitConfigArgs = [
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
] as const;

const gitEnv: Record<string, string> = {
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
};

const pathLimit = 4096;
const workspaceFileLimit = 200_000;
const workspaceByteLimit = 512 * 1024 * 1024;
const changeCountLimit = 10_000;
const changeByteLimit = 256 * 1024 * 1024;
const messageLimit = 4096;
const sparseLimit = 256;

/** Relative repository path: no traversal, empty parts, backslashes, NUL, or
 * any component that a case-insensitive, HFS+ or NTFS checkout would treat as
 * the Git control directory. */
function treePath(value: unknown): string {
  if (
    typeof value !== "string" ||
    value === "" ||
    Buffer.byteLength(value) > pathLimit ||
    /[\0\\]/.test(value) ||
    value.startsWith("/") ||
    value.endsWith("/")
  )
    throw new GitIntegrationError("invalid-input");
  for (const part of value.split("/")) {
    const folded = part
      .normalize("NFC")
      .replace(/[‌-‏‪-‮⁪-⁯﻿]/g, "")
      .replace(/[. ]+$/, "")
      .toLowerCase();
    if (
      part === "" ||
      part === "." ||
      part === ".." ||
      folded === ".git" ||
      folded === "git~1"
    )
      throw new GitIntegrationError("invalid-input");
  }
  return value;
}

function sparsePath(value: unknown): string {
  treePath(value);
  const text = value as string;
  if (/[*?[\]]|^[!#]|^\s|\s$/.test(text))
    throw new GitIntegrationError("invalid-input");
  return text;
}

function commitMessage(value: unknown): Buffer {
  if (typeof value !== "string" || value === "" || value.includes("\0"))
    throw new GitIntegrationError("invalid-input");
  const bytes = Buffer.from(value, "utf8");
  if (bytes.byteLength > messageLimit || bytes.toString("utf8") !== value)
    throw new GitIntegrationError("invalid-input");
  return bytes;
}

export type TreeChange =
  | {
      readonly path: string;
      readonly mode: "100644" | "100755" | "120000";
      readonly bytes: Uint8Array;
    }
  | { readonly path: string; readonly deleted: true };

export interface PreparedWorkspace {
  /** Private directory holding everything below; pass to cleanupWorkspace. */
  readonly directory: string;
  /** Git directory for a normal non-bare repository placed at <worktree>/.git. */
  readonly gitDir: string;
  /** Tar file with the tree of HEAD (restricted to the sparse paths if any). */
  readonly tree: string;
}

interface TreeEntry {
  readonly mode: string;
  readonly oid: string;
  readonly size: number;
  readonly path: string;
}

function octal(value: number, width: number): Buffer {
  const field = Buffer.alloc(width);
  field.write(value.toString(8).padStart(width - 1, "0"), "latin1");
  return field;
}

function tarHeader(
  name: string,
  mode: number,
  size: number,
  type: string,
  link = "",
): Buffer {
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, "utf8");
  octal(mode, 8).copy(header, 100);
  octal(0, 8).copy(header, 108);
  octal(0, 8).copy(header, 116);
  octal(size, 12).copy(header, 124);
  octal(946684800, 12).copy(header, 136);
  header.fill(0x20, 148, 156);
  header.write(type, 156, 1, "latin1");
  header.write(link, 157, 100, "utf8");
  header.write("ustar\0", 257, 6, "latin1");
  header.write("00", 263, 2, "latin1");
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8, "latin1");
  return header;
}

function paxRecord(key: string, value: string): Buffer {
  const body = Buffer.from(` ${key}=${value}\n`, "utf8");
  let length = body.byteLength + String(body.byteLength).length;
  if (String(length).length > String(body.byteLength).length) length += 1;
  return Buffer.concat([Buffer.from(String(length), "latin1"), body]);
}

function padded(bytes: Buffer): Buffer[] {
  const rest = (512 - (bytes.byteLength % 512)) % 512;
  return rest === 0 ? [bytes] : [bytes, Buffer.alloc(rest)];
}

function tarEntry(entry: TreeEntry, content: Buffer): Buffer[] {
  const symlink = entry.mode === "120000";
  const link = symlink ? content.toString("utf8") : "";
  const records: Buffer[] = [];
  const longName = Buffer.byteLength(entry.path) > 100;
  const longLink = Buffer.byteLength(link) > 100;
  if (longName) records.push(paxRecord("path", entry.path));
  if (longLink) records.push(paxRecord("linkpath", link));
  const out: Buffer[] = [];
  if (records.length > 0) {
    const pax = Buffer.concat(records);
    out.push(tarHeader("PaxHeader/entry", 0o644, pax.byteLength, "x"));
    out.push(...padded(pax));
  }
  const mode = symlink ? 0o777 : entry.mode === "100755" ? 0o755 : 0o644;
  out.push(
    tarHeader(
      longName ? entry.path.slice(0, 50) : entry.path,
      mode,
      symlink ? 0 : content.byteLength,
      symlink ? "2" : "0",
      longLink ? "" : link,
    ),
  );
  if (!symlink) out.push(...padded(content));
  return out;
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
  readonly #directories = new Set<string>();

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
        [...context, "--no-pager", ...gitConfigArgs, ...args],
        {
          cwd: this.#config.repository,
          env: gitEnv,
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

  async candidateMessage(commit: string): Promise<Uint8Array> {
    oid(commit);
    await this.#repository();
    const object = await this.#git(["cat-file", "commit", commit]);
    const separator = object.indexOf("\n\n");
    if (separator < 0 || object.length - separator - 2 > messageLimit)
      throw new GitIntegrationError("invalid-candidate");
    return object.subarray(separator + 2);
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
      await this.#candidate(base, candidate, { path });
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

  /** A candidate is one commit whose only parent is `base`. Its changes are
   * additions, modifications, deletions and mode changes of regular files,
   * executables and symlinks. Gitlinks and type changes are refused. */
  async #candidate(
    base: string,
    candidate: string,
    expectation?: FileExpectation,
  ): Promise<{ path: string; newMode: string }[]> {
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
    const raw = await this.#run(
      [
        "diff-tree",
        "--no-commit-id",
        "--raw",
        "-r",
        "-z",
        "--no-renames",
        "--full-index",
        base,
        candidate,
      ],
      {
        gitDir: this.#config.repository,
        cwd: this.#config.repository,
        maxBuffer: 64 * 1024 * 1024,
        timeout: 60_000,
      },
    );
    const decoded = raw.toString("utf8");
    if (!Buffer.from(decoded, "utf8").equals(raw))
      throw new GitIntegrationError("invalid-candidate");
    const fields = decoded.split("\0");
    if (fields.pop() !== "" || fields.length % 2 !== 0)
      throw new GitIntegrationError("invalid-candidate");
    const modes = new Set(["100644", "100755", "120000"]);
    const changes: { path: string; newMode: string }[] = [];
    const symlinks: { path: string; oid: string }[] = [];
    const seen = new Set<string>();
    for (let i = 0; i < fields.length; i += 2) {
      const meta =
        /^:(\d{6}) (\d{6}) ([a-f0-9]{40}) ([a-f0-9]{40}) ([AMD])$/.exec(
          fields[i]!,
        );
      if (!meta) throw new GitIntegrationError("invalid-candidate");
      const oldMode = meta[1]!;
      const newMode = meta[2]!;
      const status = meta[5];
      const added = status === "A";
      const deleted = status === "D";
      if (
        (!added && !modes.has(oldMode!)) ||
        (!deleted && !modes.has(newMode!)) ||
        (added && oldMode !== "000000") ||
        (deleted && newMode !== "000000") ||
        // blob <-> symlink is a type change, not a modification
        (!added &&
          !deleted &&
          (oldMode === "120000") !== (newMode === "120000"))
      )
        throw new GitIntegrationError("invalid-candidate");
      const path = fields[i + 1]!;
      try {
        treePath(path);
      } catch {
        throw new GitIntegrationError("invalid-candidate");
      }
      if (
        expectation &&
        (fields.length !== 2 ||
          status !== "M" ||
          oldMode !== newMode ||
          newMode === "120000" ||
          path !== expectation.path)
      )
        throw new GitIntegrationError("invalid-candidate");
      if (seen.has(path)) throw new GitIntegrationError("invalid-candidate");
      seen.add(path);
      changes.push({ path, newMode });
      if (newMode === "120000") symlinks.push({ path, oid: meta[4]! });
      if (changes.length > changeCountLimit)
        throw new GitIntegrationError("invalid-candidate");
    }
    if (changes.length === 0)
      throw new GitIntegrationError("invalid-candidate");
    if (symlinks.length) await this.#checkCandidateSymlinks(symlinks);
    if (!expectation) {
      const entries = await this.#entries(
        this.#config.repository,
        this.#config.repository,
        candidate,
      );
      try {
        checkTreeCollisions(entries.map(({ path }) => path));
      } catch {
        throw new GitIntegrationError("invalid-candidate");
      }
    }
    return changes;
  }

  async #checkCandidateSymlinks(
    entries: readonly { path: string; oid: string }[],
  ): Promise<void> {
    // Recheck pinned commits, including candidates produced by older hosts.
    const batch = await this.#run(["cat-file", "--batch"], {
      gitDir: this.#config.repository,
      cwd: this.#config.repository,
      input: Buffer.from(entries.map((entry) => `${entry.oid}\n`).join("")),
      maxBuffer: entries.length * (pathLimit + 64),
      timeout: 60_000,
    });
    let offset = 0;
    for (const entry of entries) {
      const newline = batch.indexOf(10, offset);
      if (newline < 0) throw new GitIntegrationError("invalid-candidate");
      const header = batch.toString("latin1", offset, newline);
      const match = /^([a-f0-9]{40}) blob (\d+)$/.exec(header);
      const end = newline + 1 + Number(match?.[2]);
      if (
        match?.[1] !== entry.oid ||
        batch[end] !== 10 ||
        !isSafeSymlinkTarget(entry.path, batch.subarray(newline + 1, end))
      )
        throw new GitIntegrationError("invalid-candidate");
      offset = end + 1;
    }
    if (offset !== batch.length)
      throw new GitIntegrationError("invalid-candidate");
  }

  async protectedPaths(
    base: string,
    candidate: string,
    protectedPaths: readonly string[],
  ): Promise<string[]> {
    await this.#repository();
    const changes = await this.#candidate(base, candidate);
    return changes
      .filter(
        ({ path, newMode }) =>
          newMode === "120000" || matchesTreePaths(path, protectedPaths),
      )
      .map(({ path }) => path)
      .sort();
  }

  /** `git ls-tree -r -z --full-tree <commit>`, for the strict ls-tree parser. */
  async listTree(commit: string): Promise<Uint8Array> {
    oid(commit);
    await this.#repository();
    await this.#commit(commit);
    return this.#run(["ls-tree", "-r", "-z", "--full-tree", commit], {
      gitDir: this.#config.repository,
      cwd: this.#config.repository,
      maxBuffer: 64 * 1024 * 1024,
      timeout: 60_000,
    });
  }

  async diff(
    base: string,
    candidate: string,
    expectation?: FileExpectation,
  ): Promise<Uint8Array> {
    oid(base);
    oid(candidate);
    await this.#repository();
    await this.#candidate(base, candidate, expectation);
    return this.#git([
      "-c",
      `attr.tree=${emptyTree}`,
      "diff",
      "--no-ext-diff",
      "--no-textconv",
      "--no-renames",
      "--no-color",
      "--text",
      "--full-index",
      "--src-prefix=a/",
      "--dst-prefix=b/",
      base,
      candidate,
    ]);
  }

  async advance(
    base: string,
    candidate: string,
    expectation?: FileExpectation,
  ): Promise<void> {
    oid(base);
    oid(candidate);
    await this.#repository();
    await this.#candidate(base, candidate, expectation);
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
  #run(
    args: readonly string[],
    options: {
      gitDir?: string;
      cwd: string;
      env?: Record<string, string>;
      input?: Uint8Array;
      maxBuffer?: number;
      timeout?: number;
      allowExitOne?: boolean;
    },
  ): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const child = execFile(
        this.#config.binary,
        [
          ...(options.gitDir ? [`--git-dir=${options.gitDir}`] : []),
          "--no-pager",
          ...gitConfigArgs,
          ...args,
        ],
        {
          cwd: options.cwd,
          env: { ...gitEnv, ...options.env },
          timeout: options.timeout ?? 10_000,
          killSignal: "SIGKILL",
          maxBuffer: options.maxBuffer ?? outputLimit,
          encoding: "buffer",
        },
        (error, stdout) => {
          if (
            error &&
            !(options.allowExitOne && (error as { code?: unknown }).code === 1)
          )
            reject(
              new GitIntegrationError(
                (error as NodeJS.ErrnoException).code ===
                  "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"
                  ? "output-limit"
                  : "git-failed",
              ),
            );
          else resolve(stdout);
        },
      );
      child.stdin?.on("error", () => {
        /* Process completion reports a fixed diagnostic. */
      });
      child.stdin?.end(options.input ? Buffer.from(options.input) : undefined);
    });
  }

  async #stage(prefix: string): Promise<string> {
    await mkdir(this.#config.stagingRoot, { recursive: true, mode: 0o700 });
    const staging = await lstat(this.#config.stagingRoot);
    if (
      !staging.isDirectory() ||
      staging.isSymbolicLink() ||
      (staging.mode & 0o077) !== 0
    )
      throw new GitIntegrationError("unsafe-repository");
    const directory = await mkdtemp(join(this.#config.stagingRoot, prefix));
    this.#directories.add(directory);
    const made = await lstat(directory);
    if (
      !made.isDirectory() ||
      made.isSymbolicLink() ||
      (made.mode & 0o077) !== 0
    )
      throw new GitIntegrationError("unsafe-repository");
    return directory;
  }

  async #entries(
    gitDir: string,
    cwd: string,
    commit: string,
    includeDirectories = false,
  ): Promise<TreeEntry[]> {
    const output = await this.#run(
      [
        "ls-tree",
        "-r",
        "-l",
        "-z",
        "--full-tree",
        ...(includeDirectories ? ["-t"] : []),
        commit,
      ],
      { gitDir, cwd, maxBuffer: 256 * 1024 * 1024, timeout: 60_000 },
    );
    const entries: TreeEntry[] = [];
    let start = 0;
    while (start < output.length) {
      const end = output.indexOf(0, start);
      if (end < 0) throw new GitIntegrationError("git-failed");
      const record = output.subarray(start, end);
      start = end + 1;
      const tab = record.indexOf(9);
      const match = /^(\d{6}) (blob|commit|tree) ([a-f0-9]{40}) +(\d+|-)$/.exec(
        record.subarray(0, Math.max(tab, 0)).toString("latin1"),
      );
      if (tab < 0 || !match) throw new GitIntegrationError("git-failed");
      const bytes = record.subarray(tab + 1);
      const path = bytes.toString("utf8");
      if (!Buffer.from(path, "utf8").equals(bytes))
        throw new GitIntegrationError("unsupported-entry");
      entries.push({
        mode: match[1]!,
        oid: match[3]!,
        size: match[4] === "-" ? 0 : Number(match[4]),
        path,
      });
      if (entries.length > 4 * workspaceFileLimit)
        throw new GitIntegrationError("output-limit");
    }
    return entries;
  }

  /**
   * Builds a private workspace without checking anything out on the host:
   * `git/` is a full-history git directory (base at refs/heads/base, HEAD at
   * refs/heads/work = previous or base, no remotes, hooks disabled, index of
   * HEAD with no worktree) and `tree.tar` is the tree of HEAD written by this
   * module from blob objects (no filters, attributes, export-subst or
   * checkout). Only regular files, executables and symlinks are accepted;
   * submodules are rejected. With sparsePaths, the tar holds only those paths
   * and the index marks the rest skip-worktree. If every sparse path is a
   * directory, cone mode (parent-directory files included) is configured;
   * otherwise non-cone patterns with anchored paths are used.
   */
  async prepareWorkspace(options: {
    base: string;
    previous?: string;
    sparsePaths?: readonly string[];
  }): Promise<PreparedWorkspace> {
    const base = oid(options.base);
    const previous =
      options.previous === undefined ? undefined : oid(options.previous);
    const head = previous ?? base;
    let sparse: string[] | undefined;
    if (options.sparsePaths !== undefined) {
      if (
        !Array.isArray(options.sparsePaths) ||
        options.sparsePaths.length === 0 ||
        options.sparsePaths.length > sparseLimit
      )
        throw new GitIntegrationError("invalid-input");
      sparse = [...new Set(options.sparsePaths.map(sparsePath))];
    }
    await this.#repository();
    await this.#commit(base);
    if (previous !== undefined) {
      await this.#commit(previous);
      const ancestor = (
        await this.#git(["merge-base", base, previous], undefined, true)
      )
        .toString("utf8")
        .trim();
      if (ancestor !== base) throw new GitIntegrationError("invalid-input");
    }
    const kinds = new Map<string, "tree" | "blob">();
    if (sparse !== undefined) {
      const requested = new Set(sparse.map(foldTreePath));
      const matched = new Set<string>();
      for (const { path, mode } of await this.#entries(
        this.#config.repository,
        this.#config.repository,
        head,
        true,
      )) {
        const key = foldTreePath(path);
        if (!requested.has(key)) continue;
        if (matched.has(key) || mode === "160000")
          throw new GitIntegrationError("invalid-input");
        kinds.set(sparsePath(path), mode === "040000" ? "tree" : "blob");
        matched.add(key);
      }
      if (matched.size !== requested.size)
        throw new GitIntegrationError("invalid-input");
      sparse = [...kinds.keys()];
    }
    const cone =
      sparse !== undefined && sparse.every((p) => kinds.get(p) === "tree");
    const dirs = (sparse ?? []).filter((p) => kinds.get(p) === "tree");
    const files = new Set(
      (sparse ?? []).filter((p) => kinds.get(p) === "blob"),
    );
    const ancestors = new Set<string>();
    if (cone)
      for (const dir of dirs) {
        const parts = dir.split("/");
        for (let i = 1; i < parts.length; i++)
          ancestors.add(parts.slice(0, i).join("/"));
      }
    const included = (path: string): boolean => {
      if (sparse === undefined) return true;
      if (files.has(path)) return true;
      if (dirs.some((dir) => path.startsWith(`${dir}/`))) return true;
      if (!cone) return false;
      const slash = path.lastIndexOf("/");
      return slash < 0 || ancestors.has(path.slice(0, slash));
    };

    let directory: string | undefined;
    try {
      directory = await this.#stage("workspace-");
      const gitDir = join(directory, "git");
      const tree = join(directory, "tree.tar");
      await this.#run(["init", "--bare", "--quiet", "--template=", gitDir], {
        cwd: directory,
      });
      await mkdir(join(gitDir, "info"), { recursive: true, mode: 0o700 });
      const refspecs = [`${base}:refs/heads/base`];
      if (previous !== undefined) refspecs.push(`${previous}:refs/heads/work`);
      await this.#run(
        [
          "-c",
          "transfer.fsckObjects=true",
          "-c",
          "gc.auto=0",
          "fetch",
          "--quiet",
          "--no-tags",
          "--no-write-fetch-head",
          "--no-recurse-submodules",
          "--",
          this.#config.repository,
          ...refspecs,
        ],
        {
          gitDir,
          cwd: directory,
          env: { GIT_ALLOW_PROTOCOL: "file" },
          timeout: 600_000,
        },
      );
      if (previous === undefined)
        await this.#run(["update-ref", "refs/heads/work", base], {
          gitDir,
          cwd: directory,
        });
      await this.#run(["symbolic-ref", "HEAD", "refs/heads/work"], {
        gitDir,
        cwd: directory,
      });
      await rm(join(gitDir, "hooks"), { recursive: true, force: true });
      const entries = await this.#entries(gitDir, directory, "HEAD");
      const selected = entries.filter((entry) => included(entry.path));
      for (const entry of entries) treePath(entry.path);
      if (selected.length > workspaceFileLimit)
        throw new GitIntegrationError("output-limit");
      let total = 0;
      for (const entry of selected) {
        if (!["100644", "100755", "120000"].includes(entry.mode))
          throw new GitIntegrationError("unsupported-entry");
        total += entry.size;
        if (total > workspaceByteLimit)
          throw new GitIntegrationError("output-limit");
      }
      const index = join(gitDir, "index");
      await this.#run(["read-tree", "HEAD"], {
        gitDir,
        cwd: directory,
        env: { GIT_INDEX_FILE: index },
        timeout: 60_000,
      });
      const skipped = entries.filter((entry) => !included(entry.path));
      if (sparse !== undefined && skipped.length > 0)
        await this.#run(["update-index", "--skip-worktree", "-z", "--stdin"], {
          gitDir,
          cwd: directory,
          env: { GIT_INDEX_FILE: index, GIT_WORK_TREE: directory },
          input: Buffer.from(skipped.map((e) => `${e.path}\0`).join("")),
          timeout: 60_000,
        });
      if (sparse !== undefined)
        await writeFile(
          join(gitDir, "info", "sparse-checkout"),
          cone
            ? `${[
                "/*",
                "!/*/",
                ...[...ancestors, ...dirs]
                  .sort()
                  .flatMap((dir) =>
                    ancestors.has(dir)
                      ? [`/${dir}/`, `!/${dir}/*/`]
                      : [`/${dir}/`],
                  ),
              ].join("\n")}\n`
            : `${sparse
                .map((path) =>
                  kinds.get(path) === "tree" ? `/${path}/` : `/${path}`,
                )
                .join("\n")}\n`,
          { mode: 0o600 },
        );
      await writeFile(
        join(gitDir, "config"),
        [
          "[core]",
          "\trepositoryformatversion = 0",
          "\tfilemode = true",
          "\tbare = false",
          "\thooksPath = /dev/null",
          "\tautocrlf = false",
          ...(sparse
            ? [
                "\tsparseCheckout = true",
                `\tsparseCheckoutCone = ${cone ? "true" : "false"}`,
              ]
            : []),
          "[index]",
          "\tsparse = false",
          "[user]",
          '\tname = "Agent Bootstrap Worker"',
          '\temail = "worker@agent-bootstrap.invalid"',
          "[commit]",
          "\tgpgsign = false",
          "",
        ].join("\n"),
        { mode: 0o600 },
      );
      await this.#tar(gitDir, directory, tree, selected);
      return { directory, gitDir, tree };
    } catch (error) {
      let cleanupFailed = false;
      if (directory) {
        try {
          await this.cleanupWorkspace(directory);
        } catch {
          cleanupFailed = true;
        }
      }
      throw new GitIntegrationError(
        error instanceof GitIntegrationError ? error.code : "git-failed",
        cleanupFailed ||
          (error instanceof GitIntegrationError && error.cleanupFailed),
      );
    }
  }

  async #tar(
    gitDir: string,
    cwd: string,
    output: string,
    entries: readonly TreeEntry[],
  ): Promise<void> {
    const total = entries.reduce((sum, entry) => sum + entry.size, 0);
    const batch = await this.#run(["cat-file", "--batch"], {
      gitDir,
      cwd,
      input: Buffer.from(entries.map((entry) => `${entry.oid}\n`).join("")),
      maxBuffer: total + entries.length * 64 + 1024 * 1024,
      timeout: 600_000,
    });
    const file = await open(
      output,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
    try {
      let offset = 0;
      for (const entry of entries) {
        const newline = batch.indexOf(10, offset);
        if (
          newline < 0 ||
          batch.subarray(offset, newline).toString("latin1") !==
            `${entry.oid} blob ${entry.size}`
        )
          throw new GitIntegrationError("git-failed");
        const start = newline + 1;
        const end = start + entry.size;
        if (batch[end] !== 10) throw new GitIntegrationError("git-failed");
        const content = batch.subarray(start, end);
        if (
          entry.mode === "120000" &&
          (entry.size === 0 ||
            entry.size > pathLimit ||
            content.includes(0) ||
            !Buffer.from(content.toString("utf8"), "utf8").equals(content))
        )
          throw new GitIntegrationError("unsupported-entry");
        for (const chunk of tarEntry(entry, content)) await file.write(chunk);
        offset = end + 1;
      }
      await file.write(Buffer.alloc(1024));
    } finally {
      await file.close();
    }
  }

  async cleanupWorkspace(directory: string): Promise<void> {
    if (typeof directory !== "string" || !this.#directories.has(directory))
      throw new GitIntegrationError("invalid-input");
    try {
      await rm(directory, { recursive: true, force: true });
      this.#directories.delete(directory);
    } catch {
      throw new GitIntegrationError("cleanup-failed", true);
    }
  }

  /**
   * Creates a pinned candidate commit on top of base without a worktree. A
   * change is either `{ path, mode, bytes }` (add or replace; symlink bytes are
   * the target) or `{ path, deleted: true }` (the path must exist as a file or
   * symlink in base). Paths must be unique. The host is author and committer.
   */
  async createCandidateTree(
    base: string,
    changes: readonly TreeChange[],
    message: string,
  ): Promise<string> {
    oid(base);
    const text = commitMessage(message);
    if (
      !Array.isArray(changes) ||
      changes.length === 0 ||
      changes.length > changeCountLimit
    )
      throw new GitIntegrationError("invalid-input");
    const seen = new Set<string>();
    let total = 0;
    const updates: { path: string; mode: string; bytes: Buffer }[] = [];
    const deletions: string[] = [];
    for (const change of changes) {
      const path = treePath(change?.path);
      if (seen.has(path)) throw new GitIntegrationError("invalid-input");
      seen.add(path);
      if ("deleted" in change) {
        if (change.deleted !== true)
          throw new GitIntegrationError("invalid-input");
        deletions.push(path);
        continue;
      }
      if (
        !["100644", "100755", "120000"].includes(change.mode) ||
        !(change.bytes instanceof Uint8Array)
      )
        throw new GitIntegrationError("invalid-input");
      const bytes = Buffer.from(change.bytes);
      total += bytes.byteLength;
      if (
        total > changeByteLimit ||
        (change.mode === "120000" && !isSafeSymlinkTarget(path, bytes))
      )
        throw new GitIntegrationError("invalid-input");
      updates.push({ path, mode: change.mode, bytes });
    }
    await this.#repository();
    await this.#commit(base);
    const existing = new Set<string>();
    for (const entry of await this.#entries(
      this.#config.repository,
      this.#config.repository,
      base,
    ))
      existing.add(entry.path);
    for (const path of deletions)
      if (!existing.has(path)) throw new GitIntegrationError("invalid-input");
    // A path may not turn an existing file into a directory (or back) unless
    // the change set deletes the old path explicitly.
    const final = new Set(existing);
    for (const path of deletions) final.delete(path);
    for (const update of updates) final.add(update.path);
    try {
      checkTreeCollisions(final);
    } catch {
      throw new GitIntegrationError("invalid-input");
    }
    let directory: string | undefined;
    let candidate: string | undefined;
    let failure: GitIntegrationError | undefined;
    let cleanupFailed = false;
    try {
      directory = await this.#stage("candidate-tree-");
      const env = {
        GIT_INDEX_FILE: join(directory, "index"),
        GIT_LITERAL_PATHSPECS: "1",
      };
      const options = {
        gitDir: this.#config.repository,
        cwd: this.#config.repository,
        env,
      };
      await this.#run(["read-tree", base], options);
      const objects: string[] = Array.from<string>({ length: updates.length });
      let next = 0;
      const worker = async () => {
        for (let i = next++; i < updates.length; i = next++) {
          objects[i] = oid(
            (
              await this.#run(
                ["hash-object", "-w", "--no-filters", "--stdin"],
                {
                  ...options,
                  input: updates[i]!.bytes,
                },
              )
            )
              .toString("utf8")
              .trim(),
          );
        }
      };
      await Promise.all(
        Array.from({ length: Math.min(8, updates.length) }, worker),
      );
      const infos = [
        ...deletions.map((path) => `0 ${"0".repeat(40)}\t${path}\0`),
        ...updates.map(
          (update, i) => `${update.mode} ${objects[i]}\t${update.path}\0`,
        ),
      ];
      await this.#run(["update-index", "-z", "--index-info"], {
        ...options,
        input: Buffer.from(infos.join("")),
        timeout: 60_000,
      });
      const tree = oid(
        (await this.#run(["write-tree"], options)).toString("utf8").trim(),
      );
      candidate = oid(
        (
          await this.#run(["commit-tree", tree, "-p", base, "-F", "-"], {
            ...options,
            input: text,
          })
        )
          .toString("utf8")
          .trim(),
      );
      await this.#pin(candidate);
    } catch (error) {
      failure =
        error instanceof GitIntegrationError
          ? error
          : new GitIntegrationError("git-failed");
    } finally {
      if (directory) {
        try {
          await rm(directory, { recursive: true, force: true });
          this.#directories.delete(directory);
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
}
