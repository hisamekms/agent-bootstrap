import { secretTestFacts } from "./secret-test-record.ts";
import {
  requireCredentialScan,
  type CredentialScanner,
} from "./credential-scan.ts";
import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  rm,
} from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import { claudeRoleHarness, guestOf } from "../actors.ts";
import {
  CLAUDE_CODE,
  CLAUDE_CODE_BUILDS,
  claudeCodeGuestSetup,
  claudeCodeProvider,
  claudeCodeTools,
  type ClaudeCodeAuth,
  type ClaudeCodeInstall,
} from "../claude-code.ts";
import { GitIntegrationError } from "../git-integration.ts";
import { isSafeSymlinkTarget } from "../workspace-tree.ts";
import { MICROSANDBOX_LIMITS } from "../microsandbox.ts";
import {
  INTERACTIVE_MAX_LIFETIME_MS,
  type SandboxFile,
  type TerminalCommand,
  type TerminalExit,
} from "../sandbox-runtime.ts";
import type {
  ReviewerPlan,
  ConciergePlan,
  TrustedHost,
  TrustedHostRunOptions,
  WorkerPlan,
} from "../trusted-host.ts";
import type { ExecutionContext } from "../execution-context.ts";
import type { Config, SecretActor } from "../config/layers.ts";
import { ConfigError } from "../config/messages.ts";
import {
  parseClaudeAuthMode,
  userStateDirectory,
  type ClaudeAuthMode,
} from "./claude-config.ts";
import { orchestratorMcp, SECRET_EXECUTOR_SHELL } from "./claude-policy.ts";
import { HostApiServer } from "./host-api.ts";
import { gitCommit } from "./model.ts";
import { ActorRunner } from "./runner.ts";
import { secretVariable, withActorSecret } from "./secret-launch.ts";
import type { OrchestratorStore } from "./store.ts";
import { createTaskExecutor, localMainCommit } from "./tasks.ts";
import type { Verification } from "../reviewed-integration.ts";
import {
  checkDirectory,
  prepareTargetDirectory,
  resolveTarget,
} from "./target.ts";

/** macOS limits Unix socket paths to 104 bytes; /private/tmp keeps the Host API
 * socket short there. Other hosts use the OS temporary directory. */
function socketRoot(): string {
  return existsSync("/private/tmp") ? "/private/tmp" : tmpdir();
}

const PORT = 5000;
const modes = ["default", "acceptEdits", "plan", "auto"] as const;
type PermissionMode = (typeof modes)[number];
const runFile = promisify(execFile);
const gitEnv = {
  PATH: "/usr/bin:/bin",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_NO_LAZY_FETCH: "1",
  GIT_ALLOW_PROTOCOL: "",
  GIT_NO_REPLACE_OBJECTS: "1",
  GIT_ATTR_NOSYSTEM: "1",
  GIT_OPTIONAL_LOCKS: "0",
};

export interface ConciergeSnapshot {
  readonly dir: string;
  readonly commit: string;
  readonly files: readonly string[];
}

type ConciergeHost = Pick<
  TrustedHost,
  "runPlanner" | "runReviewer" | "prepareConciergeVolume"
> &
  Partial<Pick<TrustedHost, "runWorker" | "runVerification">> & {
    runConcierge(
      plan: ConciergePlan,
      id: string,
      use: (terminal: {
        attach(command: TerminalCommand): Promise<TerminalExit>;
      }) => Promise<void>,
    ): ReturnType<TrustedHost["runConcierge"]>;
  };

export interface ConciergeDeps {
  readonly scan?: CredentialScanner;
  readonly host: ConciergeHost;
  readonly store: OrchestratorStore;
  readonly snapshot: (
    repoRoot: string,
    sessionId: string,
    commit?: string,
    goalRepository?: boolean,
    target?: ConciergeOptions["target"],
  ) => Promise<ConciergeSnapshot>;
  readonly install: ClaudeCodeInstall;
  readonly auth: ClaudeCodeAuth;
  readonly config: Config;
  readonly baseImage: string;
  readonly note?: (message: string) => void;
  readonly verification?: Verification;
  readonly listen?: (
    ...args: Parameters<typeof HostApiServer.listen>
  ) => Promise<Pick<HostApiServer, "close">>;
}

export interface ConciergeOptions {
  readonly repoRoot: string;
  readonly target?: Awaited<ReturnType<typeof resolveTarget>>;
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
  const secretEnv =
    auth.mode === "external" ? undefined : claudeCodeProvider(auth).secretEnv;
  const mcp = JSON.stringify({ mcpServers: { orchestrator: orchestratorMcp } });
  const script = `
${claudeCodeGuestSetup(secretEnv, "alpine")}    umask 077
    mkdir -p /state/home
    chmod 700 /state/home
    if test -n "\${LO_MOUNT_CONFIG_DIR:-}"; then
      claude_config="$LO_MOUNT_CONFIG_DIR"
    else
      ${secretEnv ? 'claude_config=/state/claude; mkdir -p "$claude_config"; chmod 700 "$claude_config"' : "claude_config=$(mktemp -d)"}
    fi
    cat > /tmp/lo-mcp.json <<'EOF'
${mcp}
EOF
    set --
    if test -n "\${LO_MOUNT_RESTRICTED:-}"; then set -- --tools ""; fi
    cd /repo
    exec env -i PATH=/usr/bin:/bin:/usr/sbin:/sbin HOME=/state/home \\
      CLAUDE_CONFIG_DIR="$claude_config" ${secretEnv ? `${secretEnv}="$${secretEnv}"` : ""} \\
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 DISABLE_AUTOUPDATER=1 \\
      DISABLE_TELEMETRY=1 DISABLE_ERROR_REPORTING=1 \\
      NODE_EXTRA_CA_CERTS="\${NODE_EXTRA_CA_CERTS:-}" TERM=xterm-256color \\
      ${CLAUDE_CODE.guestPath} --mcp-config /tmp/lo-mcp.json --strict-mcp-config --setting-sources '' \\
      --append-system-prompt 'At the start of each operator turn, call orchestrator get_inbox. Tell the operator about new action items using their host titles and IDs. For gates, direct the operator to the operator CLI. Only the operator can answer gates. Never claim to have answered a gate.' \\
      "$@" --model '${model}' --permission-mode ${mode}${options.continue ? " --continue" : ""}
  `;
  return { argv: ["/bin/sh", "-ec", script], workdir: "/repo" };
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

/** Export a pinned local main tree without reading worktree files or downloading objects. */
export async function snapshotConciergeRepo(
  repoRoot: string,
  sessionId: string,
  commit?: string,
  goalRepository = false,
  target?: ConciergeOptions["target"],
): Promise<ConciergeSnapshot> {
  if (!/^[a-f0-9-]{36}$/.test(sessionId)) throw new Error("Invalid session ID");
  target ??= await resolveTarget(repoRoot, repoRoot);
  const root = await prepareTargetDirectory(
    target.bootstrapRoot,
    target.directory,
    target.env,
  );
  const parent = join(root, "snapshots");
  await mkdir(parent, { recursive: true, mode: 0o700 });
  await checkDirectory(parent);
  const dir = join(parent, sessionId);
  await mkdir(dir, { mode: 0o700 });
  try {
    await chmod(dir, 0o700);
    const git = "/usr/bin/git";
    const cwd = resolve(repoRoot);
    const base =
      commit === undefined ? await localMainCommit(cwd) : gitCommit(commit);
    const objects = goalRepository
      ? join(root, "repository.git", "objects")
      : (
          await runFile(
            git,
            ["rev-parse", "--path-format=absolute", "--git-path", "objects"],
            { cwd, env: gitEnv, timeout: 15_000, maxBuffer: 8192 },
          )
        ).stdout.replace(/\n$/, "");
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
          base.length === 64
            ? "--object-format=sha256"
            : "--object-format=sha1",
        ],
        { cwd: metadata, env: gitEnv, timeout: 15_000, maxBuffer: 4096 },
      );
      const env = { ...gitEnv, GIT_OBJECT_DIRECTORY: objects };
      const gitOptions = {
        cwd: metadata,
        env,
        timeout: 15_000,
        maxBuffer: 8 * 1024 * 1024,
      };
      const { stdout: listing } = await runFile(
        git,
        ["ls-tree", "-r", "-l", "-z", base],
        gitOptions,
      );
      const files: string[] = [];
      for (const entry of listing.split("\0")) {
        if (!entry) continue;
        const tab = entry.indexOf("\t");
        if (tab < 0) throw new Error("Concierge tree listing failed");
        const path = entry.slice(tab + 1);
        if (/^\.local(?:\/|$)/i.test(path)) continue;
        files.push(path);
        if (!entry.startsWith("120000 ")) continue;
        const link = /^120000 blob ([a-f0-9]{40}|[a-f0-9]{64}) +(\d+)$/.exec(
          entry.slice(0, tab),
        );
        if (!link || Number(link[2]) > 4096)
          throw new GitIntegrationError("unsafe-input-symlink");
        const { stdout: bytes } = await runFile(
          git,
          ["cat-file", "blob", link[1]!],
          { ...gitOptions, encoding: "buffer", maxBuffer: 4096 },
        );
        if (!isSafeSymlinkTarget(path, bytes))
          throw new GitIntegrationError("unsafe-input-symlink");
      }
      const archive = spawn(
        git,
        [
          "archive",
          "--format=tar",
          base,
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
      return { dir, commit: base, files };
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
  snapshot: Pick<ConciergeSnapshot, "dir" | "files">,
  includeOrchestratorDocs = true,
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
  const docs = (includeOrchestratorDocs ? [...tracked] : [])
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
  const provider =
    auth.mode === "external" ? undefined : claudeCodeProvider(auth);
  const tools = claudeCodeTools(install, "alpine");
  const harness = claudeRoleHarness({
    auth,
    model: options.model,
    tools,
    profile: "base",
  });
  const { repoRoot } = options;
  const target = options.target ?? (await resolveTarget(repoRoot, repoRoot));
  const { bootstrapRoot, volume: stateVolume, env } = target;
  const { config, baseImage } = deps;
  const secretHarness = (actor: SecretActor) => {
    const variable = secretVariable(config, actor);
    if (!variable) return;
    if (auth.mode !== "external")
      throw new ConfigError(
        `secretEnv.${variable}`,
        "Secret grants require claude.auth to be external.",
        "Select external mode or remove the grant and retry.",
      );
    const secretAuth = { mode: "secret-file", variable } as const;
    return claudeRoleHarness({
      auth: secretAuth,
      model: options.model,
      profile: "base",
      shell: actor === "Executor" && SECRET_EXECUTOR_SHELL,
      reportWorkerUsage: actor === "Executor",
      tools: claudeCodeTools(install, "alpine", secretAuth),
    });
  };
  const planner = secretHarness("Planner");
  const reviewer = secretHarness("Reviewer") ?? harness;
  const executor = secretHarness("Executor");
  function runActor<P extends WorkerPlan | ReviewerPlan, T>(
    run: (
      plan: P,
      id?: string,
      context?: ExecutionContext,
      options?: TrustedHostRunOptions,
    ) => Promise<T>,
  ) {
    return async (
      plan: P,
      id?: string,
      context?: ExecutionContext,
      runOptions?: TrustedHostRunOptions,
    ): Promise<T> => {
      const variable = plan.command.claudeSecretVariable;
      if (!variable) return run(plan, id, context, runOptions);
      try {
        return await withActorSecret(
          config,
          userStateDirectory(env),
          variable,
          baseImage,
          target.repoRoot,
          (secret) => run(plan, id, context, { ...runOptions, ...secret }),
        );
      } catch (error) {
        if (error instanceof ConfigError)
          deps.note?.(`${error.message}\nnext: ${error.next}`);
        throw error;
      }
    };
  }
  const runPlanner = runActor(host.runPlanner.bind(host));
  const runReviewer = runActor(host.runReviewer.bind(host));
  if (auth.mode === "external" && !deps.scan)
    throw new Error("Credential screening is required");
  if (deps.scan) {
    requireCredentialScan(
      await prepareTargetDirectory(bootstrapRoot, target.directory, env),
    );
  }

  const invocationId = randomUUID();
  const { id: sessionId } = store.startSession("Concierge", invocationId, true);
  let snapshotDir: string | undefined;
  let socketDir: string | undefined;
  let server: Pick<HostApiServer, "close"> | undefined;
  let drain: Promise<void> | undefined;
  let drainFailed = false;
  let scheduler: ReturnType<typeof setInterval> | undefined;
  let stopping = false;
  let failed = false;
  let outcome: Awaited<ReturnType<ConciergeHost["runConcierge"]>>["outcome"];
  let exitCode: number | null = null;
  let code: Awaited<ReturnType<ConciergeHost["runConcierge"]>>["code"];
  const cleanupErrors: string[] = [];
  const queued = new Set<string>();
  const cancelQueued = (id: string) => {
    if (store.getExecution(id)?.status === "queued")
      store.finishExecution(id, "cancelled", { code: "session-ended" });
  };

  try {
    options.onSession?.(sessionId);
    const snapshot = await deps.snapshot(
      repoRoot,
      sessionId,
      undefined,
      false,
      target,
    );
    snapshotDir = snapshot.dir;
    store.recordSessionSnapshot(sessionId, snapshot.commit);
    const context = await conciergeContext(snapshot, target?.isDefault);
    socketDir = await mkdtemp(join(socketRoot(), "lo-"));
    const socket = join(socketDir, "h.sock");
    const scan = deps.scan;
    const tasks =
      host.runWorker && host.runVerification
        ? createTaskExecutor({
            directory: await prepareTargetDirectory(
              bootstrapRoot,
              target.directory,
              env,
            ),
            repoRoot,
            ...(scan ? { scan } : {}),
            store,
            snapshotCommit: snapshot.commit,
            host: {
              runWorker: runActor(host.runWorker.bind(host)),
              runReviewer,
              runVerification: host.runVerification.bind(host),
            },
            worker(profile) {
              if (executor) {
                if (profile !== "base") {
                  const error = new ConfigError(
                    "secretEnv",
                    "The Executor's secret grant requires the base profile.",
                    "Choose the base profile for this task or remove the grant.",
                  );
                  deps.note?.(`${error.message}\nnext: ${error.next}`);
                  throw error;
                }
                return executor;
              }
              const guest = guestOf(profile);
              const workerInstall =
                guest === "alpine"
                  ? install
                  : {
                      ...install,
                      binary: join(
                        bootstrapRoot,
                        ".local",
                        "claude-code",
                        CLAUDE_CODE.version,
                        CLAUDE_CODE_BUILDS.debian.platform,
                        "claude",
                      ),
                    };
              return claudeRoleHarness({
                auth,
                model: options.model,
                profile,
                reportWorkerUsage: true,
                tools: claudeCodeTools(workerInstall, guest),
              });
            },
            reviewer,
            ...(deps.verification ? { verification: deps.verification } : {}),
          })
        : undefined;

    const runner = new ActorRunner({
      ...(scan ? { scan } : {}),
      store,
      ...(tasks ? { tasks, canScheduleTasks: () => !stopping } : {}),
      runPlanner: (...args) => {
        if (stopping) throw new Error("Concierge session ended");
        return runPlanner(...args);
      },
      runReviewer,
      harness: reviewer,
      ...(planner ? { plannerHarness: planner } : {}),
      ...(executor ? { executorRequiresBase: true } : {}),
      model: options.model,
      context: async (commit, goalRepository) => {
        if (commit === null || commit === snapshot.commit) return context;
        const pinned = await deps.snapshot(
          repoRoot,
          randomUUID(),
          commit,
          goalRepository,
          target,
        );
        try {
          if (pinned.commit !== commit)
            throw new Error("Planner snapshot mismatch");
          return await conciergeContext(pinned, target?.isDefault);
        } finally {
          await rm(pinned.dir, { recursive: true, force: true });
        }
      },
    });
    let drainRequested = false;
    const scheduleDrain = () => {
      if (stopping || drainFailed) return;
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
      ...(scan ? { scan } : {}),
      store,
      socketPath: socket,
      sessionId,
      inbox: {
        target: target.repoRoot,
        secretTests: () =>
          secretTestFacts(config.secretEnv, userStateDirectory(env), baseImage),
      },
      ...(tasks ? { onTaskRegistered: scheduleDrain } : {}),
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
    if (tasks) {
      scheduleDrain();
      // Operator decisions can arrive from another process via state.db.
      scheduler = setInterval(scheduleDrain, 1000);
      scheduler.unref();
    }
    ({ outcome, code } = await host.runConcierge(
      {
        sandbox: {
          profile: "concierge",
          tools,
          claude: true,
          ...(provider ? { provider } : {}),
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
    clearInterval(scheduler);
    const cleanup = async (code: string, effect: () => unknown) => {
      try {
        await effect();
      } catch {
        cleanupErrors.push(code);
      }
    };
    await cleanup("concierge-end-session-failed", () =>
      store.endSession(sessionId, {
        mode,
        status:
          !failed && outcome === "ok" && exitCode === 0
            ? "succeeded"
            : "failed",
        exitCode,
        ...(code ? { code } : {}),
      }),
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
  return { sessionId, outcome, exitCode, ...(code ? { code } : {}) };
}

export function parseConciergeArgs(args: readonly string[]) {
  let run = false;
  let resume = false;
  let target: string | undefined;
  let claudeAuth: ClaudeAuthMode | undefined;
  let volumeShell: string | undefined;
  let mode: ReturnType<typeof parseConciergeMode> | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--run" && !run) run = true;
    else if (args[i] === "--continue" && !resume) resume = true;
    else if (args[i] === "--claude-auth" && claudeAuth === undefined)
      claudeAuth = parseClaudeAuthMode(args[++i]);
    else if (args[i] === "--volume-shell" && volumeShell === undefined) {
      volumeShell = args[++i];
      if (!volumeShell || !/^[a-z][a-z0-9-]{0,47}$/.test(volumeShell))
        throw new Error("Invalid mount name");
    } else if (args[i] === "--mode" && mode === undefined)
      mode = parseConciergeMode(args[++i]);
    else if (args[i] === "--target" && target === undefined) {
      target = args[++i];
      if (!target || target.startsWith("--") || target.includes("\0"))
        throw new Error("Invalid Concierge arguments");
    } else throw new Error("Invalid Concierge arguments");
  }
  return {
    run,
    mode: mode ?? "auto",
    continue: resume,
    target,
    ...(claudeAuth ? { claudeAuth } : {}),
    ...(volumeShell ? { volumeShell } : {}),
  };
}
