import { randomUUID } from "node:crypto";
import type { AuditInput, AuditSink } from "./audit.ts";
import type {
  CollectedArtifacts,
  SandboxCommand,
  SandboxHandle,
  SandboxRuntime,
  SandboxSession,
  SandboxSpec,
} from "./sandbox-runtime.ts";
import { ProfileCatalog, ROLE_PROFILES } from "./sandbox-profiles.ts";
import type { ProfileName, ProfileRole } from "./sandbox-profiles.ts";

type Operation = NonNullable<AuditInput["operation"]>;
type Outcome = NonNullable<AuditInput["outcome"]>;

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
    "readOnlyFiles" | "maxLifetimeMs" | "profile"
  >;
  readonly command: SandboxCommand;
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

  constructor(
    audit: AuditSink,
    sandbox: SandboxRuntime,
    profiles: ProfileCatalog,
  ) {
    if (!(profiles instanceof ProfileCatalog))
      throw new Error("Profile catalog required");
    this.#audit = audit;
    this.#sandbox = sandbox;
    this.#profiles = profiles;
  }

  /** Resolves the requested profile before any audit write. */
  #profileFor(role: ProfileRole, requested: unknown): ProfileName {
    const profile = requested ?? "base";
    if (!this.#profiles.has(profile) || !ROLE_PROFILES[role].includes(profile))
      throw new Error("Sandbox profile not allowed");
    return profile;
  }

  async runWorker(plan: WorkerPlan, id?: string): Promise<WorkerRun> {
    return this.#run("Worker", plan, id);
  }

  /** Read-only verification under its own role. It accepts only files,
   * lifetime and profile: never a provider, tools or a host port. */
  async runVerification(
    plan: VerificationPlan,
    id?: string,
  ): Promise<ReviewerRun> {
    if (
      Object.keys(plan.sandbox).some(
        (key) =>
          key !== "readOnlyFiles" &&
          key !== "maxLifetimeMs" &&
          key !== "profile",
      )
    )
      throw new Error("Verification accepts only files, lifetime and profile");
    return this.#readOnly("Verification", plan, id);
  }

  async runReviewer(plan: ReviewerPlan, id?: string): Promise<ReviewerRun> {
    return this.#readOnly("Reviewer", plan, id);
  }

  async runPlanner(plan: ReviewerPlan, id?: string): Promise<ReviewerRun> {
    return this.#readOnly("Planner", plan, id);
  }

  /** Only the trusted host supplies control files; no repository or workspace
   * is copied implicitly. Coordinator output is data for host routing. */
  async runCoordinator(plan: ReviewerPlan, id?: string): Promise<ReviewerRun> {
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
    return this.#readOnly("Coordinator", plan, id);
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
    const profile = this.#profileFor("Coordinator", plan.sandbox.profile);
    const image = this.#profiles.imageDigest(profile);
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
    };
    const command = { ...plan.command, argv: [...plan.command.argv] };
    const append = async (event: Omit<AuditInput, "invocationId" | "role">) => {
      try {
        await this.#audit.append({
          ...event,
          invocationId: id,
          role: "Coordinator",
        });
      } catch {
        throw new HostAuditError(id);
      }
    };
    const allow = async (operation: Operation) => {
      await append({ kind: "operation.requested", operation });
      await append({ kind: "operation.allowed", operation });
    };
    await append({ kind: "invocation.started" });
    let outcome: Outcome = "failed";
    let handle: SandboxHandle | undefined;
    let failure: { error: unknown } | undefined;
    let value: T | undefined;
    const egress = sandbox.provider !== undefined;
    let destroyedOk = false;
    try {
      if (egress) await allow("provider.egress");
      await append({
        kind: "operation.requested",
        operation: "sandbox.create",
        profile,
        image,
      });
      await append({ kind: "operation.allowed", operation: "sandbox.create" });
      try {
        handle = await this.#sandbox.create({
          ...sandbox,
          profile,
          imageDigest: image,
          invocationId: id,
        });
      } catch (error) {
        await append({
          kind: "operation.finished",
          operation: "sandbox.create",
          outcome: "failed",
        });
        throw error;
      }
      await append({
        kind: "operation.finished",
        operation: "sandbox.create",
        outcome: "ok",
      });
      await allow("sandbox.exec");
      let session: SandboxSession | undefined;
      let status: Outcome = "failed";
      try {
        session = await open(handle, command);
        value = await use(session);
        status = "ok";
      } catch (error) {
        failure = { error };
      } finally {
        session?.close();
      }
      const stopped = session ? await session.finished : undefined;
      const code = (failure?.error as { code?: unknown } | undefined)?.code;
      if (status !== "ok" && (stopped === "timed-out" || code === "timed-out"))
        status = "timed-out";
      await append({
        kind: "operation.finished",
        operation: "sandbox.exec",
        outcome: status,
      });
      outcome = status;
    } catch (error) {
      if (error instanceof HostAuditError) throw error;
      failure ??= { error };
      outcome = "failed";
    }
    if (handle) {
      const current = handle;
      await allow("sandbox.destroy");
      let destroyed: Outcome = "ok";
      destroyedOk = true;
      try {
        await this.#sandbox.destroy(current);
      } catch {
        destroyed = "failed";
        destroyedOk = false;
        if (outcome === "ok") outcome = "failed";
      }
      await append({
        kind: "operation.finished",
        operation: "sandbox.destroy",
        outcome: destroyed,
      });
    }
    // The grant is closed `ok` exactly when no sandbox holds it any more:
    // none was created, or it was destroyed. The turn result is in exec.
    if (egress)
      await append({
        kind: "operation.finished",
        operation: "provider.egress",
        outcome: !handle || destroyedOk ? "ok" : "failed",
      });
    await append({ kind: "invocation.finished", outcome });
    if (failure) throw failure.error;
    return outcome === "ok"
      ? { id, outcome, value: value as T }
      : { id, outcome };
  }

  #readOnly(
    role: "Reviewer" | "Planner" | "Coordinator" | "Verification",
    plan: ReviewerPlan | VerificationPlan,
    id?: string,
  ): Promise<ReviewerRun> {
    // Verification never copies egress or tools, even from a non-enumerable
    // property that the key check in runVerification cannot see.
    if ("repository" in plan.sandbox)
      throw new Error("Only Worker may use a repository");
    const wide: ReviewerPlan["sandbox"] =
      role === "Verification" ? {} : (plan.sandbox as ReviewerPlan["sandbox"]);
    const sandbox: ReviewerPlan["sandbox"] = {
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
    };
    return this.#run(
      role,
      {
        sandbox,
        command: { ...plan.command, argv: [...plan.command.argv] },
        collectPaths: [],
      },
      id,
    );
  }

  async #run(
    role: "Worker" | "Reviewer" | "Planner" | "Coordinator" | "Verification",
    plan: WorkerPlan,
    id: string = randomUUID(),
  ): Promise<WorkerRun & ReviewerRun> {
    // Only Worker may carry a repository or collect the tree. Refused before
    // any audit write.
    if (
      role !== "Worker" &&
      (plan.sandbox.repository !== undefined || plan.collectTree !== undefined)
    )
      throw new Error("Only Worker may use a repository");
    if (
      plan.collectTree !== undefined &&
      (plan.collectTree !== true || plan.collectPaths.length > 0)
    )
      throw new Error("collectTree excludes collectPaths");
    const profile = this.#profileFor(role, plan.sandbox.profile);
    const image = this.#profiles.imageDigest(profile);
    const append = async (event: Omit<AuditInput, "invocationId" | "role">) => {
      try {
        await this.#audit.append({
          ...event,
          invocationId: id,
          role,
        });
      } catch {
        throw new HostAuditError(id);
      }
    };
    const authorize = async (operation: Operation, allowed: boolean) => {
      await append({
        kind: "operation.requested",
        operation,
        ...(operation === "sandbox.create" ? { profile, image } : {}),
      });
      if (allowed) await append({ kind: "operation.allowed", operation });
      else
        await append({
          kind: "operation.denied",
          operation,
          outcome: "denied",
        });
    };
    const execute = async <T>(
      operation: Operation,
      action: () => Promise<T>,
      outcome: (value: T) => Outcome = () => "ok",
    ): Promise<{ value: T } | null> => {
      // Authorization covers the adapter operation and its bounded internal
      // cleanup on failure. Explicit destroy requires its own authorization.
      await authorize(operation, true);
      let value: T;
      try {
        value = await action();
      } catch {
        await append({
          kind: "operation.finished",
          operation,
          outcome: "failed",
        });
        return null;
      }
      await append({
        kind: "operation.finished",
        operation,
        outcome: outcome(value),
      });
      return { value };
    };
    await append({ kind: "invocation.started" });
    let handle: SandboxHandle | undefined;
    let outcome: Outcome = "failed";
    let artifacts: CollectedArtifacts | undefined;
    let response: Uint8Array | undefined;
    // Credentialed provider egress is its own audited grant, recorded before
    // the sandbox that receives it exists and closed after teardown.
    const egress = plan.sandbox.provider !== undefined;
    if (egress) await authorize("provider.egress", true);
    try {
      const created = await execute("sandbox.create", () =>
        this.#sandbox.create({
          ...plan.sandbox,
          profile,
          imageDigest: image,
          invocationId: id,
        }),
      );
      if (created) {
        handle = created.value;
        const current = handle;
        const executed = await execute(
          "sandbox.exec",
          () => this.#sandbox.exec(current, plan.command),
          (result) =>
            result.status === "exited"
              ? result.exitCode === 0
                ? "ok"
                : "failed"
              : result.status,
        );
        if (
          executed?.value.status === "exited" &&
          executed.value.exitCode === 0
        ) {
          const request =
            role === "Worker" ? guestRequest(executed.value.stdout) : "none";
          outcome = "ok";
          if (role !== "Worker") response = executed.value.stdout;
          if (
            request === "collect" &&
            (plan.collectPaths.length > 0 || plan.collectTree)
          ) {
            const paths = plan.collectPaths;
            const spec = plan.collectTree ? { tree: true as const } : { paths };
            const collected = await execute("sandbox.collect", () =>
              this.#sandbox.collect(current, spec),
            );
            if (collected) artifacts = collected.value;
            else outcome = "failed";
          } else if (request !== "none") {
            await authorize(
              request === "collect" ? "sandbox.collect" : "unknown",
              false,
            );
            outcome = "denied";
          }
        } else if (executed && executed.value.status !== "exited") {
          outcome = executed.value.status;
        }
      }
    } catch (error) {
      // A failed mandatory write halts the invocation. The sandbox adapter's
      // bounded lifetime applies if explicit teardown could not be authorized.
      if (error instanceof HostAuditError) throw error;
      outcome = "failed";
    }
    if (handle) {
      const current = handle;
      const destroyed = await execute("sandbox.destroy", () =>
        this.#sandbox.destroy(current),
      );
      if (!destroyed) outcome = "failed";
      if (egress)
        await append({
          kind: "operation.finished",
          operation: "provider.egress",
          outcome: destroyed ? "ok" : "failed",
        });
    } else if (egress)
      // No sandbox was created, so the grant ended unused.
      await append({
        kind: "operation.finished",
        operation: "provider.egress",
        outcome: "ok",
      });
    await append({ kind: "invocation.finished", outcome });
    return {
      id,
      outcome,
      ...(outcome === "ok" && artifacts ? { artifacts } : {}),
      ...(outcome === "ok" && response ? { response } : {}),
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
