import { createHash, randomUUID } from "node:crypto";
import { types } from "node:util";
import type {
  AuditInput,
  AuditSink,
  DnsQueryInput,
  NetworkFinishedInput,
  NetworkInput,
  ProcessResultInput,
  ResourceEventInput,
  SandboxBindingInput,
} from "./audit.ts";
import type { EgressGatewayOptions } from "./egress-gateway.ts";
import { WORKER_MESSAGE_LIMIT } from "./sandbox-runtime.ts";
import { EgressPolicy, type HostService } from "./egress-policy.ts";
import {
  parseExecutionContext,
  type ExecutionContext,
} from "./execution-context.ts";
import {
  requireAudited,
  type ObservabilityConfig,
} from "./observability-config.ts";
import {
  SequenceSource,
  type ExecutionOutcome,
  type RuntimeEvent,
  type RuntimeEventPayloads,
  type RuntimeEventType,
  type RuntimeObserver,
} from "./runtime-events.ts";
import type {
  CollectedArtifacts,
  ExecResult,
  ResourceSample,
  SandboxCommand,
  SandboxEgressGateway,
  SandboxHandle,
  SandboxRuntime,
  SandboxSession,
  SandboxSpec,
} from "./sandbox-runtime.ts";
import { ProfileCatalog, ROLE_PROFILES } from "./sandbox-profiles.ts";
import type { ProfileName, ProfileRole } from "./sandbox-profiles.ts";

type Operation = NonNullable<AuditInput["operation"]>;
type Outcome = NonNullable<AuditInput["outcome"]>;

const AUDIT_HEALTH_POLL_MS = 25;
// Bump when the gateway policy evaluation or digest schema changes.
const GATEWAY_POLICY_VERSION = 1;

export interface WorkerPlan {
  readonly sandbox: SandboxSpec;
  readonly command: SandboxCommand;
  readonly collectPaths: readonly string[];
  /** Collect the whole workspace (without `.git`) as one tar instead of
   * named paths. Exclusive with a non-empty `collectPaths`. */
  readonly collectTree?: true;
}

export interface WorkerRun {
  readonly id: string;
  readonly outcome: Outcome;
  readonly artifacts?: CollectedArtifacts;
}

export interface ReviewerPlan {
  readonly sandbox: Pick<
    SandboxSpec,
    | "readOnlyFiles"
    | "maxLifetimeMs"
    | "tools"
    | "provider"
    | "hostTcpPort"
    | "profile"
  >;
  readonly command: SandboxCommand;
}

export interface ReviewerRun {
  readonly id: string;
  readonly outcome: Outcome;
  readonly response?: Uint8Array;
}

export interface CoordinatorSessionPlan {
  readonly sandbox: Pick<
    SandboxSpec,
    "tools" | "hostTcpPort" | "provider" | "maxLifetimeMs" | "profile"
  >;
  readonly command: SandboxCommand;
}

export interface VerificationPlan {
  readonly sandbox: Pick<
    SandboxSpec,
    "readOnlyFiles" | "maxLifetimeMs" | "profile" | "repository"
  >;
  readonly command: SandboxCommand;
}

export interface HostObservabilityAudit extends AuditSink {
  readonly isV5Writable: boolean;
  appendExecutionContext(context: ExecutionContext): void | Promise<void>;
  appendSandboxBinding(binding: SandboxBindingInput): void | Promise<void>;
  appendProcessResult(result: ProcessResultInput): void | Promise<void>;
  appendResourceEvent(event: ResourceEventInput): void | Promise<void>;
  appendNetwork(input: NetworkInput): void | Promise<void>;
  appendNetworkFinished(input: NetworkFinishedInput): void | Promise<void>;
  appendDnsQuery(input: DnsQueryInput): void | Promise<void>;
}

/** The adapter must use this ID for the actual backend sandbox and enforce
 * spec.expectedNetRuleDigest before creating it. */
export interface BoundSandboxRuntime extends SandboxRuntime {
  createBound(spec: SandboxSpec, sandboxId: string): Promise<SandboxHandle>;
  netRuleDigest(spec: SandboxSpec): string;
}

export interface HostGateway {
  readonly socksPort: number;
  readonly dnsPort: number;
  readonly username: string;
  readonly password: string;
  readonly quarantined: boolean;
  close(): Promise<void>;
}

export interface HostObserver extends RuntimeObserver {
  /** Terminal sample captured by the runtime before removal. */
  observeFinalResourceSample?(
    executionId: string,
    sandboxId: string,
    sample: ResourceSample,
  ): void;
}

export interface TrustedHostOptions {
  readonly config: Pick<ObservabilityConfig, "audit" | "telemetry">;
  readonly gatewayFactory?: (
    options: EgressGatewayOptions,
  ) => Promise<HostGateway>;
  readonly observers?: readonly HostObserver[];
}

export interface TrustedHostRunOptions {
  readonly allowUnauditedRun?: boolean;
  readonly hostServices?: readonly HostService[];
}

type Role = NonNullable<AuditInput["role"]>;
type Invoke = {
  readonly id: string;
  readonly role: Role;
  readonly sandbox: SandboxSpec;
  readonly command: SandboxCommand;
  readonly context: ExecutionContext | undefined;
  readonly options: TrustedHostRunOptions | undefined;
} & (
  | { readonly plan: Pick<WorkerPlan, "collectPaths" | "collectTree"> }
  | {
      readonly open: NonNullable<SandboxRuntime["openSession"]>;
      readonly use: (session: SandboxSession) => Promise<unknown>;
    }
);

function writableAudit(audit: AuditSink): audit is HostObservabilityAudit {
  const candidate = audit as Partial<HostObservabilityAudit>;
  return (
    candidate.isV5Writable === true &&
    typeof candidate.appendExecutionContext === "function" &&
    typeof candidate.appendSandboxBinding === "function" &&
    typeof candidate.appendProcessResult === "function" &&
    typeof candidate.appendResourceEvent === "function" &&
    typeof candidate.appendNetwork === "function" &&
    typeof candidate.appendNetworkFinished === "function" &&
    typeof candidate.appendDnsQuery === "function"
  );
}

function executionOutcome(outcome: Outcome): ExecutionOutcome {
  switch (outcome) {
    case "ok":
      return "succeeded";
    case "timed-out":
      return "timed_out";
    case "cancelled":
      return "cancelled";
    case "interrupted":
      return "unknown";
    default:
      return "failed";
  }
}

function resourceKind(
  outcome: Outcome,
  code: unknown,
): ResourceEventInput["kind"] | undefined {
  if (code === "lifetime-expired") return "lifetime-expired";
  if (outcome === "timed-out") return "timed-out";
  if (outcome === "cancelled") return "forced-termination";
}

export class HostAuditError extends Error {
  readonly invocationId: string;

  constructor(invocationId: string) {
    super("Host audit unavailable");
    this.name = "HostAuditError";
    this.invocationId = invocationId;
  }
}

/** Executes isolated roles. Only Worker may request bounded collection. */
export class TrustedHost {
  readonly #audit: AuditSink;
  readonly #sandbox: SandboxRuntime;
  readonly #profiles: ProfileCatalog;

  readonly #required:
    | {
        readonly audit: HostObservabilityAudit;
        readonly runtime: BoundSandboxRuntime;
        readonly openGateway: NonNullable<TrustedHostOptions["gatewayFactory"]>;
      }
    | undefined;
  readonly #observers: readonly HostObserver[];
  readonly #disabled: boolean;
  readonly #source = new SequenceSource("trusted-host");
  readonly #gatewayCredentials = new Map<
    string,
    {
      readonly binding: SandboxEgressGateway;
      readonly gateway: HostGateway;
    }
  >();
  #observerFailures = 0;

  /** Omitting options retains the existing mandatory audit for offline callers. */
  constructor(
    audit: AuditSink,
    sandbox: SandboxRuntime,
    profiles: ProfileCatalog,
    options?: TrustedHostOptions,
  ) {
    if (!(profiles instanceof ProfileCatalog))
      throw new Error("Profile catalog required");
    if (options) {
      const mode = options.config.audit.mode;
      if (mode === "required") {
        if (!writableAudit(audit))
          throw new Error("Writable v5 audit required");
        const runtime = sandbox as Partial<BoundSandboxRuntime>;
        if (
          typeof runtime.createBound !== "function" ||
          typeof runtime.netRuleDigest !== "function"
        )
          throw new Error("Runtime with audited gateway support required");
        if (typeof options.gatewayFactory !== "function")
          throw new Error("Egress gateway factory required");
        this.#required = {
          audit,
          runtime: runtime as BoundSandboxRuntime,
          openGateway: options.gatewayFactory,
        };
      } else if (mode !== "disabled") {
        throw new Error("Invalid audit mode");
      }
    }
    this.#disabled = options?.config.audit.mode === "disabled";
    this.#observers = options?.config.telemetry.enabled
      ? [...(options.observers ?? [])]
      : [];
    this.#audit = audit;
    this.#sandbox = sandbox;
    this.#profiles = profiles;
  }

  get observerFailures(): number {
    return this.#observerFailures;
  }

  /** Host-only adapter callback. The password is available during create. */
  gatewayPassword(binding: SandboxEgressGateway): string {
    const credential = this.#gatewayCredentials.get(binding.username);
    if (
      !credential ||
      credential.binding.socksPort !== binding.socksPort ||
      credential.binding.dnsPort !== binding.dnsPort ||
      credential.binding.passwordEnv !== binding.passwordEnv ||
      credential.gateway.quarantined ||
      !this.#required?.audit.isV5Writable
    )
      throw new Error("Gateway credential unavailable");
    return credential.gateway.password;
  }

  #notify(use: (observer: HostObserver) => void): void {
    for (const observer of this.#observers) {
      try {
        const delivery: unknown = use(observer);
        if (delivery !== undefined)
          void Promise.resolve(delivery).catch(() => {
            this.#observerFailures++;
          });
      } catch {
        this.#observerFailures++;
      }
    }
  }

  /** Resolves the requested profile before any audit write. */
  #profileFor(role: ProfileRole, requested: unknown): ProfileName {
    const profile = requested ?? "base";
    if (!this.#profiles.has(profile) || !ROLE_PROFILES[role].includes(profile))
      throw new Error("Sandbox profile not allowed");
    return profile;
  }

  async runWorker(
    plan: WorkerPlan,
    id?: string,
    context?: ExecutionContext,
    options?: TrustedHostRunOptions,
  ): Promise<WorkerRun> {
    return this.#run("Worker", plan, id, context, options);
  }

  /** Read-only verification under its own role. It accepts only files,
   * lifetime, profile and a host-prepared repository (never collected):
   * never a provider, tools or a host port. */
  async runVerification(
    plan: VerificationPlan,
    id?: string,
    context?: ExecutionContext,
    options?: TrustedHostRunOptions,
  ): Promise<ReviewerRun> {
    if (
      Object.keys(plan.sandbox).some(
        (key) =>
          key !== "readOnlyFiles" &&
          key !== "maxLifetimeMs" &&
          key !== "profile" &&
          key !== "repository",
      )
    )
      throw new Error(
        "Verification accepts only files, lifetime, profile and repository",
      );
    return this.#readOnly("Verification", plan, id, context, options);
  }

  async runReviewer(
    plan: ReviewerPlan,
    id?: string,
    context?: ExecutionContext,
    options?: TrustedHostRunOptions,
  ): Promise<ReviewerRun> {
    return this.#readOnly("Reviewer", plan, id, context, options);
  }

  async runPlanner(
    plan: ReviewerPlan,
    id?: string,
    context?: ExecutionContext,
    options?: TrustedHostRunOptions,
  ): Promise<ReviewerRun> {
    return this.#readOnly("Planner", plan, id, context, options);
  }

  /** Only the trusted host supplies control files; no repository or workspace
   * is copied implicitly. Coordinator output is data for host routing. */
  async runCoordinator(
    plan: ReviewerPlan,
    id?: string,
    context?: ExecutionContext,
    options?: TrustedHostRunOptions,
  ): Promise<ReviewerRun> {
    if (
      Object.keys(plan.sandbox).some(
        (key) =>
          key !== "readOnlyFiles" &&
          key !== "maxLifetimeMs" &&
          key !== "tools" &&
          key !== "provider" &&
          key !== "hostTcpPort" &&
          key !== "profile",
      ) ||
      plan.sandbox.readOnlyFiles?.length !== 1 ||
      plan.sandbox.readOnlyFiles[0]?.path !== "control.json"
    )
      throw new Error(
        "Coordinator requires one host-prepared control.json file",
      );
    return this.#readOnly("Coordinator", plan, id, context, options);
  }

  /** A streamed Coordinator turn. The sandbox receives no files; the host
   * passes the prompt over the session and treats all output as data. The
   * create, exec and destroy operations are audited like any invocation.
   * If a mandatory audit write fails after create, the host stops without
   * further effects, including destroy; the backend lifetime then applies. */
  async runCoordinatorSession<T>(
    plan: CoordinatorSessionPlan,
    id: string,
    use: (session: SandboxSession) => Promise<T>,
    context?: ExecutionContext,
    options?: TrustedHostRunOptions,
  ): Promise<{ id: string; outcome: Outcome; value?: T }> {
    const open = this.#sandbox.openSession?.bind(this.#sandbox);
    if (
      !open ||
      "repository" in plan.sandbox ||
      Object.keys(plan.sandbox).some(
        (key) =>
          key !== "tools" &&
          key !== "hostTcpPort" &&
          key !== "provider" &&
          key !== "maxLifetimeMs" &&
          key !== "profile",
      )
    )
      throw new Error("Coordinator session requires a streaming sandbox");
    const sandbox: SandboxSpec = {
      ...(plan.sandbox.tools
        ? { tools: plan.sandbox.tools.map((tool) => ({ ...tool })) }
        : {}),
      ...(plan.sandbox.hostTcpPort !== undefined
        ? { hostTcpPort: plan.sandbox.hostTcpPort }
        : {}),
      ...(plan.sandbox.provider
        ? { provider: { ...plan.sandbox.provider } }
        : {}),
      ...(plan.sandbox.maxLifetimeMs !== undefined
        ? { maxLifetimeMs: plan.sandbox.maxLifetimeMs }
        : {}),
      ...(plan.sandbox.profile !== undefined
        ? { profile: plan.sandbox.profile }
        : {}),
    };
    const { outcome, value } = await this.#invoke({
      id,
      role: "Coordinator",
      sandbox,
      command: plan.command,
      open,
      use,
      context:
        context === undefined ? undefined : parseExecutionContext(context),
      options,
    });
    return outcome === "ok"
      ? { id, outcome, value: value as T }
      : { id, outcome };
  }

  #readOnly(
    role: "Reviewer" | "Planner" | "Coordinator" | "Verification",
    plan: ReviewerPlan | VerificationPlan,
    id?: string,
    context?: ExecutionContext,
    options?: TrustedHostRunOptions,
  ): Promise<ReviewerRun> {
    // Verification never copies egress or tools, even from a non-enumerable
    // property that the key check in runVerification cannot see.
    if ("repository" in plan.sandbox && role !== "Verification")
      throw new Error("Only Worker may use a repository");
    const wide: ReviewerPlan["sandbox"] =
      role === "Verification" ? {} : (plan.sandbox as ReviewerPlan["sandbox"]);
    const repository =
      role === "Verification"
        ? (plan.sandbox as VerificationPlan["sandbox"]).repository
        : undefined;
    const sandbox: ReviewerPlan["sandbox"] & Pick<SandboxSpec, "repository"> = {
      ...(plan.sandbox.readOnlyFiles
        ? {
            readOnlyFiles: plan.sandbox.readOnlyFiles.map((file) => ({
              path: file.path,
              bytes: Buffer.isBuffer(file.bytes)
                ? Buffer.from(file.bytes)
                : new Uint8Array(file.bytes),
            })),
          }
        : {}),
      ...(plan.sandbox.maxLifetimeMs !== undefined
        ? { maxLifetimeMs: plan.sandbox.maxLifetimeMs }
        : {}),
      ...(wide.tools ? { tools: wide.tools.map((tool) => ({ ...tool })) } : {}),
      ...(wide.provider ? { provider: { ...wide.provider } } : {}),
      ...(wide.hostTcpPort !== undefined
        ? { hostTcpPort: wide.hostTcpPort }
        : {}),
      ...(plan.sandbox.profile !== undefined
        ? { profile: plan.sandbox.profile }
        : {}),
      ...(repository !== undefined
        ? { repository: { gitDir: repository.gitDir, tree: repository.tree } }
        : {}),
    };
    return this.#run(
      role,
      {
        sandbox,
        command: { ...plan.command, argv: [...plan.command.argv] },
        collectPaths: [],
      },
      id,
      context,
      options,
    );
  }

  async #run(
    role: "Worker" | "Reviewer" | "Planner" | "Coordinator" | "Verification",
    plan: WorkerPlan,
    id: string | undefined,
    context: ExecutionContext | undefined,
    options: TrustedHostRunOptions | undefined,
  ): Promise<WorkerRun & ReviewerRun> {
    // Only Worker may carry a repository or collect the tree. Refused before
    // any audit write.
    if (
      role !== "Worker" &&
      ((plan.sandbox.repository !== undefined && role !== "Verification") ||
        plan.collectTree !== undefined)
    )
      throw new Error("Only Worker may use a repository");
    if (
      plan.collectTree !== undefined &&
      (plan.collectTree !== true || plan.collectPaths.length > 0)
    )
      throw new Error("collectTree excludes collectPaths");
    const validated =
      context === undefined ? undefined : parseExecutionContext(context);
    const invocationId = id ?? validated?.executionId ?? randomUUID();
    const { outcome, artifacts, response } = await this.#invoke({
      id: invocationId,
      role,
      sandbox: plan.sandbox,
      command: plan.command,
      plan: {
        collectPaths: [...plan.collectPaths],
        ...(plan.collectTree ? { collectTree: plan.collectTree } : {}),
      },
      context: validated,
      options,
    });
    return {
      id: invocationId,
      outcome,
      ...(outcome === "ok" && artifacts ? { artifacts } : {}),
      ...(outcome === "ok" && response ? { response } : {}),
    };
  }

  async #invoke(input: Invoke): Promise<{
    outcome: Outcome;
    artifacts?: CollectedArtifacts;
    response?: Uint8Array;
    value?: unknown;
  }> {
    const { id, role, options } = input;
    const required = this.#required;
    const audit = required?.audit;
    if (this.#disabled)
      requireAudited(input.sandbox, { audit: { mode: "disabled" } }, options);
    const sandbox = { ...input.sandbox };
    if (this.#disabled)
      requireAudited(sandbox, { audit: { mode: "disabled" } }, options);
    if ("egressGateway" in sandbox || "expectedNetRuleDigest" in sandbox)
      throw new Error("Gateway bindings are assigned by the trusted host");
    if (!this.#disabled && "hostTcpPort" in sandbox)
      throw new Error("Direct hostTcpPort requires disabled audit mode");
    if (!required && !this.#disabled && sandbox.provider !== undefined)
      throw new Error("Provider egress requires a configured audit mode");

    const context =
      input.context === undefined
        ? audit || this.#observers.length
          ? parseExecutionContext({ executionId: id })
          : undefined
        : input.context;
    if (context && context.executionId !== id)
      throw new Error("Execution context ID must match invocation ID");

    if (sandbox.provider)
      sandbox.provider = Object.freeze({ ...sandbox.provider });
    const command = { ...input.command, argv: [...input.command.argv] };
    const profile = this.#profileFor(role, sandbox.profile);
    const image = this.#profiles.imageDigest(profile);
    const provider = sandbox.provider;
    const hostServices = options?.hostServices;
    if (hostServices?.length && (!audit || role === "Verification"))
      throw new Error(
        "Host services require an audited gateway and an egress-capable role",
      );
    const providerBinding = provider
      ? { hostname: provider.host, port: provider.port ?? 443 }
      : undefined;
    const policy =
      audit && (providerBinding || hostServices?.length)
        ? new EgressPolicy({
            allow: providerBinding ? [providerBinding] : [],
            ...(providerBinding ? { providerBinding } : {}),
            ...(hostServices ? { hostServices } : {}),
          })
        : undefined;
    const gatewayPolicyDigest = policy
      ? createHash("sha256")
          .update(
            JSON.stringify({
              version: GATEWAY_POLICY_VERSION,
              allow: policy.allow,
              allowIps: policy.allowIps,
              hostServices: policy.hostServices,
              providerBinding: policy.providerBinding ?? null,
            }),
          )
          .digest("hex")
      : undefined;
    const sandboxId = audit ? `bootstrap-${randomUUID()}` : undefined;

    let handle: SandboxHandle | undefined;
    let sandboxDestroyed = false;
    let gateway: HostGateway | undefined;
    let gatewayClosed = false;
    let executionStarted = false;
    let executionFinished = false;
    let auditFailed = false;
    const startedAt = performance.now();
    const traceparent = context?.traceContext?.traceparent.split("-");
    const traceFields = {
      ...(context?.correlationId
        ? { correlationId: context.correlationId }
        : {}),
      ...(traceparent?.[1] ? { traceId: traceparent[1] } : {}),
    };
    const emit = <K extends RuntimeEventType>(
      eventType: K,
      payload: RuntimeEventPayloads[K],
      operationId?: string,
      occurredAt?: string,
    ) => {
      if (!this.#observers.length) return;
      const timestamp = new Date().toISOString();
      const attributedId =
        handle?.id ?? (eventType === "sandbox.created" ? sandboxId : undefined);
      const event = {
        eventId: randomUUID(),
        eventType,
        schemaVersion: 1,
        occurredAt: occurredAt ?? timestamp,
        recordedAt: timestamp,
        source: this.#source.next(),
        executionId: id,
        ...(attributedId ? { sandboxId: attributedId } : {}),
        ...(operationId ? { operationId } : {}),
        ...traceFields,
        payload,
      } as RuntimeEvent;
      this.#notify((observer) => observer.observe(structuredClone(event)));
    };

    const auditUnavailable = () =>
      (gateway !== undefined && gateway.quarantined !== false) ||
      (audit !== undefined && audit.isV5Writable !== true);
    const ensureAudit = () => {
      if (auditUnavailable()) throw new HostAuditError(id);
    };
    const write = async (action: () => void | Promise<void>) => {
      ensureAudit();
      try {
        await action();
      } catch {
        throw new HostAuditError(id);
      }
      ensureAudit();
    };
    const append = (event: Omit<AuditInput, "invocationId" | "role">) =>
      this.#disabled
        ? Promise.resolve()
        : write(() => this.#audit.append({ ...event, invocationId: id, role }));
    const authorize = async (operation: Operation, allowed = true) => {
      await append({
        kind: "operation.requested",
        operation,
        ...(operation === "sandbox.create" ? { profile, image } : {}),
      });
      await append(
        allowed
          ? { kind: "operation.allowed", operation }
          : { kind: "operation.denied", operation, outcome: "denied" },
      );
    };
    const finish = (operation: Operation, outcome: Outcome) =>
      append({ kind: "operation.finished", operation, outcome });
    const closeGateway = async () => {
      if (!gateway || gatewayClosed) return;
      gatewayClosed = true;
      try {
        await gateway.close();
      } catch {
        throw new HostAuditError(id);
      }
      ensureAudit();
    };

    let outcome: Outcome = "failed";
    let artifacts: CollectedArtifacts | undefined;
    let response: Uint8Array | undefined;
    let value: unknown;
    let failure: { error: unknown } | undefined;
    let providerGranted = false;
    try {
      await append({ kind: "invocation.started" });
      if (audit && context)
        await write(() => audit.appendExecutionContext(context));
      executionStarted = true;
      if (context)
        emit("execution.started", {
          role,
          profile,
          runtimeKind: "microsandbox",
          context,
        });

      let binding: SandboxEgressGateway | undefined;
      if (required && policy && sandboxId) {
        ensureAudit();
        try {
          gateway = await required.openGateway({
            executionId: id,
            sandboxLabel: sandboxId,
            policy,
            audit: required.audit,
            ...(this.#observers.length
              ? {
                  observer: {
                    observe: (event: RuntimeEvent) =>
                      this.#notify((observer) =>
                        observer.observe(
                          structuredClone({ ...event, ...traceFields }),
                        ),
                      ),
                  },
                }
              : {}),
          });
          if (!gateway || gateway.quarantined !== false)
            throw new HostAuditError(id);
        } catch (error) {
          if (error instanceof HostAuditError) throw error;
          failure = { error: new Error("Egress gateway unavailable") };
        }
        if (gateway) {
          ensureAudit();
          const suffix = sandboxId
            .slice("bootstrap-".length)
            .replaceAll("-", "")
            .toUpperCase();
          const primaryEnv = `AGENT_GATEWAY_${suffix}_SECRET`;
          const passwordEnv =
            provider?.secretEnv === primaryEnv
              ? `AGENT_SOCKS_${suffix}_SECRET`
              : primaryEnv;
          binding = Object.freeze({
            socksPort: gateway.socksPort,
            dnsPort: gateway.dnsPort,
            username: gateway.username,
            passwordEnv,
          });
        }
      }

      if (!failure) {
        if (provider) {
          await authorize("provider.egress");
          providerGranted = true;
        }
        await authorize("sandbox.create");
        const operationId = randomUUID();
        const createStarted = performance.now();
        const spec = Object.freeze({
          ...sandbox,
          profile,
          imageDigest: image,
          invocationId: id,
          ...(binding ? { egressGateway: binding } : {}),
        });
        try {
          ensureAudit();
          if (required) {
            if (!sandboxId) throw new HostAuditError(id);
            const digest = required.runtime.netRuleDigest(spec);
            if (typeof digest !== "string" || !/^[0-9a-f]{64}$/.test(digest))
              throw new Error("Invalid sandbox network rule digest");
            await write(() =>
              required.audit.appendSandboxBinding({
                invocationId: id,
                sandboxId,
                runtimeKind: "microsandbox",
                netRuleDigest: digest,
                ...(policy && gatewayPolicyDigest
                  ? {
                      egressMode: "gateway",
                      gatewayPolicyId: policy.policyId,
                      gatewayPolicyDigest,
                    }
                  : { egressMode: "none" }),
              }),
            );
            ensureAudit();
            if (binding && gateway) {
              if (this.#gatewayCredentials.has(binding.username))
                throw new Error("Duplicate gateway username");
              this.#gatewayCredentials.set(binding.username, {
                binding,
                gateway,
              });
            }
            try {
              handle = await required.runtime.createBound(
                Object.freeze({ ...spec, expectedNetRuleDigest: digest }),
                sandboxId,
              );
            } finally {
              if (binding) this.#gatewayCredentials.delete(binding.username);
            }
            if (handle.id !== sandboxId || handle.netRuleDigest !== digest)
              throw new HostAuditError(id);
          } else {
            handle = await this.#sandbox.create(spec);
          }
        } catch (error) {
          if (error instanceof HostAuditError) throw error;
          failure = { error };
        }
        await finish("sandbox.create", handle ? "ok" : "failed");
        emit(
          "sandbox.created",
          {
            outcome: handle ? "succeeded" : "failed",
            durationMs: performance.now() - createStarted,
            profile,
            runtimeKind: "microsandbox",
          },
          operationId,
        );
      }

      if (handle) {
        const current = handle;
        await authorize("sandbox.exec");
        const operationId = randomUUID();
        const processStarted = performance.now();
        const dispatchedAt = new Date().toISOString();
        ensureAudit();
        // The gateway and shared audit expose health through getters.
        const auditAbort =
          audit && !("open" in input) ? new AbortController() : undefined;
        if (auditAbort) {
          command.signal = command.signal
            ? AbortSignal.any([command.signal, auditAbort.signal])
            : auditAbort.signal;
        }
        const monitor =
          auditAbort &&
          setInterval(() => {
            if (auditUnavailable()) auditAbort.abort();
          }, AUDIT_HEALTH_POLL_MS);
        const process = await this.#runProcess(
          input,
          current,
          command,
          ensureAudit,
          () => emit("process.started", { outcome: "started" }, operationId),
        ).finally(() => clearInterval(monitor));
        ensureAudit();
        const durationMs = performance.now() - processStarted;
        const { result, exit, kind } = process;
        outcome = process.outcome;
        failure = process.failure;
        value = process.value;
        if (!process.sessionOpened)
          emit(
            "process.started",
            { outcome: result ? "started" : "failed" },
            operationId,
            dispatchedAt,
          );
        if (audit)
          await write(() =>
            audit.appendProcessResult({
              invocationId: id,
              operation: "sandbox.exec",
              signal: null,
              ...exit,
            }),
          );
        if (kind && audit)
          await write(() =>
            audit.appendResourceEvent({
              invocationId: id,
              sandboxId: current.id,
              kind,
            }),
          );
        await finish("sandbox.exec", outcome);
        emit(
          "process.exited",
          {
            outcome: executionOutcome(outcome),
            signal: null,
            ...exit,
            durationMs,
          },
          operationId,
        );
        if (kind) emit("resource.limit_exceeded", { kind }, operationId);

        if (outcome === "ok" && result && "plan" in input) {
          const request =
            role === "Worker" ? guestRequest(result.stdout) : "none";
          if (role !== "Worker") response = result.stdout;
          if (
            request === "collect" &&
            (input.plan.collectPaths.length > 0 || input.plan.collectTree)
          ) {
            const spec = input.plan.collectTree
              ? { tree: true as const }
              : { paths: input.plan.collectPaths };
            await authorize("sandbox.collect");
            ensureAudit();
            try {
              const collected = await this.#sandbox.collect(current, spec);
              const { files, tree, message } = collected;
              artifacts = {
                files,
                ...(tree ? { tree } : {}),
                // Only a Worker tree collect may carry a proposed message.
                ...(role === "Worker" &&
                input.plan.collectTree &&
                message &&
                message.byteLength <= WORKER_MESSAGE_LIMIT
                  ? { message }
                  : {}),
              };
            } catch (error) {
              if (error instanceof HostAuditError) throw error;
              outcome = "failed";
            }
            await finish("sandbox.collect", outcome);
          } else if (request !== "none") {
            await authorize(
              request === "collect" ? "sandbox.collect" : "unknown",
              false,
            );
            outcome = "denied";
          }
        }
      }

      // Stop egress and drain its audit writes before authorizing VM removal.
      await closeGateway();
      let destroyed: Outcome = "ok";
      if (handle) {
        await authorize("sandbox.destroy");
        const operationId = randomUUID();
        const destroyStarted = performance.now();
        ensureAudit();
        try {
          // The runtime captures its terminal sample before backend removal.
          await this.#sandbox.destroy(handle);
          sandboxDestroyed = true;
        } catch (error) {
          if (error instanceof HostAuditError) throw error;
          destroyed = "failed";
          if ("plan" in input || outcome === "ok") outcome = "failed";
        }
        await finish("sandbox.destroy", destroyed);
        if (this.#observers.length) {
          const current = handle;
          let sample: ResourceSample | null | undefined;
          try {
            const final = this.#sandbox.finalResourceSample?.(current);
            if (final) sample = Object.freeze({ ...final });
          } catch {
            // A sampling failure never changes the invocation outcome.
          }
          if (sample) {
            const finalSample = sample;
            this.#notify((observer) =>
              observer.observeFinalResourceSample?.(
                id,
                current.id,
                finalSample,
              ),
            );
          }
        }
        emit(
          "sandbox.destroyed",
          {
            outcome: destroyed === "ok" ? "succeeded" : "failed",
            durationMs: performance.now() - destroyStarted,
          },
          operationId,
        );
      }
      if (providerGranted) await finish("provider.egress", destroyed);
      await append({ kind: "invocation.finished", outcome });
      executionFinished = true;
      emit("execution.finished", {
        outcome: executionOutcome(outcome),
        durationMs: performance.now() - startedAt,
      });
      if ("open" in input && failure) throw failure.error;
      return {
        outcome,
        ...(artifacts ? { artifacts } : {}),
        ...(response ? { response } : {}),
        ...(value !== undefined ? { value } : {}),
      };
    } catch (error) {
      if (error instanceof HostAuditError) {
        auditFailed = true;
        const closing = closeGateway().catch(() => {});
        if (handle && !sandboxDestroyed) {
          try {
            await this.#sandbox.destroy(handle);
          } catch {
            // The adapter's sandbox lifetime bounds failed emergency cleanup.
          }
        }
        await closing;
      }
      throw error;
    } finally {
      if ((executionStarted || auditFailed) && !executionFinished)
        emit("execution.finished", {
          outcome: "unknown",
          durationMs: performance.now() - startedAt,
        });
      await closeGateway();
    }
  }
  async #runProcess(
    input: Invoke,
    handle: SandboxHandle,
    command: SandboxCommand,
    ensureAudit: () => void,
    sessionStarted: () => void,
  ) {
    let result: ExecResult | undefined;
    let value: unknown;
    let failure: { error: unknown } | undefined;
    let sessionOpened = false;
    let outcome: Outcome = "failed";
    let code: unknown;
    try {
      if ("open" in input) {
        const session = await input.open(handle, command);
        sessionOpened = true;
        try {
          sessionStarted();
          ensureAudit();
          value = await input.use({
            send(line) {
              ensureAudit();
              session.send(line);
            },
            lines: session.lines,
            close: () => session.close(),
            finished: session.finished,
          });
          outcome = "ok";
        } catch (error) {
          failure = { error };
        } finally {
          session.close();
        }
        const stopped = await session.finished;
        if (stopped === "timed-out") outcome = "timed-out";
        // A successful callback normally closes its own session.
        if (stopped === "cancelled" && command.signal?.aborted)
          outcome = "cancelled";
        if (failure) throw failure.error;
      } else {
        result = await this.#sandbox.exec(handle, command);
        outcome =
          result.status === "exited"
            ? result.exitCode === 0
              ? "ok"
              : "failed"
            : result.status;
      }
    } catch (error) {
      if (error instanceof HostAuditError) throw error;
      failure ??= { error };
      if (typeof error === "object" && error !== null && !types.isProxy(error))
        code = Object.getOwnPropertyDescriptor(error, "code")?.value;
      if (code === "timed-out" || code === "lifetime-expired")
        outcome = "timed-out";
      else if (code === "cancelled") outcome = "cancelled";
      else if (outcome === "ok") outcome = "failed";
    }
    const exit =
      result?.status === "exited"
        ? { exitCode: result.exitCode, guestReported: true as const }
        : { exitCode: null, guestReported: false as const };
    return {
      result,
      value,
      outcome,
      failure,
      sessionOpened,
      exit,
      kind: resourceKind(outcome, code),
    };
  }
}

function guestRequest(bytes: Uint8Array): "none" | "collect" | "unknown" {
  if (bytes.length === 0) return "none";
  if (bytes.length > 128) return "unknown";
  try {
    const request = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    );
    if (
      request &&
      !Array.isArray(request) &&
      Object.keys(request).length === 1 &&
      request.tool === "collect"
    ) {
      return "collect";
    }
  } catch {
    return "unknown";
  }
  return "unknown";
}
