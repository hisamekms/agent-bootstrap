import { addProject } from "../src/config/projects.ts";
import { configEnv, initConfigRepo } from "./config-fixture.ts";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import {
  AuditStoreError,
  SqliteAudit,
  type AuditInput,
  type NetworkInput,
} from "../src/audit.ts";
import { exportAudit, exportAuditChecked } from "../src/audit-export.ts";
import { createCredentialScanner } from "../src/local-orchestrator/credential-scan.ts";
import { JsonlFileError, scan } from "../src/jsonl-files.ts";
import { readInvocationTrace } from "../src/task-trace.ts";
import { CLAUDE_MANAGED_PATH } from "../src/claude-code.ts";
import { runCli } from "../src/local-orchestrator/cli.ts";

const now = () => new Date("2026-11-23T01:02:03Z");
const invocationId = "719fcff0-ee4f-4adc-a9af-124be8115e72";
const sandboxId = "bootstrap-4f2c634d-6fb3-43aa-b405-8ecff42b565a";
const policyId = "a".repeat(64);
const traceId = "0123456789abcdef0123456789abcdef";
const network = {
  invocationId,
  sandboxId,
  connectionId: "b4741cf7-5b33-42d5-a8ef-ecf08e3475b9",
  destinationIp: "2001:db8::1",
  destinationPort: 443,
  channel: "provider-egress",
  hostname: "provider.example",
  decision: "allow",
  policyId,
  reasonCode: "allowlisted-host",
} as const satisfies NetworkInput;

const start = { invocationId, kind: "invocation.started" } as const;
const request = {
  invocationId,
  kind: "operation.requested",
  operation: "sandbox.exec",
  role: "Worker",
} as const;
const allowed = { ...request, kind: "operation.allowed" } as const;
const moduleUrl = new URL("../src/audit-export.ts", import.meta.url);

function fixture(t: TestContext) {
  const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "audit-export-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const db = join(root, "audit.sqlite");
  const obs = join(root, "observability");
  const dir = join(obs, "audit");
  const audit = new SqliteAudit(db);
  t.after(() => audit.close());
  return { root, db, obs, dir, audit, state: join(dir, "export-state.json") };
}

function files(dir: string): string[] {
  return fs
    .readdirSync(dir)
    .filter((file) => file.endsWith(".jsonl"))
    .sort();
}

function contents(dir: string): string {
  return files(dir)
    .map((file) => fs.readFileSync(join(dir, file), "utf8"))
    .join("");
}

function lines(dir: string): Record<string, unknown>[] {
  return contents(dir)
    .trimEnd()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

test("exports a non-WAL backup without accepting it as a writable audit", async (t) => {
  const { root, db, obs, dir, audit } = fixture(t);
  audit.append(start);
  const { Database } = createRequire(import.meta.url)("bun:sqlite") as {
    Database: new (filename: string) => {
      run(sql: string, path: string): void;
      close(): void;
    };
  };
  const snapshot = join(root, "audit-backup.sqlite");
  const source = new Database(db);
  try {
    source.run("VACUUM INTO ?", snapshot);
  } finally {
    source.close();
  }
  const before = fs.readFileSync(snapshot);
  exportAudit(snapshot, obs, { now });
  assert.equal(lines(dir)[0]?.executionId, invocationId);
  const out = join(root, "analysis");
  let stderr = "";
  const io = {
    stdin: process.stdin,
    isTTY: false,
    stdout: { write: () => {} },
    stderr: { write: (chunk: string) => (stderr += chunk) },
    prompt: () => {
      throw new Error("unexpected analysis prompt");
    },
  };
  const env = configEnv(root);
  const repo = initConfigRepo(join(root, "repo"));
  addProject(repo, undefined, env);
  assert.equal(
    await runCli(["analyze", "--audit", snapshot, "--out", out], io, repo, env),
    0,
    stderr,
  );
  const target = fs.readdirSync(out).find((name) => name !== "load.sql")!;
  assert.equal(lines(join(out, target, "audit"))[0]?.executionId, invocationId);
  assert.equal(
    await runCli(
      ["--all-targets", "analyze", "--audit", snapshot],
      io,
      repo,
      env,
    ),
    2,
  );
  assert.throws(
    () => new SqliteAudit(snapshot),
    (error) => error instanceof AuditStoreError && error.code === "open-failed",
  );
  assert.deepEqual(fs.readFileSync(snapshot), before);
  assert.equal(fs.existsSync(`${snapshot}-wal`), false);
  assert.equal(fs.existsSync(`${snapshot}-shm`), false);
});

test("projects every execution table into the exact schema with deterministic output", (t) => {
  const { root, db, obs, dir, audit, state } = fixture(t);
  audit.append(start);
  audit.append(request);
  audit.append(allowed);
  audit.append({ ...request, operation: "sandbox.collect" });
  audit.append({
    ...request,
    operation: "sandbox.collect",
    kind: "operation.denied",
    outcome: "denied",
  });
  audit.appendExecutionContext({
    executionId: invocationId,
    sessionId: randomUUID(),
    correlationId: randomUUID(),
    traceContext: {
      traceparent: `00-${traceId}-0123456789abcdef-01`,
      tracestate: "sample=private",
    },
    attributes: { suite: "local", ratio: 0.5 },
  });
  audit.appendSandboxBinding({
    invocationId,
    sandboxId,
    runtimeKind: "microsandbox",
    egressMode: "gateway",
    netRuleDigest: policyId,
    gatewayPolicyId: policyId,
    gatewayPolicyDigest: policyId,
  });
  audit.appendProcessResult({
    invocationId,
    operation: "sandbox.exec",
    exitCode: 17,
    signal: null,
    guestReported: true,
  });
  audit.appendNetwork(network);
  audit.appendDnsQuery({
    invocationId,
    sandboxId,
    queryId: randomUUID(),
    qname: "provider.example",
    qtype: 28,
    protocol: "udp",
    decision: "allow",
    policyId,
    reasonCode: "allowlisted-host",
    answerIps: ["2001:db8::1"],
  });
  audit.appendResourceEvent({ invocationId, sandboxId, kind: "timed-out" });
  audit.claimRequest({
    taskId: randomUUID(),
    requestKind: "integration",
    keyDigest: "b".repeat(64),
    fingerprint: "c".repeat(64),
  });
  audit.close();

  const before = fs.readFileSync(db);
  exportAudit(db, obs, { now });
  const another = join(root, "other");
  exportAudit(db, another, { now });
  assert.equal(contents(dir), contents(join(another, "audit")));
  assert.deepEqual(fs.readFileSync(db), before);
  assert.equal(fs.statSync(state).mode & 0o777, 0o600);

  const records = lines(dir);
  assert.deepEqual(
    records.map((record) => record.auditId),
    [
      "audit_events:1",
      "audit_events:2",
      "audit_events:3",
      "audit_events:4",
      "audit_events:5",
      "execution_contexts:1",
      "sandbox_bindings:1",
      "process_results:1",
      "network_events:1",
      "network_events:2",
      "network_events:3",
      "resource_events:1",
      "derived_audit_events:2",
      "derived_network_events:2",
    ],
  );
  const fields = [
    "auditId",
    "schemaVersion",
    "recordedAt",
    "executionId",
    "sandboxId",
    "operationId",
    "actor",
    "action",
    "target",
    "phase",
    "result",
    "policyId",
    "reasonCode",
    "traceId",
    "attributes",
  ];
  for (const record of records) {
    assert.deepEqual(
      Object.keys(record).sort(),
      [...fields, ...(record.derived ? ["derived"] : [])].sort(),
    );
    assert.equal(record.schemaVersion, "agent-bootstrap.audit/v1");
    assert.equal(record.executionId, invocationId);
    assert.equal(record.sandboxId, sandboxId);
    assert.equal(record.traceId, traceId);
  }
  assert.deepEqual(records[5]?.attributes, { suite: "local", ratio: 0.5 });
  assert.deepEqual(records[7]?.attributes, {
    exitCode: 17,
    signal: null,
    guestReported: true,
  });
  assert.deepEqual(records[10]?.attributes, {
    protocol: "udp",
    qtype: 28,
    answerIps: ["2001:db8::1"],
  });
  assert.equal(records[9]?.target, "[2001:db8::1]:443");
  assert.equal(records[9]?.actor, "gateway");
  assert.equal(records[9]?.policyId, policyId);
  assert.equal(records[9]?.reasonCode, "allowlisted-host");
  assert.equal(records[9]?.phase, "decision");
  assert.equal(records[4]?.result, "deny");
  for (const record of records.slice(-2)) {
    assert.equal(record.derived, true);
    assert.equal(record.phase, "outcome");
    assert.equal(record.result, "unknown");
  }
  assert.equal(records[12]?.operationId, records[2]?.operationId);
  assert.equal(records[13]?.operationId, records[9]?.operationId);
});

test("resumes per table and exports late outcomes without repeating earlier observations", (t) => {
  const { db, obs, dir, audit, state } = fixture(t);
  audit.append(request);
  audit.appendNetwork(network);
  exportAudit(db, obs, { now });
  const initial = contents(dir);
  const checkpoint = fs.readFileSync(state, "utf8");
  exportAudit(db, obs, { now });
  assert.equal(contents(dir), initial);
  assert.equal(fs.readFileSync(state, "utf8"), checkpoint);
  assert.equal(files(dir).length, 1);

  audit.append(allowed);
  exportAudit(db, obs, { now });
  assert.deepEqual(
    lines(dir)
      .slice(-1)
      .map((record) => record.auditId),
    ["audit_events:2"],
  );
  audit.append({ ...request, kind: "operation.finished", outcome: "ok" });
  audit.appendNetworkFinished({
    invocationId,
    sandboxId,
    connectionId: network.connectionId,
    result: "connected",
    endReason: "upstream-closed",
    bytesSent: 10,
    bytesReceived: 5,
    durationMs: 2,
  });
  exportAudit(db, obs, { now });
  const records = lines(dir);
  const results = records.slice(-2);
  assert.deepEqual(
    results.map((record) => [record.auditId, record.phase, record.result]),
    [
      ["audit_events:3", "outcome", "ok"],
      ["network_events:3", "outcome", "connected"],
    ],
  );
  assert.equal(results[0]?.operationId, records[0]?.operationId);
  assert.equal(results[1]?.operationId, network.connectionId);
  assert.equal(results[1]?.target, "[2001:db8::1]:443");
  assert.equal(records.filter((record) => record.derived).length, 2);
  assert.deepEqual(JSON.parse(fs.readFileSync(state, "utf8")).watermark, {
    audit_events: 3,
    network_events: 3,
  });
});

test("after a crash, replays the partial and deduplicates a file published before the checkpoint", (t) => {
  const { db, obs, dir, audit, state } = fixture(t);
  for (let i = 0; i < 3; i++) audit.append(start);
  audit.close();
  const script = `
    import * as fs from "node:fs";
    import { exportAudit, exportAuditChecked } from ${JSON.stringify(moduleUrl.href)};
    let writes = 0;
    exportAudit(${JSON.stringify(db)}, ${JSON.stringify(obs)}, {
      now: () => new Date(${JSON.stringify(now().toISOString())}),
      maxBytes: 600,
      fs: {
        ...fs,
        writeSync(fd, data) {
          if (data.toString("utf8", 0, 11) === '{"auditId":' && ++writes === 2) {
            fs.writeSync(fd, data.subarray(0, 12));
            process.kill(process.pid, "SIGKILL");
          }
          return fs.writeSync(fd, data);
        },
      },
    });
  `;
  const child = spawnSync(process.execPath, ["--eval", script], {
    encoding: "utf8",
  });
  assert.equal(child.signal, "SIGKILL", child.stderr);
  assert.deepEqual(scan(dir), {
    partialFiles: ["2026-11-23-0002.jsonl.partial"],
    truncatedFiles: ["2026-11-23-0002.jsonl.partial"],
  });
  const [partial] = scan(dir).partialFiles;
  const partialPath = join(dir, partial!);
  const interrupted = fs.readFileSync(partialPath);
  assert.deepEqual(files(dir), ["2026-11-23-0001.jsonl"]);
  assert.deepEqual(JSON.parse(fs.readFileSync(state, "utf8")).watermark, {});
  assert.throws(
    () => exportAudit(db, obs, { now }),
    (error) =>
      error instanceof JsonlFileError &&
      error.code === "stale-lock" &&
      error.pid === child.pid,
  );
  fs.unlinkSync(join(dir, "writer.lock"));

  exportAudit(db, obs, { now });
  assert.deepEqual(fs.readFileSync(partialPath), interrupted);
  assert.deepEqual(
    lines(dir).map((record) => record.auditId),
    ["audit_events:1", "audit_events:2", "audit_events:3"],
  );
  const recovered = contents(dir);
  exportAudit(db, obs, { now });
  assert.equal(contents(dir), recovered);
});

test("CLI opens an existing database and refuses a different source for the same output", (t) => {
  const { root, db, obs, dir, audit } = fixture(t);
  const cli = fileURLToPath(moduleUrl);
  const run = (path: string) =>
    spawnSync(process.execPath, [cli, path, obs], { encoding: "utf8" });
  assert.equal(run(db).status, 0);
  audit.append(start);
  assert.equal(run(db).status, 0);
  assert.equal(lines(dir).length, 1);

  const other = join(root, "other.sqlite");
  const alternate = new SqliteAudit(other);
  alternate.close();
  const result = run(other);
  assert.equal(result.status, 1);
  assert.equal(result.stderr.trim(), "Audit export failed");
  assert.equal(lines(dir).length, 1);
});

test("reports checkpoint ENOSPC while holding the lock and resumes without duplicates", (t) => {
  const { db, obs, dir, audit, state } = fixture(t);
  audit.append(start);
  exportAudit(db, obs, { now });
  const checkpoint = fs.readFileSync(state, "utf8");
  audit.append({ ...start, kind: "invocation.finished", outcome: "ok" });
  assert.throws(
    () =>
      exportAudit(db, obs, {
        now,
        fs: {
          ...fs,
          renameSync(from, to) {
            if (to === state) {
              assert.throws(
                () => exportAudit(db, obs, { now }),
                (error) =>
                  error instanceof JsonlFileError &&
                  error.code === "writer-locked",
              );
              throw Object.assign(new Error("test disk full"), {
                code: "ENOSPC",
              });
            }
            fs.renameSync(from, to);
          },
        },
      }),
    (error) => error instanceof JsonlFileError && error.code === "disk-full",
  );
  assert.equal(fs.readFileSync(state, "utf8"), checkpoint);
  assert.equal(fs.existsSync(join(dir, "writer.lock")), false);
  assert.equal(lines(dir).length, 2);
  exportAudit(db, obs, { now });
  assert.equal(lines(dir).length, 2);
  assert.deepEqual(JSON.parse(fs.readFileSync(state, "utf8")).watermark, {
    audit_events: 2,
  });
});

test("exports Concierge create channels and volume reuse with the existing JSONL schema", (t) => {
  const { db, obs, dir, audit } = fixture(t);
  const detail = {
    socketPath: "/fixture/api.sock",
    vsockPort: 5000,
    snapshotDir: "/fixture/repo",
    volumeName: "lo-session",
  };
  audit.append({
    invocationId,
    kind: "operation.requested",
    operation: "sandbox.create",
    role: "Concierge",
    profile: "concierge",
    image: policyId,
    detail,
  });
  const volume = {
    invocationId: randomUUID(),
    role: "Concierge",
    operation: "volume.create",
    detail: { volumeName: detail.volumeName },
  } as const;
  audit.append({ ...volume, kind: "operation.requested" });
  audit.append({ ...volume, kind: "operation.allowed" });
  audit.append({
    ...volume,
    kind: "operation.finished",
    outcome: "ok",
    detail: { ...volume.detail, reused: true },
  });
  audit.append({
    invocationId: randomUUID(),
    kind: "operation.requested",
    operation: "sandbox.create",
    role: "Verification",
    profile: "bun",
    image: policyId,
  });
  exportAudit(db, obs, { now });
  const [row, requested, allowed, finished, bun] = lines(dir);
  assert.equal(row?.schemaVersion, "agent-bootstrap.audit/v1");
  assert.equal(row?.actor, "Concierge");
  assert.deepEqual(row?.attributes, {
    profile: "concierge",
    image: policyId,
    ...detail,
  });
  assert.equal(finished?.action, "volume.create");
  assert.equal(finished?.operationId, requested?.operationId);
  assert.equal(allowed?.operationId, requested?.operationId);
  assert.deepEqual(finished?.attributes, { ...volume.detail, reused: true });
  assert.deepEqual(bun?.attributes, { profile: "bun", image: policyId });
});

test("checked audit export screens projected records before publication", async (t) => {
  const { root, db, obs, dir, audit } = fixture(t);
  audit.append({ ...start, role: "Worker" });
  const notes: string[] = [];
  const scanner = createCredentialScanner(
    { leakPatterns: ["Worker"] },
    root,
    (note) => notes.push(note),
  );
  await assert.rejects(exportAuditChecked(db, obs, scanner), {
    code: "credential-leak",
  });
  assert.deepEqual(files(dir), []);
  assert.equal(notes.length, 1);
  await exportAuditChecked(
    db,
    obs,
    createCredentialScanner({}, root, () => {}),
  );
  assert.equal(lines(dir)[0]?.actor, "Worker");
});

test("reopens a current audit with legacy Claude details, appends, and exports", (t) => {
  const { db, obs, dir, audit } = fixture(t);
  assert.equal(audit.schemaVersion, 8);
  audit.close();
  const conciergeId = randomUUID();
  const reviewer = { invocationId, role: "Reviewer" } as const;
  const concierge = { invocationId: conciergeId, role: "Concierge" } as const;
  const create = {
    kind: "operation.requested",
    operation: "sandbox.create",
  } as const;
  const failed = { kind: "invocation.finished", outcome: "failed" } as const;
  const group = "fixture-group";
  const legacyEvents: (Omit<AuditInput, "detail"> & {
    detail: Record<string, unknown>;
  })[] = [
    {
      ...reviewer,
      ...start,
      detail: {
        authMode: "config-dir",
        settingsDigest: policyId,
        managedPath: CLAUDE_MANAGED_PATH,
        group,
        groupPath: "/claude-config",
      },
    },
    { ...reviewer, ...create, detail: { mode: "config-dir", group } },
    { ...reviewer, ...failed, detail: { code: "credentials-detached" } },
    {
      ...concierge,
      ...create,
      profile: "concierge",
      image: policyId,
      detail: {
        socketPath: "/tmp/fixture.sock",
        vsockPort: 5000,
        snapshotDir: "/tmp/snapshot",
        volumeName: "lo-fixture-volume",
        group,
      },
    },
    { ...concierge, ...failed, detail: { code: "config-tampered" } },
  ];
  const { Database } = createRequire(import.meta.url)("bun:sqlite") as {
    Database: new (filename: string) => {
      run(sql: string, values: (string | null)[]): void;
      close(): void;
    };
  };
  const legacy = new Database(db);
  try {
    for (const event of legacyEvents)
      legacy.run(
        `INSERT INTO audit_events
          (recorded_at, invocation_id, kind, operation, outcome, role, profile, image, detail)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          now().toISOString(),
          event.invocationId,
          event.kind,
          event.operation ?? null,
          event.outcome ?? null,
          event.role ?? null,
          event.profile ?? null,
          event.image ?? null,
          JSON.stringify(event.detail),
        ],
      );
  } finally {
    legacy.close();
  }

  const reopened = new SqliteAudit(db);
  t.after(() => reopened.close());
  assert.equal(reopened.schemaVersion, 8);
  for (const id of [invocationId, conciergeId]) {
    const expected = legacyEvents
      .filter((event) => event.invocationId === id)
      .map((event) => event.detail);
    assert.deepEqual(
      reopened.read(id).map((event) => event.detail),
      expected,
    );
    assert.deepEqual(
      readInvocationTrace(reopened, id)?.events.map((event) => event.detail),
      expected,
    );
  }
  for (const event of legacyEvents) {
    assert.throws(() => reopened.append(event as never), {
      code: "invalid-event",
    });
  }
  reopened.append({
    ...concierge,
    ...failed,
    invocationId: randomUUID(),
    detail: { code: "volume-detached" },
  });

  exportAudit(db, obs, { now });
  assert.deepEqual(
    lines(dir)
      .filter((line) => !line.derived)
      .map((line) => line.attributes),
    [
      ...legacyEvents.map((event) => ({
        ...(event.profile && { profile: event.profile, image: event.image }),
        ...event.detail,
      })),
      { code: "volume-detached" },
    ],
  );
});
