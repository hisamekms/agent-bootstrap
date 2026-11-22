import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";

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
    | "unknown";
  readonly outcome?:
    "ok" | "denied" | "failed" | "timed-out" | "cancelled" | "interrupted";
  readonly role?: "Worker" | "Planner" | "Reviewer" | "Coordinator";
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

export type AuditEvent = AuditInput & {
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
const roles = ["Worker", "Planner", "Reviewer", "Coordinator"];
const inputKeys = ["invocationId", "kind", "operation", "outcome", "role"];

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

function parseInput(value: unknown): AuditInput {
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
  } = { invocationId: id, kind };
  for (const [key, allowed] of [
    ["operation", operations],
    ["outcome", outcomes],
    ["role", roles],
  ] as const) {
    if (Object.hasOwn(descriptors, key)) {
      const field: unknown = descriptors[key]?.value;
      if (typeof field !== "string" || !allowed.includes(field))
        throw new AuditStoreError("invalid-event");
      result[key] = field;
    }
  }
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
  return result as AuditInput;
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
  const input = parseInput({
    invocationId: row.invocation_id,
    kind: row.kind,
    ...(row.operation === null ? {} : { operation: row.operation }),
    ...(row.outcome === null ? {} : { outcome: row.outcome }),
    ...(row.role === null ? {} : { role: row.role }),
  });
  return { ...input, ...rowMetadata(row) };
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
      let version = record(
        database.query("PRAGMA user_version").get(),
      ).user_version;
      const objects = database
        .query(
          "SELECT name, sql FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*' ORDER BY name",
        )
        .all();
      if (
        !this.#readOnly &&
        app === 0 &&
        version === 0 &&
        objects.length === 0
      ) {
        // This is a recognized empty database, not an unrelated schema. Its
        // first schema commit must initialize WAL too: switching an otherwise
        // idle database to WAL and immediately closing can leave Bun SQLite's
        // read-only reopen unable to initialize the WAL bookkeeping files.
        database.exec("PRAGMA journal_mode=WAL");
        database.exec("BEGIN IMMEDIATE");
        try {
          for (const entry of schema) database.exec(entry.sql);
          database.exec(
            `PRAGMA application_id=${applicationId}; PRAGMA user_version=2; COMMIT`,
          );
          version = 2;
        } catch {
          try {
            database.exec("ROLLBACK");
          } catch {
            /* Closing below discards the connection. */
          }
          throw new AuditStoreError("invalid-database");
        }
      } else if (app !== applicationId || (version !== 1 && version !== 2))
        throw new AuditStoreError("invalid-database");
      const installed = database
        .query(
          "SELECT name, sql FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*'",
        )
        .all();
      const expectedSchema = version === 1 ? auditSchema : schema;
      if (
        installed.length !== expectedSchema.length ||
        !expectedSchema.every((expected) =>
          installed.some((value) => {
            const actual = record(value);
            return actual.name === expected.name && actual.sql === expected.sql;
          }),
        )
      )
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
      if (version === 2) {
        for (const raw of database
          .query("SELECT * FROM request_claims ORDER BY sequence")
          .all())
          parseClaimRow(raw);
      }
      if (!this.#readOnly && version === 1) {
        database.exec("BEGIN IMMEDIATE");
        try {
          for (const entry of claimSchema) database.exec(entry.sql);
          database.exec("PRAGMA user_version=2; COMMIT");
        } catch {
          try {
            database.exec("ROLLBACK");
          } catch {
            /* Closing below discards the connection. */
          }
          throw new AuditStoreError("invalid-database");
        }
      }
      // Change persistent journaling only after recognizing and validating the
      // database. Unrelated SQLite databases are rejected without this mutation.
      if (!this.#readOnly) database.exec("PRAGMA journal_mode=WAL");
      if (
        record(database.query("PRAGMA journal_mode").get()).journal_mode !==
          "wal" ||
        record(database.query("PRAGMA synchronous").get()).synchronous !== 2
      )
        throw new AuditStoreError("invalid-database");
      this.#database = database;
    } catch {
      try {
        database?.close();
      } catch {
        /* Never expose SQLite diagnostics. */
      }
      throw new AuditStoreError("open-failed");
    }
  }

  append(event: AuditInput): void {
    if (this.#closed) throw new AuditStoreError("closed");
    if (this.#readOnly) throw new AuditStoreError("read-only");
    if (this.#writeFailed) throw new AuditStoreError("append-failed");
    const input = parseInput(event);
    try {
      this.#database.exec("BEGIN IMMEDIATE");
      this.#database
        .query(
          "INSERT INTO audit_events (recorded_at, invocation_id, kind, operation, outcome, role) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .run(
          new Date().toISOString(),
          input.invocationId,
          input.kind,
          input.operation ?? null,
          input.outcome ?? null,
          input.role ?? null,
        );
      if (
        record(this.#database.query("SELECT changes() AS count").get())
          .count !== 1
      )
        throw new AuditStoreError("append-failed");
      this.#database.exec("COMMIT");
    } catch {
      // A failed COMMIT may be ambiguous to the caller. Never retry an effect
      // on that basis; fail closed and require reopening/trace reconciliation.
      this.#writeFailed = true;
      try {
        this.#database.exec("ROLLBACK");
      } catch {
        /* Connection is quarantined for writes. */
      }
      throw new AuditStoreError("append-failed");
    }
  }

  /** Claims identity only, not successful execution. A crash after claiming
   * requires host reconciliation; replay never implicitly retries an effect. */
  claimRequest(request: RequestClaimInput): RequestClaim {
    if (this.#closed) throw new AuditStoreError("closed");
    if (this.#readOnly) throw new AuditStoreError("read-only");
    if (this.#writeFailed) throw new AuditStoreError("append-failed");
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
      if (!conflict || rollbackFailed) this.#writeFailed = true;
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

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    try {
      this.#database.close();
    } catch {
      throw new AuditStoreError("read-failed");
    }
  }
}
