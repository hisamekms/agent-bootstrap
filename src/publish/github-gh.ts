import { execFile } from "node:child_process";
import { accessSync, constants, realpathSync } from "node:fs";
import { homedir } from "node:os";
import {
  builtInCredentialScanner,
  credentialScanClean,
  proposalCredentialCheck,
  type CredentialScanner,
} from "../local-orchestrator/credential-scan.ts";
import { delimiter, isAbsolute, join, relative, sep } from "node:path";
import {
  autoMergeMethods,
  validPublishRemote,
  PublishError,
  type PublishDestination,
  type PublishCheckState,
  type PublishFailure,
  type PublishProvider,
  type PublishPrFacts,
  type PublishPullRequest,
} from "./port.ts";

const headPattern = /^[0-9a-f]{40}$/;
const repositoryPattern = "[A-Za-z0-9][A-Za-z0-9-]{0,38}/[A-Za-z0-9_.-]{1,100}";
const remoteUrl = new RegExp(
  `^(?:https://github\\.com/|git@github\\.com:|ssh://git@github\\.com/)(${repositoryPattern})$`,
);
const prFields =
  "number,url,state,headRefOid,headRefName,baseRefName,isCrossRepository,statusCheckRollup,autoMergeRequest,mergeable,mergeStateStatus,reviewDecision,additions,deletions,changedFiles";

type Command = (
  binary: "git" | "gh",
  args: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  stdin?: string,
) => Promise<{ stdout: string; diagnostic: string; ok: boolean }>;

function outsideCheckout(checkout: string, path: string) {
  const fromCheckout = relative(checkout, path);
  return (
    fromCheckout === ".." ||
    fromCheckout.startsWith(".." + sep) ||
    isAbsolute(fromCheckout)
  );
}

function realPath(path: string) {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

function githubCli(checkout: string, path: string) {
  const repo = realPath(checkout);
  for (const directory of path.split(delimiter).filter(isAbsolute)) {
    try {
      const executable = realpathSync(join(directory, "gh"));
      if (!outsideCheckout(repo, executable)) continue;
      accessSync(executable, constants.X_OK);
      return executable;
    } catch {
      // A host PATH entry may not contain gh.
    }
  }
}
const execute: Command = (binary, args, cwd, env, stdin) =>
  new Promise((resolve) => {
    const executable =
      binary === "git" ? "/usr/bin/git" : githubCli(cwd, env.PATH ?? "");
    if (!executable) {
      resolve({ stdout: "", diagnostic: "", ok: false });
      return;
    }
    const child = execFile(
      executable,
      [...args],
      {
        cwd,
        env,
        shell: false,
        timeout: 30_000,
        killSignal: "SIGKILL",
        maxBuffer: 512 * 1024,
      },
      (error, stdout, stderr) =>
        resolve({ stdout, diagnostic: stderr, ok: !error }),
    );
    child.stdin?.on("error", () => {});
    child.stdin?.end(stdin);
  });

function checkState(row: Record<string, unknown>): PublishCheckState {
  const result = row.conclusion || row.state;
  if (
    [
      "FAILURE",
      "ERROR",
      "CANCELLED",
      "TIMED_OUT",
      "ACTION_REQUIRED",
      "STARTUP_FAILURE",
      "STALE",
    ].some((state) => state === result)
  )
    return "fail";
  return ["SUCCESS", "NEUTRAL", "SKIPPED"].some((state) => state === result)
    ? "pass"
    : "pending";
}

function boundedCheckName(raw: string) {
  let name = "";
  // Reserve room for all 50 checks within a publish journal event.
  for (const char of raw.replace(/\p{C}/gu, " ").trim()) {
    if (Buffer.byteLength(JSON.stringify(name + char)) > 32) break;
    name += char;
  }
  return name.trimEnd();
}

async function checkFacts(
  value: unknown,
  destination: PublishDestination,
  scan?: CredentialScanner,
) {
  if (!Array.isArray(value)) return { checks: "unknown" } as const;
  const checkCounts = { pass: 0, pending: 0, fail: 0 };
  const checkRuns: NonNullable<PublishPrFacts["checkRuns"]> = [];
  if (value.length === 0)
    return { checks: "none", checkRuns, checkCounts } as const;
  const visible: { raw: string; name: string; state: PublishCheckState }[] = [];
  for (const item of value as unknown[]) {
    const row =
      item && typeof item === "object" ? (item as Record<string, unknown>) : {};
    const state = checkState(row);
    checkCounts[state]++;
    if (visible.length === 50) continue;
    const label = row.name ?? row.context;
    const raw = typeof label === "string" ? label : "";
    visible.push({ raw, name: boundedCheckName(raw), state });
  }
  // Screen both what GitHub returned and what will appear in the journal.
  const sources = visible.map(({ raw, name }) => [raw, name]);
  const screen = proposalCredentialCheck(scan ?? builtInCredentialScanner);
  const screened = await screen(sources);
  // Reserve space for the pinned destination and other fields in the journal.
  let remaining = 2600 - Buffer.byteLength(JSON.stringify(destination));
  for (const [i, { name, state }] of visible.entries()) {
    const entry = {
      name: credentialScanClean(screened[i] ?? null)
        ? name || "チェック"
        : "名前非表示",
      state,
    };
    remaining -= Buffer.byteLength(JSON.stringify(entry)) + 1;
    if (remaining < 0) break;
    checkRuns.push(entry);
  }
  const checks = checkCounts.fail
    ? "failed"
    : checkCounts.pending
      ? "pending"
      : "passed";
  return { checks, checkRuns, checkCounts } as const;
}

function mergeability(
  row: Record<string, unknown>,
  checks: PublishPullRequest["checks"],
  review: PublishPrFacts["review"],
): NonNullable<PublishPrFacts["mergeable"]> {
  const status = row.mergeStateStatus;
  if (row.mergeable === "CONFLICTING" || status === "DIRTY") return "conflict";
  if (status === "BEHIND" || status === "DRAFT") return "blocked";
  if (status === "BLOCKED") {
    // GitHub also reports BLOCKED while required checks are running. If no
    // other blocker is known, let GitHub decide whether auto-merge can arm.
    return checks === "pending" &&
      row.mergeable === "MERGEABLE" &&
      review !== "review-required" &&
      review !== "changes-requested"
      ? "unknown"
      : "blocked";
  }
  return row.mergeable === "MERGEABLE" && status !== "UNKNOWN"
    ? "clean"
    : "unknown";
}

function reviewDecision(value: unknown): NonNullable<PublishPrFacts["review"]> {
  switch (value) {
    case "APPROVED":
      return "approved";
    case "CHANGES_REQUESTED":
      return "changes-requested";
    case "REVIEW_REQUIRED":
      return "review-required";
    default:
      return "none";
  }
}

async function pullRequest(
  value: unknown,
  destination: PublishDestination,
  scan?: CredentialScanner,
): Promise<PublishPullRequest> {
  if (!value || typeof value !== "object")
    throw new PublishError("publish-pr-failed");
  const row = value as Record<string, unknown>;
  const state =
    row.state === "OPEN"
      ? "open"
      : row.state === "MERGED"
        ? "merged"
        : row.state === "CLOSED"
          ? "closed"
          : null;
  const { number, url, headRefOid } = row;
  if (
    typeof number !== "number" ||
    !Number.isSafeInteger(number) ||
    number < 1 ||
    typeof url !== "string" ||
    url.toLowerCase() !==
      `https://github.com/${destination.repository}/pull/${number}`.toLowerCase() ||
    !url.startsWith("https://github.com/") ||
    !state ||
    typeof headRefOid !== "string" ||
    !headPattern.test(headRefOid) ||
    row.headRefName !== destination.branch ||
    row.baseRefName !== destination.base ||
    row.isCrossRepository !== false
  )
    throw new PublishError("publish-pr-failed");
  const request = row.autoMergeRequest as
    { mergeMethod?: unknown } | null | undefined;
  const method =
    typeof request?.mergeMethod === "string"
      ? request.mergeMethod.toLowerCase()
      : "off";
  const autoMerge = autoMergeMethods.find((entry) => entry === method);
  if (!autoMerge) throw new PublishError("publish-pr-failed");
  const stats: PublishPrFacts = {};
  for (const key of ["additions", "deletions", "changedFiles"] as const) {
    const value = row[key];
    if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0)
      stats[key] = value;
  }
  const checkResults = await checkFacts(
    row.statusCheckRollup,
    destination,
    scan,
  );
  const review = reviewDecision(row.reviewDecision);
  return {
    number,
    url,
    head: headRefOid,
    state,
    ...checkResults,
    mergeable: mergeability(row, checkResults.checks, review),
    review,
    ...stats,
    autoMerge,
  };
}

export function githubGh(
  checkout: string,
  hostEnv = process.env,
  run: Command = execute,
  scan?: CredentialScanner,
): PublishProvider {
  const checkoutPath = realPath(checkout);
  const path = hostEnv.PATH?.split(delimiter)
    .filter(
      (entry) =>
        isAbsolute(entry) && outsideCheckout(checkoutPath, realPath(entry)),
    )
    .join(delimiter);
  const ghConfigDir = hostEnv.GH_CONFIG_DIR;
  const commonEnv = {
    HOME: hostEnv.HOME ?? homedir(),
    PATH: path || "/usr/bin:/bin",
    ...(hostEnv.XDG_CONFIG_HOME && {
      XDG_CONFIG_HOME: hostEnv.XDG_CONFIG_HOME,
    }),
    // Git can use gh auth git-credential, which needs the same host login.
    ...(ghConfigDir &&
      isAbsolute(ghConfigDir) && { GH_CONFIG_DIR: ghConfigDir }),
    LC_ALL: "C",
  };
  const gitEnv = {
    ...commonEnv,
    ...(hostEnv.SSH_AUTH_SOCK && { SSH_AUTH_SOCK: hostEnv.SSH_AUTH_SOCK }),
    GIT_TERMINAL_PROMPT: "0",
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_GRAFT_FILE: "/dev/null",
    GIT_ALLOW_PROTOCOL: "https:ssh",
    GIT_SSH_COMMAND: "/usr/bin/ssh",
    SSH_ASKPASS_REQUIRE: "never",
    GIT_SSH_VARIANT: "ssh",
  };
  const ghEnv = {
    ...commonEnv,
    GH_HOST: "github.com",
    GH_PROMPT_DISABLED: "1",
    GH_NO_UPDATE_NOTIFIER: "1",
    GH_NO_EXTENSION_UPDATE_NOTIFIER: "1",
    GH_PAGER: "cat",
    NO_COLOR: "1",
  };
  const git = (args: readonly string[]) =>
    run("git", ["-c", "core.hooksPath=/dev/null", ...args], checkout, gitEnv);
  const gh = (args: readonly string[], body?: string) =>
    run("gh", args, checkout, ghEnv, body);

  const output = (
    result: Awaited<ReturnType<Command>>,
    code: PublishFailure,
  ) => {
    if (!result.ok) throw new PublishError(code);
    return result.stdout;
  };
  const json = (stdout: string): unknown => {
    try {
      return JSON.parse(stdout) as unknown;
    } catch {
      throw new PublishError("publish-pr-failed");
    }
  };
  const remoteDestination = async (remote: string) => {
    if (!validPublishRemote(remote))
      throw new PublishError("publish-destination-invalid");
    const read = async (push: boolean) => {
      const raw = output(
        await git([
          "remote",
          "get-url",
          ...(push ? ["--push"] : []),
          "--all",
          "--",
          remote,
        ]),
        "publish-destination-invalid",
      );
      const url = raw.replace(/\r?\n$/, "");
      const repository = remoteUrl
        .exec(url)?.[1]
        ?.replace(/\.git$/, "")
        .toLowerCase();
      return { url, repository };
    };
    const [fetch, push] = await Promise.all([read(false), read(true)]);
    const repository = fetch.repository;
    if (
      !repository ||
      repository !== push.repository ||
      repository.endsWith("/.") ||
      repository.endsWith("/..") ||
      repository.endsWith("/")
    )
      throw new PublishError("publish-destination-invalid");
    return { repository, fetchUrl: fetch.url, pushUrl: push.url };
  };
  const checkDestination = async (destination: PublishDestination) => {
    const resolved = await remoteDestination(destination.remote);
    if (resolved.repository !== destination.repository)
      throw new PublishError("publish-destination-changed");
    return resolved;
  };
  const checkTransferUrl = async (url: string, push: boolean) => {
    // Passing a literal URL avoids resolving the configured remote a second
    // time. Git still applies URL rewrites to literals, so reject a second hop.
    const alias = "agent-bootstrap-publish-url-check";
    const resolved = output(
      await git(
        push
          ? ["-c", `remote.${alias}.url=${url}`, "remote", "-v"]
          : ["ls-remote", "--get-url", "--", url],
      ),
      "publish-destination-invalid",
    );
    const matches = push
      ? resolved
          .split(/\r?\n/)
          .filter(
            (line) => line.startsWith(`${alias}\t`) && line.endsWith(" (push)"),
          )
      : [resolved.replace(/\r?\n$/, "")];
    const expected = push ? `${alias}\t${url} (push)` : url;
    if (matches.length !== 1 || matches[0] !== expected)
      throw new PublishError("publish-destination-changed");
  };
  const preventRedirects = (url: string) =>
    url.startsWith("https://")
      ? ["-c", `http.${url}.followRedirects=false`]
      : [];
  const ref = (destination: PublishDestination) =>
    `refs/heads/${destination.branch}`;
  const repo = (destination: PublishDestination) => [
    "--repo",
    `github.com/${destination.repository}`,
  ];

  return {
    async repository(remote) {
      return (await remoteDestination(remote)).repository;
    },
    async remoteHead(destination) {
      const { fetchUrl } = await checkDestination(destination);
      await checkTransferUrl(fetchUrl, false);
      const stdout = output(
        await git([
          ...preventRedirects(fetchUrl),
          "ls-remote",
          "--refs",
          "--upload-pack=git-upload-pack",
          "--",
          fetchUrl,
          ref(destination),
        ]),
        "publish-poll-failed",
      ).trim();
      if (!stdout) return null;
      const [head, name] = stdout.split("\t");
      if (!head || !headPattern.test(head) || name !== ref(destination))
        throw new PublishError("publish-poll-failed");
      return head;
    },
    async push(destination, head, expectedRemoteHead) {
      if (
        !headPattern.test(head) ||
        (expectedRemoteHead !== null && !headPattern.test(expectedRemoteHead))
      )
        throw new PublishError("publish-stale-head");
      if (
        expectedRemoteHead &&
        !(await git(["merge-base", "--is-ancestor", expectedRemoteHead, head]))
          .ok
      )
        throw new PublishError("publish-non-fast-forward");
      const { pushUrl } = await checkDestination(destination);
      await checkTransferUrl(pushUrl, true);
      const result = await git([
        ...preventRedirects(pushUrl),
        "push",
        "--porcelain",
        "--no-verify",
        "--no-signed",
        "--no-follow-tags",
        "--recurse-submodules=no",
        "--receive-pack=git-receive-pack",
        "--",
        pushUrl,
        `${head}:${ref(destination)}`,
      ]);
      if (!result.ok) {
        const rejected =
          /^!\t[^\t\n]+\t\[rejected\] \((?:non-fast-forward|fetch first)\)\r?$/m.test(
            result.stdout,
          );
        throw new PublishError(
          rejected ? "publish-non-fast-forward" : "publish-push-failed",
        );
      }
    },
    async findPullRequest(destination, recoveringHead, afterPrNumber = 0) {
      const value = json(
        output(
          await gh([
            "pr",
            "list",
            ...repo(destination),
            "--head",
            destination.branch,
            "--base",
            destination.base,
            "--state",
            recoveringHead ? "all" : "open",
            "--limit",
            "100",
            "--json",
            prFields,
          ]),
          "publish-pr-failed",
        ),
      );
      if (!Array.isArray(value)) throw new PublishError("publish-pr-failed");
      const candidates = value
        .filter(
          (item) =>
            item &&
            typeof item === "object" &&
            item.isCrossRepository === false,
        )
        .filter(
          (item) =>
            typeof item.number === "number" && item.number > afterPrNumber,
        );
      const candidate =
        candidates.find((item) => item.state === "OPEN") ??
        candidates.find((item) => item.headRefOid === recoveringHead);
      return candidate ? pullRequest(candidate, destination, scan) : null;
    },
    async readPullRequest(destination, number) {
      const pr = await pullRequest(
        json(
          output(
            await gh([
              "pr",
              "view",
              String(number),
              ...repo(destination),
              "--json",
              prFields,
            ]),
            "publish-pr-failed",
          ),
        ),
        destination,
        scan,
      );
      if (pr.number !== number) throw new PublishError("publish-pr-failed");
      return pr;
    },
    async openPullRequest(destination, title, body) {
      output(
        await gh(
          [
            "pr",
            "create",
            ...repo(destination),
            "--head",
            destination.branch,
            "--base",
            destination.base,
            `--title=${title}`,
            "--body-file",
            "-",
          ],
          body,
        ),
        "publish-pr-failed",
      );
    },
    async mergePullRequest(destination, number, method, expectedHead) {
      output(
        await gh([
          "pr",
          "merge",
          String(number),
          ...repo(destination),
          `--${method}`,
          "--match-head-commit",
          expectedHead,
        ]),
        "publish-merge-failed",
      );
    },
    async closePullRequest(destination, number) {
      output(
        await gh(["pr", "close", String(number), ...repo(destination)]),
        "publish-close-failed",
      );
    },
    async setAutoMerge(destination, number, method, expectedHead) {
      const result = await gh([
        "pr",
        "merge",
        String(number),
        ...repo(destination),
        ...(method === "off"
          ? ["--disable-auto"]
          : ["--auto", `--${method}`, "--match-head-commit", expectedHead]),
      ]);
      if (!result.ok)
        throw new PublishError(
          /auto.?merge is not (?:allowed|enabled)|auto.?merge.*(?:disabled|not (?:allowed|enabled))|no required (?:status )?checks|protected branch rules not configured|clean status/i.test(
            result.diagnostic,
          )
            ? "auto-merge-unavailable"
            : "publish-auto-merge-failed",
        );
    },
  };
}
