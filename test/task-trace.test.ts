import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test, { type TestContext } from "node:test";
import {
  auditSchemaSql,
  SqliteAudit,
  type NetworkInput,
} from "../src/audit.ts";
import { CoordinatorTask } from "../src/coordinator.ts";

const script = fileURLToPath(new URL("../src/trace.ts", import.meta.url));
const digest = "a".repeat(64);

function fixture(t: TestContext) {
  const root = mkdtempSync(
    join(realpathSync(tmpdir()), "bootstrap-task-trace-"),
  );
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, filename: join(root, "audit.sqlite") };
}

function runTrace(...args: string[]) {
  const result = spawnSync(process.execPath, [script, ...args], {
    encoding: "utf8",
    timeout: 60_000,
  });
  if (result.error) throw result.error;
  return result;
}

function readTrace(...args: string[]) {
  const result = runTrace(...args);
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout, /[\u0085\u202e]/u);
  return JSON.parse(result.stdout);
}

function auditBytes(filename: string) {
  return ["", "-wal"].map((suffix) => {
    const path = filename + suffix;
    return existsSync(path) ? readFileSync(path) : null;
  });
}

test("invocation and task views show the same v5 evidence and keep connection outcomes distinct", async (t) => {
  const { root, filename } = fixture(t);
  const taskId = randomUUID();
  let turns = 0;
  const unexpected = () => {
    throw new Error("Unexpected Coordinator operation");
  };
  const task = new CoordinatorTask(root, taskId, {
    async step(_control, id) {
      const action =
        turns++ === 0
          ? { tool: "delegate", key: "one", role: "Worker" }
          : { done: true };
      return { id, response: Buffer.from(JSON.stringify(action)) };
    },
    async delegate(_role, _control, id) {
      return { id, outcome: "ok" };
    },
    reviewedCandidate: unexpected,
    decide: unexpected,
  });
  await task.submit("Fixture");
  assert.equal(await task.run(), "done");
  const journal = await task.trace();
  const turn = journal.find((row) => row.kind === "turn.started");
  const delegation = journal.find((row) => row.kind === "delegate.finished");
  assert.ok(turn);
  assert.ok(delegation);

  const sandboxId = `bootstrap-${randomUUID()}`;
  const otherSandbox = `bootstrap-${randomUUID()}`;
  const connectionId = randomUUID();
  const deniedId = randomUUID();
  const unrelatedId = randomUUID();
  const label = "left\u202eright";
  const audit = new SqliteAudit(filename);
  t.after(() => audit.close());
  audit.append({
    invocationId: turn.run,
    kind: "invocation.started",
    role: "Coordinator",
  });
  audit.appendExecutionContext({
    executionId: turn.run,
    sessionId: taskId,
    traceContext: {
      traceparent: "00-0123456789abcdef0123456789abcdef-0123456789abcdef-01",
    },
    attributes: { label },
  });
  audit.appendSandboxBinding({
    invocationId: turn.run,
    sandboxId,
    runtimeKind: "microsandbox",
    egressMode: "gateway",
    netRuleDigest: digest,
    gatewayPolicyId: digest,
    gatewayPolicyDigest: digest,
  });
  audit.appendProcessResult({
    invocationId: turn.run,
    operation: "sandbox.exec",
    exitCode: 17,
    signal: null,
    guestReported: true,
  });
  const network = {
    invocationId: turn.run,
    sandboxId,
    connectionId,
    decision: "allow",
    reasonCode: "allowlisted-host",
    channel: "egress",
    destinationIp: "192.0.2.1",
    destinationPort: 443,
    hostname: "provider.example",
    policyId: digest,
  } as const satisfies NetworkInput;
  audit.appendNetwork(network);
  audit.appendNetwork({ ...network, sandboxId: otherSandbox });
  audit.appendNetwork({
    ...network,
    connectionId: deniedId,
    decision: "deny",
    reasonCode: "not-allowlisted",
  });
  audit.appendDnsQuery({
    invocationId: turn.run,
    sandboxId,
    queryId: connectionId,
    protocol: "udp",
    qname: "provider.example",
    qtype: 1,
    answerIps: ["192.0.2.1"],
    decision: "allow",
    reasonCode: "allowlisted-host",
    policyId: digest,
  });
  audit.appendNetworkFinished({
    invocationId: turn.run,
    sandboxId: otherSandbox,
    connectionId,
    result: "connect-failed",
    endReason: "error",
    bytesSent: 0,
    bytesReceived: 0,
    durationMs: 10,
  });
  audit.appendResourceEvent({
    invocationId: turn.run,
    sandboxId,
    kind: "timed-out",
  });
  audit.appendExecutionContext({ executionId: delegation.invocation });
  audit.appendExecutionContext({ executionId: unrelatedId });
  audit.close();
  const before = auditBytes(filename);

  const {
    invocationId: shownId,
    outcome,
    ...invocation
  } = readTrace(filename, turn.run);
  assert.equal(shownId, turn.run);
  assert.equal(outcome, "incomplete");
  assert.equal(invocation.executionContexts[0].attributes.label, label);
  assert.equal(invocation.executionContexts[0].sessionId, taskId);
  assert.equal(invocation.sandboxBindings[0].netRuleDigest, digest);
  assert.equal(invocation.processResults[0].exitCode, 17);
  assert.equal(invocation.processResults[0].guestReported, true);
  assert.equal(invocation.resourceEvents[0].kind, "timed-out");
  const [pending, finished, denied] = invocation.networkConnections;
  assert.equal(invocation.networkConnections.length, 3);
  assert.equal(pending.connectionId, connectionId);
  assert.equal(pending.sandboxId, sandboxId);
  assert.equal(pending.outcome, "unknown");
  assert.deepEqual(
    pending.phases.map((row: { phase: string }) => row.phase),
    ["requested", "decided"],
  );
  assert.equal(finished.connectionId, connectionId);
  assert.equal(finished.sandboxId, otherSandbox);
  assert.equal(finished.outcome, "connect-failed");
  assert.deepEqual(
    finished.phases.map((row: { phase: string }) => row.phase),
    ["requested", "decided", "finished"],
  );
  assert.equal(finished.phases[2].durationMs, 10);
  assert.equal(denied.connectionId, deniedId);
  assert.equal(denied.phases[1].decision, "deny");
  assert.equal(Object.hasOwn(denied, "outcome"), false);
  assert.equal(invocation.dnsQueries[0].queryId, connectionId);
  assert.deepEqual(invocation.dnsQueries[0].answerIps, ["192.0.2.1"]);

  const joined = readTrace("task", filename, root, taskId);
  assert.equal(joined.invocations.length, 2);
  assert.deepEqual(joined.invocations[0], { id: turn.run, ...invocation });
  assert.equal(joined.invocations[1].id, delegation.invocation);
  assert.deepEqual(joined.invocations[1].events, []);
  assert.equal(
    joined.invocations[1].executionContexts[0].executionId,
    delegation.invocation,
  );
  assert.equal(
    readTrace(filename, delegation.invocation).executionContexts[0].executionId,
    delegation.invocation,
  );
  assert.deepEqual(auditBytes(filename), before);
});

test("the trace reads v4 without upgrading it and reports missing invocations", (t) => {
  const { filename } = fixture(t);
  const invocationId = randomUUID();
  const { Database } = createRequire(import.meta.url)("bun:sqlite") as {
    Database: new (path: string) => { exec(sql: string): void; close(): void };
  };
  const db = new Database(filename);
  try {
    db.exec("PRAGMA journal_mode=WAL; BEGIN IMMEDIATE");
    for (const sql of auditSchemaSql(4)) db.exec(sql);
    db.exec(`INSERT INTO audit_events (recorded_at, invocation_id, kind)
        VALUES ('2026-11-23T00:00:00.000Z', '${invocationId}', 'invocation.started');
      PRAGMA application_id=0x41424731; PRAGMA user_version=4; COMMIT`);
  } finally {
    db.close();
  }
  const before = auditBytes(filename);
  const trace = readTrace(filename, invocationId);
  assert.equal(trace.events[0].kind, "invocation.started");
  for (const field of [
    "executionContexts",
    "sandboxBindings",
    "processResults",
    "networkConnections",
    "dnsQueries",
    "resourceEvents",
  ]) {
    assert.deepEqual(trace[field], []);
  }
  const missing = runTrace(filename, randomUUID());
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /Invocation was not found/);
  assert.deepEqual(auditBytes(filename), before);
  const audit = new SqliteAudit(filename, { readonly: true });
  try {
    assert.equal(audit.schemaVersion, 4);
  } finally {
    audit.close();
  }
});
