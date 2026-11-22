import { execFile, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { boundedLines } from "./lines.ts";
import {
  SandboxRuntimeError,
  type CollectedArtifacts,
  type CollectSpec,
  type ExecResult,
  type SandboxCommand,
  type SandboxHandle,
  type SandboxRuntime,
  type SandboxSession,
  type SandboxSpec,
  type SandboxTool,
} from "./sandbox-runtime.ts";

export interface MicrosandboxConfig {
  readonly binary: string;
  readonly home: string;
  readonly stagingRoot: string;
  readonly image: string;
}

/** Conservative fixed bounds for this initial offline adapter. */
export const MICROSANDBOX_LIMITS = {
  files: 64,
  fileBytes: 256 * 1024,
  workspaceBytes: 1024 * 1024,
  outputBytes: 1024 * 1024,
  commandTimeoutMs: 60_000,
  defaultLifetimeMs: 120_000,
  maxLifetimeMs: 300_000,
  backendTimeoutMs: 15_000,
  tools: 4,
  toolBytes: 512 * 1024 * 1024,
  sessionLineBytes: 1024 * 1024,
  sessionBytes: 16 * 1024 * 1024,
} as const;

type ProcessResult = {
  code: number | null;
  stdout: Buffer;
  stderr: Buffer;
  failure?: "timed-out" | "cancelled" | "output-limit" | "backend-failure";
};

type State = {
  id: string;
  directory: string;
  deadline: number;
  busy: boolean;
  closed: boolean;
  removed: boolean;
  destruction?: Promise<void>;
};

function invalid(): never {
  throw new SandboxRuntimeError("invalid-input");
}

function boundedInteger(value: number, maximum: number): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) invalid();
}

function relativePath(path: string): void {
  if (
    typeof path !== "string" ||
    path.length > 240 ||
    !/^[a-zA-Z0-9._-]+(?:\/[a-zA-Z0-9._-]+)*$/.test(path)
  )
    invalid();
  if (path.split("/").some((part) => part === "." || part === "..")) invalid();
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  let size = 0;
  for await (const chunk of createReadStream(path)) {
    size += (chunk as Buffer).length;
    if (size > MICROSANDBOX_LIMITS.toolBytes) invalid();
    hash.update(chunk as Buffer);
  }
  return hash.digest("hex");
}

function checkTools(tools: readonly SandboxTool[]): SandboxTool[] {
  if (tools.length > MICROSANDBOX_LIMITS.tools) invalid();
  const guests = new Set<string>();
  return tools.map((tool) => {
    if (
      typeof tool.hostPath !== "string" ||
      !isAbsolute(tool.hostPath) ||
      /[\0:\r\n]/.test(tool.hostPath) ||
      typeof tool.guestPath !== "string" ||
      !/^\/tmp\/[a-zA-Z0-9._-]{1,64}$/.test(tool.guestPath) ||
      tool.guestPath.split("/").some((part) => part === "." || part === "..") ||
      guests.has(tool.guestPath) ||
      typeof tool.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(tool.sha256)
    )
      invalid();
    guests.add(tool.guestPath);
    return { ...tool };
  });
}

/** Host-only adapter. Callers must supply dedicated trusted host directories and
 * a cached digest-pinned image containing /bin/sh, base64, wc and test. */
export class MicrosandboxRuntime implements SandboxRuntime {
  readonly #config: MicrosandboxConfig;
  readonly #states = new WeakMap<SandboxHandle, State>();

  constructor(config: MicrosandboxConfig) {
    for (const path of [config.binary, config.home, config.stagingRoot]) {
      if (
        typeof path !== "string" ||
        !isAbsolute(path) ||
        /[\0:\r\n]/.test(path)
      )
        invalid();
    }
    if (
      !/^[a-zA-Z0-9][a-zA-Z0-9._/:-]*@sha256:[a-f0-9]{64}$/.test(config.image)
    )
      invalid();
    this.#config = { ...config };
  }

  #env() {
    return {
      PATH: "/usr/bin:/bin",
      MSB_HOME: this.#config.home,
      MSB_BACKEND: "local",
    };
  }

  #run(
    args: readonly string[],
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<ProcessResult> {
    if (signal?.aborted)
      return Promise.resolve({
        code: null,
        stdout: Buffer.alloc(0),
        stderr: Buffer.alloc(0),
        failure: "cancelled",
      });
    return new Promise((resolve) => {
      const controller = new AbortController();
      let interrupted: "timed-out" | "cancelled" | undefined;
      const interrupt = (reason: "timed-out" | "cancelled") => {
        if (interrupted) return;
        interrupted = reason;
        controller.abort();
      };
      const cancel = () => interrupt("cancelled");
      const timer = setTimeout(() => interrupt("timed-out"), timeoutMs);
      signal?.addEventListener("abort", cancel, { once: true });
      execFile(
        this.#config.binary,
        [...args],
        {
          env: this.#env(),
          cwd: this.#config.home,
          encoding: "buffer",
          killSignal: "SIGKILL",
          maxBuffer: MICROSANDBOX_LIMITS.outputBytes,
          signal: controller.signal,
        },
        (error, stdout, stderr) => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", cancel);
          const result: ProcessResult = { code: 0, stdout, stderr };
          if (error) {
            const code = (error as NodeJS.ErrnoException).code;
            result.code = typeof code === "number" ? code : null;
            if (interrupted) result.failure = interrupted;
            else if (code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER")
              result.failure = "output-limit";
            else if (typeof code !== "number")
              result.failure = "backend-failure";
          }
          resolve(result);
        },
      );
    });
  }

  async #checked(args: readonly string[]): Promise<ProcessResult> {
    const result = await this.#run(args, MICROSANDBOX_LIMITS.backendTimeoutMs);
    if (result.failure || result.code !== 0)
      throw new SandboxRuntimeError(result.failure ?? "backend-failure");
    return result;
  }

  #state(handle: SandboxHandle): State {
    const state = this.#states.get(handle);
    if (!state || state.closed) throw new SandboxRuntimeError("unknown-handle");
    if (state.busy || state.destruction) throw new SandboxRuntimeError("busy");
    return state;
  }

  async #withCleanup(state: State, failure: unknown): Promise<never> {
    let cleanupFailed = false;
    try {
      await this.#destroy(state);
    } catch {
      cleanupFailed = true;
    }
    throw new SandboxRuntimeError(
      failure instanceof SandboxRuntimeError ? failure.code : "backend-failure",
      cleanupFailed,
      cleanupFailed ? state.id : undefined,
    );
  }

  async create(spec: SandboxSpec): Promise<SandboxHandle> {
    const invocationId = spec.invocationId;
    if (
      invocationId !== undefined &&
      (typeof invocationId !== "string" ||
        !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(
          invocationId,
        ))
    )
      invalid();
    const lifetime =
      spec.maxLifetimeMs ?? MICROSANDBOX_LIMITS.defaultLifetimeMs;
    boundedInteger(lifetime, MICROSANDBOX_LIMITS.maxLifetimeMs);
    const tools = checkTools(spec.tools ?? []);
    const port = spec.hostTcpPort;
    if (port !== undefined) boundedInteger(port, 65_535);
    const fileGroups = [spec.files ?? [], spec.readOnlyFiles ?? []];
    if (fileGroups.flat().length > MICROSANDBOX_LIMITS.files) invalid();
    let total = 0;
    // Copy input bytes before the first await so callers cannot mutate staged input.
    const snapshots = fileGroups.map((files) => {
      const paths = new Set<string>();
      return files.map((file) => {
        relativePath(file.path);
        if (
          !(file.bytes instanceof Uint8Array) ||
          file.bytes.byteLength > MICROSANDBOX_LIMITS.fileBytes ||
          paths.has(file.path)
        )
          invalid();
        paths.add(file.path);
        total += file.bytes.byteLength;
        if (total > MICROSANDBOX_LIMITS.workspaceBytes) invalid();
        return { path: file.path, bytes: new Uint8Array(file.bytes) };
      });
    });
    let state: State | undefined;
    let directory: string | undefined;
    try {
      const version = await this.#checked(["--version"]);
      if (version.stdout.toString("utf8").trim() !== "msb 0.7.16")
        throw new SandboxRuntimeError("unsupported-version");
      for (const tool of tools)
        if ((await sha256File(tool.hostPath)) !== tool.sha256)
          throw new SandboxRuntimeError("tool-digest");
      await mkdir(this.#config.stagingRoot, { recursive: true, mode: 0o700 });
      directory = await mkdtemp(join(this.#config.stagingRoot, "msb-"));
      const workspace = join(directory, "workspace");
      const review = join(directory, "review");
      const [writable = [], readOnly = []] = snapshots;
      for (const [root, files] of [
        [workspace, writable],
        [review, readOnly],
      ] as const) {
        await mkdir(root, { mode: 0o700 });
        for (const file of files) {
          const destination = join(root, file.path);
          const parent = destination.slice(0, destination.lastIndexOf("/"));
          await mkdir(parent, { recursive: true, mode: 0o700 });
          await writeFile(destination, file.bytes, { flag: "wx", mode: 0o600 });
        }
      }
      state = {
        id: `bootstrap-${randomUUID()}`,
        directory,
        deadline: performance.now() + lifetime,
        busy: false,
        closed: false,
        removed: false,
      };
      await this.#checked([
        "create",
        "--name",
        state.id,
        ...(invocationId
          ? ["--label", `agent-bootstrap-invocation=${invocationId}`]
          : []),
        "--pull",
        "never",
        "--no-net",
        ...(port !== undefined ? ["--net-rule", `allow@host:tcp:${port}`] : []),
        "--max-duration",
        `${Math.ceil(lifetime / 1000)}s`,
        "--copy-dir",
        `${workspace}:/workspace`,
        ...(readOnly.length ? ["--mount-dir", `${review}:/review:ro`] : []),
        ...tools.flatMap((tool) => [
          "--copy-file",
          `${tool.hostPath}:${tool.guestPath}`,
        ]),
        this.#config.image,
      ]);
      const handle = Object.freeze({ id: state.id });
      this.#states.set(handle, state);
      return handle;
    } catch (error) {
      if (state) return this.#withCleanup(state, error);
      let cleanupFailed = false;
      if (directory) {
        try {
          await rm(directory, { recursive: true, force: true });
        } catch {
          cleanupFailed = true;
        }
      }
      throw new SandboxRuntimeError(
        error instanceof SandboxRuntimeError ? error.code : "backend-failure",
        cleanupFailed,
      );
    }
  }

  async #execute(
    state: State,
    argv: readonly string[],
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<ExecResult> {
    const remaining = state.deadline - performance.now();
    if (remaining <= 0) throw new SandboxRuntimeError("lifetime-expired");
    const duration = Math.min(timeoutMs, remaining);
    const result = await this.#run(
      [
        "exec",
        "--no-stdin",
        "--no-tty",
        "--workdir",
        "/workspace",
        "--timeout",
        `${Math.ceil(duration / 1000) + 2}s`,
        state.id,
        "--",
        ...argv,
      ],
      duration,
      signal,
    );
    if (
      result.failure === "backend-failure" ||
      result.failure === "output-limit"
    )
      throw new SandboxRuntimeError(result.failure);
    return {
      status: result.failure ?? "exited",
      exitCode: result.code,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  }

  async exec(
    handle: SandboxHandle,
    command: SandboxCommand,
  ): Promise<ExecResult> {
    const state = this.#state(handle);
    boundedInteger(command.timeoutMs, MICROSANDBOX_LIMITS.commandTimeoutMs);
    if (
      !command.argv.length ||
      command.argv.length > 128 ||
      command.argv.some(
        (arg) =>
          typeof arg !== "string" || arg.length > 8192 || arg.includes("\0"),
      )
    )
      invalid();
    const argv = [...command.argv];
    state.busy = true;
    try {
      const result = await this.#execute(
        state,
        argv,
        command.timeoutMs,
        command.signal,
      );
      if (result.status !== "exited" || result.exitCode !== 0)
        await this.#destroy(state);
      return result;
    } catch (error) {
      return this.#withCleanup(state, error);
    } finally {
      state.busy = false;
    }
  }

  /** One streamed guest command. The handle stays busy until it stops; then
   * the caller destroys it. */
  async openSession(
    handle: SandboxHandle,
    command: SandboxCommand,
  ): Promise<SandboxSession> {
    const state = this.#state(handle);
    boundedInteger(command.timeoutMs, MICROSANDBOX_LIMITS.commandTimeoutMs);
    if (
      !command.argv.length ||
      command.argv.length > 128 ||
      command.argv.some(
        (arg) =>
          typeof arg !== "string" || arg.length > 8192 || arg.includes("\0"),
      )
    )
      invalid();
    if (command.signal?.aborted) throw new SandboxRuntimeError("cancelled");
    const remaining = state.deadline - performance.now();
    if (remaining <= 0) throw new SandboxRuntimeError("lifetime-expired");
    const duration = Math.min(command.timeoutMs, remaining);
    state.busy = true;
    const child = spawn(
      this.#config.binary,
      [
        "exec",
        "--stream",
        "--timeout",
        `${Math.ceil(duration / 1000) + 2}s`,
        state.id,
        "--",
        ...command.argv,
      ],
      {
        env: this.#env(),
        cwd: this.#config.home,
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    let stop: ExecResult["status"] | undefined;
    const kill = (reason: ExecResult["status"]) => {
      stop ??= reason;
      child.stdin.end();
      if (child.exitCode === null && child.signalCode === null)
        child.kill("SIGKILL");
    };
    const cancel = () => kill("cancelled");
    const timer = setTimeout(() => kill("timed-out"), duration);
    command.signal?.addEventListener("abort", cancel, { once: true });
    child.stdin.on("error", () => {});
    child.stderr.resume();
    const finished = new Promise<ExecResult["status"]>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        command.signal?.removeEventListener("abort", cancel);
        state.busy = false;
        resolve(stop ?? "exited");
      };
      child.once("close", done);
      child.once("error", () => {
        stop ??= "cancelled";
        child.stdout.destroy();
        done();
      });
    });
    async function* capped(): AsyncGenerator<Buffer> {
      let total = 0;
      try {
        for await (const chunk of child.stdout) {
          total += (chunk as Buffer).length;
          if (total > MICROSANDBOX_LIMITS.sessionBytes) {
            kill("cancelled");
            throw new SandboxRuntimeError("output-limit");
          }
          yield chunk as Buffer;
        }
      } catch (error) {
        if (error instanceof SandboxRuntimeError) throw error;
        // A destroyed stream after close or spawn failure simply ends.
      }
    }
    return {
      send(line) {
        if (stop === undefined && child.stdin.writable)
          child.stdin.write(`${line}\n`);
      },
      lines: boundedLines(capped(), MICROSANDBOX_LIMITS.sessionLineBytes),
      close: () => kill("cancelled"),
      finished,
    };
  }

  async collect(
    handle: SandboxHandle,
    spec: CollectSpec,
  ): Promise<CollectedArtifacts> {
    const state = this.#state(handle);
    if (
      spec.paths.length > MICROSANDBOX_LIMITS.files ||
      new Set(spec.paths).size !== spec.paths.length
    )
      invalid();
    for (const path of spec.paths) relativePath(path);
    const paths = [...spec.paths];
    state.busy = true;
    try {
      const files = [];
      let total = 0;
      for (const path of paths) {
        // No host extraction. Check every guest path component for links, then
        // stream only an exact bounded regular file as base64 over captured stdout.
        const script =
          'p=/workspace; test ! -L "$p"; rest=$1; while :; do part=${rest%%/*}; p=$p/$part; test ! -L "$p"; case "$rest" in */*) rest=${rest#*/};; *) break;; esac; done; test -f "$p"; n=$(wc -c < "$p"); test "$n" -le "$2"; printf "%s\\n" "$n"; base64 < "$p"';
        const result = await this.#execute(
          state,
          [
            "/bin/sh",
            "-ec",
            script,
            "collect",
            path,
            String(MICROSANDBOX_LIMITS.fileBytes),
          ],
          10_000,
        );
        if (result.status !== "exited" || result.exitCode !== 0)
          throw new SandboxRuntimeError("collection-failed");
        const text = Buffer.from(result.stdout).toString("ascii");
        const newline = text.indexOf("\n");
        const size = Number(text.slice(0, newline).trim());
        const encoded = text.slice(newline + 1).replace(/\s/g, "");
        if (
          newline < 1 ||
          !Number.isSafeInteger(size) ||
          size < 0 ||
          size > MICROSANDBOX_LIMITS.fileBytes ||
          !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
            encoded,
          )
        )
          throw new SandboxRuntimeError("collection-failed");
        const bytes = Buffer.from(encoded, "base64");
        total += bytes.byteLength;
        if (
          bytes.byteLength !== size ||
          total > MICROSANDBOX_LIMITS.workspaceBytes
        )
          throw new SandboxRuntimeError("collection-limit");
        files.push({ path, bytes });
      }
      return { files };
    } catch (error) {
      return this.#withCleanup(state, error);
    } finally {
      state.busy = false;
    }
  }

  #destroy(state: State): Promise<void> {
    if (state.destruction) return state.destruction;
    state.closed = true;
    state.destruction = (async () => {
      let failed = false;
      if (!state.removed) {
        try {
          await this.#checked(["rm", "--force", state.id]);
          state.removed = true;
        } catch {
          failed = true;
        }
      }
      try {
        await rm(state.directory, { recursive: true, force: true });
      } catch {
        failed = true;
      }
      if (failed)
        throw new SandboxRuntimeError("cleanup-failed", true, state.id);
    })().catch((error: unknown) => {
      delete state.destruction;
      throw error;
    });
    return state.destruction;
  }

  destroy(handle: SandboxHandle): Promise<void> {
    const state = this.#states.get(handle);
    if (!state)
      return Promise.reject(new SandboxRuntimeError("unknown-handle"));
    if (state.destruction) return state.destruction;
    if (state.busy) return Promise.reject(new SandboxRuntimeError("busy"));
    return this.#destroy(state);
  }
}
