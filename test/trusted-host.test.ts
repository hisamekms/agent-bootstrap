import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createRequire } from "node:module";
import { type AuditSink, SqliteAudit, auditSchemaSql } from "../src/audit.ts";
import { HostRequests } from "../src/host-requests.ts";
import type {
  ExecResult,
  SandboxEgressGateway,
  SandboxRuntime,
  SandboxSpec,
} from "../src/sandbox-runtime.ts";
import { ProfileCatalog } from "../src/sandbox-profiles.ts";
import { HOST_SERVICE_NAME } from "../src/egress-policy.ts";
import type { RuntimeEvent } from "../src/runtime-events.ts";
import { SandboxRuntimeError } from "../src/sandbox-runtime.ts";
import {
  HostAuditError,
  TrustedHost,
  type BoundSandboxRuntime,
  type HostObservabilityAudit,
  type TrustedHostOptions,
} from "../src/trusted-host.ts";
import { fakeGateway } from "./fake-gateway.ts";

const profiles = new ProfileCatalog({
  base: { image: `fixture.invalid/alpine@sha256:${"a".repeat(64)}` },
  concierge: { image: `fixture.invalid/concierge@sha256:${"c".repeat(64)}` },
});

function fixture(t: { after(fn: () => void): void }) {
  const directory = mkdtempSync(join(tmpdir(), "bootstrap-audit-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return join(directory, "audit.sqlite");
}

const plan = {
  sandbox: { maxLifetimeMs: 10_000 },
  command: { argv: ["/fixture"], timeoutMs: 500 },
  collectPaths: ["report.txt"],
};

function adapter(request: string, status: ExecResult["status"] = "exited") {
  const calls: string[] = [];
  let invocationId: string | undefined;
  const runtime: SandboxRuntime = {
    async create(spec) {
      calls.push("create");
      invocationId = spec.invocationId;
      return { id: "fixture" };
    },
    async exec() {
      calls.push("exec");
      return {
        status,
        exitCode: status === "exited" ? 0 : null,
        stdout: Buffer.from(request),
        stderr: Buffer.from("fixture-private-data"),
      };
    },
    async collect(_handle, spec) {
      calls.push("collect");
      assert.deepEqual("paths" in spec && spec.paths, ["report.txt"]);
      return { files: [{ path: "report.txt", bytes: Buffer.from("fixture") }] };
    },
    async destroy() {
      calls.push("destroy");
    },
  };
  return { calls, runtime, invocationId: () => invocationId };
}

test("worker traces distinguish requested, authorized and completed operations", async (t) => {
  const filename = fixture(t);
  const audit = new SqliteAudit(filename);
  const { calls, runtime, invocationId } = adapter('{"tool":"collect"}');
  const result = await new TrustedHost(audit, runtime, profiles).runWorker(
    plan,
  );
  assert.equal(result.outcome, "ok");
  assert.equal(invocationId(), result.id);
  assert.equal(result.artifacts?.files[0]?.path, "report.txt");
  assert.deepEqual(calls, ["create", "exec", "collect", "destroy"]);
  audit.close();
  const reopened = new SqliteAudit(filename, { readonly: true });
  try {
    const trace = reopened.read(result.id);
    assert.deepEqual(
      trace
        .filter((event) => event.operation === "sandbox.collect")
        .map((event) => event.kind),
      ["operation.requested", "operation.allowed", "operation.finished"],
    );
    assert.equal(trace.at(-1)?.outcome, "ok");
    assert.doesNotMatch(
      JSON.stringify(trace),
      /fixture-private-data|report\.txt/,
    );
  } finally {
    reopened.close();
  }
});

test("only Worker delivers the bounded stderr tail to an opt-in host callback", async (t) => {
  const audit = new SqliteAudit(fixture(t));
  t.after(() => audit.close());
  const { calls, runtime } = adapter("");
  const tail = Buffer.from("x".repeat(4076) + "private fixture data");
  assert.equal(tail.length, 4096);
  const stderr = Buffer.concat([Buffer.from("discarded prefix"), tail]);
  runtime.exec = async () => {
    calls.push("exec");
    return { status: "exited", exitCode: 7, stdout: Buffer.alloc(0), stderr };
  };
  const host = new TrustedHost(audit, runtime, profiles);
  const diagnostics: { id: string; bytes: Uint8Array }[] = [];
  const options = {
    onWorkerStderr(bytes: Uint8Array, id: string) {
      diagnostics.push({ id, bytes });
      throw new Error(bytes.toString());
    },
  };
  const worker = await host.runWorker(plan, undefined, undefined, options);
  const reviewer = await host.runReviewer(plan, undefined, undefined, options);
  const defaultWorker = await host.runWorker(plan);
  assert.equal(worker.outcome, "failed");
  assert.equal(reviewer.outcome, "failed");
  assert.equal(defaultWorker.outcome, "failed");
  assert.deepEqual(diagnostics, [
    { id: worker.id, bytes: new Uint8Array(tail) },
  ]);
  assert.deepEqual(calls, [
    "create",
    "exec",
    "destroy",
    "create",
    "exec",
    "destroy",
    "create",
    "exec",
    "destroy",
  ]);
  for (const run of [worker, reviewer, defaultWorker]) {
    assert.doesNotMatch(JSON.stringify(run), /private fixture data/);
    assert.doesNotMatch(
      JSON.stringify(audit.read(run.id)),
      /private fixture data/,
    );
  }
});

test("unknown guest actions are denied and timeout remains distinct from failure", async (t) => {
  const audit = new SqliteAudit(fixture(t));
  t.after(() => audit.close());
  const denied = adapter('{"tool":"fixture-secret-attempt"}');
  const rejection = await new TrustedHost(
    audit,
    denied.runtime,
    profiles,
  ).runWorker(plan);
  assert.equal(rejection.outcome, "denied");
  assert.deepEqual(denied.calls, ["create", "exec", "destroy"]);
  const trace = audit.read(rejection.id);
  assert.ok(trace.some((event) => event.kind === "operation.denied"));
  assert.doesNotMatch(JSON.stringify(trace), /fixture-secret-attempt/);
  const timed = adapter("", "timed-out");
  const timeout = await new TrustedHost(
    audit,
    timed.runtime,
    profiles,
  ).runWorker(plan);
  assert.equal(timeout.outcome, "timed-out");
  assert.equal(audit.read(timeout.id).at(-1)?.outcome, "timed-out");
  assert.deepEqual(timed.calls, ["create", "exec", "destroy"]);
});

test("an audit write failure stops the pending operation and later operations", async (t) => {
  const audit = new SqliteAudit(fixture(t));
  t.after(() => audit.close());
  const { calls, runtime } = adapter('{"tool":"collect"}');
  const failing: AuditSink = {
    async append(event) {
      if (
        event.operation === "sandbox.exec" &&
        event.kind === "operation.allowed"
      ) {
        await Promise.resolve();
        throw new Error("synthetic write failure");
      }
      audit.append(event);
    },
  };
  let traceId: string | undefined;
  await assert.rejects(
    new TrustedHost(failing, runtime, profiles).runWorker(plan),
    (error) => {
      assert.ok(error instanceof HostAuditError);
      traceId = error.invocationId;
      return true;
    },
  );
  assert.deepEqual(calls, ["create", "destroy"]);
  assert.ok(traceId);
  assert.deepEqual(
    audit
      .read(traceId)
      .filter((event) => event.operation === "sandbox.exec")
      .map((event) => event.kind),
    ["operation.requested"],
  );
});

test("a write rejected by a read-only audit database prevents sandbox creation", async (t) => {
  const filename = fixture(t);
  new SqliteAudit(filename).close();
  const audit = new SqliteAudit(filename, { readonly: true });
  t.after(() => audit.close());
  const { calls, runtime } = adapter("");
  await assert.rejects(
    new TrustedHost(audit, runtime, profiles).runWorker(plan),
    HostAuditError,
  );
  assert.deepEqual(calls, []);
});

test("read-only trace exposes an admitted operation after host process death", (t) => {
  const filename = fixture(t);
  const invocationId = randomUUID();
  const module = new URL("../src/audit.ts", import.meta.url);
  const child = spawnSync(
    process.execPath,
    [
      "-e",
      `import { SqliteAudit } from ${JSON.stringify(module.pathname)};
     const store = new SqliteAudit(process.argv[1]);
     const base = {invocationId: process.argv[2], role: "Worker"};
     store.append({...base, kind: "invocation.started"});
     store.append({...base, kind: "operation.requested", operation: "sandbox.exec"});
     store.append({...base, kind: "operation.allowed", operation: "sandbox.exec"});
     process.kill(process.pid, "SIGKILL");`,
      filename,
      invocationId,
    ],
    { timeout: 5000 },
  );
  assert.equal(child.signal, "SIGKILL", child.stderr?.toString());
  const trace = spawnSync(
    process.execPath,
    [
      new URL("../src/trace.ts", import.meta.url).pathname,
      filename,
      invocationId,
    ],
    { timeout: 5000 },
  );
  assert.equal(trace.status, 0, trace.stderr?.toString());
  const recovered = JSON.parse(trace.stdout.toString());
  assert.equal(recovered.outcome, "incomplete");
  assert.deepEqual(recovered.pendingOperation, {
    operation: "sandbox.exec",
    effect: "unknown",
  });
  assert.equal(recovered.events.at(-1).kind, "operation.allowed");
});

test("delegate and integration receipts replay across restart and reject conflicts", (t) => {
  const filename = fixture(t);
  const taskId = randomUUID();
  const request = {
    role: "Worker" as const,
    task: "fixture task",
    inputs: [],
    idempotencyKey: "first",
  };
  const artifact = {
    id: randomUUID(),
    mediaType: "text/plain",
    sha256: "a".repeat(64),
  };
  const integration = {
    idempotencyKey: request.idempotencyKey,
    source: { id: randomUUID() },
    candidate: artifact,
    expectedBase: artifact,
    evidence: [],
    reason: "fixture integration",
  };
  const audit = new SqliteAudit(filename);
  const requests = new HostRequests(audit);
  const delegated = requests.delegate(taskId, request);
  const submitted = requests.requestIntegration(taskId, integration);
  assert.equal(delegated.replayed, false);
  assert.equal(submitted.replayed, false);
  assert.notEqual(delegated.id, submitted.id);
  audit.close();
  const reopened = new SqliteAudit(filename);
  try {
    const recovered = new HostRequests(reopened);
    assert.deepEqual(recovered.delegate(taskId, request), {
      id: delegated.id,
      replayed: true,
    });
    assert.deepEqual(recovered.requestIntegration(taskId, integration), {
      id: submitted.id,
      replayed: true,
    });
    assert.throws(
      () =>
        recovered.delegate(taskId, { ...request, task: "fixture conflict" }),
      /request-conflict/,
    );
    assert.throws(
      () =>
        recovered.requestIntegration(taskId, {
          ...integration,
          expectedBase: { ...artifact, sha256: "b".repeat(64) },
        }),
      /request-conflict/,
    );
    assert.notEqual(recovered.delegate(randomUUID(), request).id, delegated.id);
  } finally {
    reopened.close();
  }
});

test("a Coordinator session is audited, fails closed and always tears down", async (t) => {
  const audit = new SqliteAudit(fixture(t));
  t.after(() => audit.close());
  const calls: string[] = [];
  const runtime: SandboxRuntime = {
    async create(spec) {
      calls.push(
        `create ${spec.hostTcpPort ?? "-"} ${spec.tools?.length ?? 0}`,
      );
      return { id: "fixture" };
    },
    async exec() {
      throw new Error("not used");
    },
    async collect() {
      throw new Error("not used");
    },
    async destroy() {
      calls.push("destroy");
    },
    async openSession() {
      calls.push("open");
      return {
        send() {},
        lines: (async function* () {})(),
        close() {
          calls.push("close");
        },
        finished: Promise.resolve("cancelled" as const),
      };
    },
  };
  const host = new TrustedHost(audit, runtime, profiles);
  const plan = {
    sandbox: { maxLifetimeMs: 10_000 },
    command: { argv: ["/fixture"], timeoutMs: 500 },
  };
  const ok = await host.runCoordinatorSession(
    plan,
    randomUUID(),
    async () => 7,
  );
  assert.deepEqual(ok.value, 7);
  assert.deepEqual(calls.splice(0), ["create - 0", "open", "close", "destroy"]);
  const operations = (id: string) =>
    audit
      .read(id)
      .filter((event) => event.kind === "operation.finished")
      .map((event) => `${event.operation} ${event.outcome}`);
  assert.deepEqual(operations(ok.id), [
    "sandbox.create ok",
    "sandbox.exec ok",
    "sandbox.destroy ok",
  ]);
  const failing = randomUUID();
  await assert.rejects(
    host.runCoordinatorSession(plan, failing, async () => {
      throw new Error("fixture model failure");
    }),
    /fixture model failure/,
  );
  assert.deepEqual(calls.splice(0), ["create - 0", "open", "close", "destroy"]);
  assert.deepEqual(operations(failing), [
    "sandbox.create ok",
    "sandbox.exec failed",
    "sandbox.destroy ok",
  ]);
  assert.equal(audit.read(failing).at(-1)?.outcome, "failed");
  // Files and other sandbox fields are not accepted for a Coordinator session.
  await assert.rejects(
    host.runCoordinatorSession(
      { ...plan, sandbox: { ...plan.sandbox, files: [] } as never },
      randomUUID(),
      async () => 1,
    ),
    /streaming sandbox/,
  );
  // A failed audit write stops before any sandbox effect.
  const broken = new TrustedHost(
    {
      append() {
        throw new Error("fixture audit failure");
      },
    },
    runtime,
    profiles,
  );
  await assert.rejects(
    broken.runCoordinatorSession(plan, randomUUID(), async () => 1),
    HostAuditError,
  );
  assert.deepEqual(calls, []);
});

test("Coordinator session failures are audited in order and keep their codes", async (t) => {
  const audit = new SqliteAudit(fixture(t));
  t.after(() => audit.close());
  const plan = {
    sandbox: { maxLifetimeMs: 10_000 },
    command: { argv: ["/fixture"], timeoutMs: 500 },
  };
  const session = (finished: "cancelled" | "timed-out" = "cancelled") => ({
    send() {},
    lines: (async function* () {})(),
    close() {},
    finished: Promise.resolve(finished),
  });
  const make = (overrides: Partial<SandboxRuntime>, calls: string[]) =>
    new TrustedHost(
      audit,
      {
        async create() {
          calls.push("create");
          return { id: "fixture" };
        },
        async exec() {
          throw new Error("not used");
        },
        async collect() {
          throw new Error("not used");
        },
        async destroy() {
          calls.push("destroy");
        },
        async openSession() {
          calls.push("open");
          return session();
        },
        ...overrides,
      },
      profiles,
    );
  const finished = (id: string) =>
    audit
      .read(id)
      .filter((event) => event.kind === "operation.finished")
      .map((event) => `${event.operation} ${event.outcome}`);
  const cases: [
    Partial<SandboxRuntime>,
    (() => Promise<number>) | null,
    string[],
    string[],
  ][] = [
    [
      {
        async create() {
          throw new Error("fixture create failure");
        },
      },
      null,
      ["sandbox.create failed"],
      [],
    ],
    [
      {
        async openSession() {
          throw new Error("fixture open failure");
        },
      },
      null,
      ["sandbox.create ok", "sandbox.exec failed", "sandbox.destroy ok"],
      ["create", "destroy"],
    ],
    [
      {
        async destroy() {
          throw new Error("fixture destroy failure");
        },
      },
      async () => 1,
      ["sandbox.create ok", "sandbox.exec ok", "sandbox.destroy failed"],
      ["create", "open"],
    ],
    [
      {},
      async () => {
        throw Object.assign(new Error("fixture timeout"), {
          code: "timed-out",
        });
      },
      ["sandbox.create ok", "sandbox.exec timed-out", "sandbox.destroy ok"],
      ["create", "open", "destroy"],
    ],
  ];
  for (const [overrides, use, expected, calls] of cases) {
    const seen: string[] = [];
    const id = randomUUID();
    const result = make(overrides, seen).runCoordinatorSession(
      plan,
      id,
      use ?? (async () => 1),
    );
    if (expected.at(-1) === "sandbox.destroy failed") {
      const value = await result;
      assert.equal(value.outcome, "failed");
      assert.equal(value.value, undefined);
    } else await assert.rejects(result);
    assert.deepEqual(finished(id), expected);
    assert.equal(audit.read(id).at(-1)?.kind, "invocation.finished");
    assert.deepEqual(seen, calls);
  }
  // An audit failure after create permits only emergency teardown.
  let writes = 0;
  const calls: string[] = [];
  const host = new TrustedHost(
    {
      append() {
        if (++writes === 5) throw new Error("fixture audit failure");
      },
    },
    {
      async create() {
        calls.push("create");
        return { id: "fixture" };
      },
      async exec() {
        throw new Error("not used");
      },
      async collect() {
        throw new Error("not used");
      },
      async destroy() {
        calls.push("destroy");
      },
      async openSession() {
        calls.push("open");
        return session();
      },
    },
    profiles,
  );
  await assert.rejects(
    host.runCoordinatorSession(plan, randomUUID(), async () => 1),
    HostAuditError,
  );
  assert.deepEqual(calls, ["create", "destroy"]);
});

test("a new audit database uses schema 6 and records provider egress", async (t) => {
  const filename = fixture(t);
  const audit = new SqliteAudit(filename);
  const id = randomUUID();
  audit.append({
    invocationId: id,
    kind: "invocation.started",
    role: "Worker",
  });
  audit.append({
    invocationId: id,
    kind: "operation.requested",
    operation: "provider.egress",
    role: "Worker",
  });
  audit.close();
  const reopened = new SqliteAudit(filename, { readonly: true });
  t.after(() => reopened.close());
  assert.equal(reopened.read(id).at(-1)?.operation, "provider.egress");
  const version = spawnSync(
    "/usr/bin/sqlite3",
    [filename, "PRAGMA user_version"],
    {
      encoding: "utf8",
    },
  );
  if (version.status === 0) assert.equal(version.stdout.trim(), "6");
});

const { Database } = createRequire(import.meta.url)("bun:sqlite") as {
  Database: new (
    filename: string,
    options: { create: boolean },
  ) => { exec(sql: string): void; close(): void };
};

const dbProfiles = new ProfileCatalog({
  base: { image: `fixture.invalid/alpine@sha256:${"a".repeat(64)}` },
  db: { image: `fixture.invalid/postgres@sha256:${"b".repeat(64)}` },
});

function recorder() {
  const specs: SandboxSpec[] = [];
  const runtime: SandboxRuntime = {
    async create(spec) {
      specs.push(spec);
      return { id: "fixture" };
    },
    async exec() {
      return {
        status: "exited",
        exitCode: 0,
        stdout: Buffer.alloc(0),
        stderr: Buffer.alloc(0),
      };
    },
    async collect() {
      return { files: [] };
    },
    async destroy() {},
    async openSession() {
      return {
        send() {},
        lines: (async function* () {})(),
        close() {},
        finished: Promise.resolve("cancelled" as const),
      };
    },
  };
  return { specs, runtime };
}

const requested = (audit: SqliteAudit, id: string) =>
  audit
    .read(id)
    .filter(
      (event) =>
        event.kind === "operation.requested" &&
        event.operation === "sandbox.create",
    );

const quick = { command: { argv: ["/fixture"], timeoutMs: 500 } };

test("sandbox.create records the default base profile and its digest", async (t) => {
  const audit = new SqliteAudit(fixture(t));
  t.after(() => audit.close());
  const { specs, runtime } = recorder();
  const host = new TrustedHost(audit, runtime, dbProfiles);
  const run = await host.runWorker({ ...plan, collectPaths: [] });
  const [event] = requested(audit, run.id);
  assert.equal(event?.profile, "base");
  assert.equal(event?.image, "a".repeat(64));
  assert.equal(specs[0]?.profile, "base");
  // The adapter receives the audited digest to check against its own catalog.
  assert.equal(specs[0]?.imageDigest, event?.image);
  assert.equal(
    audit.read(run.id).filter((e) => e.profile !== undefined).length,
    1,
  );
});

test("Worker may use a configured db profile and not an unconfigured one", async (t) => {
  const audit = new SqliteAudit(fixture(t));
  t.after(() => audit.close());
  const { specs, runtime } = recorder();
  const host = new TrustedHost(audit, runtime, dbProfiles);
  const worker = (profile: "db" | "browser") => ({
    sandbox: { maxLifetimeMs: 10_000, profile },
    ...quick,
    collectPaths: [],
  });
  const run = await host.runWorker(worker("db"));
  assert.equal(run.outcome, "ok");
  assert.equal(requested(audit, run.id)[0]?.profile, "db");
  assert.equal(requested(audit, run.id)[0]?.image, "b".repeat(64));
  assert.equal(specs[0]?.profile, "db");
  const id = randomUUID();
  await assert.rejects(
    host.runWorker(worker("browser"), id),
    /Sandbox profile not allowed/,
  );
  assert.deepEqual(audit.read(id), []);
  assert.equal(specs.length, 1);
});

test("Reviewer, Planner and Coordinator refuse db before any audit write", async (t) => {
  const audit = new SqliteAudit(fixture(t));
  t.after(() => audit.close());
  const { specs, runtime } = recorder();
  const host = new TrustedHost(audit, runtime, dbProfiles);
  const sandbox = { maxLifetimeMs: 10_000, profile: "db" as const };
  const control = {
    maxLifetimeMs: 10_000,
    profile: "db" as const,
    readOnlyFiles: [{ path: "control.json", bytes: Buffer.from("{}") }],
  };
  for (const [name, run] of [
    ["reviewer", (id: string) => host.runReviewer({ sandbox, ...quick }, id)],
    ["planner", (id: string) => host.runPlanner({ sandbox, ...quick }, id)],
    [
      "coordinator",
      (id: string) => host.runCoordinator({ sandbox: control, ...quick }, id),
    ],
    [
      "session",
      (id: string) =>
        host.runCoordinatorSession({ sandbox, ...quick }, id, async () => 1),
    ],
  ] as const) {
    const id = randomUUID();
    await assert.rejects(run(id), /Sandbox profile not allowed/, name);
    assert.deepEqual(audit.read(id), [], name);
  }
  assert.equal(specs.length, 0);
});

test("the session path records profile and image on sandbox.create", async (t) => {
  const audit = new SqliteAudit(fixture(t));
  t.after(() => audit.close());
  const { specs, runtime } = recorder();
  const host = new TrustedHost(audit, runtime, dbProfiles);
  const id = randomUUID();
  const result = await host.runCoordinatorSession(
    { sandbox: { maxLifetimeMs: 10_000 }, ...quick },
    id,
    async () => 1,
  );
  assert.equal(result.outcome, "ok");
  const [event] = requested(audit, id);
  assert.equal(event?.profile, "base");
  assert.equal(event?.image, "a".repeat(64));
  assert.equal(specs[0]?.profile, "base");
  // The adapter receives the audited digest to check against its own catalog.
  assert.equal(specs[0]?.imageDigest, event?.image);
  assert.equal(event?.role, "Coordinator");
});

test("runVerification is read-only, audited as Verification and accepts db", async (t) => {
  const audit = new SqliteAudit(fixture(t));
  t.after(() => audit.close());
  const { specs, runtime } = recorder();
  const host = new TrustedHost(audit, runtime, dbProfiles);
  const run = await host.runVerification({
    sandbox: { maxLifetimeMs: 10_000, profile: "db" },
    ...quick,
  });
  assert.equal(run.outcome, "ok");
  const trace = audit.read(run.id);
  assert.ok(trace.every((event) => event.role === "Verification"));
  assert.equal(requested(audit, run.id)[0]?.profile, "db");
  assert.equal(specs[0]?.profile, "db");
  assert.equal(
    trace.some((event) => event.operation === "sandbox.collect"),
    false,
  );
  const defaulted = await host.runVerification({ sandbox: {}, ...quick });
  assert.equal(requested(audit, defaulted.id)[0]?.profile, "base");
  const refused = await new TrustedHost(
    audit,
    runtime,
    new ProfileCatalog({
      base: { image: `fixture.invalid/alpine@sha256:${"a".repeat(64)}` },
    }),
  );
  const id = randomUUID();
  await assert.rejects(
    refused.runVerification({ sandbox: { profile: "db" }, ...quick }, id),
    /Sandbox profile not allowed/,
  );
  assert.deepEqual(audit.read(id), []);
});

test("runVerification refuses provider, tools and hostTcpPort without auditing", async (t) => {
  const audit = new SqliteAudit(fixture(t));
  t.after(() => audit.close());
  const { specs, runtime } = recorder();
  const host = new TrustedHost(audit, runtime, dbProfiles);
  for (const extra of [
    { provider: {} },
    { tools: [] },
    { hostTcpPort: 4242 },
  ]) {
    const id = randomUUID();
    await assert.rejects(
      host.runVerification(
        { sandbox: { maxLifetimeMs: 1000, ...extra } as never, ...quick },
        id,
      ),
      /Verification accepts only/,
    );
    assert.deepEqual(audit.read(id), []);
  }
  assert.equal(specs.length, 0);
});

test("TrustedHost requires a ProfileCatalog", () => {
  const { runtime } = recorder();
  assert.throws(
    () =>
      new TrustedHost({ append() {} }, runtime, {
        has: () => true,
      } as unknown as ProfileCatalog),
    /Profile catalog required/,
  );
});

test("a v3 audit database fails closed at sandbox.create", async (t) => {
  const filename = fixture(t);
  const db = new Database(filename, { create: true });
  db.exec("PRAGMA journal_mode=WAL");
  for (const sql of auditSchemaSql(3)) db.exec(sql);
  db.exec(`PRAGMA application_id=${0x41424731}; PRAGMA user_version=3`);
  db.close();
  const audit = new SqliteAudit(filename);
  t.after(() => audit.close());
  const { specs, runtime } = recorder();
  const host = new TrustedHost(audit, runtime, dbProfiles);
  const id = randomUUID();
  await assert.rejects(
    host.runWorker({ ...plan, collectPaths: [] }, id),
    HostAuditError,
  );
  assert.equal(specs.length, 0);
  assert.deepEqual(
    audit.read(id).map((event) => event.kind),
    ["invocation.started"],
  );
});

test("verification never forwards egress or tools, even hidden ones", async (t) => {
  const { ProfileCatalog } = await import("../src/sandbox-profiles.ts");
  const specs: unknown[] = [];
  const runtime: SandboxRuntime = {
    async create(spec) {
      specs.push(spec);
      return { id: "fixture" };
    },
    async exec() {
      return {
        status: "exited",
        exitCode: 0,
        stdout: Buffer.from('{"review":"pass"}'),
        stderr: new Uint8Array(),
      };
    },
    async collect() {
      return { files: [] };
    },
    async destroy() {},
  };
  const sandbox = { maxLifetimeMs: 10_000 };
  Object.defineProperty(sandbox, "provider", {
    value: { host: "api.example.com", secretEnv: "EXAMPLE_TOKEN" },
    enumerable: false,
  });
  Object.defineProperty(sandbox, "tools", {
    value: [{ hostPath: "/x", guestPath: "/x", sha256: "0".repeat(64) }],
    enumerable: false,
  });
  const host = new TrustedHost(
    new SqliteAudit(fixture(t)),
    runtime,
    new ProfileCatalog({
      base: { image: `fixture.invalid/alpine@sha256:${"a".repeat(64)}` },
    }),
  );
  const run = await host.runVerification({
    sandbox,
    command: { argv: ["/fixture"], timeoutMs: 500 },
  });
  assert.equal(run.outcome, "ok");
  const spec = specs[0] as Record<string, unknown>;
  assert.equal(spec.provider, undefined);
  assert.equal(spec.tools, undefined);
  assert.equal(spec.profile, "base");
});

test("collectTree requests a tree collection under the audited sandbox.collect operation", async (t) => {
  const audit = new SqliteAudit(fixture(t));
  t.after(() => audit.close());
  const specs: unknown[] = [];
  const created: unknown[] = [];
  const runtime: SandboxRuntime = {
    async create(spec) {
      created.push(spec.repository);
      return { id: "fixture" };
    },
    async exec() {
      return {
        status: "exited",
        exitCode: 0,
        stdout: Buffer.from('{"tool":"collect"}'),
        stderr: Buffer.alloc(0),
      };
    },
    async collect(_handle, spec) {
      specs.push(spec);
      return { files: [], tree: Buffer.from("TAR") };
    },
    async destroy() {},
  };
  const repository = { gitDir: "/x/git", tree: "/x/tree.tar" };
  const result = await new TrustedHost(audit, runtime, profiles).runWorker({
    sandbox: { repository },
    command: plan.command,
    collectPaths: [],
    collectTree: true,
  });
  assert.equal(result.outcome, "ok");
  assert.deepEqual(specs, [{ tree: true }]);
  assert.deepEqual(created, [repository]);
  assert.equal(Buffer.from(result.artifacts!.tree!).toString(), "TAR");
  const trace = audit.read(result.id);
  assert.deepEqual(
    trace
      .filter((event) => event.operation === "sandbox.collect")
      .map((event) => event.kind),
    ["operation.requested", "operation.allowed", "operation.finished"],
  );
});

test("collectTree with paths and repository on other roles are refused before any audit write", async (t) => {
  const audit = new SqliteAudit(fixture(t));
  t.after(() => audit.close());
  const { runtime, calls } = adapter("");
  const host = new TrustedHost(audit, runtime, profiles);
  const repository = { gitDir: "/x/git", tree: "/x/tree.tar" };
  await assert.rejects(
    host.runWorker(
      { ...plan, collectTree: true },
      "11111111-1111-4111-8111-111111111111",
    ),
    /collectTree/,
  );
  const sandbox = { repository } as never;
  const command = plan.command;
  await assert.rejects(host.runReviewer({ sandbox, command }), /repository/);
  await assert.rejects(host.runPlanner({ sandbox, command }), /repository/);
  await assert.rejects(
    host.runCoordinator({ sandbox, command }),
    /Coordinator requires/,
  );
  await assert.rejects(
    host.runCoordinatorSession({ sandbox, command }, "id", async () => 1),
    /Coordinator session/,
  );
  assert.deepEqual(calls, []);
  assert.deepEqual(audit.read("11111111-1111-4111-8111-111111111111"), []);
});

test("Verification may carry a host-prepared repository but never collects or gets extras", async (t) => {
  const audit = new SqliteAudit(fixture(t));
  t.after(() => audit.close());
  const created: unknown[] = [];
  const runtime: SandboxRuntime = {
    async create(spec) {
      created.push(spec);
      return { id: "fixture" };
    },
    async exec() {
      return {
        status: "exited",
        exitCode: 0,
        stdout: Buffer.from('{"review":"pass"}'),
        stderr: Buffer.alloc(0),
      };
    },
    async collect() {
      throw new Error("verification never collects");
    },
    async destroy() {},
  };
  const host = new TrustedHost(audit, runtime, profiles);
  const repository = { gitDir: "/x/git", tree: "/x/tree.tar" };
  const run = await host.runVerification({
    sandbox: { repository, maxLifetimeMs: 1000 },
    command: plan.command,
  });
  assert.equal(run.outcome, "ok");
  assert.deepEqual((created[0] as SandboxSpec).repository, repository);
  for (const extra of [{ tools: [] }, { hostTcpPort: 1 }, { provider: {} }])
    await assert.rejects(
      host.runVerification({
        sandbox: { repository, ...extra } as never,
        command: plan.command,
      }),
      /only/i,
    );
  assert.equal(created.length, 1);
});

const requiredConfig = {
  audit: { mode: "required" },
  telemetry: {
    enabled: true,
    resourceSamplingIntervalMs: 1000,
    traceSamplingRatio: 1,
  },
} as const;
const provider = {
  host: "provider.example",
  secretEnv: "AGENT_BOOTSTRAP_GATEWAY_SECRET",
};
const providerPlan = { ...plan, sandbox: { ...plan.sandbox, provider } };
const ruleDigest = "b".repeat(64);

function observedFixture(
  t: { after(fn: () => void): void },
  overrides?: Partial<BoundSandboxRuntime>,
  failWrite?: string,
  options?: Partial<TrustedHostOptions>,
) {
  const db = new SqliteAudit(fixture(t));
  t.after(() => db.close());
  const calls: string[] = [];
  const fake = fakeGateway(calls);
  let auditAvailable = true;
  function write(label: string, action: () => void) {
    calls.push(label);
    if (label === failWrite)
      return Promise.reject(new Error("fixture append failure"));
    action();
  }
  const audit: HostObservabilityAudit = {
    get isV5Writable() {
      return auditAvailable && db.isV5Writable;
    },
    append: (event) =>
      write([event.kind, event.operation].filter(Boolean).join(" "), () =>
        db.append(event),
      ),
    appendExecutionContext: (context) =>
      write("execution_contexts", () => db.appendExecutionContext(context)),
    appendSandboxBinding: (input) =>
      write("sandbox_bindings", () => db.appendSandboxBinding(input)),
    appendProcessResult: (input) =>
      write("process_results", () => db.appendProcessResult(input)),
    appendResourceEvent: (input) =>
      write("resource_events", () => db.appendResourceEvent(input)),
    appendNetwork: db.appendNetwork.bind(db),
    appendNetworkFinished: db.appendNetworkFinished.bind(db),
    appendDnsQuery: db.appendDnsQuery.bind(db),
  };
  let binding: SandboxEgressGateway | undefined;
  const runtime: BoundSandboxRuntime = {
    netRuleDigest() {
      return ruleDigest;
    },
    async create() {
      throw new Error("Required mode used an unbound create");
    },
    async createBound(spec, id) {
      calls.push("create");
      assert.equal(spec.expectedNetRuleDigest, ruleDigest);
      assert.equal(spec.hostTcpPort, undefined);
      const row = db.readExecution(spec.invocationId!).sandboxBindings[0];
      assert.equal(row?.sandboxId, id);
      assert.equal(row?.netRuleDigest, ruleDigest);
      if (spec.egressGateway) {
        binding = spec.egressGateway;
        assert.equal(
          host.gatewayPassword({ ...spec.egressGateway }),
          fake.gateway.password,
        );
        assert.throws(() =>
          host.gatewayPassword({ ...spec.egressGateway!, dnsPort: 12345 }),
        );
        assert.equal("password" in spec.egressGateway, false);
        assert.notEqual(
          spec.egressGateway.passwordEnv,
          spec.provider?.secretEnv,
        );
        assert.equal(row.egressMode, "gateway");
        const policy = fake.opened!.policy;
        assert.equal(row.gatewayPolicyId, policy.policyId);
        const policyDigest = createHash("sha256")
          .update(
            JSON.stringify({
              version: 1,
              allow: policy.allow,
              allowIps: policy.allowIps,
              hostServices: policy.hostServices,
              providerBinding: policy.providerBinding ?? null,
            }),
          )
          .digest("hex");
        assert.equal(row.gatewayPolicyDigest, policyDigest);
        assert.notEqual(row.gatewayPolicyDigest, row.gatewayPolicyId);
        assert.equal(fake.opened?.sandboxLabel, id);
      } else {
        assert.equal(row.egressMode, "none");
      }
      return { id, netRuleDigest: ruleDigest };
    },
    async exec() {
      calls.push("exec");
      return {
        status: "exited",
        exitCode: 0,
        stdout: Buffer.from('{"tool":"collect"}'),
        stderr: Buffer.from("fixture-private-data"),
      };
    },
    async collect() {
      calls.push("collect");
      return { files: [] };
    },
    async destroy() {
      calls.push("destroy");
    },
    finalResourceSample() {
      calls.push("final-sample");
      return { memoryBytes: 42 };
    },
    ...overrides,
  };
  const host = new TrustedHost(audit, runtime, profiles, {
    config: requiredConfig,
    gatewayFactory: fake.open,
    ...options,
  });
  return {
    host,
    db,
    audit,
    calls,
    fake,
    runtime,
    failAuditStore() {
      auditAvailable = false;
    },
    get binding() {
      return binding;
    },
  };
}

test("required host durably binds the actual sandbox before create and audits the result", async (t) => {
  const events: RuntimeEvent[] = [];
  const samples: unknown[] = [];
  const observed = observedFixture(t, {}, undefined, {
    observers: [
      {
        observe() {
          throw new Error("fixture observer");
        },
      },
      {
        observe: (event) => events.push(event),
        observeFinalResourceSample: (...sample) => samples.push(sample),
      },
    ],
  });
  const { host, db, calls, fake } = observed;
  const context = {
    executionId: randomUUID(),
    correlationId: randomUUID(),
    attributes: { fixture: true },
  };
  const result = await host.runWorker(providerPlan, undefined, context);
  assert.equal(result.id, context.executionId);
  assert.equal(result.outcome, "ok");
  assert.deepEqual(calls, [
    "invocation.started",
    "execution_contexts",
    "gateway.open",
    "operation.requested provider.egress",
    "operation.allowed provider.egress",
    "operation.requested sandbox.create",
    "operation.allowed sandbox.create",
    "sandbox_bindings",
    "create",
    "operation.finished sandbox.create",
    "operation.requested sandbox.exec",
    "operation.allowed sandbox.exec",
    "exec",
    "process_results",
    "operation.finished sandbox.exec",
    "operation.requested sandbox.collect",
    "operation.allowed sandbox.collect",
    "collect",
    "operation.finished sandbox.collect",
    "gateway.close",
    "operation.requested sandbox.destroy",
    "operation.allowed sandbox.destroy",
    "destroy",
    "operation.finished sandbox.destroy",
    "final-sample",
    "operation.finished provider.egress",
    "invocation.finished",
  ]);
  const { executionContexts, sandboxBindings, processResults } =
    db.readExecution(result.id);
  assert.deepEqual(executionContexts[0]?.attributes, context.attributes);
  assert.equal(processResults[0]?.exitCode, 0);
  assert.equal(processResults[0]?.guestReported, true);
  assert.equal(fake.opened?.audit !== undefined, true);
  assert.deepEqual(fake.opened?.policy.providerBinding, {
    hostname: provider.host,
    port: 443,
  });
  const sandboxId = sandboxBindings[0]?.sandboxId;
  assert.deepEqual(samples, [[result.id, sandboxId, { memoryBytes: 42 }]]);
  assert.ok(observed.binding);
  assert.throws(() => host.gatewayPassword(observed.binding!));
  assert.deepEqual(
    events.map((event) => event.eventType),
    [
      "execution.started",
      "sandbox.created",
      "process.started",
      "process.exited",
      "sandbox.destroyed",
      "execution.finished",
    ],
  );
  assert.ok(
    events.every(
      (event) =>
        event.executionId === result.id &&
        event.correlationId === context.correlationId,
    ),
  );
  assert.equal(events[1]?.sandboxId, sandboxId);
  assert.deepEqual(
    events.map((event) => event.source.sequence),
    [1, 2, 3, 4, 5, 6],
  );
  assert.equal(host.observerFailures, events.length);
  assert.doesNotMatch(
    JSON.stringify({ events, rows: db.readExecution(result.id) }),
    /fixture-private-data|AGENT_BOOTSTRAP_GATEWAY_SECRET|abababababab/,
  );
});

test("required host stops at every new mandatory append failure and closes an open gateway", async (t) => {
  for (const [write, effects] of [
    ["execution_contexts", []],
    ["sandbox_bindings", ["gateway.open", "gateway.close"]],
    [
      "process_results",
      ["gateway.open", "create", "exec", "gateway.close", "destroy"],
    ],
    [
      "resource_events",
      ["gateway.open", "create", "exec", "gateway.close", "destroy"],
    ],
  ] as const) {
    const { host, calls } = observedFixture(
      t,
      {
        async exec() {
          calls.push("exec");
          return {
            status: "timed-out",
            exitCode: null,
            stdout: Buffer.alloc(0),
            stderr: Buffer.alloc(0),
          };
        },
      },
      write,
    );
    const id = randomUUID();
    await assert.rejects(
      host.runWorker(providerPlan, id),
      (error) => error instanceof HostAuditError && error.invocationId === id,
    );
    assert.deepEqual(
      calls.filter((call) =>
        /^(create|exec|collect|destroy|gateway\..*)$/.test(call),
      ),
      effects,
    );
    assert.ok(calls.includes(write));
    assert.ok(!calls.includes("invocation.finished"));
  }
});

test("gateway quarantine halts the host when exec exits or throws first", async (t) => {
  for (const throws of [false, true]) {
    const { host, calls, fake } = observedFixture(t, {
      async exec() {
        calls.push("exec");
        fake.quarantine();
        if (throws) throw new Error("fixture exec failure");
        return {
          status: "exited",
          exitCode: 0,
          stdout: Buffer.from('{"tool":"collect"}'),
          stderr: Buffer.alloc(0),
        };
      },
    });
    await assert.rejects(host.runWorker(providerPlan), HostAuditError);
    assert.deepEqual(calls.slice(-4), [
      "operation.allowed sandbox.exec",
      "exec",
      "gateway.close",
      "destroy",
    ]);
  }
});

test("gateway audit failure while draining relays triggers unaudited sandbox teardown", async (t) => {
  const { host, calls, fake } = observedFixture(t);
  fake.failAuditOnClose();
  await assert.rejects(host.runWorker(providerPlan), HostAuditError);
  assert.deepEqual(calls.slice(-2), ["gateway.close", "destroy"]);
  assert.ok(!calls.includes("operation.requested sandbox.destroy"));
});

test("gateway quarantine and shared audit failure abort an in-flight exec", async (t) => {
  for (const failure of ["gateway", "audit-store"] as const) {
    const events: RuntimeEvent[] = [];
    const caller = new AbortController();
    const observed = observedFixture(
      t,
      {
        async exec(_handle, { signal }) {
          assert.ok(signal);
          await new Promise<void>((resolve, reject) => {
            const timeout = setTimeout(
              () => reject(new Error("No abort")),
              500,
            );
            signal.addEventListener(
              "abort",
              () => {
                clearTimeout(timeout);
                observed.calls.push("abort");
                resolve();
              },
              { once: true },
            );
            if (failure === "gateway") observed.fake.quarantine();
            else observed.failAuditStore();
          });
          return {
            status: "cancelled",
            exitCode: null,
            stdout: Buffer.alloc(0),
            stderr: Buffer.alloc(0),
          };
        },
      },
      undefined,
      { observers: [{ observe: (event) => void events.push(event) }] },
    );
    const id = randomUUID();
    const work = failure === "gateway" ? providerPlan : plan;
    await assert.rejects(
      observed.host.runWorker(
        { ...work, command: { ...work.command, signal: caller.signal } },
        id,
      ),
      HostAuditError,
    );
    assert.equal(caller.signal.aborted, false);
    assert.deepEqual(
      observed.calls.slice(failure === "gateway" ? -3 : -2),
      failure === "gateway"
        ? ["abort", "gateway.close", "destroy"]
        : ["abort", "destroy"],
    );
    assert.equal(observed.db.readExecution(id).processResults.length, 0);
    assert.equal(observed.db.read(id).at(-1)?.kind, "operation.allowed");
    const finished = events.at(-1);
    assert.equal(finished?.eventType, "execution.finished");
    assert.equal(finished.payload.outcome, "unknown");
  }
});

test("required host refuses invalid setup, mismatched context and direct host ports", async (t) => {
  const { host, db, runtime, calls, fake } = observedFixture(t);
  assert.throws(
    () =>
      new TrustedHost(db, runtime, profiles, {
        config: requiredConfig,
      }),
    /factory/,
  );
  assert.throws(
    () =>
      new TrustedHost(db, adapter("").runtime, profiles, {
        config: requiredConfig,
        gatewayFactory: fake.open,
      }),
    /gateway support/,
  );
  const path = fixture(t);
  const writable = new SqliteAudit(path);
  writable.close();
  const readOnly = new SqliteAudit(path, { readonly: true });
  t.after(() => readOnly.close());
  assert.throws(
    () =>
      new TrustedHost(readOnly, runtime, profiles, {
        config: requiredConfig,
        gatewayFactory: fake.open,
      }),
    /Writable v6/,
  );
  await assert.rejects(
    host.runWorker({
      ...plan,
      sandbox: { ...plan.sandbox, hostTcpPort: 4242 },
    }),
    /hostTcpPort/,
  );
  await assert.rejects(
    host.runWorker(plan, randomUUID(), {
      executionId: randomUUID(),
    }),
    /context ID/,
  );
  assert.deepEqual(calls, []);
});

test("disabled mode requires per-run agent and host-port opt-in and makes no audit writes", async () => {
  const { runtime, calls } = adapter("");
  let writes = 0;
  const host = new TrustedHost(
    {
      append() {
        writes++;
      },
    },
    runtime,
    profiles,
    {
      config: { ...requiredConfig, audit: { mode: "disabled" } },
    },
  );
  await assert.rejects(
    host.runWorker(providerPlan),
    /explicit allowUnauditedRun/,
  );
  const direct = { ...plan, sandbox: { ...plan.sandbox, hostTcpPort: 4242 } };
  await assert.rejects(host.runWorker(direct), /explicit allowUnauditedRun/);
  assert.deepEqual(calls, []);
  const result = await host.runWorker(direct, undefined, undefined, {
    allowUnauditedRun: true,
  });
  assert.equal(result.outcome, "ok");
  assert.deepEqual(calls, ["create", "exec", "destroy"]);
  assert.equal(writes, 0);
});

test("required host maps host services through the gateway and isolates DNS observer data", async (t) => {
  const received: string[][] = [];
  const { host, fake } = observedFixture(
    t,
    {
      async exec() {
        const opened = fake.opened!;
        const answerIps = ["192.0.2.2"];
        opened.observer!.observe({
          eventId: randomUUID(),
          eventType: "network.dns.query",
          schemaVersion: 1,
          occurredAt: new Date().toISOString(),
          recordedAt: new Date().toISOString(),
          source: {
            component: "fixture",
            instanceId: randomUUID(),
            sequence: 1,
          },
          payload: {
            queryId: randomUUID(),
            protocol: "udp",
            qname: HOST_SERVICE_NAME,
            qtype: 1,
            decision: "allow",
            reasonCode: "host-service",
            policyId: opened.policy.policyId,
            answerIps,
          },
        });
        assert.deepEqual(answerIps, ["192.0.2.2"]);
        return {
          status: "exited",
          exitCode: 0,
          stdout: Buffer.alloc(0),
          stderr: Buffer.alloc(0),
        };
      },
    },
    undefined,
    {
      observers: [
        {
          observe(event) {
            if (event.eventType === "network.dns.query")
              (event.payload.answerIps as string[]).push("8.8.8.8");
          },
        },
        {
          observe(event) {
            if (event.eventType === "network.dns.query")
              received.push([...event.payload.answerIps]);
          },
        },
      ],
    },
  );
  const result = await host.runWorker(plan, undefined, undefined, {
    hostServices: [
      {
        hostname: HOST_SERVICE_NAME,
        ip: "192.0.2.2",
        port: 8080,
        loopbackPort: 4242,
      },
    ],
  });
  assert.equal(result.outcome, "ok");
  assert.deepEqual(received, [["192.0.2.2"]]);
  assert.deepEqual(
    fake.opened?.policy.decideConnect({
      ip: "192.0.2.2",
      port: 8080,
      sandbox: "fixture",
    }),
    {
      decision: "allow",
      reasonCode: "host-service",
      channel: "host-service",
      upstream: { ip: "127.0.0.1", port: 4242 },
    },
  );
});

test("timeout, cancellation and explicit lifetime expiry get distinct resource evidence", async (t) => {
  for (const [status, kind, expected] of [
    ["timed-out", "timed-out", "timed-out"],
    ["cancelled", "forced-termination", "cancelled"],
    ["lifetime-expired", "lifetime-expired", "timed-out"],
  ] as const) {
    const { host, db, calls } = observedFixture(
      t,
      {
        async exec() {
          if (status === "lifetime-expired")
            throw new SandboxRuntimeError(status);
          return {
            status,
            exitCode: null,
            stdout: Buffer.alloc(0),
            stderr: Buffer.alloc(0),
          };
        },
      },
      undefined,
      {
        config: {
          ...requiredConfig,
          telemetry: { ...requiredConfig.telemetry, enabled: false },
        },
        observers: [
          {
            observe() {
              assert.fail("disabled telemetry");
            },
          },
        ],
      },
    );
    const result = await host.runWorker(plan);
    assert.equal(result.outcome, expected);
    const rows = db.readExecution(result.id);
    assert.deepEqual(
      rows.resourceEvents.map((row) => row.kind),
      [kind],
    );
    assert.equal(rows.processResults[0]?.guestReported, false);
    assert.equal(rows.processResults[0]?.exitCode, null);
    assert.ok(!calls.includes("final-sample"));
    assert.equal(host.observerFailures, 0);
  }
});

test("required Coordinator sessions use the same binding, process and shutdown barriers", async (t) => {
  const { host, db, calls, fake } = observedFixture(t, {
    async openSession() {
      calls.push("session.open");
      return {
        send() {},
        lines: (async function* () {})(),
        close() {
          calls.push("session.close");
        },
        finished: Promise.resolve("cancelled" as const),
      };
    },
  });
  const id = randomUUID();
  const result = await host.runCoordinatorSession(
    providerPlan,
    id,
    async () => {
      calls.push("session.use");
      return 42;
    },
    { executionId: id, attributes: { streamed: true } },
  );
  assert.deepEqual(result, { id, outcome: "ok", value: 42 });
  const rows = db.readExecution(id);
  assert.equal(rows.sandboxBindings[0]?.sandboxId, fake.opened?.sandboxLabel);
  assert.equal(rows.processResults[0]?.exitCode, null);
  assert.equal(rows.processResults[0]?.guestReported, false);
  assert.deepEqual(
    calls.filter((call) =>
      /^(session\.|process_results|gateway.close|destroy)/.test(call),
    ),
    [
      "session.open",
      "session.use",
      "session.close",
      "process_results",
      "gateway.close",
      "destroy",
    ],
  );
});

test("a runtime that returns a different sandbox ID or network digest is quarantined", async (t) => {
  for (const field of ["id", "netRuleDigest"] as const) {
    const { host, db, calls } = observedFixture(t, {
      async createBound(_spec, id) {
        calls.push("create");
        return { id, netRuleDigest: ruleDigest, [field]: "mismatch" };
      },
    });
    const id = randomUUID();
    await assert.rejects(host.runWorker(providerPlan, id), HostAuditError);
    assert.equal(db.readExecution(id).sandboxBindings.length, 1);
    assert.deepEqual(calls.slice(-2), ["gateway.close", "destroy"]);
    assert.ok(!calls.includes("operation.finished sandbox.create"));
    assert.ok(!calls.includes("exec"));
    assert.ok(!calls.includes("operation.requested sandbox.destroy"));
  }
});

test("gateway bind failure refuses required egress before any provider grant or VM operation", async (t) => {
  const { host, calls } = observedFixture(t, {}, undefined, {
    async gatewayFactory() {
      throw new Error("fixture listener unavailable");
    },
  });
  const result = await host.runWorker(providerPlan);
  assert.equal(result.outcome, "failed");
  assert.deepEqual(calls, [
    "invocation.started",
    "execution_contexts",
    "invocation.finished",
  ]);
});

test("the legacy audit path refuses egress without an explicit mode", async (t) => {
  const audit = new SqliteAudit(fixture(t));
  t.after(() => audit.close());
  const { runtime, calls } = adapter("");
  const host = new TrustedHost(audit, runtime, profiles);
  await assert.rejects(host.runWorker(providerPlan), /configured audit/);
  await assert.rejects(
    host.runWorker({
      ...plan,
      sandbox: { hostTcpPort: 4242 },
    }),
    /hostTcpPort/,
  );
  assert.deepEqual(calls, []);
});

test("asynchronous telemetry rejections are counted without affecting the run", async (t) => {
  const { host } = observedFixture(t, undefined, undefined, {
    observers: [
      {
        async observe() {
          throw new Error("fixture exporter");
        },
        async observeFinalResourceSample() {
          throw new Error("fixture sampler");
        },
      },
    ],
  });
  assert.equal((await host.runWorker(plan)).outcome, "ok");
  assert.equal(host.observerFailures, 7);
});

test("Coordinator session send refuses further guest work after gateway quarantine", async (t) => {
  const { host, calls, fake } = observedFixture(t, {
    async openSession() {
      return {
        send(line) {
          calls.push(line);
        },
        lines: (async function* () {})(),
        close() {
          calls.push("session.close");
        },
        finished: Promise.resolve("cancelled" as const),
      };
    },
  });
  const id = randomUUID();
  await assert.rejects(
    host.runCoordinatorSession(providerPlan, id, async (session) => {
      session.send("first message");
      fake.quarantine();
      session.send("blocked message");
    }),
    HostAuditError,
  );
  assert.deepEqual(calls.slice(-4), [
    "first message",
    "session.close",
    "gateway.close",
    "destroy",
  ]);
});

const conciergePlan = {
  sandbox: {
    profile: "concierge",
    provider: { host: "api.anthropic.com", secretEnv: "ANTHROPIC_API_KEY" },
    interactive: {
      vsock: { hostPath: "/fixture/api.sock", port: 5000 },
      stateVolume: "lo-session",
      snapshotDir: "/fixture/repo",
    },
  },
} as const;

test("Concierge creates through the audited provider gateway and records each terminal attach", async (t) => {
  const id = randomUUID();
  const results = [7, 0];
  const { host, calls, db, fake } = observedFixture(t, {
    async attachTerminal(handle, command) {
      calls.push("attach");
      assert.equal(
        handle.id,
        db.readExecution(id).sandboxBindings[0]?.sandboxId,
      );
      assert.equal(db.read(id).at(-1)?.kind, "operation.allowed");
      assert.equal(db.read(id).at(-1)?.operation, "sandbox.exec");
      assert.deepEqual(command.argv, ["claude"]);
      return { exitCode: results.shift()! };
    },
  });
  let escaped: ((command: { argv: string[] }) => Promise<unknown>) | undefined;
  assert.deepEqual(
    await host.runConcierge(conciergePlan, id, async ({ attach }) => {
      escaped = attach;
      assert.deepEqual(await attach({ argv: ["claude"] }), { exitCode: 7 });
      assert.deepEqual(await attach({ argv: ["claude"] }), { exitCode: 0 });
      return "used";
    }),
    { id, outcome: "ok", value: "used" },
  );
  await assert.rejects(escaped!({ argv: ["claude"] }), /unknown-handle/);
  assert.deepEqual(fake.opened?.policy.allow, [
    { hostname: "api.anthropic.com", port: 443 },
  ]);
  assert.deepEqual(fake.opened?.policy.hostServices, []);
  assert.deepEqual(
    db.readExecution(id).processResults.map(({ exitCode }) => exitCode),
    [7, 0],
  );
  const trace = db.read(id);
  assert.ok(trace.every(({ role }) => role === "Concierge"));
  assert.equal(
    trace.find(({ operation }) => operation === "sandbox.create")?.profile,
    "concierge",
  );
  assert.deepEqual(
    trace
      .filter(({ operation }) => operation === "sandbox.exec")
      .map(({ kind, outcome }) => [kind, outcome]),
    [
      ["operation.requested", undefined],
      ["operation.allowed", undefined],
      ["operation.finished", "failed"],
      ["operation.requested", undefined],
      ["operation.allowed", undefined],
      ["operation.finished", "ok"],
    ],
  );
  assert.deepEqual(
    calls.filter((call) =>
      ["create", "attach", "gateway.close", "destroy"].includes(call),
    ),
    ["create", "attach", "attach", "gateway.close", "destroy"],
  );
});

test("Concierge refuses unsupported hosts, other profiles, other providers and host services before create", async (t) => {
  const use = async () => assert.fail("unexpected callback");
  const unsupported = observedFixture(t);
  await assert.rejects(
    unsupported.host.runConcierge(conciergePlan, randomUUID(), use),
    /audited interactive/,
  );
  const { host, calls, runtime, db } = observedFixture(t, {
    async attachTerminal() {
      assert.fail("unexpected attach");
    },
  });
  const unaudited = new TrustedHost(db, runtime, profiles);
  await assert.rejects(
    unaudited.runConcierge(conciergePlan, randomUUID(), use),
    /audited interactive/,
  );
  for (const sandbox of [
    { ...conciergePlan.sandbox, profile: "base" as const },
    { ...conciergePlan.sandbox, provider },
    {
      ...conciergePlan.sandbox,
      provider: { ...conciergePlan.sandbox.provider, port: 444 },
    },
    { ...conciergePlan.sandbox, hostTcpPort: 8080 },
  ])
    await assert.rejects(
      host.runConcierge({ sandbox }, randomUUID(), use),
      /audited interactive/,
    );
  await assert.rejects(
    host.runConcierge(conciergePlan, randomUUID(), use, undefined, {
      hostServices: [
        {
          hostname: HOST_SERVICE_NAME,
          port: 8080,
          ip: "192.0.2.1",
          loopbackPort: 8080,
        },
      ],
    }),
    /audited interactive/,
  );
  await assert.rejects(
    host.runWorker({ ...plan, sandbox: { profile: "concierge" } }),
    /profile not allowed/,
  );
  await assert.rejects(
    host.runWorker({
      ...plan,
      sandbox: { interactive: conciergePlan.sandbox.interactive },
    }),
    /Only Concierge/,
  );
  assert.deepEqual(calls, []);
  assert.deepEqual(unsupported.calls, []);
});

test("Concierge cannot resume guest work after a mandatory terminal audit failure", async (t) => {
  for (const label of [
    "operation.requested sandbox.exec",
    "operation.allowed sandbox.exec",
    "process_results",
    "operation.finished sandbox.exec",
  ]) {
    const id = randomUUID();
    const { host, calls, db } = observedFixture(
      t,
      {
        async attachTerminal() {
          calls.push("attach");
          return { exitCode: 0 };
        },
      },
      label,
    );
    await assert.rejects(
      host.runConcierge(conciergePlan, id, async ({ attach }) => {
        await assert.rejects(attach({ argv: ["claude"] }), HostAuditError);
        await assert.rejects(
          async () => attach({ argv: ["claude"] }),
          HostAuditError,
        );
      }),
      HostAuditError,
    );
    assert.equal(
      calls.filter((call) => call === "attach").length,
      label.startsWith("operation.") && !label.includes("finished") ? 0 : 1,
    );
    assert.equal(
      db.read(id).some(({ operation }) => operation === "sandbox.destroy"),
      false,
    );
    assert.deepEqual(calls.slice(-2), ["gateway.close", "destroy"]);
  }
});

test("Concierge closes the gateway and destroys a sandbox when audit fails during an attach", async (t) => {
  const id = randomUUID();
  let stop: (result: { exitCode: null }) => void = () =>
    assert.fail("no attach");
  const { host, calls, db, fake } = observedFixture(t, {
    async attachTerminal() {
      calls.push("attach");
      return new Promise((resolve) => {
        stop = resolve;
        fake.quarantine();
      });
    },
    async destroy() {
      calls.push("destroy");
      stop({ exitCode: null });
    },
  });
  await assert.rejects(
    host.runConcierge(conciergePlan, id, ({ attach }) =>
      attach({ argv: ["claude"] }),
    ),
    HostAuditError,
  );
  assert.deepEqual(calls.slice(-3), ["attach", "gateway.close", "destroy"]);
  assert.deepEqual(db.readExecution(id).processResults, []);
});

test("an idle Concierge callback cannot retain the VM and gateway past its lifetime", async (t) => {
  const id = randomUUID();
  const { host, calls, db } = observedFixture(t, {
    async attachTerminal() {
      assert.fail("unexpected attach");
    },
  });
  let attachAfterExpiry: (() => Promise<unknown>) | undefined;
  const result = await host.runConcierge(
    {
      sandbox: { ...conciergePlan.sandbox, maxLifetimeMs: 30 },
    },
    id,
    ({ attach }) => {
      attachAfterExpiry = () => attach({ argv: ["claude"] });
      return new Promise(() => {});
    },
  );
  assert.deepEqual(result, { id, outcome: "timed-out" });
  await assert.rejects(attachAfterExpiry!(), /unknown-handle/);
  assert.equal(db.read(id).at(-1)?.outcome, "timed-out");
  assert.ok(calls.indexOf("gateway.close") < calls.indexOf("destroy"));
});
