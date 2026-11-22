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
