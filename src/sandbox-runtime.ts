/** Provider-neutral, host-owned sandbox lifecycle. No credential or integration API. */
import type { ProfileName } from "./sandbox-profiles.ts";

export interface SandboxFile {
  readonly path: string;
  readonly bytes: Uint8Array;
}

/** A host executable copied into the guest. The adapter verifies the digest
 * on the host before copying; the guest command should verify it again. */
export interface SandboxTool {
  readonly hostPath: string;
  /** Absolute guest path directly under /tmp. */
  readonly guestPath: string;
  readonly sha256: string;
}

/** A guest variable name that may carry a credential placeholder. The host
 * passes the real value to the backend under the same name, and the guest
 * sees the placeholder under it, so the name must be credential-shaped
 * (`*_TOKEN`, `*_KEY` or `*_SECRET`) and must not be read as configuration by
 * the backend, the loader, the TLS stack, proxies, the runtime or the CLI. */
export function isSafeCredentialVariable(name: unknown): name is string {
  if (typeof name !== "string" || !/^[A-Z][A-Z0-9_]{0,63}$/.test(name))
    return false;
  if (!/_(TOKEN|KEY|SECRET)$/.test(name)) return false;
  if (
    /^(MSB_|LD_|DYLD_|SSL_|NODE_|GIT_|BASH_|RUST_|CARGO_|XDG_|LC_|BUN_|OTEL_|MCP_|ENABLE_|DISABLE_|DOCKER_|AWS_|GOOGLE_|AZURE_|CLAUDE_CODE_CLIENT_)/.test(
      name,
    )
  )
    return false;
  return !/_PROXY$/.test(name);
}

export interface SandboxProvider {
  readonly host: string;
  readonly secretEnv: string;
  /** Request header that receives the credential. Default: `authorization`. */
  readonly header?: "authorization" | "x-api-key";
  /** HTTPS port. Default: 443. */
  readonly port?: number;
  /** Extra upstream CA for this host, as an absolute host path. Intended for
   * local verification fixtures that stand in for the provider. */
  readonly upstreamCaCertPath?: string;
}

/** Whether two provider bindings are the same once defaults are filled in. */
export function sameProvider(
  a: SandboxProvider | undefined,
  b: SandboxProvider | undefined,
): boolean {
  if (!a || !b) return a === b;
  const key = (provider: SandboxProvider) =>
    JSON.stringify([
      provider.host,
      provider.secretEnv,
      provider.header ?? "authorization",
      provider.port ?? 443,
      provider.upstreamCaCertPath ?? null,
    ]);
  return key(a) === key(b);
}

/** Host-owned binding to per-sandbox loopback listeners. */
export interface SandboxEgressGateway {
  readonly socksPort: number;
  readonly dnsPort: number;
  readonly username: string;
  readonly passwordEnv: string;
}

export interface InteractiveSpec {
  readonly vsock: { readonly hostPath: string; readonly port: number };
  readonly stateVolume: string;
  readonly snapshotDir: string;
}

export interface TerminalCommand {
  readonly argv: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
  readonly workdir?: "/repo" | "/state";
}

export const INTERACTIVE_MAX_LIFETIME_MS = 12 * 60 * 60 * 1000;

export function isConciergeVolumeName(name: unknown): name is string {
  return typeof name === "string" && /^lo-[a-z0-9][a-z0-9-]{0,62}$/.test(name);
}

export function terminalEnvEntries(
  env: TerminalCommand["env"],
): [string, string][] {
  if (env === undefined) return [];
  if (!env || typeof env !== "object" || Array.isArray(env))
    throw new SandboxRuntimeError("invalid-input");
  const entries = Object.entries(env);
  for (const [name, value] of entries) {
    if (
      (!["TERM", "COLORTERM", "LANG", "LC_ALL", "COLUMNS", "LINES"].includes(
        name,
      ) &&
        !/^LO_[A-Z0-9_]{1,40}$/.test(name)) ||
      typeof value !== "string" ||
      /[\0\r\n]/.test(value) ||
      Buffer.byteLength(value) > 1024
    )
      throw new SandboxRuntimeError("invalid-input");
  }
  return entries;
}

export interface SandboxSpec {
  /** Named VM environment. Default: `base`. */
  readonly profile?: ProfileName;
  /** The 64-hex image digest the trusted host recorded for `profile`. The
   * adapter refuses the spec if its own catalog resolves a different image,
   * so the audit cannot name one image while another boots. */
  readonly imageDigest?: string;
  readonly files?: readonly SandboxFile[];
  /** Host-prepared repository for a Worker: a git directory (full history)
   * and the HEAD tree as a tar. The VM gets `/workspace` = the extracted tree
   * plus `/workspace/.git` = a copy of the git directory. Absolute host
   * paths. Mutually exclusive with `files`. */
  readonly repository?: {
    readonly gitDir: string;
    readonly tree: string;
  };
  readonly tools?: readonly SandboxTool[];
  /** Direct TCP to this host port. Mutually exclusive with the gateway. */
  readonly hostTcpPort?: number;
  readonly egressGateway?: SandboxEgressGateway;
  /** Network and interactive host-channel argv digest recorded before create. */
  readonly expectedNetRuleDigest?: string;
  /** HTTPS egress to one model provider host, with the trusted host's
   * credential substituted for a guest placeholder in the Authorization
   * header. The guest sees only `$<secretEnv>`, set to a placeholder. */
  readonly provider?: SandboxProvider;
  /** Immutable host-provided snapshot, mounted under /review. */
  readonly readOnlyFiles?: readonly SandboxFile[];
  readonly interactive?: InteractiveSpec;
  readonly maxLifetimeMs?: number;
  /** Optional trusted host trace ID for locating a sandbox after restart. */
  readonly invocationId?: string;
}

export interface SandboxHandle {
  readonly id: string;
  readonly netRuleDigest?: string;
}

/** VM-wide point sample. Missing counters are unavailable. */
export interface ResourceSample {
  readonly cpuPercent?: number;
  readonly cpus?: number;
  readonly vcpuTimeNs?: number;
  readonly memoryBytes?: number;
  readonly memoryAvailableBytes?: number;
  readonly memoryLimitBytes?: number;
  readonly memoryHostResidentBytes?: number;
  readonly diskReadBytes?: number;
  readonly diskWriteBytes?: number;
  readonly netRxBytes?: number;
  readonly netTxBytes?: number;
  readonly upperUsedBytes?: number;
  readonly upperFreeBytes?: number;
  readonly upperHostAllocatedBytes?: number;
  readonly uptimeSecs?: number;
}

export interface SandboxCommand {
  readonly argv: readonly string[];
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
}

export interface ExecResult {
  readonly status: "exited" | "timed-out" | "cancelled";
  readonly exitCode: number | null;
  readonly stdout: Uint8Array;
  readonly stderr: Uint8Array;
}

/** Either named small files, or the whole workspace except `.git` as a tar. */
export type CollectSpec =
  { readonly paths: readonly string[] } | { readonly tree: true };

export const WORKER_MESSAGE_PATH = "/tmp/agent-bootstrap/commit-message";
export const WORKER_MESSAGE_LIMIT = 4096;

export interface CollectedArtifacts {
  readonly files: readonly SandboxFile[];
  /** Tar of the workspace without `.git`, for `{ tree: true }`. */
  readonly tree?: Uint8Array;
  /** Untrusted Worker commit message proposal, for `{ tree: true }` only. */
  readonly message?: Uint8Array;
}

/** A long-running guest command with line-delimited stdin and stdout. */
export interface SandboxSession {
  send(line: string): void;
  /** Bounded stdout lines. Ends when the command ends or the session closes. */
  readonly lines: AsyncIterable<string>;
  /** Stop the command. Idempotent. */
  close(): void;
  /** Settles once the command has stopped and the handle can be destroyed. */
  readonly finished: Promise<ExecResult["status"]>;
}

/** Host adapter capability. Callers authorize volume operations through TrustedHost. */
export interface ConciergeVolumeBackend {
  createVolume(name: string): Promise<{ reused: boolean }>;
  removeVolume(name: string): Promise<void>;
}

export interface SandboxRuntime {
  /** Computes the network and interactive host-channel argv digest before the host authorizes create. */
  netRuleDigest?(spec: SandboxSpec): string;
  create(spec: SandboxSpec): Promise<SandboxHandle>;
  /** Creates under the host's audited ID and enforces expectedNetRuleDigest. */
  createBound?(spec: SandboxSpec, sandboxId: string): Promise<SandboxHandle>;
  exec(handle: SandboxHandle, command: SandboxCommand): Promise<ExecResult>;
  /** Optional: adapters without streaming do not support sessions. */
  openSession?(
    handle: SandboxHandle,
    command: SandboxCommand,
  ): Promise<SandboxSession>;
  attachTerminal?(
    handle: SandboxHandle,
    command: TerminalCommand,
  ): Promise<{ exitCode: number | null }>;
  collect(
    handle: SandboxHandle,
    spec: CollectSpec,
  ): Promise<CollectedArtifacts>;
  sampleResources?(handle: SandboxHandle): Promise<ResourceSample | null>;
  /** Consumes the sample captured before successful backend removal. */
  finalResourceSample?(handle: SandboxHandle): ResourceSample | null;
  destroy(handle: SandboxHandle): Promise<void>;
}

/** Fixed diagnostics contain no backend output, guest arguments or host paths. */
export class SandboxRuntimeError extends Error {
  readonly code: string;
  readonly cleanupFailed: boolean;
  readonly sandboxId: string | undefined;

  constructor(code: string, cleanupFailed = false, sandboxId?: string) {
    super(
      `Sandbox operation failed: ${code}${cleanupFailed ? "; cleanup failed" : ""}`,
    );
    this.name = "SandboxRuntimeError";
    this.code = code;
    this.cleanupFailed = cleanupFailed;
    this.sandboxId = sandboxId;
  }
}
