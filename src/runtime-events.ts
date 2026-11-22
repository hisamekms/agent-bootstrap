import { randomUUID } from "node:crypto";
import type { ExecutionContext } from "./execution-context.ts";
import type { ProfileName, ProfileRole } from "./sandbox-profiles.ts";

export type ExecutionOutcome =
  "succeeded" | "failed" | "cancelled" | "timed_out" | "unknown";

export interface RuntimeEventSource {
  readonly component: string;
  readonly instanceId: string;
  readonly sequence: number;
}

type ExecutionMetadata = {
  readonly role: ProfileRole;
  readonly profile: ProfileName;
  readonly agentKind?: "codex" | "claude";
  readonly runtimeKind: string;
};

type EffectOutcome = { readonly outcome: "succeeded" | "failed" };
type Duration = { readonly durationMs: number };
type Policy = { readonly policyId: string };

type Connection = {
  readonly connectionId: string;
  readonly protocol: "tcp";
};

type ConnectionTarget = Connection & {
  readonly destinationIp: string;
  readonly destinationPort: number;
  readonly hostname?: string;
  readonly channel: "direct" | "provider-egress" | "host-service";
};

// The gateway can refuse a handshake before a valid destination is available.
type UnaddressedConnection = Connection & {
  readonly destinationIp?: never;
  readonly destinationPort?: never;
  readonly hostname?: never;
  readonly channel?: never;
};

type AddressedDecision = ConnectionTarget &
  (
    | {
        readonly decision: "allow";
        readonly reasonCode:
          "allowlisted-host" | "allowlisted-ip" | "host-service";
      }
    | {
        readonly decision: "deny";
        readonly reasonCode:
          "not-allowlisted" | "reserved-range" | "unpinned-ip";
      }
  );

type HandshakeFailure = (ConnectionTarget | UnaddressedConnection) & {
  readonly decision: "deny";
  readonly reasonCode: "auth-failed" | "udp-refused" | "invalid-destination";
};

type DnsDecision =
  | {
      readonly decision: "allow";
      readonly reasonCode: "allowlisted-host" | "host-service";
      readonly answerIps: readonly string[];
    }
  | {
      readonly decision: "deny";
      readonly reasonCode: "dns-not-allowlisted" | "dns-type-refused";
      readonly answerIps: readonly [];
    };

export interface RuntimeEventPayloads {
  readonly "execution.started": ExecutionMetadata & {
    readonly context: ExecutionContext;
  };
  readonly "execution.finished": Duration & {
    readonly outcome: ExecutionOutcome;
  };
  readonly "sandbox.created": EffectOutcome &
    Duration & {
      readonly profile: ProfileName;
      readonly runtimeKind: string;
    };
  readonly "sandbox.destroyed": EffectOutcome & Duration;
  /** Reserved. In v0.1 create also starts the sandbox. */
  readonly "sandbox.started": Readonly<Record<string, never>>;
  /** Reserved. In v0.1 destroy also stops the sandbox. */
  readonly "sandbox.stopped": Readonly<Record<string, never>>;
  readonly "process.started": { readonly outcome: "started" | "failed" };
  readonly "process.exited": Duration & {
    readonly outcome: ExecutionOutcome;
    readonly signal: null;
  } & (
      | { readonly exitCode: number; readonly guestReported: true }
      | { readonly exitCode: null; readonly guestReported: boolean }
    );
  readonly "policy.evaluated": Policy & {
    readonly decision: "allow" | "deny";
    readonly reasonCode: string;
  };
  readonly "resource.limit_exceeded": {
    readonly kind:
      | "limit-exceeded"
      | "timed-out"
      | "lifetime-expired"
      | "forced-termination"
      | "abnormal-exit";
  };
  readonly "network.connect.requested":
    ConnectionTarget | UnaddressedConnection;
  readonly "network.connect.decided": Policy &
    (AddressedDecision | HandshakeFailure);
  readonly "network.connect.finished": Duration & {
    readonly connectionId: string;
    readonly result: "connected" | "connect-failed" | "refused" | "timeout";
    readonly endReason:
      | "client-closed"
      | "upstream-closed"
      | "idle-timeout"
      | "sandbox-destroyed"
      | "audit-failure"
      | "error";
    readonly bytesSent: number;
    readonly bytesReceived: number;
  };
  readonly "network.dns.query": Policy &
    DnsDecision & {
      readonly queryId: string;
      readonly protocol: "udp" | "tcp";
      readonly qname: string;
      readonly qtype: number;
    };
}

export type RuntimeEventType = keyof RuntimeEventPayloads;

/** In-process observation only. Durable evidence belongs to the audit store. */
export type RuntimeEvent<T extends RuntimeEventType = RuntimeEventType> = {
  [K in T]: {
    readonly eventId: string;
    readonly eventType: K;
    readonly schemaVersion: 1;
    /** UTC ISO 8601 time at the source. */
    readonly occurredAt: string;
    /** UTC ISO 8601 time when the envelope was recorded. */
    readonly recordedAt: string;
    readonly source: RuntimeEventSource;
    readonly executionId?: string;
    readonly sandboxId?: string;
    readonly operationId?: string;
    readonly correlationId?: string;
    readonly traceId?: string;
    readonly spanId?: string;
    readonly payload: RuntimeEventPayloads[K];
  };
}[T];

export interface RuntimeObserver {
  /** Callers contain exceptions from observers. */
  observe(event: RuntimeEvent): void;
}

/** Keep one counter for each emitting component instance. */
export class SequenceSource {
  #sequence = 0;
  readonly component: string;
  readonly instanceId: string;

  constructor(component: string, instanceId: string = randomUUID()) {
    this.component = component;
    this.instanceId = instanceId;
  }

  next(): RuntimeEventSource {
    if (this.#sequence === Number.MAX_SAFE_INTEGER)
      throw new RangeError("Runtime event sequence exhausted");
    return {
      component: this.component,
      instanceId: this.instanceId,
      sequence: ++this.#sequence,
    };
  }
}
