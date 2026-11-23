import { execFile, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, lstatSync } from "node:fs";
import {
  copyFile,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  rmdir,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { CredentialProvider } from "./credentials.ts";
import { boundedLines } from "./lines.ts";
import {
  METRICS_OUTPUT_BYTES,
  parseMicrosandboxMetrics,
} from "./microsandbox-metrics.ts";
import { PROFILE_NAMES, ProfileCatalog } from "./sandbox-profiles.ts";
import {
  isSafeCredentialVariable,
  sameProvider,
  SandboxRuntimeError,
  WORKER_MESSAGE_LIMIT,
  WORKER_MESSAGE_PATH,
  type CollectedArtifacts,
  type CollectSpec,
  type ExecResult,
  type InteractiveSpec,
  type ResourceSample,
  type SandboxCommand,
  type SandboxEgressGateway,
  type SandboxHandle,
  type SandboxProvider,
  type SandboxRuntime,
  type SandboxSession,
  type SandboxSpec,
  type SandboxTool,
  type TerminalCommand,
} from "./sandbox-runtime.ts";

export interface MicrosandboxConfig {
  readonly binary: string;
  readonly home: string;
  readonly stagingRoot: string;
  readonly profiles: ProfileCatalog;
  /** Required only for specs with `provider`. Used on the host to pass the
   * credential to the backend's TLS substitution at create time. */
  readonly credentials?: CredentialProvider;
  /** The provider egress binding that specs may request: the credential's
   * host, header, variable, port and upstream CA. A spec's `provider` must
   * equal it exactly. At most one entry, because `credentials` is a single
   * credential. Default: none. */
  readonly providers?: readonly SandboxProvider[];
  /** Resolve the password for this binding on the host at create time. */
  readonly gatewayPassword?: (
    gateway: SandboxEgressGateway,
  ) => string | Promise<string>;
}

export const GATEWAY_NET_RULES =
  "allow@dns,deny@host,deny@0.0.0.0/0:tcp:53,deny@[::/0]:tcp:53,deny@0.0.0.0/0:tcp:853,deny@[::/0]:tcp:853,allow@0.0.0.0/0:tcp,allow@[::/0]:tcp";

const METRICS_TIMEOUT_MS = 1000;
const SANDBOX_NAME =
  /^bootstrap-[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;

/** Conservative fixed bounds for this initial offline adapter. */
export const MICROSANDBOX_LIMITS = {
  files: 64,
  fileBytes: 256 * 1024,
  workspaceBytes: 1024 * 1024,
  outputBytes: 1024 * 1024,
  commandTimeoutMs: 240_000,
  defaultLifetimeMs: 120_000,
  maxLifetimeMs: 300_000,
  interactiveMaxLifetimeMs: 12 * 60 * 60 * 1000,
  backendTimeoutMs: 15_000,
  tools: 8,
  toolBytes: 512 * 1024 * 1024,
  sessionLineBytes: 1024 * 1024,
  sessionBytes: 16 * 1024 * 1024,
  sessionStopMs: 5000,
  gitDirBytes: 2 * 1024 * 1024 * 1024,
  gitDirEntries: 200_000,
  treeBytes: 1024 * 1024 * 1024,
  collectedTreeBytes: 512 * 1024 * 1024,
  treeStepTimeoutMs: 120_000,
} as const;

const TREE_GUEST = "/tmp/agent-bootstrap-tree.tar";
const COLLECT_GUEST = "/tmp/agent-bootstrap-collect.tar";

/** Total bytes of a directory of plain files and directories. Any symlink or
 * special file, or exceeding a bound, is invalid input. */
async function plainTreeBytes(root: string): Promise<number> {
  let total = 0;
  let entries = 0;
  const walk = async (dir: string): Promise<void> => {
    for (const name of await readdir(dir)) {
      if (++entries > MICROSANDBOX_LIMITS.gitDirEntries) invalid();
      const path = join(dir, name);
      const info = await lstat(path);
      if (info.isDirectory()) await walk(path);
      else if (info.isFile()) {
        total += info.size;
        if (total > MICROSANDBOX_LIMITS.gitDirBytes) invalid();
      } else invalid();
    }
  };
  await walk(root);
  return total;
}

async function checkRepository(repository: {
  gitDir: string;
  tree: string;
}): Promise<void> {
  const { gitDir, tree } = repository;
  for (const path of [gitDir, tree]) {
    if (typeof path !== "string" || !isAbsolute(path) || /[\0:\r\n]/.test(path))
      invalid();
  }
  const git = await lstat(gitDir).catch(() => null);
  if (!git?.isDirectory()) invalid();
  const archive = await lstat(tree).catch(() => null);
  if (!archive?.isFile() || archive.size > MICROSANDBOX_LIMITS.treeBytes)
    invalid();
  await plainTreeBytes(gitDir);
}

type ProcessResult = {
  code: number | null;
  stdout: Buffer;
  stderr: Buffer;
  failure?: "timed-out" | "cancelled" | "output-limit" | "backend-failure";
};

type State = {
  id: string;
  cleanupLabel?: string;
  directory: string;
  deadline: number;
  interactive: boolean;
  terminal?: { stop(): void; finished: Promise<{ exitCode: number | null }> };
  busy: boolean;
  closed: boolean;
  removed: boolean;
  destruction?: Promise<void>;
  sampling?: {
    controller: AbortController;
    result: Promise<ResourceSample | null>;
  };
  finalSample?: ResourceSample;
};

type NetworkConfig = {
  args: string[];
  gateway: SandboxEgressGateway | undefined;
  provider: SandboxProvider | undefined;
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

/** Backend arguments for credentialed provider egress. The host-gateway
 * name maps to the backend's `host` target; other names are domain rules. */
function providerArgs(
  provider: SandboxProvider,
  throughGateway: boolean,
): string[] {
  const port = provider.port ?? 443;
  const target =
    provider.host === "host.microsandbox.internal" ? "host" : provider.host;
  return [
    ...(throughGateway
      ? []
      : [
          "--net-rule",
          "allow@dns",
          "--net-rule",
          `allow@${target}:tcp:${port}`,
        ]),
    "--tls-intercept",
    ...(port !== 443 ? ["--tls-intercept-port", String(port)] : []),
    ...(provider.upstreamCaCertPath
      ? [
          "--tls-upstream-ca-cert-for",
          `${provider.host}=${provider.upstreamCaCertPath}`,
        ]
      : []),
    "--secret",
    `${provider.secretEnv}:headers=${provider.header ?? "authorization"}@${provider.host}`,
    "--secret-violation-action",
    "block",
  ];
}

function checkVolumeName(name: string): void {
  if (typeof name !== "string" || !/^lo-[a-z0-9][a-z0-9-]{0,62}$/.test(name))
    invalid();
}

function interactiveArgs(spec: SandboxSpec): string[] {
  const { interactive } = spec;
  if (interactive === undefined) {
    if (spec.profile === "concierge") invalid();
    return [];
  }
  if (
    !interactive?.vsock ||
    spec.profile !== "concierge" ||
    !spec.egressGateway ||
    !spec.provider ||
    spec.repository !== undefined ||
    spec.readOnlyFiles !== undefined ||
    spec.files !== undefined ||
    spec.hostTcpPort !== undefined
  )
    invalid();
  const {
    vsock: { hostPath, port },
    stateVolume,
    snapshotDir,
  } = interactive;
  for (const path of [hostPath, snapshotDir])
    if (
      typeof path !== "string" ||
      !isAbsolute(path) ||
      resolve(path) !== path ||
      /[\0:=,\r\n]/.test(path)
    )
      invalid();
  if (Buffer.byteLength(hostPath) >= 100 || port < 1024) invalid();
  boundedInteger(port, 65_535);
  checkVolumeName(stateVolume);
  return [
    "--vsock",
    `${hostPath}:${port}`,
    "--mount-named",
    `${stateVolume}:/state`,
    "--mount-dir",
    `${snapshotDir}:/repo:ro`,
  ];
}

function checkInteractivePaths(spec: InteractiveSpec): void {
  const {
    vsock: { hostPath },
    snapshotDir,
  } = spec;
  const uid = process.getuid?.();
  const socket = lstatSync(hostPath, { throwIfNoEntry: false });
  const parent = lstatSync(dirname(hostPath), { throwIfNoEntry: false });
  const snapshot = lstatSync(snapshotDir, { throwIfNoEntry: false });
  if (
    uid === undefined ||
    !socket?.isSocket() ||
    socket.uid !== uid ||
    (socket.mode & 0o7777) !== 0o600 ||
    !parent?.isDirectory() ||
    (parent.mode & 0o022) !== 0 ||
    !snapshot?.isDirectory() ||
    snapshot.uid !== uid
  )
    invalid();
}

function terminalArgs(command: TerminalCommand): string[] {
  if (
    !Array.isArray(command.argv) ||
    command.argv.length < 1 ||
    command.argv.length > 64 ||
    [...command.argv].some(
      (arg) => typeof arg !== "string" || arg.includes("\0"),
    ) ||
    (command.env !== undefined &&
      (!command.env ||
        typeof command.env !== "object" ||
        Array.isArray(command.env))) ||
    (command.workdir !== undefined &&
      command.workdir !== "/repo" &&
      command.workdir !== "/state")
  )
    invalid();
  const assignments = Object.entries(command.env ?? {}).map(([name, value]) => {
    if (
      !/^[A-Z][A-Z0-9_]{0,63}$/.test(name) ||
      /(?:^|_)(?:TOKEN|KEY|SECRET|PASSWORD|PASSWD|CREDENTIALS?|AUTHORIZATION)(?:_|$)/.test(
        name,
      ) ||
      typeof value !== "string" ||
      value.includes("\0")
    )
      invalid();
    return `${name}=${value}`;
  });
  if (!assignments.length) return [...command.argv];
  // env interprets leading NAME=value arguments as assignments, even after --.
  if (!command.argv[0] || command.argv[0].includes("=")) invalid();
  return ["/usr/bin/env", "--", ...assignments, ...command.argv];
}

function digestNetworkArgs(args: readonly string[]): string {
  // JSON preserves the exact argument boundaries and order.
  return createHash("sha256").update(JSON.stringify(args)).digest("hex");
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
    if (!(config.profiles instanceof ProfileCatalog)) invalid();
    if (config.providers && config.providers.length > 1) invalid();
    this.#config = {
      ...config,
      ...(config.providers
        ? {
            providers: Object.freeze(
              config.providers.map((provider) =>
                Object.freeze({ ...provider }),
              ),
            ),
          }
        : {}),
    };
  }

  #env(extra: Record<string, string> = {}) {
    return {
      ...extra,
      PATH: "/usr/bin:/bin",
      MSB_HOME: this.#config.home,
      MSB_BACKEND: "local",
    };
  }

  #run(
    args: readonly string[],
    timeoutMs: number,
    signal?: AbortSignal,
    extraEnv?: Record<string, string>,
    maxBuffer: number = MICROSANDBOX_LIMITS.outputBytes,
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
          env: this.#env(extraEnv),
          cwd: this.#config.home,
          encoding: "buffer",
          killSignal: "SIGKILL",
          maxBuffer,
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

  async #checked(
    args: readonly string[],
    extraEnv?: Record<string, string>,
  ): Promise<ProcessResult> {
    const result = await this.#run(
      args,
      MICROSANDBOX_LIMITS.backendTimeoutMs,
      undefined,
      extraEnv,
    );
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

  /** The backend does not verify digest-form local tags, so before every
   * create the reported image digest must equal the one in the reference.
   * Run failures keep the backend codes; a wrong answer is invalid-input.
   * Backend output never reaches the error. */
  async #verifyImage(image: string): Promise<void> {
    const result = await this.#checked([
      "image",
      "inspect",
      "--format",
      "json",
      image,
    ]);
    let reported: unknown;
    try {
      const parsed: unknown = JSON.parse(result.stdout.toString("utf8"));
      if (
        typeof parsed === "object" &&
        parsed !== null &&
        !Array.isArray(parsed)
      )
        reported = (parsed as { digest?: unknown }).digest;
    } catch {
      invalid();
    }
    if (reported !== `sha256:${image.slice(-64)}`) invalid();
  }

  #network(spec: SandboxSpec): NetworkConfig {
    const port = spec.hostTcpPort;
    if (port !== undefined) boundedInteger(port, 65_535);
    const requestedProvider = spec.provider;
    if (
      requestedProvider !== undefined &&
      (!requestedProvider || typeof requestedProvider !== "object")
    )
      invalid();
    const provider = requestedProvider ? { ...requestedProvider } : undefined;
    if (
      provider &&
      (port !== undefined ||
        !this.#config.credentials ||
        typeof provider.host !== "string" ||
        !this.#config.providers?.some((allowed) =>
          sameProvider(allowed, provider),
        ) ||
        !/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/.test(
          provider.host,
        ) ||
        typeof provider.secretEnv !== "string" ||
        !isSafeCredentialVariable(provider.secretEnv) ||
        (provider.header !== undefined &&
          provider.header !== "authorization" &&
          provider.header !== "x-api-key") ||
        (provider.port !== undefined &&
          (!Number.isSafeInteger(provider.port) ||
            provider.port < 1 ||
            provider.port > 65_535)) ||
        (provider.upstreamCaCertPath !== undefined &&
          (typeof provider.upstreamCaCertPath !== "string" ||
            !isAbsolute(provider.upstreamCaCertPath) ||
            /[\0:=,\r\n]/.test(provider.upstreamCaCertPath))))
    )
      invalid();
    const binding = spec.egressGateway;
    let gateway: SandboxEgressGateway | undefined;
    const args = ["--no-net"];
    if (binding !== undefined) {
      if (
        port !== undefined ||
        !this.#config.gatewayPassword ||
        binding === null ||
        typeof binding !== "object"
      )
        invalid();
      const { socksPort, dnsPort, username, passwordEnv } = binding;
      boundedInteger(socksPort, 65_535);
      boundedInteger(dnsPort, 65_535);
      if (
        socksPort === dnsPort ||
        typeof username !== "string" ||
        username.length < 1 ||
        username.length > 255 ||
        /[^a-zA-Z0-9._-]/.test(username) ||
        username.startsWith("-") ||
        !isSafeCredentialVariable(passwordEnv) ||
        this.#config.providers?.some(
          (allowed) => allowed.secretEnv === passwordEnv,
        )
      )
        invalid();
      gateway = Object.freeze({ socksPort, dnsPort, username, passwordEnv });
      args.push(
        "--net-rule",
        GATEWAY_NET_RULES,
        "--dns-nameserver",
        `127.0.0.1:${dnsPort}`,
        "--proxy",
        `socks5://127.0.0.1:${socksPort}`,
        "--socks5-username",
        username,
        "--socks5-password-env",
        passwordEnv,
      );
    } else if (port !== undefined) {
      args.push("--net-rule", `allow@host:tcp:${port}`);
    }
    if (provider) args.push(...providerArgs(provider, gateway !== undefined));
    return { args, gateway, provider };
  }

  netRuleDigest(spec: SandboxSpec): string {
    // Preserve the exact digest input for non-interactive sandboxes.
    return digestNetworkArgs([
      ...this.#network(spec).args,
      ...interactiveArgs(spec),
    ]);
  }

  async #createBackend(
    state: State,
    args: readonly string[],
    gateway?: SandboxEgressGateway,
    provider?: SandboxProvider,
    interactive?: InteractiveSpec,
  ): Promise<void> {
    const create = async (env: Record<string, string>) => {
      if (gateway) {
        let password: string | undefined;
        try {
          // Resolve the provider token before the final gateway health check.
          const resolved = this.#config.gatewayPassword?.(gateway);
          password = typeof resolved === "string" ? resolved : await resolved;
        } catch {
          throw new SandboxRuntimeError("backend-failure");
        }
        if (
          typeof password !== "string" ||
          password.length < 1 ||
          password.length > 255 ||
          /[^\x21-\x7e]/.test(password)
        )
          invalid();
        env[gateway.passwordEnv] = password;
      }
      if (interactive) checkInteractivePaths(interactive);
      // A failed CLI create can leave a partially created sandbox.
      state.removed = false;
      return this.#checked(args, env);
    };
    const credentials = this.#config.credentials;
    if (provider && credentials)
      await credentials.withAccessToken((token) =>
        create({ [provider.secretEnv]: token }),
      );
    else await create({});
  }

  async create(
    spec: SandboxSpec,
  ): Promise<SandboxHandle & { readonly netRuleDigest: string }> {
    return this.#create(spec, `bootstrap-${randomUUID()}`, false);
  }

  async createBound(
    spec: SandboxSpec,
    sandboxId: string,
  ): Promise<SandboxHandle & { readonly netRuleDigest: string }> {
    if (
      typeof sandboxId !== "string" ||
      sandboxId.length !== 46 ||
      !SANDBOX_NAME.test(sandboxId)
    )
      invalid();
    return this.#create(spec, sandboxId, true);
  }

  async #checkNameAvailable(sandboxId: string): Promise<void> {
    const result = await this.#checked(["list", "--format", "json"]);
    let sandboxes: unknown;
    try {
      sandboxes = JSON.parse(result.stdout.toString("utf8"));
    } catch {
      throw new SandboxRuntimeError("backend-failure");
    }
    if (!Array.isArray(sandboxes))
      throw new SandboxRuntimeError("backend-failure");
    for (const sandbox of sandboxes) {
      if (!sandbox || typeof sandbox.name !== "string")
        throw new SandboxRuntimeError("backend-failure");
      if (sandbox.name === sandboxId)
        throw new SandboxRuntimeError("name-collision");
    }
  }

  async #create(
    spec: SandboxSpec,
    sandboxId: string,
    bound: boolean,
  ): Promise<SandboxHandle & { readonly netRuleDigest: string }> {
    const invocationId = spec.invocationId;
    if (
      invocationId !== undefined &&
      (typeof invocationId !== "string" ||
        !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(
          invocationId,
        ))
    )
      invalid();
    const profileName: unknown =
      spec.profile === undefined ? "base" : spec.profile;
    if (
      typeof profileName !== "string" ||
      !(PROFILE_NAMES as readonly string[]).includes(profileName) ||
      !this.#config.profiles.has(profileName)
    )
      invalid();
    const profile = this.#config.profiles.get(profileName);
    if (
      spec.imageDigest !== undefined &&
      spec.imageDigest !== this.#config.profiles.imageDigest(profileName)
    )
      invalid();
    const lifetime =
      spec.maxLifetimeMs ?? MICROSANDBOX_LIMITS.defaultLifetimeMs;
    const requestedInteractive = spec.interactive;
    if (requestedInteractive !== undefined && !requestedInteractive?.vsock)
      invalid();
    const interactive = requestedInteractive
      ? { ...requestedInteractive, vsock: { ...requestedInteractive.vsock } }
      : undefined;
    const channels = interactiveArgs(
      interactive ? { ...spec, interactive } : spec,
    );
    boundedInteger(
      lifetime,
      interactive
        ? MICROSANDBOX_LIMITS.interactiveMaxLifetimeMs
        : MICROSANDBOX_LIMITS.maxLifetimeMs,
    );
    const tools = checkTools(spec.tools ?? []);
    const { args: networkArgs, gateway, provider } = this.#network(spec);
    const netRuleDigest = digestNetworkArgs([...networkArgs, ...channels]);
    if (
      (bound || spec.expectedNetRuleDigest !== undefined) &&
      spec.expectedNetRuleDigest !== netRuleDigest
    )
      invalid();
    const repository = spec.repository
      ? { gitDir: spec.repository.gitDir, tree: spec.repository.tree }
      : undefined;
    if (spec.repository !== undefined && (!repository || spec.files?.length))
      invalid();
    if (repository) await checkRepository(repository);
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
    let reservation: string | undefined;
    try {
      if (interactive) checkInteractivePaths(interactive);
      if (bound) {
        // Reserve the name across adapters and processes sharing this home.
        const path = join(
          this.#config.home,
          `.agent-bootstrap-create-${sandboxId}`,
        );
        try {
          await mkdir(path, { mode: 0o700 });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "EEXIST")
            throw new SandboxRuntimeError("name-collision");
          throw error;
        }
        reservation = path;
      }
      const version = await this.#checked(["--version"]);
      if (version.stdout.toString("utf8").trim() !== "msb 0.7.16")
        throw new SandboxRuntimeError("unsupported-version");
      await this.#verifyImage(profile.image);
      if (bound) await this.#checkNameAvailable(sandboxId);
      await mkdir(this.#config.stagingRoot, { recursive: true, mode: 0o700 });
      directory = await mkdtemp(join(this.#config.stagingRoot, "msb-"));
      // Copy each tool into private staging and verify the copy, so the
      // bytes handed to the backend are the bytes that were checked.
      const staged: string[] = [];
      if (tools.length) await mkdir(join(directory, "tools"), { mode: 0o700 });
      for (const [index, tool] of tools.entries()) {
        const info = await lstat(tool.hostPath).catch(() => null);
        if (!info?.isFile()) throw new SandboxRuntimeError("tool-digest");
        if (info.size > MICROSANDBOX_LIMITS.toolBytes) invalid();
        const copy = join(directory, "tools", String(index));
        await copyFile(tool.hostPath, copy);
        if ((await sha256File(copy)) !== tool.sha256)
          throw new SandboxRuntimeError("tool-digest");
        staged.push(copy);
      }
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
      let stagedTree: string | undefined;
      if (repository) {
        // Copy, then re-check the copy, so the bytes handed to the backend
        // are the bytes that were checked.
        await cp(repository.gitDir, join(workspace, ".git"), {
          recursive: true,
          verbatimSymlinks: true,
          errorOnExist: true,
          force: false,
        });
        await plainTreeBytes(join(workspace, ".git"));
        stagedTree = join(directory, "tree.tar");
        await copyFile(repository.tree, stagedTree);
        const info = await lstat(stagedTree);
        if (!info.isFile() || info.size > MICROSANDBOX_LIMITS.treeBytes)
          invalid();
      }
      state = {
        id: sandboxId,
        ...(bound
          ? { cleanupLabel: `agent-bootstrap-create=${randomUUID()}` }
          : {}),
        directory,
        deadline: performance.now() + lifetime,
        interactive: interactive !== undefined,
        busy: false,
        closed: false,
        removed: true,
      };
      const createArgs = [
        "create",
        "--name",
        state.id,
        ...(invocationId
          ? ["--label", `agent-bootstrap-invocation=${invocationId}`]
          : []),
        ...(state.cleanupLabel ? ["--label", state.cleanupLabel] : []),
        "--pull",
        "never",
        ...networkArgs,
        ...channels,
        "--max-duration",
        `${Math.ceil(lifetime / 1000)}s`,
        ...(profile.memoryMiB !== undefined
          ? ["--memory", `${profile.memoryMiB}M`]
          : []),
        ...(profile.cpus !== undefined ? ["--cpus", String(profile.cpus)] : []),
        "--copy-dir",
        `${workspace}:/workspace`,
        ...(readOnly.length ? ["--mount-dir", `${review}:/review:ro`] : []),
        ...tools.flatMap((tool, index) => [
          "--copy-file",
          `${staged[index]}:${tool.guestPath}`,
        ]),
        ...(stagedTree ? ["--copy-file", `${stagedTree}:${TREE_GUEST}`] : []),
        profile.image,
      ];
      await this.#createBackend(
        state,
        createArgs,
        gateway,
        provider,
        interactive,
      );
      if (stagedTree) {
        const extracted = await this.#execute(
          state,
          [
            "/bin/sh",
            "-ec",
            `tar -xf ${TREE_GUEST} -C /workspace && rm -f ${TREE_GUEST} && test -d /workspace/.git`,
          ],
          MICROSANDBOX_LIMITS.treeStepTimeoutMs,
        );
        if (extracted.status !== "exited" || extracted.exitCode !== 0)
          throw new SandboxRuntimeError("backend-failure");
      }
      const handle = Object.freeze({
        id: state.id,
        netRuleDigest,
      });
      this.#states.set(handle, state);
      return handle;
    } catch (error) {
      if (state) return await this.#withCleanup(state, error);
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
    } finally {
      // A stale reservation safely refuses reuse of this ID. Preserve the
      // creation or cleanup outcome if the reservation cannot be removed.
      if (reservation) await rmdir(reservation).catch(() => {});
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

  async attachTerminal(
    handle: SandboxHandle,
    command: TerminalCommand,
  ): Promise<{ exitCode: number | null }> {
    const state = this.#state(handle);
    if (!state.interactive) throw new SandboxRuntimeError("unsupported");
    const argv = terminalArgs(command);
    const remaining = state.deadline - performance.now();
    if (remaining <= 0) throw new SandboxRuntimeError("lifetime-expired");
    const child = spawn(
      this.#config.binary,
      [
        "exec",
        "-t",
        "--workdir",
        command.workdir ?? "/repo",
        state.id,
        "--",
        ...argv,
      ],
      { cwd: this.#config.home, env: this.#env(), stdio: "inherit" },
    );
    const stop = () => {
      child.kill("SIGKILL");
    };
    const timer = setTimeout(stop, Math.ceil(remaining));
    const finished = new Promise<{ exitCode: number | null }>(
      (resolve, reject) => {
        child.once("error", () =>
          reject(new SandboxRuntimeError("backend-failure")),
        );
        child.once("close", (exitCode) => resolve({ exitCode }));
      },
    ).finally(() => {
      clearTimeout(timer);
      delete state.terminal;
      state.busy = false;
    });
    state.busy = true;
    state.terminal = { stop, finished };
    return finished;
  }

  async createVolume(name: string): Promise<void> {
    checkVolumeName(name);
    const result = await this.#run(
      ["volume", "create", name],
      MICROSANDBOX_LIMITS.backendTimeoutMs,
    );
    if (
      result.failure ||
      (result.code !== 0 &&
        !/already exists/i.test(result.stderr.toString("utf8")))
    )
      throw new SandboxRuntimeError(result.failure ?? "backend-failure");
  }

  async removeVolume(name: string): Promise<void> {
    checkVolumeName(name);
    await this.#checked(["volume", "remove", name]);
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
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(
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
    } catch {
      throw new SandboxRuntimeError("backend-failure");
    }
    const stdin = child.stdin!;
    const stdout = child.stdout!;
    state.busy = true;
    let stop: ExecResult["status"] | undefined;
    const kill = (reason: ExecResult["status"]) => {
      stop ??= reason;
      stdin.end();
      if (child.exitCode === null && child.signalCode === null)
        child.kill("SIGKILL");
      // A descendant holding stdout can delay "close" indefinitely.
      if (settledFlag) return;
      forced ??= setTimeout(() => {
        stdout.destroy();
        settle();
      }, MICROSANDBOX_LIMITS.sessionStopMs);
    };
    let forced: ReturnType<typeof setTimeout> | undefined;
    let settledFlag = false;
    let settle: () => void = () => {};
    const cancel = () => kill("cancelled");
    const timer = setTimeout(() => kill("timed-out"), duration);
    command.signal?.addEventListener("abort", cancel, { once: true });
    stdin.on("error", () => {});
    child.stderr?.resume();
    const finished = new Promise<ExecResult["status"]>((resolve) => {
      settle = () => {
        if (settledFlag) return;
        settledFlag = true;
        clearTimeout(timer);
        clearTimeout(forced);
        command.signal?.removeEventListener("abort", cancel);
        state.busy = false;
        resolve(stop ?? "exited");
      };
      child.once("close", settle);
      child.once("error", () => {
        stop ??= "cancelled";
        stdout.destroy();
        settle();
      });
    });
    async function* capped(): AsyncGenerator<Buffer> {
      let total = 0;
      try {
        for await (const chunk of stdout) {
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
        if (stop === undefined && stdin.writable) stdin.write(`${line}\n`);
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
    if ("tree" in spec) {
      if (spec.tree !== true || Object.keys(spec).length !== 1) invalid();
      return this.#collectTree(state);
    }
    if (
      !Array.isArray(spec.paths) ||
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

  async #collectTree(state: State): Promise<CollectedArtifacts> {
    state.busy = true;
    const staging = join(state.directory, "collect.tar");
    try {
      const packed = await this.#execute(
        state,
        [
          "/bin/sh",
          "-ec",
          `cd /workspace && tar -cf ${COLLECT_GUEST} --exclude ./.git --exclude .git .`,
        ],
        MICROSANDBOX_LIMITS.treeStepTimeoutMs,
      );
      if (packed.status !== "exited" || packed.exitCode !== 0)
        throw new SandboxRuntimeError("collection-failed");
      const copied = await this.#run(
        ["copy", `${state.id}:${COLLECT_GUEST}`, staging],
        Math.min(
          MICROSANDBOX_LIMITS.treeStepTimeoutMs,
          Math.max(1, state.deadline - performance.now()),
        ),
      );
      if (copied.failure || copied.code !== 0)
        throw new SandboxRuntimeError(copied.failure ?? "collection-failed");
      // msb copy writes the guest-controlled tar before this size check.
      // Streaming the tar into the parser is future work.
      const info = await lstat(staging).catch(() => null);
      if (!info?.isFile()) throw new SandboxRuntimeError("collection-failed");
      if (info.size > MICROSANDBOX_LIMITS.collectedTreeBytes)
        throw new SandboxRuntimeError("output-limit");
      const tree = new Uint8Array(await readFile(staging));
      await rm(staging, { force: true });
      const message = await this.#collectMessage(state);
      return { files: [], tree, ...(message ? { message } : {}) };
    } catch (error) {
      return this.#withCleanup(state, error);
    } finally {
      state.busy = false;
    }
  }

  async #sample(
    id: string,
    signal?: AbortSignal,
  ): Promise<ResourceSample | null> {
    try {
      const result = await this.#run(
        ["metrics", id, "--format", "json"],
        METRICS_TIMEOUT_MS,
        signal,
        undefined,
        METRICS_OUTPUT_BYTES,
      );
      if (result.failure || result.code !== 0) return null;
      return parseMicrosandboxMetrics(result.stdout);
    } catch {
      return null;
    }
  }

  async sampleResources(handle: SandboxHandle): Promise<ResourceSample | null> {
    const state = this.#states.get(handle);
    if (!state || state.closed) return null;
    if (state.sampling) return state.sampling.result;
    const controller = new AbortController();
    const result = this.#sample(state.id, controller.signal);
    state.sampling = { controller, result };
    try {
      return await result;
    } finally {
      delete state.sampling;
    }
  }

  finalResourceSample(handle: SandboxHandle): ResourceSample | null {
    const state = this.#states.get(handle);
    const sample = state?.finalSample;
    if (state) delete state.finalSample;
    return sample ?? null;
  }

  async #collectMessage(state: State): Promise<Uint8Array | undefined> {
    // Bound the read itself, even if the guest replaces the checked file.
    const result = await this.#execute(
      state,
      [
        "/bin/sh",
        "-ec",
        `p=${WORKER_MESSAGE_PATH};
          [ ! -L "\${p%/*}" ] && [ ! -L "$p" ] && [ -f "$p" ] || exit 3;
          head -c ${WORKER_MESSAGE_LIMIT + 1} -- "$p" | base64`,
      ],
      10_000,
    );
    if (result.status === "exited" && result.exitCode === 3) return;
    if (result.status !== "exited" || result.exitCode !== 0)
      throw new SandboxRuntimeError("collection-failed");
    const encoded = Buffer.from(result.stdout)
      .toString("latin1")
      .replace(/[\r\n]/g, "");
    if (
      encoded.length > 4 * Math.ceil(WORKER_MESSAGE_LIMIT / 3) ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
        encoded,
      )
    )
      return;
    const bytes = Buffer.from(encoded, "base64");
    if (bytes.byteLength <= WORKER_MESSAGE_LIMIT) return bytes;
  }

  #destroy(state: State): Promise<void> {
    if (state.destruction) return state.destruction;
    state.closed = true;
    state.destruction = (async () => {
      let failed = false;
      const terminal = state.terminal;
      if (terminal) {
        terminal.stop();
        await terminal.finished.catch(() => {});
      }
      if (!state.removed) {
        const sampling = state.sampling;
        if (sampling) {
          sampling.controller.abort();
          await sampling.result;
        }
        const sample = await this.#sample(state.id);
        try {
          // A failed bound create may have collided after the list check.
          // Remove only a sandbox carrying this create attempt's label.
          await this.#checked([
            "rm",
            "--force",
            ...(state.cleanupLabel
              ? ["--label", state.cleanupLabel]
              : [state.id]),
          ]);
          state.removed = true;
          if (sample) state.finalSample = sample;
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
    if (state.busy && !state.terminal)
      return Promise.reject(new SandboxRuntimeError("busy"));
    return this.#destroy(state);
  }
}
