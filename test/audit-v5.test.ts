import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import {
  AuditStoreError,
  SqliteAudit,
  auditSchemaSql,
  type AuditSequenceWatermark,
  type DnsQueryInput,
  type NetworkFinishedInput,
  type NetworkInput,
  type SandboxBindingInput,
} from "../src/audit.ts";

interface Db {
  exec(sql: string): unknown;
  query(sql: string): {
    get(...bindings: (string | number)[]): Record<string, unknown> | null;
    run(...bindings: (string | number)[]): unknown;
  };
  close(): void;
}
const { Database } = createRequire(import.meta.url)("bun:sqlite") as {
  Database: new (filename: string, options: { create: boolean }) => Db;
};

const digest = "a".repeat(64);
const traceparent = "00-0123456789abcdef0123456789abcdef-0123456789abcdef-01";
const invocationId = randomUUID();
const sandboxId = `bootstrap-${randomUUID()}`;

function fixture(t: TestContext): string {
  const directory = mkdtempSync(join(tmpdir(), "bootstrap-audit-v5-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return join(directory, "audit.sqlite");
}

function legacy(filename: string, version: 1 | 2 | 3 | 4): void {
  const db = new Database(filename, { create: true });
  try {
    db.exec("PRAGMA journal_mode=WAL");
    db.exec("BEGIN IMMEDIATE");
    for (const sql of auditSchemaSql(version)) db.exec(sql);
    db.exec(
      `PRAGMA application_id=${0x41424731}; PRAGMA user_version=${version}; COMMIT`,
    );
  } finally {
    db.close();
  }
}

function withDb<T>(filename: string, work: (db: Db) => T): T {
  const db = new Database(filename, { create: false });
  try {
    return work(db);
  } finally {
    db.close();
  }
}

function errorCode(code: string) {
  return (error: unknown) =>
    error instanceof AuditStoreError && error.code === code;
}

const started = { invocationId, kind: "invocation.started" } as const;
const context = {
  executionId: invocationId,
  sessionId: randomUUID(),
  retryOfExecutionId: randomUUID(),
  correlationId: randomUUID(),
  traceContext: { traceparent, tracestate: "solver=sampled" },
  attributes: { suite: "local", ratio: 0.5, sampled: true },
};
const binding: SandboxBindingInput = {
  invocationId,
  sandboxId,
  runtimeKind: "microsandbox",
  egressMode: "gateway",
  netRuleDigest: digest,
  gatewayPolicyId: digest,
  gatewayPolicyDigest: digest,
};
const processResult = {
  invocationId,
  operation: "sandbox.exec",
  exitCode: 17,
  signal: null,
  guestReported: true,
} as const;
const network = {
  invocationId,
  sandboxId,
  connectionId: randomUUID(),
  channel: "provider-egress",
  destinationIp: "2001:db8::1",
  destinationPort: 443,
  hostname: "provider.example",
  decision: "allow",
  reasonCode: "allowlisted-host",
  policyId: digest,
} as const satisfies NetworkInput;
const finished = {
  invocationId,
  sandboxId,
  connectionId: network.connectionId,
  result: "connected",
  endReason: "upstream-closed",
  bytesSent: Number.MAX_SAFE_INTEGER,
  bytesReceived: 42,
  durationMs: 12.5,
} as const satisfies NetworkFinishedInput;
const resource = { invocationId, sandboxId, kind: "timed-out" } as const;
const dns = {
  invocationId,
  sandboxId,
  queryId: randomUUID(),
  qname: "provider.example",
  qtype: 28,
  protocol: "udp",
  decision: "allow",
  reasonCode: "allowlisted-host",
  policyId: digest,
  answerIps: ["2001:db8::1"],
} as const satisfies DnsQueryInput;
const claim = {
  taskId: randomUUID(),
  requestKind: "integration",
  keyDigest: digest,
  fingerprint: digest,
} as const;

function v5Appends(audit: SqliteAudit): (() => void)[] {
  return [
    () => audit.appendExecutionContext(context),
    () => audit.appendSandboxBinding(binding),
    () => audit.appendProcessResult(processResult),
    () => audit.appendNetwork(network),
    () => audit.appendNetworkFinished(finished),
    () => audit.appendDnsQuery(dns),
    () => audit.appendResourceEvent(resource),
  ];
}

test("fresh v5 stores and reopens every kind of evidence", (t) => {
  const filename = fixture(t);
  const audit = new SqliteAudit(filename);
  t.after(() => audit.close());
  assert.equal(audit.schemaVersion, 5);
  assert.equal(audit.isV5Writable, true);
  audit.append(started);
  audit.claimRequest(claim);
  for (const append of v5Appends(audit)) append();
  audit.close();

  withDb(filename, (db) => {
    assert.equal(db.query("PRAGMA user_version").get()?.user_version, 5);
    assert.equal(db.query("PRAGMA journal_mode").get()?.journal_mode, "wal");
    assert.equal(db.query("PRAGMA quick_check").get()?.quick_check, "ok");
  });
  // Both constructors also assert WAL and synchronous=FULL on their own connection.
  const reader = new SqliteAudit(filename, { readonly: true });
  t.after(() => reader.close());
  assert.equal(reader.isV5Writable, false);
  assert.throws(() => reader.appendDnsQuery(dns), errorCode("read-only"));

  const execution = reader.readExecution(invocationId);
  assert.deepEqual(execution.auditEvents, reader.read(invocationId));
  const data = <T extends { sequence: number; recordedAt: string }>(
    rows: T[],
  ) =>
    rows.map(({ sequence, recordedAt, ...fields }) => {
      assert.ok(sequence > 0);
      assert.equal(new Date(recordedAt).toISOString(), recordedAt);
      return fields;
    });
  assert.deepEqual(data(execution.executionContexts), [
    { ...context, traceContext: { traceparent } },
  ]);
  assert.deepEqual(data(execution.sandboxBindings), [binding]);
  assert.deepEqual(data(execution.processResults), [processResult]);
  assert.deepEqual(data(execution.resourceEvents), [resource]);
  const {
    decision: _decision,
    policyId: _policy,
    reasonCode: _reason,
    ...requested
  } = network;
  assert.deepEqual(data(execution.networkEvents), [
    { ...requested, phase: "requested", protocol: "tcp" },
    { ...network, phase: "decided", protocol: "tcp" },
    { ...finished, phase: "finished", protocol: "tcp" },
    { ...dns, phase: "dns" },
  ]);
  assert.equal(
    execution.networkEvents[1]?.sequence,
    execution.networkEvents[0]!.sequence + 1,
  );
  assert.equal(
    execution.networkEvents[1]?.recordedAt,
    execution.networkEvents[0]?.recordedAt,
  );
  assert.deepEqual(reader.incompleteNetwork(invocationId), []);
  assert.ok(
    Object.values(reader.readExecution(randomUUID())).every(
      (rows) => rows.length === 0,
    ),
  );
});

test("export watermarks resume independently for each execution table", (t) => {
  const audit = new SqliteAudit(fixture(t));
  t.after(() => audit.close());
  audit.append(started);
  audit.appendNetwork(network);
  audit.appendExecutionContext(context);
  audit.claimRequest(claim);
  const records = audit.readSince({});
  assert.deepEqual(
    records.map(({ table, sequence }) => [table, sequence]),
    [
      ["audit_events", 1],
      ["execution_contexts", 1],
      ["network_events", 1],
      ["network_events", 2],
    ],
  );
  const watermark: AuditSequenceWatermark = {
    audit_events: 1,
    execution_contexts: 1,
    network_events: 2,
  };
  assert.deepEqual(audit.readSince(watermark), []);
  audit.appendNetworkFinished(finished);
  audit.appendDnsQuery(dns);
  audit.appendResourceEvent(resource);
  assert.deepEqual(
    audit.readSince(watermark).map(({ table, sequence }) => [table, sequence]),
    [
      ["network_events", 3],
      ["network_events", 4],
      ["resource_events", 1],
    ],
  );
  for (const value of [-1, 0.5, Infinity, Number.MAX_SAFE_INTEGER + 1])
    assert.throws(
      () => audit.readSince({ network_events: value }),
      errorCode("invalid-event"),
    );
});

test("read-only v4 is preserved and write-open upgrades without changing existing tables or rows", (t) => {
  const filename = fixture(t);
  legacy(filename, 4);
  withDb(filename, (db) => {
    db.query(
      "INSERT INTO audit_events (recorded_at, invocation_id, kind, operation, role, profile, image) VALUES (?, ?, 'operation.requested', 'sandbox.create', 'Verification', 'base', ?)",
    ).run(new Date().toISOString(), invocationId, digest);
    db.query(
      "INSERT INTO request_claims (recorded_at, id, task_id, request_kind, key_digest, fingerprint) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(
      new Date().toISOString(),
      randomUUID(),
      claim.taskId,
      claim.requestKind,
      claim.keyDigest,
      claim.fingerprint,
    );
  });
  const reader = new SqliteAudit(filename, { readonly: true });
  const expected = reader.readExecution(invocationId);
  assert.equal(reader.schemaVersion, 4);
  assert.equal(reader.readSince({}).length, 1);
  reader.close();
  assert.equal(
    withDb(
      filename,
      (db) => db.query("PRAGMA user_version").get()?.user_version,
    ),
    4,
  );

  const writer = new SqliteAudit(filename);
  t.after(() => writer.close());
  assert.equal(writer.schemaVersion, 5);
  assert.deepEqual(writer.readExecution(invocationId), expected);
  assert.equal(writer.claimRequest(claim).replayed, true);
  writer.appendExecutionContext(context);
  assert.equal(writer.readExecution(invocationId).executionContexts.length, 1);
  assert.deepEqual(
    auditSchemaSql(5).slice(0, auditSchemaSql(4).length),
    auditSchemaSql(4),
  );
});

test("v1 through v3 refuse every v5 append while accepting legacy evidence", (t) => {
  for (const version of [1, 2, 3] as const) {
    const filename = fixture(t);
    legacy(filename, version);
    const audit = new SqliteAudit(filename);
    t.after(() => audit.close());
    assert.equal(audit.schemaVersion, Math.max(2, version));
    assert.equal(audit.isV5Writable, false);
    for (const append of v5Appends(audit))
      assert.throws(append, errorCode("invalid-event"));
    audit.append(started);
    assert.equal(audit.readExecution(invocationId).auditEvents.length, 1);
    assert.deepEqual(audit.incompleteNetwork(invocationId), []);
  }
});

test("every audit table blocks updates and deletes", (t) => {
  const filename = fixture(t);
  const audit = new SqliteAudit(filename);
  audit.append(started);
  audit.claimRequest(claim);
  for (const append of v5Appends(audit)) append();
  audit.close();
  withDb(filename, (db) => {
    for (const table of [
      "audit_events",
      "request_claims",
      "execution_contexts",
      "sandbox_bindings",
      "process_results",
      "network_events",
      "resource_events",
    ]) {
      assert.throws(
        () => db.exec(`UPDATE ${table} SET recorded_at = 'x'`),
        /append-only/,
      );
      assert.throws(() => db.exec(`DELETE FROM ${table}`), /append-only/);
    }
  });
});

test("exact-schema validation refuses a replaced v5 trigger", (t) => {
  const filename = fixture(t);
  new SqliteAudit(filename).close();
  withDb(filename, (db) => {
    db.exec("DROP TRIGGER network_events_no_update");
    db.exec(
      "CREATE TRIGGER network_events_no_update BEFORE UPDATE ON network_events BEGIN SELECT 1; END",
    );
  });
  for (const readonly of [true, false])
    assert.throws(
      () => new SqliteAudit(filename, { readonly }),
      errorCode("open-failed"),
    );
});

test("quick_check rejects persisted CHECK violations", (t) => {
  const filename = fixture(t);
  new SqliteAudit(filename).close();
  withDb(filename, (db) => {
    db.exec("PRAGMA ignore_check_constraints=ON");
    db.query(
      "INSERT INTO resource_events (recorded_at, invocation_id, kind) VALUES (?, ?, 'forged')",
    ).run(new Date().toISOString(), invocationId);
    db.exec("PRAGMA ignore_check_constraints=OFF");
    assert.notEqual(db.query("PRAGMA quick_check").get()?.quick_check, "ok");
  });
  assert.throws(() => new SqliteAudit(filename), errorCode("open-failed"));
});

test("open rejects rows that satisfy SQLite checks but violate v5 validation", (t) => {
  for (const [sql, params] of [
    [
      "INSERT INTO execution_contexts (recorded_at, invocation_id, attributes) VALUES (?, ?, ?)",
      [JSON.stringify({ password: "synthetic" })],
    ],
    [
      "INSERT INTO network_events (recorded_at, invocation_id, sandbox_id, flow_id, phase, protocol) VALUES (?, ?, ?, ?, 'requested', 'tcp')",
      [sandboxId, randomUUID()],
    ],
  ] as const) {
    const filename = fixture(t);
    new SqliteAudit(filename).close();
    withDb(filename, (db) => {
      db.query(sql).run(new Date().toISOString(), invocationId, ...params);
      assert.equal(db.query("PRAGMA quick_check").get()?.quick_check, "ok");
    });
    assert.throws(
      () => new SqliteAudit(filename, { readonly: true }),
      errorCode("open-failed"),
    );
  }
});

test("network and context inputs reject unbounded or sensitive fields", (t) => {
  const audit = new SqliteAudit(fixture(t));
  t.after(() => audit.close());
  for (const attributes of [
    { api_key: "synthetic" },
    { label: "Bearer sample-credential" },
    { label: digest },
    { label: "/private/location" },
  ])
    assert.throws(
      () => audit.appendExecutionContext({ ...context, attributes }),
      errorCode("invalid-event"),
    );

  for (const change of [
    { destinationIp: "::ffff:192.0.2.1" },
    { destinationIp: "64:ff9b::c000:201" },
    { destinationIp: "2001:0db8::1" },
    { destinationIp: "192.000.2.1" },
    { destinationPort: 0 },
    { destinationPort: 65536 },
    { hostname: "a".repeat(254) },
    { hostname: "example.com/secret" },
    { hostname: "example.com\n" },
    { reasonCode: "unexpected" },
    { headers: { authorization: "synthetic" } },
  ])
    assert.throws(
      () => audit.appendNetwork({ ...network, ...change } as NetworkInput),
      errorCode("invalid-event"),
    );

  audit.appendNetwork(network);
  for (const change of [
    { endReason: "untrusted" },
    { bytesSent: Number.MAX_SAFE_INTEGER + 1 },
    { bytesReceived: -1 },
    { durationMs: Infinity },
  ])
    assert.throws(
      () =>
        audit.appendNetworkFinished({
          ...finished,
          ...change,
        } as NetworkFinishedInput),
      errorCode("invalid-event"),
    );

  assert.throws(
    () =>
      audit.appendDnsQuery({
        ...dns,
        decision: "deny",
        reasonCode: "dns-not-allowlisted",
      }),
    errorCode("invalid-event"),
  );
  audit.appendNetworkFinished(finished);
  audit.appendExecutionContext(context);
  assert.equal(audit.isV5Writable, true);
});

test("a statement failure rolls back the whole network pair and quarantines all writes", (t) => {
  const filename = fixture(t);
  const audit = new SqliteAudit(filename);
  t.after(() => audit.close());
  let notifications = 0;
  audit.onV5Unwritable(() => {
    throw new Error("fixture subscriber");
  });
  audit.onV5Unwritable(() => {
    assert.equal(audit.isV5Writable, false);
    notifications++;
  });
  const unsubscribe = audit.onV5Unwritable(() => {
    notifications += 100;
  });
  unsubscribe();
  withDb(filename, (db) =>
    db.exec(
      "CREATE TRIGGER fail_decision BEFORE INSERT ON network_events WHEN NEW.phase = 'decided' BEGIN SELECT RAISE(ABORT, 'fixture'); END",
    ),
  );
  assert.throws(() => audit.appendNetwork(network), errorCode("append-failed"));
  withDb(filename, (db) => db.exec("DROP TRIGGER fail_decision"));
  assert.deepEqual(audit.readExecution(invocationId).networkEvents, []);
  for (const append of [
    ...v5Appends(audit),
    () => audit.append(started),
    () => audit.claimRequest(claim),
  ])
    assert.throws(append, errorCode("append-failed"));
  assert.equal(audit.isV5Writable, false);
  audit.close();
  assert.equal(notifications, 1);
  audit.onV5Unwritable(() => notifications++);
  assert.equal(notifications, 2);
});

test("a draft v5 layout without the capacity reason is refused, never rebuilt", (t) => {
  const filename = fixture(t);
  new Database(filename, { create: true }).close();
  withDb(filename, (db) => {
    db.exec("PRAGMA journal_mode=WAL");
    for (const sql of auditSchemaSql(5))
      db.exec(sql.replace(",'capacity'", ""));
    db.exec(`PRAGMA application_id=${0x41424731}; PRAGMA user_version=5`);
  });
  // Append-only tables are never rewritten in place: the exact schema check
  // refuses the draft layout for both readers and writers.
  assert.throws(() => new SqliteAudit(filename, { readonly: true }));
  assert.throws(() => new SqliteAudit(filename));
  withDb(filename, (db) => {
    const trigger = db
      .query("SELECT name FROM sqlite_schema WHERE name = ?")
      .get("network_events_no_update");
    const copy = db
      .query("SELECT name FROM sqlite_schema WHERE name = ?")
      .get("original_network_events");
    assert.ok(trigger);
    assert.equal(copy, null);
  });
});

test("closing a writable store notifies its subscribers once", (t) => {
  const audit = new SqliteAudit(fixture(t));
  let notifications = 0;
  audit.onV5Unwritable(() => {
    assert.equal(audit.isV5Writable, false);
    notifications++;
  });
  audit.close();
  audit.close();
  assert.equal(notifications, 1);
});

test("denials remain distinct from missing allowed outcomes and cannot be finished", (t) => {
  const audit = new SqliteAudit(fixture(t));
  t.after(() => audit.close());
  const deniedId = randomUUID();
  audit.appendNetwork({
    invocationId,
    sandboxId,
    connectionId: deniedId,
    decision: "deny",
    reasonCode: "auth-failed",
    policyId: digest,
  });
  audit.appendNetwork(network);
  assert.deepEqual(
    audit
      .incompleteNetwork(invocationId)
      .map(({ connectionId }) => connectionId),
    [network.connectionId],
  );
  assert.throws(
    () => audit.appendNetworkFinished({ ...finished, connectionId: deniedId }),
    errorCode("append-failed"),
  );
  assert.equal(audit.isV5Writable, false);
});

test("a killed writer leaves a durable decision and a derived unknown outcome", async (t) => {
  const filename = fixture(t);
  const auditModule = new URL("../src/audit.ts", import.meta.url).href;
  const child = spawn(
    process.execPath,
    [
      "-e",
      `import { SqliteAudit } from ${JSON.stringify(auditModule)};
     const audit = new SqliteAudit(process.argv[1]);
     audit.appendNetwork(${JSON.stringify(network)});
     process.stdout.write("committed\\n");
     setInterval(() => {}, 1000);`,
      filename,
    ],
    { stdio: ["ignore", "pipe", "ignore"] },
  );
  t.after(() => {
    child.kill("SIGKILL");
  });
  const exited = once(child, "exit");
  let output = "";
  for await (const chunk of child.stdout) {
    output += String(chunk);
    if (output.includes("\n")) {
      child.kill("SIGKILL");
      break;
    }
  }
  assert.equal(output, "committed\n");
  const [code, signal] = await exited;
  assert.equal(code, null);
  assert.equal(signal, "SIGKILL");
  const reopened = new SqliteAudit(filename, { readonly: true });
  t.after(() => reopened.close());
  assert.deepEqual(
    reopened
      .readExecution(invocationId)
      .networkEvents.map(({ phase }) => phase),
    ["requested", "decided"],
  );
  assert.deepEqual(
    reopened
      .incompleteNetwork(invocationId)
      .map(({ connectionId, outcome }) => [connectionId, outcome]),
    [[network.connectionId, "unknown"]],
  );
});
