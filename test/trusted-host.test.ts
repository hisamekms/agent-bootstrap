import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { type AuditSink, SqliteAudit } from "../src/audit.ts";
import { HostRequests } from "../src/host-requests.ts";
import type { ExecResult, SandboxRuntime } from "../src/sandbox-runtime.ts";
import { HostAuditError, TrustedHost } from "../src/trusted-host.ts";

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
      assert.deepEqual(spec.paths, ["report.txt"]);
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
  const result = await new TrustedHost(audit, runtime).runWorker(plan);
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

test("unknown guest actions are denied and timeout remains distinct from failure", async (t) => {
  const audit = new SqliteAudit(fixture(t));
  t.after(() => audit.close());
  const denied = adapter('{"tool":"fixture-secret-attempt"}');
  const rejection = await new TrustedHost(audit, denied.runtime).runWorker(
    plan,
  );
  assert.equal(rejection.outcome, "denied");
  assert.deepEqual(denied.calls, ["create", "exec", "destroy"]);
  const trace = audit.read(rejection.id);
  assert.ok(trace.some((event) => event.kind === "operation.denied"));
  assert.doesNotMatch(JSON.stringify(trace), /fixture-secret-attempt/);
  const timed = adapter("", "timed-out");
  const timeout = await new TrustedHost(audit, timed.runtime).runWorker(plan);
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
    new TrustedHost(failing, runtime).runWorker(plan),
    (error) => {
      assert.ok(error instanceof HostAuditError);
      traceId = error.invocationId;
      return true;
    },
  );
  assert.deepEqual(calls, ["create"]);
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
    new TrustedHost(audit, runtime).runWorker(plan),
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
  const host = new TrustedHost(audit, runtime);
  const plan = {
    sandbox: { hostTcpPort: 4242, maxLifetimeMs: 10_000 },
    command: { argv: ["/fixture"], timeoutMs: 500 },
  };
  const ok = await host.runCoordinatorSession(
    plan,
    randomUUID(),
    async () => 7,
  );
  assert.deepEqual(ok.value, 7);
  assert.deepEqual(calls.splice(0), [
    "create 4242 0",
    "open",
    "close",
    "destroy",
  ]);
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
  assert.deepEqual(calls.splice(0), [
    "create 4242 0",
    "open",
    "close",
    "destroy",
  ]);
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
    new TrustedHost(audit, {
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
    });
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
  // An audit failure after create stops before any further effect.
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
  );
  await assert.rejects(
    host.runCoordinatorSession(plan, randomUUID(), async () => 1),
    HostAuditError,
  );
  assert.deepEqual(calls, ["create"]);
});

test("a new audit database uses schema 3 and records provider egress", async (t) => {
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
  if (version.status === 0) assert.equal(version.stdout.trim(), "3");
});
