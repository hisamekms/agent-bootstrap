/** M0 contracts only. A host must implement isolation, authorization and auditing. */
export type Role = "Coordinator" | "Planner" | "Worker" | "Reviewer";
export type DelegateRole = Exclude<Role, "Coordinator">;

/** Opaque host-managed artifact identity, not an instruction or an executable path. */
export interface ArtifactRef {
  readonly id: string;
  readonly mediaType: string;
  /** SHA-256 of immutable bytes, encoded as 64 lowercase hexadecimal characters. */
  readonly sha256: string;
}

export const ROLE_CONTRACTS = {
  Coordinator: {
    isolation: "per-invocation",
    repository: "none",
    scratch: "none",
    hostTools: [
      "delegate",
      "getInvocation",
      "getStatus",
      "askHuman",
      "requestIntegration",
    ],
    delegateTargets: ["Planner", "Worker", "Reviewer"],
    push: "denied",
    integration: "submit-for-human-approval",
  },
  Planner: {
    isolation: "per-invocation",
    repository: "read-only",
    scratch: "read-write",
    hostTools: [],
    delegateTargets: [],
    push: "denied",
  },
  Worker: {
    isolation: "per-invocation",
    repository: "read-write-isolated",
    scratch: "read-write",
    hostTools: [],
    delegateTargets: [],
    push: "denied",
  },
  Reviewer: {
    isolation: "per-invocation",
    repository: "read-only",
    scratch: "read-write",
    hostTools: [],
    delegateTargets: [],
    push: "denied",
  },
} as const satisfies Record<Role, object>;

export interface InvocationRef {
  readonly id: string;
}

export type InvocationStatus =
  | "queued"
  | "running"
  | "waiting-for-human"
  | "completed"
  | "failed"
  | "cancelled";

export interface DelegateRequest {
  /** Task-scoped key: replay the same request; reject reuse with different contents. */
  readonly idempotencyKey: string;
  readonly role: DelegateRole;
  readonly task: string;
  readonly inputs: readonly ArtifactRef[];
}

export interface AgentResult {
  readonly summary: string;
  readonly artifacts: readonly ArtifactRef[];
  readonly evidence: readonly ArtifactRef[];
}

export interface InvocationRecord {
  readonly invocation: InvocationRef;
  readonly request: DelegateRequest;
  readonly status: InvocationStatus;
  readonly result?: AgentResult;
  readonly failure?: string;
}

/** Evidence is referenced, rather than embedding repository contents in approval prompts. */
export interface HumanQuestion {
  readonly question: string;
  readonly evidence: readonly ArtifactRef[];
}

export interface HumanRequestReceipt {
  readonly requestId: string;
}

export type HumanRequestStatus =
  | { readonly requestId: string; readonly status: "pending" }
  | {
      readonly requestId: string;
      readonly status: "answered";
      readonly answer: string;
      readonly evidence: readonly ArtifactRef[];
    };

export interface IntegrationRequest {
  /** Task-scoped key with the same replay/conflict semantics as delegation. */
  readonly idempotencyKey: string;
  readonly source: InvocationRef;
  /** Immutable candidate and base snapshot; approval must bind both identities. */
  readonly candidate: ArtifactRef;
  readonly expectedBase: ArtifactRef;
  readonly evidence: readonly ArtifactRef[];
  readonly reason: string;
}

/** Submission receipt only. Human approval and integration execution belong to the host. */
export type IntegrationReceipt =
  | { readonly status: "pending-human-approval"; readonly requestId: string }
  | {
      readonly status: "denied";
      readonly requestId: string;
      readonly reason: string;
    };

export interface TaskStatus {
  readonly invocations: readonly {
    readonly invocation: InvocationRef;
    readonly role: DelegateRole;
    readonly status: InvocationStatus;
  }[];
  readonly humanRequests: readonly HumanRequestStatus[];
  readonly integrations: readonly IntegrationReceipt[];
}

/** Trusted host boundary, available only to the Coordinator. No fixed role sequence. */
export interface CoordinatorHostPort {
  delegate(request: DelegateRequest): Promise<InvocationRef>;
  getInvocation(invocation: InvocationRef): Promise<InvocationRecord>;
  getStatus(): Promise<TaskStatus>;
  /** Resolves on submission, without blocking until a human answers. */
  askHuman(question: HumanQuestion): Promise<HumanRequestReceipt>;
  requestIntegration(request: IntegrationRequest): Promise<IntegrationReceipt>;
}

/** Paths are workspace-relative; validating and containing them is a host obligation. */
export interface ReadOnlySandboxPort {
  /** Only explicitly granted inputs or this invocation's published artifacts may be read.
   * The host must check the grant and verify the digest before returning bytes. */
  readArtifact(artifact: ArtifactRef): Promise<Uint8Array>;
  readRepository(path: string): Promise<string>;
  readScratch(path: string): Promise<string>;
  writeScratch(path: string, content: string): Promise<void>;
  publishArtifact(path: string, mediaType: string): Promise<ArtifactRef>;
}

/** Writes affect only this invocation's workspace. There is deliberately no push port. */
export interface WorkerSandboxPort extends ReadOnlySandboxPort {
  writeWorkspace(path: string, content: string): Promise<void>;
}

export interface SandboxPortsByRole {
  Coordinator: CoordinatorHostPort;
  Planner: ReadOnlySandboxPort;
  Worker: WorkerSandboxPort;
  Reviewer: ReadOnlySandboxPort;
}

export interface AgentInput {
  readonly invocation: InvocationRef;
  readonly task: string;
  readonly inputs: readonly ArtifactRef[];
}

export interface SandboxAgent<R extends Role> {
  readonly role: R;
  run(input: AgentInput, sandbox: SandboxPortsByRole[R]): Promise<AgentResult>;
}
