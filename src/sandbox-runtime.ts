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

export interface SandboxSpec {
  /** Named VM environment. Default: `base`. */
  readonly profile?: ProfileName;
  /** The 64-hex image digest the trusted host recorded for `profile`. The
   * adapter refuses the spec if its own catalog resolves a different image,
   * so the audit cannot name one image while another boots. */
  readonly imageDigest?: string;
  readonly files?: readonly SandboxFile[];
  readonly tools?: readonly SandboxTool[];
  /** The only network egress: TCP to this port on the host. Default: none. */
  readonly hostTcpPort?: number;
  /** HTTPS egress to one model provider host, with the trusted host's
   * credential substituted for a guest placeholder in the Authorization
   * header. The guest sees only `$<secretEnv>`, set to a placeholder. */
  readonly provider?: SandboxProvider;
  /** Immutable host-provided snapshot, mounted under /review. */
  readonly readOnlyFiles?: readonly SandboxFile[];
  readonly maxLifetimeMs?: number;
  /** Optional trusted host trace ID for locating a sandbox after restart. */
  readonly invocationId?: string;
}

export interface SandboxHandle {
  readonly id: string;
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

export interface CollectSpec {
  readonly paths: readonly string[];
}

export interface CollectedArtifacts {
  readonly files: readonly SandboxFile[];
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

export interface SandboxRuntime {
  create(spec: SandboxSpec): Promise<SandboxHandle>;
  exec(handle: SandboxHandle, command: SandboxCommand): Promise<ExecResult>;
  /** Optional: adapters without streaming do not support sessions. */
  openSession?(
    handle: SandboxHandle,
    command: SandboxCommand,
  ): Promise<SandboxSession>;
  collect(
    handle: SandboxHandle,
    spec: CollectSpec,
  ): Promise<CollectedArtifacts>;
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
