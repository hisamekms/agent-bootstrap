import { createHash } from "node:crypto";
import type { SqliteAudit } from "./audit.ts";
import type {
  ArtifactRef,
  DelegateRequest,
  IntegrationRequest,
} from "./contracts.ts";

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function artifact(ref: ArtifactRef): readonly [string, string, string] {
  if (
    typeof ref.id !== "string" ||
    typeof ref.mediaType !== "string" ||
    typeof ref.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(ref.sha256)
  )
    throw new Error("Invalid artifact reference");
  return [ref.id, ref.mediaType, ref.sha256];
}

/** Trusted ingress for requests from an already authorized Coordinator session.
 * Claiming a receipt does not start a worker or authorize Git integration. */
export class HostRequests {
  readonly #store: Pick<SqliteAudit, "claimRequest">;

  constructor(store: Pick<SqliteAudit, "claimRequest">) {
    this.#store = store;
  }

  delegate(taskId: string, request: DelegateRequest) {
    if (
      !(["Planner", "Worker", "Reviewer"] as const).includes(request.role) ||
      typeof request.task !== "string"
    )
      throw new Error("Invalid delegation request");
    return this.#claim(taskId, "delegation", request.idempotencyKey, [
      request.role,
      request.task,
      request.inputs.map(artifact),
    ]);
  }

  requestIntegration(taskId: string, request: IntegrationRequest) {
    if (
      typeof request.source.id !== "string" ||
      typeof request.reason !== "string"
    )
      throw new Error("Invalid integration request");
    return this.#claim(taskId, "integration", request.idempotencyKey, [
      request.source.id,
      artifact(request.candidate),
      artifact(request.expectedBase),
      request.evidence.map(artifact),
      request.reason,
    ]);
  }

  #claim(
    taskId: string,
    requestKind: "delegation" | "integration",
    key: string,
    payload: readonly unknown[],
  ) {
    if (typeof key !== "string" || key.length === 0 || key.length > 256)
      throw new Error("Invalid idempotency key");
    return this.#store.claimRequest({
      taskId,
      requestKind,
      keyDigest: digest([taskId, requestKind, key]),
      fingerprint: digest([taskId, requestKind, payload]),
    });
  }
}
