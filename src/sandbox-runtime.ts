/** Provider-neutral, host-owned sandbox lifecycle. No credential or integration API. */
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

export interface SandboxSpec {
  readonly files?: readonly SandboxFile[];
  readonly tools?: readonly SandboxTool[];
  /** The only network egress: TCP to this port on the host. Default: none. */
  readonly hostTcpPort?: number;
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
