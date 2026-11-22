import { randomUUID } from "node:crypto";
import type { AuditInput, AuditSink } from "./audit.ts";
import type {
  CollectedArtifacts,
  SandboxCommand,
  SandboxHandle,
  SandboxRuntime,
  SandboxSpec,
} from "./sandbox-runtime.ts";

type Operation = NonNullable<AuditInput["operation"]>;
type Outcome = NonNullable<AuditInput["outcome"]>;

export interface WorkerPlan {
  readonly sandbox: SandboxSpec;
  readonly command: SandboxCommand;
  readonly collectPaths: readonly string[];
}

export interface WorkerRun {
  readonly id: string;
  readonly outcome: Outcome;
  readonly artifacts?: CollectedArtifacts;
}

export interface ReviewerPlan {
  readonly sandbox: Pick<SandboxSpec, "readOnlyFiles" | "maxLifetimeMs">;
  readonly command: SandboxCommand;
}

export interface ReviewerRun {
  readonly id: string;
  readonly outcome: Outcome;
  readonly response?: Uint8Array;
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

  constructor(audit: AuditSink, sandbox: SandboxRuntime) {
    this.#audit = audit;
    this.#sandbox = sandbox;
  }

  async runWorker(plan: WorkerPlan, id?: string): Promise<WorkerRun> {
    return this.#run("Worker", plan, id);
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
        (key) => key !== "readOnlyFiles" && key !== "maxLifetimeMs",
      ) ||
      plan.sandbox.readOnlyFiles?.length !== 1 ||
      plan.sandbox.readOnlyFiles[0]?.path !== "control.json"
    )
      throw new Error(
        "Coordinator requires one host-prepared control.json file",
      );
    return this.#readOnly("Coordinator", plan, id);
  }

  #readOnly(
    role: "Reviewer" | "Planner" | "Coordinator",
    plan: ReviewerPlan,
    id?: string,
  ): Promise<ReviewerRun> {
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
    role: "Worker" | "Reviewer" | "Planner" | "Coordinator",
    plan: WorkerPlan,
    id: string = randomUUID(),
  ): Promise<WorkerRun & ReviewerRun> {
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
      await append({ kind: "operation.requested", operation });
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
    try {
      const created = await execute("sandbox.create", () =>
        this.#sandbox.create({ ...plan.sandbox, invocationId: id }),
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
          if (request === "collect" && plan.collectPaths.length > 0) {
            const paths = plan.collectPaths;
            const collected = await execute("sandbox.collect", () =>
              this.#sandbox.collect(current, { paths }),
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
    }
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
