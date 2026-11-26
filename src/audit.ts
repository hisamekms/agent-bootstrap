import { isCodexFailureCode, type CodexFailureCode } from "./codex-exec.ts";
import { CLAUDE_MANAGED_PATH } from "./claude-code.ts";
import {
  CLAUDE_FAILURE_CODES,
  RETIRED_CLAUDE_FAILURE_CODES,
  validClaudeHostname,
  validService,
  type ClaudeFailureCode,
} from "./local-orchestrator/claude-config.ts";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { isAbsolute, resolve } from "node:path";
import { types } from "node:util";
import { canonicalizeIp } from "./egress-policy.ts";
import {
  type ExecutionContext,
  parseExecutionContext,
} from "./execution-context.ts";
import {
  isConciergeVolumeName,
  isSafeCredentialVariable,
} from "./sandbox-runtime.ts";
import { PROFILE_NAMES, type ProfileName } from "./sandbox-profiles.ts";

interface AuditMount {
  readonly name: string;
  readonly mode: "ro" | "rw";
  readonly path: string;
}

function auditMounts(value: unknown): AuditMount[] {
  if (!Array.isArray(value) || !value.length) return invalidEvent();
  return value.map((item) => {
    const { name, mode, path } = dataFields(item, ["name", "mode", "path"]);
    if (
      typeof name !== "string" ||
      !/^[a-z][a-z0-9-]{0,47}$/.test(name) ||
      (mode !== "ro" && mode !== "rw") ||
      typeof path !== "string" ||
      !/^\/mnt\/[a-z0-9][a-z0-9._-]{0,63}$/.test(path)
    )
      return invalidEvent();
    return { name, mode, path };
  });
}

export const SECRET_LEAK_SINKS = [
  "guest-output",
  "result-envelope",
  "journal-error",
  "runtime-event",
  "network-audit",
  "collection",
] as const;
export type SecretLeakSink = (typeof SECRET_LEAK_SINKS)[number];

const storedClaudeFailureCodes = [
  ...CLAUDE_FAILURE_CODES,
  ...RETIRED_CLAUDE_FAILURE_CODES,
] as const;

type AuditDetail =
  | {
      readonly socketPath: string;
      readonly vsockPort: number;
      readonly snapshotDir: string;
      readonly volumeName: string;
      readonly mounts?: readonly AuditMount[];
    }
  | { readonly volumeName: string; readonly reused?: boolean }
  | { readonly plainHosts: readonly string[] }
  | { readonly mounts: readonly AuditMount[] }
  | {
      readonly authMode: "api-key" | "external" | "secret-file";
      readonly settingsDigest: string;
      readonly managedPath: typeof CLAUDE_MANAGED_PATH;
      readonly mounts?: readonly AuditMount[];
    }
  | { readonly code: ClaudeFailureCode | CodexFailureCode }
  | {
      readonly event: "siwc-refresh";
      readonly status: "started" | "ok";
    }
  | {
      readonly event: "siwc-refresh";
      readonly status: "failed";
      readonly code: Exclude<CodexFailureCode, "codex-auth">;
    }
  | { readonly event: "secret.served"; readonly variable: string }
  | {
      readonly event: "secret.delivery";
      readonly variable: string;
      readonly delivery: "acknowledged" | "unknown";
    }
  | {
      readonly event: "secret-leak-suspected";
      readonly variable: string;
      readonly sink: SecretLeakSink;
    };

export type AuditInput = {
  readonly invocationId: string;
  readonly kind:
    | "invocation.started"
    | "operation.requested"
    | "operation.allowed"
    | "operation.denied"
    | "operation.finished"
    | "invocation.finished";
  readonly operation?:
    | "sandbox.create"
    | "sandbox.exec"
    | "sandbox.collect"
    | "sandbox.destroy"
    | "provider.egress"
    | "volume.create"
    | "volume.remove"
    | "unknown";
  readonly outcome?:
    "ok" | "denied" | "failed" | "timed-out" | "cancelled" | "interrupted";
  readonly role?:
    | "Worker"
    | "Planner"
    | "Reviewer"
    | "Coordinator"
    | "Verification"
    | "Concierge";
  /** Schema v4. Only on `sandbox.create` requests, together with `image`. */
  readonly profile?: ProfileName;
  /** Schema v4. Lowercase hex SHA-256 digest of the sandbox image. */
  readonly image?: string;
  /** Schema v6. Host-owned channel or session-volume evidence. */
  readonly detail?: AuditDetail;
};

export interface AuditSink {
  /** Completes only after durable commit. Hosts must await it before effects. */
  append(event: AuditInput): void | Promise<void>;
}

/** Host-computed digests only: never persist the raw caller key or request. */
export type RequestClaimInput = {
  readonly taskId: string;
  readonly requestKind: "delegation" | "integration";
  readonly keyDigest: string;
  readonly fingerprint: string;
};

export type RequestClaim = { readonly id: string; readonly replayed: boolean };

type LegacyAuditDetail =
  | { readonly code: (typeof RETIRED_CLAUDE_FAILURE_CODES)[number] }
  | {
      readonly authMode: "config-dir";
      readonly settingsDigest: string;
      readonly managedPath: typeof CLAUDE_MANAGED_PATH;
      readonly group: string;
      readonly groupPath?: "/claude-config";
    }
  | { readonly mode: "login" | "config-dir"; readonly group: string }
  | {
      readonly socketPath: string;
      readonly vsockPort: number;
      readonly snapshotDir: string;
      readonly volumeName: string;
      readonly group: string;
    };

export type AuditEvent = Omit<AuditInput, "detail"> & {
  readonly detail?: AuditDetail | LegacyAuditDetail;
  readonly sequence: number;
  readonly recordedAt: string;
};

export class AuditStoreError extends Error {
  readonly code: string;
  constructor(
    code:
      | "invalid-event"
      | "invalid-database"
      | "open-failed"
      | "append-failed"
      | "read-failed"
      | "read-only"
      | "closed"
      | "invalid-request"
      | "request-conflict",
  ) {
    // No filename, SQLite diagnostics, arbitrary event values or process output.
    super(`Audit store: ${code}`);
    this.name = "AuditStoreError";
    this.code = code;
  }
}

type Binding = string | number | null;
interface SqliteStatement {
  run(...bindings: Binding[]): unknown;
  get(...bindings: Binding[]): unknown;
  all(...bindings: Binding[]): unknown[];
}
interface SqliteConnection {
  exec(sql: string): unknown;
  query(sql: string): SqliteStatement;
  close(): void;
}
// Bun ships this builtin. The repository deliberately has no downloaded Bun
// type dependency; keep the untyped module behind this small local boundary.
const { Database } = createRequire(import.meta.url)("bun:sqlite") as {
  Database: new (
    filename: string,
    options: { readonly: boolean; create: boolean; strict: boolean },
  ) => SqliteConnection;
};

const applicationId = 0x41424731;
const uuid =
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const kinds = [
  "invocation.started",
  "operation.requested",
  "operation.allowed",
  "operation.denied",
  "operation.finished",
  "invocation.finished",
];
const operations = [
  "sandbox.create",
  "sandbox.exec",
  "sandbox.collect",
  "sandbox.destroy",
  "provider.egress",
  "volume.create",
  "volume.remove",
  "unknown",
];
const outcomes = [
  "ok",
  "denied",
  "failed",
  "timed-out",
  "cancelled",
  "interrupted",
];
const roles = [
  "Worker",
  "Planner",
  "Reviewer",
  "Coordinator",
  "Verification",
  "Concierge",
];
const profiles: readonly string[] = PROFILE_NAMES;
const imageDigest = /^[0-9a-f]{64}$/;
const inputKeys = [
  "invocationId",
  "kind",
  "operation",
  "outcome",
  "role",
  "profile",
  "image",
  "detail",
];

const auditSchema = [
  {
    name: "audit_events",
    sql: `CREATE TABLE audit_events (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      recorded_at TEXT NOT NULL,
      invocation_id TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('invocation.started','operation.requested','operation.allowed','operation.denied','operation.finished','invocation.finished')),
      operation TEXT CHECK (operation IN ('sandbox.create','sandbox.exec','sandbox.collect','sandbox.destroy','unknown')),
      outcome TEXT CHECK (outcome IN ('ok','denied','failed','timed-out','cancelled','interrupted')),
      role TEXT CHECK (role IN ('Worker','Planner','Reviewer','Coordinator'))
    )`,
  },
  {
    name: "audit_no_update",
    sql: "CREATE TRIGGER audit_no_update BEFORE UPDATE ON audit_events BEGIN SELECT RAISE(ABORT, 'append-only'); END",
  },
  {
    name: "audit_no_delete",
    sql: "CREATE TRIGGER audit_no_delete BEFORE DELETE ON audit_events BEGIN SELECT RAISE(ABORT, 'append-only'); END",
  },
];

const claimSchema = [
  {
    name: "request_claims",
    sql: `CREATE TABLE request_claims (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      recorded_at TEXT NOT NULL,
      id TEXT NOT NULL UNIQUE,
      task_id TEXT NOT NULL,
      request_kind TEXT NOT NULL CHECK (request_kind IN ('delegation','integration')),
      key_digest TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      UNIQUE (task_id, request_kind, key_digest)
    )`,
  },
  {
    name: "claims_no_update",
    sql: "CREATE TRIGGER claims_no_update BEFORE UPDATE ON request_claims BEGIN SELECT RAISE(ABORT, 'append-only'); END",
  },
  {
    name: "claims_no_delete",
    sql: "CREATE TRIGGER claims_no_delete BEFORE DELETE ON request_claims BEGIN SELECT RAISE(ABORT, 'append-only'); END",
  },
];
const schema = [...auditSchema, ...claimSchema];

// Version 3 adds `provider.egress`, recorded before a sandbox that receives
// credentialed provider egress is created. Version 1 and 2 databases still
// open; their CHECK constraint rejects that event, so such a grant fails
// closed instead of being written to an older trace.
const auditTableV3 = auditSchema[0]!.sql.replace(
  "'sandbox.destroy','unknown'",
  "'sandbox.destroy','provider.egress','unknown'",
);
const schemaV3 = [
  { name: "audit_events", sql: auditTableV3 },
  ...auditSchema.slice(1),
  ...claimSchema,
];

// Version 4 adds the `Verification` role and the nullable `profile` and
// `image` columns, recorded on `sandbox.create` requests. Older databases are
// not altered: writing those fields to them fails closed in `append`.
const auditTableV4 = auditTableV3.replace(
  "'Coordinator'))",
  "'Coordinator','Verification')),\n      profile TEXT CHECK (profile IS NULL OR profile IN ('base','db','browser')),\n      image TEXT CHECK (image IS NULL OR (length(image) = 64 AND image NOT GLOB '*[^0-9a-f]*'))",
);
const schemaV4 = [
  { name: "audit_events", sql: auditTableV4 },
  ...auditSchema.slice(1),
  ...claimSchema,
];

const allowReasons = [
  "allowlisted-host",
  "allowlisted-ip",
  "host-service",
] as const;
const denyReasons = [
  "not-allowlisted",
  "reserved-range",
  "unpinned-ip",
] as const;
const handshakeReasons = [
  "auth-failed",
  "udp-refused",
  "invalid-destination",
  "capacity",
] as const;
const dnsAllowReasons = ["allowlisted-host", "host-service"] as const;
const dnsDenyReasons = ["dns-not-allowlisted", "dns-type-refused"] as const;
const decisions = ["allow", "deny"] as const;
const channels = ["egress", "provider-egress", "host-service"] as const;
const egressModes = ["none", "gateway"] as const;
const networkResults = [
  "connected",
  "connect-failed",
  "refused",
  "timeout",
] as const;
const endReasons = [
  "client-closed",
  "upstream-closed",
  "idle-timeout",
  "sandbox-destroyed",
  "audit-failure",
  "error",
] as const;
const resourceKinds = [
  "limit-exceeded",
  "timed-out",
  "lifetime-expired",
  "forced-termination",
  "abnormal-exit",
] as const;

type ExecutionIdentity = { readonly invocationId: string };
type SandboxIdentity = ExecutionIdentity & { readonly sandboxId: string };

export type SandboxBindingInput = SandboxIdentity & {
  readonly runtimeKind: "microsandbox";
  readonly netRuleDigest: string;
} & (
    | {
        readonly egressMode: "gateway";
        readonly gatewayPolicyId: string;
        readonly gatewayPolicyDigest: string;
      }
    | {
        readonly egressMode: "none";
        readonly gatewayPolicyId?: never;
        readonly gatewayPolicyDigest?: never;
      }
  );

export type ProcessResultInput = ExecutionIdentity & {
  readonly operation: "sandbox.exec";
  readonly signal: null;
} & (
    | { readonly exitCode: number; readonly guestReported: true }
    | { readonly exitCode: null; readonly guestReported: boolean }
  );

type NetworkTarget =
  | {
      readonly destinationIp: string;
      readonly destinationPort: number;
      readonly channel: (typeof channels)[number];
      readonly hostname?: string;
    }
  | {
      readonly destinationIp?: never;
      readonly destinationPort?: never;
      readonly channel?: never;
      readonly hostname?: never;
    };

type ConnectionIdentity = SandboxIdentity & { readonly connectionId: string };

export type NetworkInput = ConnectionIdentity &
  NetworkTarget & {
    readonly decision: (typeof decisions)[number];
    readonly policyId: string;
    readonly reasonCode:
      | (typeof allowReasons)[number]
      | (typeof denyReasons)[number]
      | (typeof handshakeReasons)[number];
  };

export type NetworkFinishedInput = ConnectionIdentity & {
  readonly result: (typeof networkResults)[number];
  readonly endReason: (typeof endReasons)[number];
  readonly bytesSent: number;
  readonly bytesReceived: number;
  readonly durationMs: number;
};

export type DnsQueryInput = SandboxIdentity & {
  readonly queryId: string;
  readonly protocol: "tcp" | "udp";
  readonly qname: string;
  readonly qtype: number;
  readonly decision: (typeof decisions)[number];
  readonly policyId: string;
  readonly reasonCode:
    (typeof dnsAllowReasons)[number] | (typeof dnsDenyReasons)[number];
  readonly answerIps: readonly string[];
};

export type ResourceEventInput = ExecutionIdentity & {
  readonly sandboxId?: string;
  readonly kind: (typeof resourceKinds)[number];
};

type AuditMetadata = Pick<AuditEvent, "sequence" | "recordedAt">;
export type NetworkEvent = AuditMetadata &
  (
    | (ConnectionIdentity &
        NetworkTarget & {
          readonly phase: "requested";
          readonly protocol: "tcp";
        })
    | (NetworkInput & { readonly phase: "decided"; readonly protocol: "tcp" })
    | (NetworkFinishedInput & {
        readonly phase: "finished";
        readonly protocol: "tcp";
      })
    | (DnsQueryInput & { readonly phase: "dns" })
  );

export interface ExecutionAudit {
  readonly auditEvents: AuditEvent[];
  readonly executionContexts: (ExecutionContext & AuditMetadata)[];
  readonly sandboxBindings: (SandboxBindingInput & AuditMetadata)[];
  readonly processResults: (ProcessResultInput & AuditMetadata)[];
  readonly networkEvents: NetworkEvent[];
  readonly resourceEvents: (ResourceEventInput & AuditMetadata)[];
}

type ExportTables = {
  audit_events: AuditEvent;
  execution_contexts: ExecutionContext & AuditMetadata;
  sandbox_bindings: SandboxBindingInput & AuditMetadata;
  process_results: ProcessResultInput & AuditMetadata;
  network_events: NetworkEvent;
  resource_events: ResourceEventInput & AuditMetadata;
};

type AuditExportTable = keyof ExportTables;
/** Each table owns a sequence. An absent watermark starts at the first row. */
export type AuditSequenceWatermark = Readonly<
  Partial<Record<AuditExportTable, number>>
>;
export type AuditExportRecord = {
  [K in AuditExportTable]: { readonly table: K } & ExportTables[K];
}[AuditExportTable];

function enumSql(values: readonly string[]): string {
  return values.map((value) => `'${value}'`).join(",");
}

function digestCheck(column: string): string {
  return `length(${column}) = 64 AND ${column} NOT GLOB '*[^0-9a-f]*'`;
}

function v5Table(name: string, columns: string) {
  return [
    {
      name,
      sql: `CREATE TABLE ${name} (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT CHECK (sequence BETWEEN 1 AND 9007199254740991),
      recorded_at TEXT NOT NULL,
      invocation_id TEXT NOT NULL CHECK (length(invocation_id) = 36),
      ${columns}
    ) STRICT`,
    },
    ...["UPDATE", "DELETE"].map((action) => ({
      name: `${name}_no_${action.toLowerCase()}`,
      sql: `CREATE TRIGGER ${name}_no_${action.toLowerCase()} BEFORE ${action} ON ${name} BEGIN SELECT RAISE(ABORT, 'append-only'); END`,
    })),
  ];
}

const v5Additions = [
  ...v5Table(
    "execution_contexts",
    `session_id TEXT CHECK (length(session_id) = 36),
      retry_of_execution_id TEXT CHECK (length(retry_of_execution_id) = 36),
      correlation_id TEXT CHECK (length(correlation_id) = 36),
      traceparent TEXT CHECK (length(traceparent) = 55),
      attributes TEXT CHECK (length(CAST(attributes AS BLOB)) <= 26000 AND json_valid(attributes)),
      UNIQUE (invocation_id)`,
  ),
  ...v5Table(
    "sandbox_bindings",
    `sandbox_id TEXT NOT NULL CHECK (length(sandbox_id) = 46),
      runtime_kind TEXT NOT NULL CHECK (runtime_kind = 'microsandbox'),
      egress_mode TEXT NOT NULL CHECK (egress_mode IN (${enumSql(egressModes)})),
      net_rule_digest TEXT NOT NULL CHECK (${digestCheck("net_rule_digest")}),
      gateway_policy_id TEXT CHECK (${digestCheck("gateway_policy_id")}),
      gateway_policy_digest TEXT CHECK (${digestCheck("gateway_policy_digest")}),
      CHECK ((egress_mode = 'gateway' AND gateway_policy_id IS NOT NULL AND gateway_policy_digest IS NOT NULL) OR
             (egress_mode = 'none' AND gateway_policy_id IS NULL AND gateway_policy_digest IS NULL)),
      UNIQUE (invocation_id, sandbox_id)`,
  ),
  ...v5Table(
    "process_results",
    `operation TEXT NOT NULL CHECK (operation = 'sandbox.exec'),
      exit_code INTEGER CHECK (exit_code BETWEEN -2147483648 AND 2147483647),
      signal TEXT CHECK (signal IS NULL),
      guest_reported INTEGER NOT NULL CHECK (guest_reported IN (0,1)),
      CHECK (exit_code IS NULL OR guest_reported = 1)`,
  ),
  ...v5Table(
    "network_events",
    `sandbox_id TEXT NOT NULL CHECK (length(sandbox_id) = 46),
      flow_id TEXT NOT NULL CHECK (length(flow_id) = 36),
      phase TEXT NOT NULL CHECK (phase IN ('requested','decided','finished','dns')),
      protocol TEXT NOT NULL CHECK (protocol IN ('tcp','udp')),
      channel TEXT CHECK (channel IN (${enumSql(channels)})),
      destination_ip TEXT CHECK (length(destination_ip) BETWEEN 2 AND 39 AND destination_ip NOT GLOB '*[^0-9a-f.:]*'),
      destination_port INTEGER CHECK (destination_port BETWEEN 1 AND 65535),
      hostname TEXT CHECK (length(hostname) BETWEEN 1 AND 253 AND hostname NOT GLOB '*[^a-zA-Z0-9.-]*'),
      decision TEXT CHECK (decision IN (${enumSql(decisions)})),
      policy_id TEXT CHECK (${digestCheck("policy_id")}),
      reason_code TEXT CHECK (reason_code IN (${enumSql([...allowReasons, ...denyReasons, ...handshakeReasons, ...dnsDenyReasons])})),
      result TEXT CHECK (result IN (${enumSql(networkResults)})),
      end_reason TEXT CHECK (end_reason IN (${enumSql(endReasons)})),
      bytes_sent INTEGER CHECK (bytes_sent BETWEEN 0 AND 9007199254740991),
      bytes_received INTEGER CHECK (bytes_received BETWEEN 0 AND 9007199254740991),
      duration_ms REAL CHECK (duration_ms BETWEEN 0 AND 9007199254740991),
      qtype INTEGER CHECK (qtype BETWEEN 0 AND 65535),
      answer_ips TEXT CHECK (length(answer_ips) <= 2700 AND json_valid(answer_ips)),
      CHECK ((destination_ip IS NULL) = (destination_port IS NULL) AND
             (destination_ip IS NULL) = (channel IS NULL)),
      CHECK (phase = 'dns' OR protocol = 'tcp'),
      CHECK ((phase = 'dns') = (qtype IS NOT NULL) AND (phase = 'dns') = (answer_ips IS NOT NULL)),
      CHECK (phase <> 'dns' OR (hostname IS NOT NULL AND destination_ip IS NULL)),
      CHECK (phase <> 'finished' OR (destination_ip IS NULL AND hostname IS NULL)),
      CHECK (phase = 'dns' OR destination_ip IS NOT NULL OR hostname IS NULL),
      CHECK ((phase IN ('decided','dns')) = (decision IS NOT NULL) AND
             (phase IN ('decided','dns')) = (policy_id IS NOT NULL) AND
             (phase IN ('decided','dns')) = (reason_code IS NOT NULL)),
      CHECK ((phase = 'finished') = (result IS NOT NULL) AND
             (phase = 'finished') = (end_reason IS NOT NULL) AND
             (phase = 'finished') = (bytes_sent IS NOT NULL) AND
             (phase = 'finished') = (bytes_received IS NOT NULL) AND
             (phase = 'finished') = (duration_ms IS NOT NULL)),
      UNIQUE (invocation_id, sandbox_id, flow_id, phase)`,
  ),
  ...v5Table(
    "resource_events",
    `sandbox_id TEXT CHECK (length(sandbox_id) = 46),
      kind TEXT NOT NULL CHECK (kind IN (${enumSql(resourceKinds)}))`,
  ),
];
const schemaV5 = [...schemaV4, ...v5Additions];
const auditTableV6 = auditTableV4
  .replace("'Verification'))", "'Verification','Concierge'))")
  .replace("'base','db','browser'", "'base','db','browser','concierge'")
  .replace(
    "'provider.egress','unknown'",
    "'provider.egress','volume.create','volume.remove','unknown'",
  )
  .replace(
    /\n    \)$/,
    ",\n      detail TEXT CHECK (detail IS NULL OR json_valid(detail))\n    )",
  );
const schemaV6 = [
  { name: "audit_events", sql: auditTableV6 },
  ...schemaV5.slice(1),
];
const auditTableV7 = auditTableV6.replace(
  "'base','db','browser','concierge'",
  "'base','db','browser','concierge','bun'",
);
const schemaV7 = [
  { name: "audit_events", sql: auditTableV7 },
  ...schemaV6.slice(1),
];
const currentVersion = 7;
const versionSchemas = {
  1: auditSchema,
  2: schema,
  3: schemaV3,
  4: schemaV4,
  5: schemaV5,
  6: schemaV6,
  7: schemaV7,
};

type AuditVersion = keyof typeof versionSchemas;

/** The exact expected schema SQL for a database version (for fixtures). */
export function auditSchemaSql(version: AuditVersion): string[] {
  return versionSchemas[version].map((entry) => entry.sql);
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new AuditStoreError("invalid-event");
  return value as Record<string, unknown>;
}

function invocationId(value: unknown): string {
  if (typeof value !== "string" || !uuid.test(value))
    throw new AuditStoreError("invalid-event");
  return value;
}

function parseInput(value: unknown): AuditInput;
function parseInput(
  value: unknown,
  stored: true,
): Omit<AuditEvent, "sequence" | "recordedAt">;
function parseInput(
  value: unknown,
  stored = false,
): Omit<AuditEvent, "sequence" | "recordedAt"> {
  const input = record(value);
  const descriptors = Object.getOwnPropertyDescriptors(input);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (
      typeof key !== "string" ||
      !inputKeys.includes(key) ||
      !Object.hasOwn(descriptors[key] ?? {}, "value")
    )
      throw new AuditStoreError("invalid-event");
  }
  const id = invocationId(descriptors.invocationId?.value);
  const kind: unknown = descriptors.kind?.value;
  if (typeof kind !== "string" || !kinds.includes(kind))
    throw new AuditStoreError("invalid-event");
  const result: {
    invocationId: string;
    kind: string;
    operation?: string;
    outcome?: string;
    role?: string;
    profile?: string;
    image?: string;
  } = { invocationId: id, kind };
  for (const [key, allowed] of [
    ["operation", operations],
    ["outcome", outcomes],
    ["role", roles],
    ["profile", profiles],
  ] as const) {
    if (Object.hasOwn(descriptors, key)) {
      const field: unknown = descriptors[key]?.value;
      if (typeof field !== "string" || !allowed.includes(field))
        throw new AuditStoreError("invalid-event");
      result[key] = field;
    }
  }
  if (Object.hasOwn(descriptors, "image")) {
    const field: unknown = descriptors.image?.value;
    if (typeof field !== "string" || !imageDigest.test(field))
      throw new AuditStoreError("invalid-event");
    result.image = field;
  }
  if (
    (result.profile === undefined) !== (result.image === undefined) ||
    (result.profile !== undefined &&
      (kind !== "operation.requested" || result.operation !== "sandbox.create"))
  )
    throw new AuditStoreError("invalid-event");
  const invocation = kind.startsWith("invocation.");
  if (
    (invocation && result.operation !== undefined) ||
    (!invocation && result.operation === undefined) ||
    ((kind === "invocation.started" ||
      kind === "operation.requested" ||
      kind === "operation.allowed") &&
      result.outcome !== undefined) ||
    ((kind === "invocation.finished" || kind === "operation.finished") &&
      result.outcome === undefined) ||
    (kind === "operation.denied" && result.outcome !== "denied") ||
    (kind === "operation.finished" && result.outcome === "denied") ||
    (result.operation === "unknown" &&
      kind !== "operation.requested" &&
      kind !== "operation.denied")
  )
    throw new AuditStoreError("invalid-event");
  const detail = parseAuditDetail(
    Object.hasOwn(descriptors, "detail"),
    descriptors.detail?.value,
    result,
    stored,
  );
  return { ...result, ...(detail ? { detail } : {}) } as Omit<
    AuditEvent,
    "sequence" | "recordedAt"
  >;
}

function parseAuditDetail(
  present: boolean,
  value: unknown,
  event: {
    kind: string;
    operation?: string;
    role?: string;
    profile?: string;
    outcome?: string;
  },
  stored: boolean,
): AuditDetail | LegacyAuditDetail | undefined {
  const { kind, operation, role, profile, outcome } = event;
  const claudeRole =
    role === "Concierge" ||
    role === "Worker" ||
    role === "Planner" ||
    role === "Reviewer";
  if (
    present &&
    (role === "Worker" || role === "Reviewer" || role === "Planner") &&
    kind === "operation.requested" &&
    operation === "sandbox.exec"
  ) {
    const { event, variable, delivery, sink } = dataFields(value, [
      "event",
      "variable",
      "delivery",
      "sink",
    ]);
    if (!isSafeCredentialVariable(variable)) return invalidEvent();
    if (
      event === "secret.served" &&
      delivery === undefined &&
      sink === undefined
    )
      return { event, variable };
    if (
      event === "secret.delivery" &&
      (delivery === "acknowledged" || delivery === "unknown") &&
      sink === undefined
    )
      return { event, variable, delivery };
    if (event === "secret-leak-suspected" && delivery === undefined)
      return { event, variable, sink: enumField(sink, SECRET_LEAK_SINKS) };
    return invalidEvent();
  }
  if (present && claudeRole && kind === "invocation.started") {
    if (
      stored &&
      value &&
      typeof value === "object" &&
      Object.hasOwn(value, "group")
    ) {
      const { authMode, settingsDigest, managedPath, group, groupPath } =
        dataFields(value, [
          "authMode",
          "settingsDigest",
          "managedPath",
          "group",
          "groupPath",
        ]);
      if (
        authMode !== "config-dir" ||
        typeof settingsDigest !== "string" ||
        !/^[a-f0-9]{64}$/.test(settingsDigest) ||
        managedPath !== CLAUDE_MANAGED_PATH ||
        !validAuditGroup(group) ||
        (groupPath !== undefined && groupPath !== "/claude-config")
      )
        return invalidEvent();
      return {
        authMode,
        settingsDigest,
        managedPath,
        group,
        ...(groupPath ? { groupPath } : {}),
      };
    }
    const { authMode, settingsDigest, managedPath, mounts } = dataFields(
      value,
      ["authMode", "settingsDigest", "managedPath", "mounts"],
    );
    if (
      (authMode !== "api-key" &&
        authMode !== "external" &&
        authMode !== "secret-file") ||
      typeof settingsDigest !== "string" ||
      !/^[a-f0-9]{64}$/.test(settingsDigest) ||
      managedPath !== CLAUDE_MANAGED_PATH
    )
      return invalidEvent();
    return {
      authMode,
      settingsDigest,
      managedPath,
      ...(mounts === undefined ? {} : { mounts: auditMounts(mounts) }),
    };
  }
  if (
    present &&
    claudeRole &&
    kind === "invocation.finished" &&
    outcome === "failed"
  ) {
    const { code } = dataFields(value, ["code"]);
    if (role === "Worker" && isCodexFailureCode(code)) return { code };
    return {
      code: enumField(
        code,
        stored ? storedClaudeFailureCodes : CLAUDE_FAILURE_CODES,
      ),
    };
  }
  if (
    present &&
    role === "Worker" &&
    operation === "sandbox.create" &&
    kind === "operation.requested" &&
    value &&
    typeof value === "object" &&
    Object.hasOwn(value, "event")
  ) {
    const { event, status, code } = dataFields(value, [
      "event",
      "status",
      "code",
    ]);
    if (event !== "siwc-refresh") return invalidEvent();
    if ((status === "started" || status === "ok") && code === undefined)
      return { event, status };
    if (
      status === "failed" &&
      isCodexFailureCode(code) &&
      code !== "codex-auth"
    )
      return { event, status, code };
    return invalidEvent();
  }
  if (
    present &&
    role !== "Verification" &&
    kind === "operation.requested" &&
    operation === "provider.egress"
  ) {
    const { plainHosts } = dataFields(value, ["plainHosts"]);
    if (
      !Array.isArray(plainHosts) ||
      plainHosts.length < 1 ||
      plainHosts.length > 193 ||
      !plainHosts.every(validClaudeHostname)
    )
      return invalidEvent();
    return { plainHosts: [...plainHosts] };
  }
  if (operation === "volume.create" || operation === "volume.remove") {
    const recordsReuse =
      operation === "volume.create" &&
      kind === "operation.finished" &&
      outcome === "ok";
    const detail = dataFields(
      value,
      recordsReuse ? ["volumeName", "reused"] : ["volumeName"],
    );
    if (role !== "Concierge" || !isConciergeVolumeName(detail.volumeName))
      return invalidEvent();
    if (!recordsReuse) return { volumeName: detail.volumeName };
    if (typeof detail.reused !== "boolean") return invalidEvent();
    return { volumeName: detail.volumeName, reused: detail.reused };
  }
  if (
    stored &&
    present &&
    claudeRole &&
    kind === "operation.requested" &&
    operation === "sandbox.create" &&
    value &&
    typeof value === "object" &&
    Object.hasOwn(value, "mode")
  ) {
    const { mode, group } = dataFields(value, ["mode", "group"]);
    if (
      !validAuditGroup(group) ||
      mode !== (role === "Concierge" ? "login" : "config-dir")
    )
      return invalidEvent();
    return { mode: role === "Concierge" ? "login" : "config-dir", group };
  }
  if (
    present &&
    claudeRole &&
    kind === "operation.requested" &&
    operation === "sandbox.create" &&
    value &&
    typeof value === "object" &&
    Object.hasOwn(value, "mounts") &&
    !Object.hasOwn(value, "socketPath")
  ) {
    const { mounts } = dataFields(value, ["mounts"]);
    return { mounts: auditMounts(mounts) };
  }
  if (
    role === "Concierge" &&
    profile === "concierge" &&
    operation === "sandbox.create" &&
    kind === "operation.requested"
  ) {
    const detail = dataFields(value, [
      "socketPath",
      "vsockPort",
      "snapshotDir",
      "volumeName",
      "mounts",
      ...(stored ? ["group"] : []),
    ]);
    const { socketPath, snapshotDir, volumeName, mounts, group } = detail;
    if (
      !isInteractiveAuditPath(socketPath) ||
      Buffer.byteLength(socketPath) >= 100 ||
      !isInteractiveAuditPath(snapshotDir) ||
      !isConciergeVolumeName(volumeName) ||
      (group !== undefined && (!validAuditGroup(group) || mounts !== undefined))
    )
      return invalidEvent();
    return {
      socketPath,
      vsockPort: integer(detail.vsockPort, 1024, 65535),
      snapshotDir,
      volumeName,
      ...(mounts === undefined ? {} : { mounts: auditMounts(mounts) }),
      ...(validAuditGroup(group) ? { group } : {}),
    };
  }
  if (present) return invalidEvent();
}

function isInteractiveAuditPath(value: unknown): value is string {
  return (
    typeof value === "string" &&
    isAbsolute(value) &&
    resolve(value) === value &&
    !/[\0:=,\r\n]/.test(value)
  );
}

function parseClaimInput(value: unknown): RequestClaimInput {
  try {
    const input = record(value);
    const descriptors = Object.getOwnPropertyDescriptors(input);
    const keys = ["taskId", "requestKind", "keyDigest", "fingerprint"];
    for (const key of Reflect.ownKeys(descriptors)) {
      if (
        typeof key !== "string" ||
        !keys.includes(key) ||
        !Object.hasOwn(descriptors[key] ?? {}, "value")
      )
        throw new AuditStoreError("invalid-request");
    }
    const taskId = invocationId(descriptors.taskId?.value);
    const requestKind: unknown = descriptors.requestKind?.value;
    const keyDigest: unknown = descriptors.keyDigest?.value;
    const fingerprint: unknown = descriptors.fingerprint?.value;
    if (
      (requestKind !== "delegation" && requestKind !== "integration") ||
      typeof keyDigest !== "string" ||
      !/^[a-f0-9]{64}$/.test(keyDigest) ||
      typeof fingerprint !== "string" ||
      !/^[a-f0-9]{64}$/.test(fingerprint)
    )
      throw new AuditStoreError("invalid-request");
    return { taskId, requestKind, keyDigest, fingerprint };
  } catch {
    throw new AuditStoreError("invalid-request");
  }
}

function rowMetadata(row: Record<string, unknown>): {
  sequence: number;
  recordedAt: string;
} {
  if (
    typeof row.sequence !== "number" ||
    !Number.isSafeInteger(row.sequence) ||
    row.sequence < 1 ||
    typeof row.recorded_at !== "string" ||
    new Date(row.recorded_at).toISOString() !== row.recorded_at
  )
    throw new AuditStoreError("invalid-database");
  return { sequence: row.sequence, recordedAt: row.recorded_at };
}

function parseClaimRow(value: unknown): RequestClaimInput & { id: string } {
  const row = record(value);
  rowMetadata(row);
  return {
    ...parseClaimInput({
      taskId: row.task_id,
      requestKind: row.request_kind,
      keyDigest: row.key_digest,
      fingerprint: row.fingerprint,
    }),
    id: invocationId(row.id),
  };
}

function parseRow(value: unknown): AuditEvent {
  const row = record(value);
  const input = parseInput(
    {
      invocationId: row.invocation_id,
      kind: row.kind,
      ...(row.operation === null ? {} : { operation: row.operation }),
      ...(row.outcome === null ? {} : { outcome: row.outcome }),
      ...(row.role === null ? {} : { role: row.role }),
      // Absent on version 1-3 rows.
      ...(row.profile == null ? {} : { profile: row.profile }),
      ...(row.image == null ? {} : { image: row.image }),
      ...(row.detail == null
        ? {}
        : { detail: JSON.parse(String(row.detail)) as unknown }),
    },
    true,
  );
  return { ...input, ...rowMetadata(row) };
}

function validAuditGroup(value: unknown): value is string {
  return validService(value) && /^[a-z][a-z0-9-]{0,47}$/.test(value);
}

function invalidEvent(): never {
  throw new AuditStoreError("invalid-event");
}

/** Read only the own data fields explicitly supported by each append. */
function dataFields(
  value: unknown,
  allowed: readonly string[],
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || types.isProxy(value))
    return invalidEvent();
  const proto: unknown = Object.getPrototypeOf(value);
  if (proto !== null && proto !== Object.prototype) return invalidEvent();
  const fields: Record<string, unknown> = Object.create(null);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== "string" || !allowed.includes(key))
      return invalidEvent();
    const descriptor = descriptors[key];
    if (!descriptor || !Object.hasOwn(descriptor, "value"))
      return invalidEvent();
    fields[key] = descriptor.value;
  }
  return fields;
}

function enumField<T extends string>(value: unknown, allowed: readonly T[]): T {
  if (
    typeof value !== "string" ||
    !(allowed as readonly string[]).includes(value)
  )
    return invalidEvent();
  return value as T;
}

function integer(
  value: unknown,
  min: number,
  max = Number.MAX_SAFE_INTEGER,
): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < min ||
    value > max
  )
    return invalidEvent();
  return value;
}

function digest(value: unknown): string {
  if (typeof value !== "string" || !imageDigest.test(value))
    return invalidEvent();
  return value;
}

function sandboxId(value: unknown): string {
  if (typeof value !== "string" || !value.startsWith("bootstrap-"))
    return invalidEvent();
  invocationId(value.slice("bootstrap-".length));
  return value;
}

function ip(value: unknown): string {
  if (typeof value !== "string" || canonicalizeIp(value) !== value)
    return invalidEvent();
  return value;
}

function hostname(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length > 253 ||
    !value
      .split(".")
      .every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label))
  )
    return invalidEvent();
  return value;
}

function answerIps(value: unknown): readonly string[] {
  if (types.isProxy(value) || !Array.isArray(value) || value.length > 64)
    return invalidEvent();
  const answers: string[] = [];
  for (let i = 0; i < value.length; i++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(i));
    if (!descriptor || !Object.hasOwn(descriptor, "value"))
      return invalidEvent();
    answers.push(ip(descriptor.value));
  }
  return answers;
}

function parseAuditContext(value: unknown): ExecutionContext {
  try {
    const { traceContext, ...context } = parseExecutionContext(value);
    // ADR D1 stores traceparent only. Tracestate can carry opaque vendor data.
    return traceContext
      ? { ...context, traceContext: { traceparent: traceContext.traceparent } }
      : context;
  } catch {
    return invalidEvent();
  }
}

const bindingFields = [
  "invocationId",
  "sandboxId",
  "runtimeKind",
  "egressMode",
  "netRuleDigest",
  "gatewayPolicyId",
  "gatewayPolicyDigest",
];
function parseBinding(value: unknown): SandboxBindingInput {
  const input = dataFields(value, bindingFields);
  const base = {
    invocationId: invocationId(input.invocationId),
    sandboxId: sandboxId(input.sandboxId),
    runtimeKind: enumField(input.runtimeKind, ["microsandbox"]),
    netRuleDigest: digest(input.netRuleDigest),
  };
  const egressMode = enumField(input.egressMode, egressModes);
  if (egressMode === "gateway")
    return {
      ...base,
      egressMode,
      gatewayPolicyId: digest(input.gatewayPolicyId),
      gatewayPolicyDigest: digest(input.gatewayPolicyDigest),
    };
  if (
    Object.hasOwn(input, "gatewayPolicyId") ||
    Object.hasOwn(input, "gatewayPolicyDigest")
  )
    return invalidEvent();
  return { ...base, egressMode };
}

const processFields = [
  "invocationId",
  "operation",
  "exitCode",
  "signal",
  "guestReported",
];
function parseProcess(value: unknown): ProcessResultInput {
  const input = dataFields(value, processFields);
  const id = invocationId(input.invocationId);
  const operation = enumField(input.operation, ["sandbox.exec"]);
  if (input.signal !== null || typeof input.guestReported !== "boolean")
    return invalidEvent();
  const base = { invocationId: id, operation, signal: null };
  if (input.exitCode === null)
    return { ...base, exitCode: null, guestReported: input.guestReported };
  if (!input.guestReported) return invalidEvent();
  return {
    ...base,
    exitCode: integer(input.exitCode, -2147483648, 2147483647),
    guestReported: true,
  };
}

const resourceFields = ["invocationId", "sandboxId", "kind"];
function parseResource(value: unknown): ResourceEventInput {
  const input = dataFields(value, resourceFields);
  return {
    invocationId: invocationId(input.invocationId),
    kind: enumField(input.kind, resourceKinds),
    ...(Object.hasOwn(input, "sandboxId")
      ? { sandboxId: sandboxId(input.sandboxId) }
      : {}),
  };
}

const connectionFields = ["invocationId", "sandboxId", "connectionId"];
const targetFields = [
  "destinationIp",
  "destinationPort",
  "channel",
  "hostname",
];
const decisionFields = ["decision", "policyId", "reasonCode"];
const finishedFields = [
  "result",
  "endReason",
  "bytesSent",
  "bytesReceived",
  "durationMs",
];
const dnsFields = [
  "invocationId",
  "sandboxId",
  "queryId",
  "protocol",
  "qname",
  "qtype",
  ...decisionFields,
  "answerIps",
];

function parseConnection(input: Record<string, unknown>): ConnectionIdentity {
  return {
    invocationId: invocationId(input.invocationId),
    sandboxId: sandboxId(input.sandboxId),
    connectionId: invocationId(input.connectionId),
  };
}

function parseTarget(input: Record<string, unknown>): NetworkTarget {
  if (!targetFields.some((key) => Object.hasOwn(input, key))) return {};
  return {
    destinationIp: ip(input.destinationIp),
    destinationPort: integer(input.destinationPort, 1, 65535),
    channel: enumField(input.channel, channels),
    ...(Object.hasOwn(input, "hostname")
      ? { hostname: hostname(input.hostname) }
      : {}),
  };
}

function parseNetwork(value: unknown): NetworkInput {
  const input = dataFields(value, [
    ...connectionFields,
    ...targetFields,
    ...decisionFields,
  ]);
  const target = parseTarget(input);
  const decision = enumField(input.decision, decisions);
  const reasonCode =
    decision === "allow"
      ? enumField(input.reasonCode, allowReasons)
      : enumField(input.reasonCode, [...denyReasons, ...handshakeReasons]);
  if (
    (target.destinationIp === undefined &&
      (decision === "allow" ||
        !(handshakeReasons as readonly string[]).includes(reasonCode))) ||
    (target.channel === "host-service") !== (reasonCode === "host-service") ||
    (target.channel === "provider-egress" &&
      reasonCode !== "allowlisted-host") ||
    (reasonCode === "allowlisted-host" && target.hostname === undefined) ||
    (reasonCode === "allowlisted-ip" && target.hostname !== undefined)
  )
    return invalidEvent();
  return {
    ...parseConnection(input),
    ...target,
    decision,
    reasonCode,
    policyId: digest(input.policyId),
  };
}

function parseFinished(value: unknown): NetworkFinishedInput {
  const input = dataFields(value, [...connectionFields, ...finishedFields]);
  const durationMs = input.durationMs;
  if (
    typeof durationMs !== "number" ||
    !Number.isFinite(durationMs) ||
    durationMs < 0 ||
    durationMs > Number.MAX_SAFE_INTEGER
  )
    return invalidEvent();
  return {
    ...parseConnection(input),
    result: enumField(input.result, networkResults),
    endReason: enumField(input.endReason, endReasons),
    bytesSent: integer(input.bytesSent, 0),
    bytesReceived: integer(input.bytesReceived, 0),
    durationMs,
  };
}

function parseDns(value: unknown): DnsQueryInput {
  const input = dataFields(value, dnsFields);
  const decision = enumField(input.decision, decisions);
  const answers = answerIps(input.answerIps);
  const qtype = integer(input.qtype, 0, 65535);
  if (
    (decision === "deny" && answers.length !== 0) ||
    (decision === "allow" && qtype !== 1 && qtype !== 28)
  )
    return invalidEvent();
  return {
    invocationId: invocationId(input.invocationId),
    sandboxId: sandboxId(input.sandboxId),
    queryId: invocationId(input.queryId),
    protocol: enumField(input.protocol, ["tcp", "udp"]),
    qname: hostname(input.qname),
    qtype,
    decision,
    policyId: digest(input.policyId),
    reasonCode:
      decision === "allow"
        ? enumField(input.reasonCode, dnsAllowReasons)
        : enumField(input.reasonCode, dnsDenyReasons),
    answerIps: answers,
  };
}

function rowFields(row: Record<string, unknown>, fields: readonly string[]) {
  const input: Record<string, unknown> = {};
  for (const key of fields) {
    const value = row[columnName(key)];
    if (value !== null) input[key] = value;
  }
  return input;
}

function columnName(key: string): string {
  return key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}

function parseContextRow(raw: unknown): ExportTables["execution_contexts"] {
  const row = record(raw);
  return {
    ...parseAuditContext({
      executionId: row.invocation_id,
      ...rowFields(row, ["sessionId", "retryOfExecutionId", "correlationId"]),
      ...(row.traceparent === null
        ? {}
        : { traceContext: { traceparent: row.traceparent } }),
      ...(row.attributes === null
        ? {}
        : { attributes: JSON.parse(String(row.attributes)) as unknown }),
    }),
    ...rowMetadata(row),
  };
}

function parseProcessRow(raw: unknown): ExportTables["process_results"] {
  const row = record(raw);
  if (row.guest_reported !== 0 && row.guest_reported !== 1)
    return invalidEvent();
  return {
    ...parseProcess({
      ...rowFields(row, ["invocationId", "operation"]),
      exitCode: row.exit_code,
      signal: row.signal,
      guestReported: row.guest_reported === 1,
    }),
    ...rowMetadata(row),
  };
}

function parseNetworkRow(raw: unknown): NetworkEvent {
  const row = record(raw);
  const metadata = rowMetadata(row);
  if (row.phase === "dns")
    return {
      ...parseDns({
        ...rowFields(row, [
          "invocationId",
          "sandboxId",
          "protocol",
          "qtype",
          ...decisionFields,
        ]),
        queryId: row.flow_id,
        qname: row.hostname,
        answerIps: JSON.parse(String(row.answer_ips)) as unknown,
      }),
      ...metadata,
      phase: "dns",
    };

  const protocol = enumField(row.protocol, ["tcp"]);
  const identity = {
    ...rowFields(row, ["invocationId", "sandboxId"]),
    connectionId: row.flow_id,
  };
  const target = rowFields(row, targetFields);
  switch (row.phase) {
    case "requested":
      return {
        ...parseConnection(identity),
        ...parseTarget(target),
        ...metadata,
        phase: row.phase,
        protocol,
      };
    case "decided":
      return {
        ...parseNetwork({
          ...identity,
          ...target,
          ...rowFields(row, decisionFields),
        }),
        ...metadata,
        phase: row.phase,
        protocol,
      };
    case "finished":
      return {
        ...parseFinished({ ...identity, ...rowFields(row, finishedFields) }),
        ...metadata,
        phase: row.phase,
        protocol,
      };
    default:
      return invalidEvent();
  }
}

const tableReaders: {
  [K in AuditExportTable]: (raw: unknown) => ExportTables[K];
} = {
  audit_events: parseRow,
  execution_contexts: parseContextRow,
  sandbox_bindings: (raw: unknown) => {
    const row = record(raw);
    return {
      ...parseBinding(rowFields(row, bindingFields)),
      ...rowMetadata(row),
    };
  },
  process_results: parseProcessRow,
  network_events: parseNetworkRow,
  resource_events: (raw: unknown) => {
    const row = record(raw);
    return {
      ...parseResource(rowFields(row, resourceFields)),
      ...rowMetadata(row),
    };
  },
};

const exportTables = Object.keys(tableReaders) as AuditExportTable[];

function connectionKey(event: ConnectionIdentity): string {
  return `${event.invocationId}/${event.sandboxId}/${event.connectionId}`;
}

/** On reopen, verify that no decision is orphaned and no outcome lacks a grant. */
function validateNetworkHistory(events: NetworkEvent[]): void {
  let requested: Extract<NetworkEvent, { phase: "requested" }> | undefined;
  const allowed = new Set<string>();
  for (const event of events) {
    if (requested) {
      if (
        event.phase !== "decided" ||
        connectionKey(requested) !== connectionKey(event) ||
        requested.recordedAt !== event.recordedAt ||
        requested.sequence + 1 !== event.sequence ||
        requested.destinationIp !== event.destinationIp ||
        requested.destinationPort !== event.destinationPort ||
        requested.channel !== event.channel ||
        requested.hostname !== event.hostname
      )
        throw new AuditStoreError("invalid-database");
      if (event.decision === "allow") allowed.add(connectionKey(event));
      requested = undefined;
    } else if (event.phase === "requested") {
      requested = event;
    } else if (
      event.phase === "decided" ||
      (event.phase === "finished" && !allowed.delete(connectionKey(event)))
    ) {
      throw new AuditStoreError("invalid-database");
    }
  }
  if (requested) throw new AuditStoreError("invalid-database");
}

/** Trusted-host, file-backed append-only store. This is not tamper protection
 * against a host administrator who can replace the database or its schema.
 *
 * A crash can leave a requested/allowed operation with no finish event. Reopen
 * preserves that uncertainty: it neither executes the operation again nor
 * fabricates an interrupted/completed outcome. Reconciliation is host-owned.
 */
export class SqliteAudit implements AuditSink {
  readonly #database: SqliteConnection;
  readonly #readOnly: boolean;
  #closed = false;
  #writeFailed = false;
  readonly #writabilityListeners = new Set<() => void>();
  readonly #version: AuditVersion;

  constructor(filename: string, options: { readonly readonly?: boolean } = {}) {
    if (
      typeof filename !== "string" ||
      !isAbsolute(filename) ||
      filename === ":memory:" ||
      filename.startsWith("file:") ||
      filename.includes("\0")
    )
      throw new AuditStoreError("open-failed");
    this.#readOnly = options.readonly ?? false;
    let database: SqliteConnection | undefined;
    try {
      database = new Database(filename, {
        readonly: this.#readOnly,
        create: !this.#readOnly,
        strict: true,
      });
      database.exec("PRAGMA busy_timeout=1000; PRAGMA synchronous=FULL");
      if (this.#readOnly) database.exec("PRAGMA query_only=ON");
      const app = record(
        database.query("PRAGMA application_id").get(),
      ).application_id;
      const foundVersion = record(
        database.query("PRAGMA user_version").get(),
      ).user_version;
      let version: AuditVersion;
      const objects = database
        .query(
          "SELECT name, sql FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*' ORDER BY name",
        )
        .all();
      if (
        !this.#readOnly &&
        app === 0 &&
        foundVersion === 0 &&
        objects.length === 0
      ) {
        // This is a recognized empty database, not an unrelated schema. Its
        // first schema commit must initialize WAL too: switching an otherwise
        // idle database to WAL and immediately closing can leave Bun SQLite's
        // read-only reopen unable to initialize the WAL bookkeeping files.
        database.exec("PRAGMA journal_mode=WAL");
        database.exec("BEGIN IMMEDIATE");
        try {
          for (const entry of schemaV7) database.exec(entry.sql);
          database.exec(
            `PRAGMA application_id=${applicationId}; PRAGMA user_version=${currentVersion}; COMMIT`,
          );
          version = currentVersion;
        } catch {
          try {
            database.exec("ROLLBACK");
          } catch {
            /* Closing below discards the connection. */
          }
          throw new AuditStoreError("invalid-database");
        }
      } else {
        if (
          app !== applicationId ||
          (foundVersion !== 1 &&
            foundVersion !== 2 &&
            foundVersion !== 3 &&
            foundVersion !== 4 &&
            foundVersion !== 5 &&
            foundVersion !== 6 &&
            foundVersion !== currentVersion)
        )
          throw new AuditStoreError("invalid-database");
        // Only an empty store may initialize WAL. Refuse a snapshot before
        // any schema migration can modify it.
        if (
          !this.#readOnly &&
          record(database.query("PRAGMA journal_mode").get()).journal_mode !==
            "wal"
        )
          throw new AuditStoreError("invalid-database");
        version = foundVersion;
      }
      const installed = database
        .query(
          "SELECT name, sql FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*'",
        )
        .all();
      const matchesSchema = (expectedSchema: typeof schemaV7) =>
        installed.length === expectedSchema.length &&
        expectedSchema.every((expected) =>
          installed.some((value) => {
            const actual = record(value);
            return actual.name === expected.name && actual.sql === expected.sql;
          }),
        );
      // v5 was never released without the capacity reason, so an earlier
      // draft layout is refused by the exact check rather than rewritten:
      // only supported schemas can be migrated.
      if (!matchesSchema(versionSchemas[version]))
        throw new AuditStoreError("invalid-database");
      if (
        record(database.query("PRAGMA quick_check").get()).quick_check !== "ok"
      )
        throw new AuditStoreError("invalid-database");
      // Validate existing rows before accepting writes to an existing trace.
      let previous = 0;
      for (const raw of database
        .query("SELECT * FROM audit_events ORDER BY sequence")
        .all()) {
        const event = parseRow(raw);
        if (event.sequence <= previous)
          throw new AuditStoreError("invalid-database");
        previous = event.sequence;
      }
      if (version >= 2) {
        for (const raw of database
          .query("SELECT * FROM request_claims ORDER BY sequence")
          .all())
          parseClaimRow(raw);
      }
      if (version >= 5) {
        for (const table of exportTables) {
          if (table === "audit_events") continue;
          const rows = database
            .query(`SELECT * FROM ${table} ORDER BY sequence`)
            .all();
          if (table === "network_events")
            validateNetworkHistory(rows.map(parseNetworkRow));
          else for (const row of rows) tableReaders[table](row);
        }
      }
      if (
        !this.#readOnly &&
        (version === 1 || version === 4 || version === 5 || version === 6)
      ) {
        const upgradedVersion = version === 1 ? 2 : currentVersion;
        database.exec("BEGIN IMMEDIATE");
        try {
          if (
            record(database.query("PRAGMA user_version").get()).user_version !==
            version
          )
            throw new AuditStoreError("invalid-database");
          if (version === 1) {
            for (const entry of claimSchema) database.exec(entry.sql);
          } else {
            if (version === 4)
              for (const entry of v5Additions) database.exec(entry.sql);
            // Rebuild only the table whose CHECK constraints changed. Copy
            // original IDs and the sequence watermark before dropping it.
            database.exec(
              "ALTER TABLE audit_events RENAME TO audit_events_previous",
            );
            database.exec(auditTableV7);
            const detailColumn = version === 6 ? ", detail" : "";
            database.exec(`
              INSERT INTO audit_events
                (sequence, recorded_at, invocation_id, kind, operation, outcome, role, profile, image${detailColumn})
                SELECT sequence, recorded_at, invocation_id, kind, operation, outcome, role, profile, image${detailColumn}
                FROM audit_events_previous;
              INSERT INTO sqlite_sequence (name, seq)
                SELECT 'audit_events', seq FROM sqlite_sequence
                WHERE name = 'audit_events_previous'
                  AND NOT EXISTS (SELECT 1 FROM sqlite_sequence WHERE name = 'audit_events');
              UPDATE sqlite_sequence SET seq = max(seq, coalesce(
                (SELECT seq FROM sqlite_sequence WHERE name = 'audit_events_previous'), 0
              )) WHERE name = 'audit_events';
              DROP TABLE audit_events_previous;
            `);
            for (const entry of auditSchema.slice(1)) database.exec(entry.sql);
          }
          database.exec(`PRAGMA user_version=${upgradedVersion}; COMMIT`);
          version = upgradedVersion;
        } catch {
          try {
            database.exec("ROLLBACK");
          } catch {
            /* Closing below discards the connection. */
          }
          throw new AuditStoreError("invalid-database");
        }
      }
      if (
        !this.#readOnly &&
        (record(database.query("PRAGMA journal_mode").get()).journal_mode !==
          "wal" ||
          record(database.query("PRAGMA synchronous").get()).synchronous !== 2)
      )
        throw new AuditStoreError("invalid-database");
      this.#database = database;
      this.#version = version;
    } catch {
      try {
        database?.close();
      } catch {
        /* Never expose SQLite diagnostics. */
      }
      throw new AuditStoreError("open-failed");
    }
  }

  get schemaVersion(): AuditVersion {
    return this.#version;
  }

  /** Legacy capability name used by the gateway. Requires the current schema. */
  get isV5Writable(): boolean {
    return (
      this.#version === currentVersion &&
      !this.#closed &&
      !this.#readOnly &&
      !this.#writeFailed
    );
  }

  /** Notify subscribers when this store can no longer accept audited runtime writes. */
  onV5Unwritable(listener: () => void): () => void {
    if (!this.isV5Writable) listener();
    else this.#writabilityListeners.add(listener);
    return () => this.#writabilityListeners.delete(listener);
  }

  #notifyV5Unwritable(): void {
    const listeners = [...this.#writabilityListeners];
    this.#writabilityListeners.clear();
    for (const listener of listeners) {
      try {
        listener();
      } catch {
        // A subscriber cannot mask the audit failure or skip other listeners.
      }
    }
  }

  #requireWriter(): void {
    if (this.#closed) throw new AuditStoreError("closed");
    if (this.#readOnly) throw new AuditStoreError("read-only");
    if (this.#writeFailed) throw new AuditStoreError("append-failed");
  }

  #requireCurrentWriter(): void {
    this.#requireWriter();
    if (this.#version !== currentVersion)
      throw new AuditStoreError("invalid-event");
  }

  #appendTransaction(write: (recordedAt: string) => void): void {
    try {
      this.#database.exec("BEGIN IMMEDIATE");
      write(new Date().toISOString());
      this.#database.exec("COMMIT");
    } catch {
      // A failed COMMIT may be ambiguous. Do not retry the privileged effect.
      this.#writeFailed = true;
      try {
        this.#database.exec("ROLLBACK");
      } catch {
        /* Connection is quarantined for writes. */
      }
      this.#notifyV5Unwritable();
      throw new AuditStoreError("append-failed");
    }
  }

  #insert(
    table: AuditExportTable,
    recordedAt: string,
    fields: Record<string, Binding>,
  ): void {
    // The column names and table are built exclusively from parsed host fields.
    const columns = Object.keys(fields).map(columnName);
    this.#database
      .query(
        `INSERT INTO ${table} (recorded_at, ${columns.join(", ")}) VALUES (?, ${columns.map(() => "?").join(", ")})`,
      )
      .run(recordedAt, ...Object.values(fields));
    if (
      record(this.#database.query("SELECT changes() AS count").get()).count !==
      1
    )
      throw new AuditStoreError("append-failed");
  }

  append(event: AuditInput): void {
    this.#requireWriter();
    const input = parseInput(event);
    if (this.#version < 7 && input.profile === "bun")
      throw new AuditStoreError("invalid-event");
    if (
      this.#version < 6 &&
      (input.role === "Concierge" ||
        input.profile === "concierge" ||
        input.detail !== undefined)
    )
      throw new AuditStoreError("invalid-event");
    // Older traces must never silently lose profile or verification evidence.
    if (
      this.#version < 4 &&
      (input.profile !== undefined ||
        input.image !== undefined ||
        input.role === "Verification")
    )
      throw new AuditStoreError("invalid-event");
    this.#appendTransaction((recordedAt) =>
      this.#insert("audit_events", recordedAt, {
        invocationId: input.invocationId,
        kind: input.kind,
        operation: input.operation ?? null,
        outcome: input.outcome ?? null,
        role: input.role ?? null,
        ...(this.#version >= 4
          ? { profile: input.profile ?? null, image: input.image ?? null }
          : {}),
        ...(this.#version >= 6
          ? { detail: input.detail ? JSON.stringify(input.detail) : null }
          : {}),
      }),
    );
  }

  appendExecutionContext(context: ExecutionContext): void {
    this.#requireCurrentWriter();
    const input = parseAuditContext(context);
    this.#appendTransaction((recordedAt) =>
      this.#insert("execution_contexts", recordedAt, {
        invocationId: input.executionId,
        sessionId: input.sessionId ?? null,
        retryOfExecutionId: input.retryOfExecutionId ?? null,
        correlationId: input.correlationId ?? null,
        traceparent: input.traceContext?.traceparent ?? null,
        attributes:
          input.attributes === undefined
            ? null
            : JSON.stringify(input.attributes),
      }),
    );
  }

  appendSandboxBinding(binding: SandboxBindingInput): void {
    this.#requireCurrentWriter();
    const input = parseBinding(binding);
    this.#appendTransaction((recordedAt) =>
      this.#insert("sandbox_bindings", recordedAt, input),
    );
  }

  appendProcessResult(result: ProcessResultInput): void {
    this.#requireCurrentWriter();
    const input = parseProcess(result);
    this.#appendTransaction((recordedAt) =>
      this.#insert("process_results", recordedAt, {
        ...input,
        guestReported: Number(input.guestReported),
      }),
    );
  }

  /** Return only once both the request and decision are durably committed. */
  appendNetwork(network: NetworkInput): void {
    this.#requireCurrentWriter();
    const {
      connectionId: flowId,
      decision,
      policyId,
      reasonCode,
      ...target
    } = parseNetwork(network);
    this.#appendTransaction((recordedAt) => {
      const base = { ...target, flowId, protocol: "tcp" };
      this.#insert("network_events", recordedAt, {
        ...base,
        phase: "requested",
      });
      this.#insert("network_events", recordedAt, {
        ...base,
        phase: "decided",
        decision,
        policyId,
        reasonCode,
      });
    });
  }

  appendNetworkFinished(network: NetworkFinishedInput): void {
    this.#requireCurrentWriter();
    const { connectionId: flowId, ...input } = parseFinished(network);
    this.#appendTransaction((recordedAt) => {
      const grant = this.#database
        .query(
          "SELECT decision FROM network_events WHERE invocation_id = ? AND sandbox_id = ? AND flow_id = ? AND phase = 'decided'",
        )
        .get(input.invocationId, input.sandboxId, flowId);
      if (!grant || record(grant).decision !== "allow")
        throw new AuditStoreError("append-failed");
      this.#insert("network_events", recordedAt, {
        ...input,
        flowId,
        phase: "finished",
        protocol: "tcp",
      });
    });
  }

  appendDnsQuery(query: DnsQueryInput): void {
    this.#requireCurrentWriter();
    const {
      queryId: flowId,
      qname,
      answerIps: answers,
      ...input
    } = parseDns(query);
    this.#appendTransaction((recordedAt) =>
      this.#insert("network_events", recordedAt, {
        ...input,
        flowId,
        phase: "dns",
        hostname: qname,
        answerIps: JSON.stringify(answers),
      }),
    );
  }

  appendResourceEvent(event: ResourceEventInput): void {
    this.#requireCurrentWriter();
    const input = parseResource(event);
    this.#appendTransaction((recordedAt) =>
      this.#insert("resource_events", recordedAt, input),
    );
  }

  /** Claims identity only, not successful execution. A crash after claiming
   * requires host reconciliation; replay never implicitly retries an effect. */
  claimRequest(request: RequestClaimInput): RequestClaim {
    this.#requireWriter();
    const input = parseClaimInput(request);
    let conflict = false;
    try {
      this.#database.exec("BEGIN IMMEDIATE");
      const existing = this.#database
        .query(
          "SELECT * FROM request_claims WHERE task_id = ? AND request_kind = ? AND key_digest = ?",
        )
        .get(input.taskId, input.requestKind, input.keyDigest);
      if (existing !== null && existing !== undefined) {
        const claimed = parseClaimRow(existing);
        if (claimed.fingerprint !== input.fingerprint) {
          conflict = true;
          throw new AuditStoreError("request-conflict");
        }
        this.#database.exec("COMMIT");
        return { id: claimed.id, replayed: true };
      }
      const id = randomUUID();
      this.#database
        .query(
          "INSERT INTO request_claims (recorded_at, id, task_id, request_kind, key_digest, fingerprint) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .run(
          new Date().toISOString(),
          id,
          input.taskId,
          input.requestKind,
          input.keyDigest,
          input.fingerprint,
        );
      if (
        record(this.#database.query("SELECT changes() AS count").get())
          .count !== 1
      )
        throw new AuditStoreError("append-failed");
      this.#database.exec("COMMIT");
      return { id, replayed: false };
    } catch {
      let rollbackFailed = false;
      try {
        this.#database.exec("ROLLBACK");
      } catch {
        rollbackFailed = true;
      }
      if (!conflict || rollbackFailed) {
        this.#writeFailed = true;
        this.#notifyV5Unwritable();
      }
      throw new AuditStoreError(
        conflict && !rollbackFailed ? "request-conflict" : "append-failed",
      );
    }
  }

  read(id: string): AuditEvent[] {
    if (this.#closed) throw new AuditStoreError("closed");
    const validated = invocationId(id);
    try {
      return this.#database
        .query(
          "SELECT * FROM audit_events WHERE invocation_id = ? ORDER BY sequence",
        )
        .all(validated)
        .map(parseRow);
    } catch {
      throw new AuditStoreError("read-failed");
    }
  }

  #readTable<K extends AuditExportTable>(
    table: K,
    criteria: "invocation_id = ?" | "sequence > ?",
    value: Binding,
  ): ExportTables[K][] {
    if (table !== "audit_events" && this.#version < 5) return [];
    const parse: (row: unknown) => ExportTables[K] = tableReaders[table];
    return this.#database
      .query(`SELECT * FROM ${table} WHERE ${criteria} ORDER BY sequence`)
      .all(value)
      .map(parse);
  }

  #readSnapshot<T>(read: () => T): T {
    if (this.#closed) throw new AuditStoreError("closed");
    try {
      this.#database.exec("BEGIN");
      const result = read();
      this.#database.exec("COMMIT");
      return result;
    } catch {
      try {
        this.#database.exec("ROLLBACK");
      } catch {
        /* Never expose SQLite diagnostics. */
      }
      throw new AuditStoreError("read-failed");
    }
  }

  readExecution(id: string): ExecutionAudit {
    if (this.#closed) throw new AuditStoreError("closed");
    const validated = invocationId(id);
    const criteria = "invocation_id = ?";
    return this.#readSnapshot(() => ({
      auditEvents: this.#readTable("audit_events", criteria, validated),
      executionContexts: this.#readTable(
        "execution_contexts",
        criteria,
        validated,
      ),
      sandboxBindings: this.#readTable("sandbox_bindings", criteria, validated),
      processResults: this.#readTable("process_results", criteria, validated),
      networkEvents: this.#readTable("network_events", criteria, validated),
      resourceEvents: this.#readTable("resource_events", criteria, validated),
    }));
  }

  /** Rows follow table order, then sequence. Request claims are task-scoped
   * private deduplication state and are excluded from execution exports. */
  readSince(sequenceWatermark: AuditSequenceWatermark): AuditExportRecord[] {
    if (this.#closed) throw new AuditStoreError("closed");
    const fields = dataFields(sequenceWatermark, exportTables);
    const cursors = exportTables.map((table) =>
      integer(Object.hasOwn(fields, table) ? fields[table] : 0, 0),
    );
    return this.#readSnapshot(() =>
      exportTables.flatMap((table, index) =>
        this.#readTable(table, "sequence > ?", cursors[index]!).map(
          (row) => ({ ...row, table }) as AuditExportRecord,
        ),
      ),
    );
  }

  incompleteNetwork(id: string): (Extract<
    NetworkEvent,
    { phase: "decided" }
  > & {
    readonly outcome: "unknown";
  })[] {
    if (this.#closed) throw new AuditStoreError("closed");
    const validated = invocationId(id);
    return this.#readSnapshot(() => {
      const pending = new Map<
        string,
        Extract<NetworkEvent, { phase: "decided" }>
      >();
      for (const event of this.#readTable(
        "network_events",
        "invocation_id = ?",
        validated,
      )) {
        if (event.phase === "decided" && event.decision === "allow")
          pending.set(connectionKey(event), event);
        else if (event.phase === "finished")
          pending.delete(connectionKey(event));
      }
      return [...pending.values()].map((event) => ({
        ...event,
        outcome: "unknown" as const,
      }));
    });
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#notifyV5Unwritable();
    try {
      this.#database.close();
    } catch {
      throw new AuditStoreError("read-failed");
    }
  }
}
