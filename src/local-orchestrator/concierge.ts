import { execFile, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  rm,
} from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import { claudeRoleHarness } from "../actors.ts";
import {
  CLAUDE_CODE,
  claudeCodeGuestSetup,
  claudeCodeProvider,
  claudeCodeTools,
  type ClaudeCodeAuth,
  type ClaudeCodeInstall,
} from "../claude-code.ts";
import { MICROSANDBOX_LIMITS } from "../microsandbox.ts";
import {
  INTERACTIVE_MAX_LIFETIME_MS,
  type SandboxFile,
  type TerminalCommand,
} from "../sandbox-runtime.ts";
import type { TrustedHost } from "../trusted-host.ts";
import { HostApiServer } from "./host-api.ts";
import { ActorRunner } from "./runner.ts";
import type { OrchestratorStore } from "./store.ts";

const PORT = 5000;
const modes = ["default", "acceptEdits", "plan", "auto"] as const;
type PermissionMode = (typeof modes)[number];
const runFile = promisify(execFile);
const gitEnv = {
  PATH: "/usr/bin:/bin",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_NO_LAZY_FETCH: "1",
  GIT_NO_REPLACE_OBJECTS: "1",
  GIT_ATTR_NOSYSTEM: "1",
  GIT_OPTIONAL_LOCKS: "0",
};

export interface ConciergeSnapshot {
  readonly dir: string;
  readonly files: readonly string[];
}

type ConciergeHost = Pick<
  TrustedHost,
  "runConcierge" | "runPlanner" | "runReviewer" | "prepareConciergeVolume"
>;

export interface ConciergeDeps {
  readonly host: ConciergeHost;
  readonly store: OrchestratorStore;
  readonly snapshot: (
    repoRoot: string,
    sessionId: string,
  ) => Promise<ConciergeSnapshot>;
  readonly install: ClaudeCodeInstall;
  readonly auth: ClaudeCodeAuth;
  readonly listen?: (
    ...args: Parameters<typeof HostApiServer.listen>
  ) => Promise<Pick<HostApiServer, "close">>;
}

export interface ConciergeOptions {
  readonly repoRoot: string;
  readonly model: string;
  readonly mode?: PermissionMode;
  readonly continue?: boolean;
  readonly lifetimeMs?: number;
  readonly onSession?: (sessionId: string) => void;
}

export function parseConciergeMode(value: unknown): PermissionMode {
  for (const mode of modes) if (value === mode) return mode;
  throw new Error("Concierge mode must be default, acceptEdits, plan, or auto");
}

export function conciergeVolumeName(repoRoot: string): string {
  const slug = createHash("sha256")
    .update(resolve(repoRoot))
    .digest("hex")
    .slice(0, 16);
  return `lo-concierge-${slug}`;
}

export function conciergeCommand(
  options: Pick<ConciergeOptions, "model" | "mode" | "continue">,
  auth: ClaudeCodeAuth,
): TerminalCommand {
  const { model } = options;
  if (typeof model !== "string" || !/^[a-z0-9][a-z0-9.-]{0,80}$/.test(model))
    throw new Error("Invalid Claude model");
  if (options.continue !== undefined && typeof options.continue !== "boolean")
    throw new Error("Invalid continuation option");
  const mode = parseConciergeMode(
    options.mode === undefined ? "auto" : options.mode,
  );
  const { secretEnv } = claudeCodeProvider(auth);
  const script = `
${claudeCodeGuestSetup(secretEnv, "alpine")}    umask 077
    mkdir -p /state/claude /state/home /etc/claude-code
    chmod 700 /state/claude /state/home
    cat > /tmp/lo-mcp.json <<'EOF'
{"mcpServers":{"orchestrator":{"type":"stdio","command":"socat","args":["STDIO","VSOCK-CONNECT:2:${PORT}"]}}}
EOF
    cat > /etc/claude-code/managed-settings.json <<'EOF'
{"permissions":{"deny":["WebFetch","Bash"],"allow":["mcp__orchestrator"]}}
EOF
    cd /repo
    exec env -i PATH=/usr/bin:/bin:/usr/sbin:/sbin HOME=/state/home \\
      CLAUDE_CONFIG_DIR=/state/claude ${secretEnv}="$${secretEnv}" \\
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 DISABLE_AUTOUPDATER=1 \\
      DISABLE_TELEMETRY=1 DISABLE_ERROR_REPORTING=1 \\
      NODE_EXTRA_CA_CERTS="\${NODE_EXTRA_CA_CERTS:-}" TERM=xterm-256color \\
      ${CLAUDE_CODE.guestPath} --mcp-config /tmp/lo-mcp.json --strict-mcp-config \\
      --model '${model}' --permission-mode ${mode}${options.continue ? " --continue" : ""}
  `;
  return { argv: ["/bin/sh", "-ec", script], workdir: "/repo" };
}

async function checkDirectory(path: string): Promise<void> {
  const parent = dirname(path);
  if (parent !== path) await checkDirectory(parent);
  const info = await lstat(path);
  const mode = info.mode & 0o7777;
  if (
    !info.isDirectory() ||
    (info.uid !== process.getuid?.() && info.uid !== 0) ||
    ((mode & 0o022) !== 0 && !(info.uid === 0 && mode === 0o1777))
  )
    throw new Error("Unsafe Concierge directory");
}

export async function prepareConciergeDirectory(
  repoRoot: string,
): Promise<string> {
  const root = resolve(repoRoot);
  await checkDirectory(root);
  let dir = root;
  for (const name of [".local", "local-orchestrator"]) {
    dir = join(dir, name);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await checkDirectory(dir);
  }
  const info = await lstat(dir);
  if (info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0)
    throw new Error("Concierge state requires a private directory");
  return dir;
}

function exited(child: ReturnType<typeof spawn>): Promise<void> {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) =>
      code === 0 ? resolve() : reject(new Error("Concierge archive failed")),
    );
  });
}

async function privateSubdirectories(dir: string): Promise<void> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const path = join(dir, entry.name);
    await chmod(path, 0o700);
    await privateSubdirectories(path);
  }
}

/** Export one pinned HEAD tree without reading worktree files or downloading objects. */
export async function snapshotConciergeRepo(
  repoRoot: string,
  sessionId: string,
): Promise<ConciergeSnapshot> {
  if (!/^[a-f0-9-]{36}$/.test(sessionId)) throw new Error("Invalid session ID");
  const root = await prepareConciergeDirectory(repoRoot);
  const parent = join(root, "snapshots");
  await mkdir(parent, { recursive: true, mode: 0o700 });
  await checkDirectory(parent);
  const dir = join(parent, sessionId);
  await mkdir(dir, { mode: 0o700 });
  try {
    await chmod(dir, 0o700);
    const git = "/usr/bin/git";
    const cwd = resolve(repoRoot);
    const { stdout } = await runFile(git, ["rev-parse", "--verify", "HEAD"], {
      cwd,
      env: gitEnv,
      timeout: 15_000,
      maxBuffer: 1024,
    });
    const head = stdout.trim();
    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(head))
      throw new Error("Invalid repository HEAD");
    const { stdout: objectPath } = await runFile(
      git,
      ["rev-parse", "--path-format=absolute", "--git-path", "objects"],
      { cwd, env: gitEnv, timeout: 15_000, maxBuffer: 8192 },
    );
    const objects = objectPath.replace(/\n$/, "");
    if (!isAbsolute(objects) || objects.includes("\n"))
      throw new Error("Invalid Git object directory");

    // Use the original objects with an empty Git repository so archive
    // cannot run checkout-local filters or consult info/attributes.
    const metadata = await mkdtemp(join(parent, ".git-"));
    try {
      await runFile(
        git,
        [
          "init",
          "--bare",
          "--template=",
          head.length === 64
            ? "--object-format=sha256"
            : "--object-format=sha1",
        ],
        { cwd: metadata, env: gitEnv, timeout: 15_000, maxBuffer: 4096 },
      );
      const env = { ...gitEnv, GIT_OBJECT_DIRECTORY: objects };
      const archive = spawn(
        git,
        [
          "archive",
          "--format=tar",
          head,
          "--",
          ".",
          ":(exclude,icase,top).local",
        ],
        {
          cwd: metadata,
          env,
          timeout: 120_000,
          killSignal: "SIGKILL",
          stdio: ["ignore", "pipe", "ignore"],
        },
      );
      const extract = spawn(
        "/usr/bin/tar",
        ["-xf", "-", "--no-same-owner", "--no-same-permissions"],
        {
          cwd: dir,
          env: { PATH: "/usr/bin:/bin" },
          timeout: 120_000,
          killSignal: "SIGKILL",
          stdio: ["pipe", "ignore", "ignore"],
        },
      );
      const results = await Promise.allSettled([
        exited(archive),
        exited(extract),
        pipeline(archive.stdout, extract.stdin),
      ]);
      if (results.some(({ status }) => status === "rejected"))
        throw new Error("Concierge archive failed");
      await privateSubdirectories(dir);
      const { stdout: listing } = await runFile(
        git,
        ["ls-tree", "-r", "-z", "--name-only", head],
        {
          cwd: metadata,
          env,
          timeout: 15_000,
          maxBuffer: 8 * 1024 * 1024,
        },
      );
      return {
        dir,
        files: listing
          .split("\0")
          .filter((path) => path && !/^\.local(?:\/|$)/i.test(path)),
      };
    } finally {
      await rm(metadata, { recursive: true, force: true });
    }
  } catch (error) {
    await rm(dir, { recursive: true, force: true });
    throw error;
  }
}

async function readContextFile(dir: string, path: string, limit: number) {
  // Git can track symlinks. Inspect each parent and open only a regular file.
  const parts = path.split("/");
  for (const part of parts.slice(0, -1)) {
    dir = join(dir, part);
    if (!(await lstat(dir).catch(missing))?.isDirectory()) return;
  }
  const filePath = join(dir, parts.at(-1)!);
  const info = await lstat(filePath).catch(missing);
  if (!info?.isFile() || info.size > limit) return;
  const file = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const bytes = Buffer.alloc(info.size + 1);
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
    if (bytesRead !== info.size) throw new Error("Concierge snapshot changed");
    return bytes.subarray(0, bytesRead);
  } finally {
    await file.close();
  }
}

function missing(error: NodeJS.ErrnoException) {
  if (error.code !== "ENOENT") throw error;
  return undefined;
}

/** Provisional Planner context, leaving room for the runner's request.json. */
export async function conciergeContext(
  snapshot: ConciergeSnapshot,
): Promise<SandboxFile[]> {
  const { fileBytes, files, workspaceBytes } = MICROSANDBOX_LIMITS;
  const listing: string[] = [];
  let listingBytes = 0;
  const tracked = new Set(
    snapshot.files.filter((path) => !/^\.local(?:\/|$)/i.test(path)),
  );
  for (const path of tracked) {
    const quoted = JSON.stringify(path);
    const line = quoted.slice(1, -1) === path ? path : quoted;
    listingBytes += Buffer.byteLength(line) + 1;
    if (listingBytes > fileBytes) break;
    listing.push(line + "\n");
  }
  const context: SandboxFile[] = [
    { path: "files.txt", bytes: Buffer.from(listing.join("")) },
  ];
  let remaining = workspaceBytes - fileBytes - context[0]!.bytes.byteLength;
  const docs = [...tracked]
    .filter((path) =>
      /^docs\/local-orchestrator\/[a-zA-Z0-9._-]+\.md$/.test(path),
    )
    .sort();
  for (const path of ["AGENTS.md", "README.md", ...docs]) {
    if (context.length >= files - 1) break;
    if (!tracked.has(path) || path.length > 236) continue;
    const bytes = await readContextFile(
      snapshot.dir,
      path,
      Math.min(fileBytes, remaining),
    );
    if (bytes === undefined) continue;
    context.push({ path, bytes });
    remaining -= bytes.byteLength;
  }
  return context;
}

async function waitForDrain(drain: Promise<void>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      drain,
      new Promise<never>((_, reject) => {
        // One actor lifetime plus audited backend cleanup.
        timer = setTimeout(
          () => reject(new Error("Concierge runner shutdown timed out")),
          360_000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export async function startConcierge(
  deps: ConciergeDeps,
  options: ConciergeOptions,
) {
  const { host, store, auth, install } = deps;
  const mode = parseConciergeMode(
    options.mode === undefined ? "auto" : options.mode,
  );
  const command = conciergeCommand({ ...options, mode }, auth);
  const lifetime =
    options.lifetimeMs === undefined ? 8 * 60 * 60 * 1000 : options.lifetimeMs;
  if (
    !Number.isSafeInteger(lifetime) ||
    lifetime < 1 ||
    lifetime > INTERACTIVE_MAX_LIFETIME_MS
  )
    throw new Error("Invalid Concierge lifetime");
  const provider = claudeCodeProvider(auth);
  const tools = claudeCodeTools(install, "alpine");
  const harness = claudeRoleHarness({
    auth,
    model: options.model,
    tools,
    profile: "base",
  });
  const stateVolume = conciergeVolumeName(options.repoRoot);

  const invocationId = randomUUID();
  const { id: sessionId } = store.startSession("Concierge", invocationId);
  let snapshotDir: string | undefined;
  let socketDir: string | undefined;
  let server: Pick<HostApiServer, "close"> | undefined;
  let drain: Promise<void> | undefined;
  let drainFailed = false;
  let stopping = false;
  let failed = false;
  let outcome: Awaited<ReturnType<ConciergeHost["runConcierge"]>>["outcome"];
  let exitCode: number | null = null;
  const cleanupErrors: string[] = [];
  const queued = new Set<string>();
  const cancelQueued = (id: string) => {
    if (store.getExecution(id)?.status === "queued")
      store.finishExecution(id, "cancelled", { code: "session-ended" });
  };

  try {
    options.onSession?.(sessionId);
    const snapshot = await deps.snapshot(options.repoRoot, sessionId);
    snapshotDir = snapshot.dir;
    const context = await conciergeContext(snapshot);
    socketDir = await mkdtemp("/private/tmp/lo-");
    const socket = join(socketDir, "h.sock");
    const runner = new ActorRunner({
      store,
      runPlanner: (...args) => {
        if (stopping) throw new Error("Concierge session ended");
        return host.runPlanner(...args);
      },
      runReviewer: (...args) => host.runReviewer(...args),
      harness,
      model: options.model,
      context: async () => context,
    });
    let drainRequested = false;
    const scheduleDrain = () => {
      drainRequested = true;
      if (drain) return;
      drainRequested = false;
      drain = runner.drain();
      void drain.then(
        () => {
          drain = undefined;
          if (drainRequested && !stopping) scheduleDrain();
        },
        () => {
          drainFailed = true;
          console.error("concierge-runner-failed");
        },
      );
    };
    server = await (deps.listen ?? HostApiServer.listen)({
      store,
      socketPath: socket,
      sessionId,
      requester: {
        async requestPlanner(input) {
          if (stopping) throw new Error("Concierge session ended");
          if (drainFailed) throw new Error("concierge-runner-failed");
          for (const id of queued)
            if (store.getExecution(id)?.status !== "queued") queued.delete(id);
          const id = await runner.requestPlanner(input);
          queued.add(id);
          if (stopping || drainFailed) cancelQueued(id);
          else scheduleDrain();
          return id;
        },
      },
    });
    await host.prepareConciergeVolume(stateVolume);
    ({ outcome } = await host.runConcierge(
      {
        sandbox: {
          profile: "concierge",
          tools,
          provider,
          maxLifetimeMs: lifetime,
          interactive: {
            vsock: { hostPath: socket, port: PORT },
            stateVolume,
            snapshotDir,
          },
        },
      },
      invocationId,
      async (terminal) => {
        console.error(
          "Guest output reaches this terminal. Disable OSC 52 clipboard access before use.",
        );
        ({ exitCode } = await terminal.attach(command));
      },
    ));
    if (mode === "auto" && exitCode !== null && exitCode !== 0)
      console.error(
        "Concierge exited in auto mode. Check the CLI message above for an auto-mode rejection, then retry with --mode default if needed.",
      );
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    stopping = true;
    const cleanup = async (code: string, effect: () => unknown) => {
      try {
        await effect();
      } catch {
        cleanupErrors.push(code);
      }
    };
    await cleanup("concierge-end-session-failed", () =>
      store.endSession(sessionId),
    );
    const closing = cleanup("concierge-close-api-failed", () =>
      server?.close(),
    );
    await cleanup("concierge-cancel-queued-failed", () => {
      for (const id of queued) cancelQueued(id);
    });
    await closing;
    await cleanup("concierge-drain-failed", () => drain && waitForDrain(drain));
    await cleanup(
      "concierge-remove-snapshot-failed",
      () => snapshotDir && rm(snapshotDir, { recursive: true, force: true }),
    );
    await cleanup(
      "concierge-remove-socket-dir-failed",
      () => socketDir && rm(socketDir, { recursive: true, force: true }),
    );
    if (failed && cleanupErrors.length) console.error(cleanupErrors.join(", "));
  }
  if (cleanupErrors.length) throw new Error(cleanupErrors.join(", "));
  return { sessionId, outcome, exitCode };
}
