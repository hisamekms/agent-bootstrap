import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SpanStatusCode, TraceFlags } from "@opentelemetry/api";
import { ExportResultCode, hrTimeToMilliseconds } from "@opentelemetry/core";
import { InMemoryLogRecordExporter } from "@opentelemetry/sdk-logs";
import {
  AggregationTemporality,
  InMemoryMetricExporter,
  DataPointType,
} from "@opentelemetry/sdk-metrics";
import { InMemorySpanExporter } from "@opentelemetry/sdk-trace";
import { SqliteAudit } from "../src/audit.ts";
import { ProfileCatalog } from "../src/sandbox-profiles.ts";
import {
  SequenceSource,
  type ExecutionOutcome,
  type RuntimeEvent,
  type RuntimeEventType,
} from "../src/runtime-events.ts";
import { createTelemetry, type Telemetry } from "../src/telemetry.ts";
import { TrustedHost, type BoundSandboxRuntime } from "../src/trusted-host.ts";

const config = {
  enabled: true,
  resourceSamplingIntervalMs: 1_000,
  traceSamplingRatio: 1,
};
const traceId = "4bf92f3577b34da6a3ce929d0e0e4736";
const parentId = "00f067aa0ba902b7";
const sandboxId = `bootstrap-${randomUUID()}`;
const executionKey = "agent_bootstrap.execution_id";
const sandboxKey = "agent_bootstrap.sandbox_id";

function memoryExporters() {
  return {
    traces: new InMemorySpanExporter(),
    metrics: new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE),
    logs: new InMemoryLogRecordExporter(),
  };
}

function events(telemetry: Telemetry, executionId = randomUUID()) {
  const source = new SequenceSource("fixture");
  function emit<K extends RuntimeEventType>(
    eventType: K,
    payload: RuntimeEvent<K>["payload"],
  ) {
    const timestamp = new Date().toISOString();
    telemetry.observe({
      eventType,
      payload,
      executionId,
      sandboxId,
      occurredAt: timestamp,
      recordedAt: timestamp,
      eventId: randomUUID(),
      schemaVersion: 1,
      source: source.next(),
    } as RuntimeEvent);
  }

  return {
    emit,
    executionId,
    start(flags = "00") {
      emit("execution.started", {
        context: {
          executionId,
          attributes: { customer: "private-context-marker" },
          traceContext: {
            traceparent: `00-${traceId}-${parentId}-${flags}`,
            tracestate: "vendor=private-tracestate-marker",
          },
        },
        role: "Worker",
        profile: "base",
        agentKind: "codex",
        runtimeKind: "microsandbox",
      });
    },
  };
}

function finishRun(run: ReturnType<typeof events>, outcome: ExecutionOutcome) {
  const exitCode =
    outcome === "succeeded" ? 0 : outcome === "failed" ? 42 : null;
  const exit =
    exitCode === null
      ? { exitCode, guestReported: false }
      : { exitCode, guestReported: true as const };
  run.emit("process.exited", { ...exit, outcome, durationMs: 4, signal: null });
  if (outcome === "timed_out")
    run.emit("resource.limit_exceeded", { kind: "timed-out" });
  run.emit("sandbox.destroyed", { outcome: "succeeded", durationMs: 1 });
  run.emit("execution.finished", { outcome, durationMs: 10 });
}

function memoryMetrics(exporters: ReturnType<typeof memoryExporters>) {
  return exporters.metrics
    .getMetrics()
    .flatMap(({ scopeMetrics }) =>
      scopeMetrics.flatMap(({ metrics }) => metrics),
    );
}

for (const outcome of [
  "succeeded",
  "failed",
  "timed_out",
  "cancelled",
] as const) {
  test(`telemetry spans and metrics for a ${outcome} execution`, async () => {
    const exporters = memoryExporters();
    const telemetry = createTelemetry(config, "/unused", { exporters });
    const run = events(telemetry);
    try {
      run.start();
      run.emit("sandbox.created", {
        outcome: "succeeded",
        durationMs: 2,
        profile: "base",
        runtimeKind: "microsandbox",
      });
      run.emit("process.started", { outcome: "started" });
      telemetry.observeFinalResourceSample(run.executionId, sandboxId, {
        vcpuTimeNs: 4000,
        memoryBytes: 120,
        diskReadBytes: 300,
      });
      finishRun(run, outcome);

      const spans = exporters.traces.getFinishedSpans();
      assert.deepEqual(
        spans.map(({ name }) => name),
        [
          "sandbox.create",
          "agent.start",
          "agent.run",
          "sandbox.destroy",
          "execution",
        ],
      );
      const [create, start, process, destroy, execution] = spans;
      assert.ok(create && start && process && destroy && execution);
      for (const span of spans) {
        assert.equal(span.spanContext().traceId, traceId);
        assert.equal(span.spanContext().traceFlags, TraceFlags.SAMPLED);
        assert.equal(span.attributes[executionKey], run.executionId);
        assert.equal(span.attributes[sandboxKey], sandboxId);
        assert.equal(span.attributes["agent.kind"], "codex");
        assert.equal(span.attributes["runtime.kind"], "microsandbox");
        assert.equal(span.attributes.role, "Worker");
        assert.equal(span.attributes.profile, "base");
      }
      for (const span of [create, start, process, destroy])
        assert.equal(
          span.parentSpanContext?.spanId,
          execution.spanContext().spanId,
        );
      assert.equal(execution.parentSpanContext?.spanId, parentId);
      assert.equal(execution.parentSpanContext?.isRemote, true);
      assert.equal(execution.spanContext().traceState, undefined);
      for (const span of [process, execution]) {
        assert.equal(span.attributes.outcome, outcome);
        assert.equal(
          span.status.code,
          outcome === "succeeded" ? SpanStatusCode.OK : SpanStatusCode.ERROR,
        );
      }
      assert.equal(
        process.attributes["process.exit_code"],
        outcome === "failed" ? 42 : outcome === "succeeded" ? 0 : undefined,
      );
      assert.equal(
        process.attributes["process.guest_reported"],
        outcome === "failed" || outcome === "succeeded",
      );
      assert.ok(Math.abs(hrTimeToMilliseconds(process.duration) - 4) < 0.01);
      assert.ok(Math.abs(hrTimeToMilliseconds(execution.duration) - 10) < 0.01);
      assert.equal(
        execution.events[0]?.attributes?.["resource.kind"],
        outcome === "timed_out" ? "timed-out" : undefined,
      );
      assert.doesNotMatch(
        JSON.stringify(execution.attributes),
        /private-context-marker/,
      );
    } finally {
      await telemetry.shutdown();
    }

    const metrics = memoryMetrics(exporters);
    for (const metric of metrics)
      for (const point of metric.dataPoints)
        assert.ok(
          Object.keys(point.attributes).every((key) =>
            [
              "role",
              "profile",
              "agent.kind",
              "outcome",
              "runtime.kind",
            ].includes(key),
          ),
        );
    const expected = {
      "execution.duration": 10,
      "sandbox.startup.duration": 2,
      "process.duration": 4,
      "sandbox.cpu.time": 4000,
      "sandbox.memory.usage": 120,
      "sandbox.memory.peak": 120,
    };
    for (const [name, value] of Object.entries(expected)) {
      const metric = metrics.find(({ descriptor }) => descriptor.name === name);
      assert.ok(metric?.dataPointType === DataPointType.HISTOGRAM, name);
      assert.equal(metric.dataPoints[0]?.value.sum, value);
    }
    const active = metrics.find(
      ({ descriptor }) => descriptor.name === "sandbox.active",
    );
    assert.equal(active?.dataPoints[0]?.value, 0);
    for (const unavailable of [
      "sandbox.disk.read",
      "sandbox.memory.host_resident",
    ])
      assert.ok(
        !metrics.some(({ descriptor }) => descriptor.name === unavailable),
      );
  });
}

test("sandbox creation failure has no process or destroy span", async () => {
  const exporters = memoryExporters();
  const telemetry = createTelemetry(config, "/unused", { exporters });
  const run = events(telemetry);
  try {
    run.start();
    run.emit("sandbox.created", {
      outcome: "failed",
      durationMs: 2,
      profile: "base",
      runtimeKind: "microsandbox",
    });
    run.emit("execution.finished", { outcome: "failed", durationMs: 10 });
    assert.deepEqual(
      exporters.traces
        .getFinishedSpans()
        .map(({ name, status }) => [name, status.code]),
      [
        ["sandbox.create", SpanStatusCode.ERROR],
        ["execution", SpanStatusCode.ERROR],
      ],
    );
  } finally {
    await telemetry.shutdown();
  }
  assert.ok(
    !memoryMetrics(exporters).some(
      ({ descriptor }) => descriptor.name === "sandbox.active",
    ),
  );
});

test("sampling combines periodic points with the forwarded terminal sample", async () => {
  const exporters = memoryExporters();
  let tick: (() => void) | undefined;
  const telemetry = createTelemetry(config, "/unused", {
    exporters,
    samplingTimer: {
      setInterval(callback, interval) {
        assert.equal(interval, config.resourceSamplingIntervalMs);
        tick = callback;
        return () => {
          tick = undefined;
        };
      },
    },
  });
  const run = events(telemetry);
  const handle = { id: sandboxId };
  try {
    run.start();
    run.emit("sandbox.created", {
      outcome: "succeeded",
      durationMs: 2,
      profile: "base",
      runtimeKind: "microsandbox",
    });
    telemetry.startResourceSampling(run.executionId, handle, {
      async sampleResources(actual) {
        assert.equal(actual, handle);
        return { memoryBytes: 512, diskReadBytes: 4, netTxBytes: 30 };
      },
    });
    assert.ok(tick);
    tick();
    await Promise.resolve();
    telemetry.observeFinalResourceSample(run.executionId, sandboxId, {
      memoryBytes: 256,
      memoryHostResidentBytes: 768,
      diskReadBytes: 19,
      netTxBytes: 30,
    });
    assert.equal(tick, undefined);
    run.emit("sandbox.destroyed", { outcome: "succeeded", durationMs: 1 });
    run.emit("execution.finished", { outcome: "succeeded", durationMs: 10 });
    const execution = exporters.traces
      .getFinishedSpans()
      .find(({ name }) => name === "execution");
    assert.equal(execution?.attributes["sandbox.memory.peak"], 512);
    assert.equal(
      execution?.attributes["resource.sampling.status"],
      "available",
    );
  } finally {
    await telemetry.shutdown();
  }
  const metrics = memoryMetrics(exporters);
  for (const [name, value] of Object.entries({
    "sandbox.memory.peak": 512,
    "sandbox.memory.usage": 256,
    "sandbox.memory.host_resident": 768,
    "sandbox.disk.read": 15,
    "sandbox.network.tx": 0,
  })) {
    const metric = metrics.find(({ descriptor }) => descriptor.name === name);
    assert.ok(metric?.dataPointType === DataPointType.HISTOGRAM, name);
    assert.equal(metric.dataPoints[0]?.value.sum, value);
  }
});

test("network logs retain correlation and allowlisted destinations and redact denied DNS names", async () => {
  const exporters = memoryExporters();
  const telemetry = createTelemetry(
    { ...config, traceSamplingRatio: 0 },
    "/unused",
    { exporters },
  );
  const run = events(telemetry);
  const policyId = "b".repeat(64);
  try {
    run.start("01");
    run.emit("network.connect.decided", {
      connectionId: "connection-id",
      policyId,
      channel: "provider-egress",
      protocol: "tcp",
      decision: "allow",
      reasonCode: "allowlisted-host",
      hostname: "provider.example",
      destinationIp: "192.0.2.1",
      destinationPort: 443,
    });
    run.emit("network.dns.query", {
      queryId: "query-id",
      policyId,
      protocol: "udp",
      qname: "provider.example",
      qtype: 1,
      decision: "allow",
      reasonCode: "allowlisted-host",
      answerIps: ["192.0.2.1"],
    });
    const denied = {
      queryId: "denied-id",
      policyId,
      protocol: "udp",
      qname: "secret-label.example",
      qtype: 1,
      decision: "deny",
      reasonCode: "dns-not-allowlisted",
      answerIps: [],
    } as const;
    run.emit("network.dns.query", denied);
    run.emit("network.dns.query", denied);
    run.emit("execution.finished", { outcome: "succeeded", durationMs: 10 });

    assert.equal(exporters.traces.getFinishedSpans().length, 0);
    const records = exporters.logs.getFinishedLogRecords();
    assert.equal(records.length, 4);
    for (const record of records) {
      assert.equal(record.spanContext?.traceId, traceId);
      assert.equal(record.spanContext?.traceFlags, TraceFlags.NONE);
      assert.equal(record.attributes[executionKey], run.executionId);
      assert.equal(record.attributes[sandboxKey], sandboxId);
    }
    const [connect, query, deniedQuery, repeated] = records;
    assert.equal(connect?.attributes["network.connection_id"], "connection-id");
    assert.equal(
      connect?.attributes["destination.hostname"],
      "provider.example",
    );
    assert.equal(connect?.attributes["destination.address"], "192.0.2.1");
    assert.equal(query?.attributes["dns.qname"], "provider.example");
    assert.equal(query?.attributes["network.query_id"], "query-id");
    assert.equal(deniedQuery?.attributes["dns.qname"], undefined);
    const hash = deniedQuery?.attributes["dns.qname_hash"];
    assert.match(String(hash), /^[a-f0-9]{64}$/);
    assert.equal(repeated?.attributes["dns.qname_hash"], hash);
    assert.doesNotMatch(
      JSON.stringify(
        records.map(({ body, attributes }) => ({ body, attributes })),
      ),
      /secret-label/,
    );
  } finally {
    await telemetry.shutdown();
  }
});

test("throwing and failing exporters are isolated across signals and shutdown", async () => {
  const memory = memoryExporters();
  const telemetry = createTelemetry(config, "/unused", {
    exporters: {
      ...memory,
      traces: {
        export() {
          throw new Error("fixture private exporter error");
        },
        async shutdown() {
          throw new Error("fixture shutdown failure");
        },
      },
      logs: {
        export(_records, callback) {
          callback({ code: ExportResultCode.FAILED });
        },
        async forceFlush() {},
        async shutdown() {},
      },
    },
  });
  const run = events(telemetry);
  assert.doesNotThrow(() => {
    run.start();
    run.emit("network.connect.decided", {
      connectionId: "fixture",
      policyId: "b".repeat(64),
      protocol: "tcp",
      decision: "deny",
      reasonCode: "auth-failed",
    });
    run.emit("execution.finished", { outcome: "succeeded", durationMs: 10 });
  });
  const shutdown = telemetry.shutdown();
  assert.equal(telemetry.shutdown(), shutdown);
  await shutdown;
  assert.equal(
    memoryMetrics(memory).find(
      ({ descriptor }) => descriptor.name === "obs.telemetry.dropped",
    )?.dataPoints[0]?.value,
    3,
  );
});

function hostFixture(
  directory: string,
  telemetry: Telemetry,
  enabled: boolean,
) {
  const audit = new SqliteAudit(join(directory, "audit.sqlite"));
  const runtime: BoundSandboxRuntime = {
    async create() {
      throw new Error("Expected bound creation");
    },
    netRuleDigest: () => "a".repeat(64),
    async createBound(spec, id) {
      return { id, netRuleDigest: spec.expectedNetRuleDigest! };
    },
    async exec() {
      return {
        status: "exited",
        exitCode: 0,
        stdout: Buffer.alloc(0),
        stderr: Buffer.from("private-stderr"),
      };
    },
    async collect() {
      return { files: [] };
    },
    async destroy() {},
    finalResourceSample: () => ({ memoryBytes: 23 }),
  };
  const host = new TrustedHost(
    audit,
    runtime,
    new ProfileCatalog({
      base: { image: `fixture.invalid/alpine@sha256:${"a".repeat(64)}` },
    }),
    {
      config: {
        audit: { mode: "required" },
        telemetry: { ...config, enabled },
      },
      observers: [telemetry],
      async gatewayFactory() {
        throw new Error("This fixture has no egress");
      },
    },
  );
  return { audit, host };
}

test("disabled telemetry is a no-op and the required SQLite audit still records the run", async (t) => {
  const directory = mkdtempSync(
    join(realpathSync(tmpdir()), "bootstrap-telemetry-"),
  );
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const telemetry = createTelemetry({ ...config, enabled: false }, directory);
  const { host, audit } = hostFixture(directory, telemetry, false);
  t.after(() => audit.close());
  const run = events(telemetry);
  run.start();
  run.emit("execution.finished", { outcome: "succeeded", durationMs: 10 });
  const result = await host.runWorker({
    sandbox: {},
    command: { argv: ["/fixture"], timeoutMs: 500 },
    collectPaths: [],
  });
  await telemetry.shutdown();

  assert.equal(result.outcome, "ok");
  const records = audit.read(result.id);
  assert.equal(records[0]?.kind, "invocation.started");
  assert.equal(records.at(-1)?.kind, "invocation.finished");
  assert.equal(records.at(-1)?.outcome, "ok");
  assert.equal(
    records.filter(({ kind }) => kind === "operation.finished").length,
    3,
  );
  const execution = audit.readExecution(result.id);
  assert.equal(execution.executionContexts.length, 1);
  assert.equal(execution.sandboxBindings.length, 1);
  assert.equal(execution.processResults.length, 1);
  assert.ok(!existsSync(join(directory, "telemetry")));
});

test("disk failure leaves the host outcome and required SQLite audit intact", async (t) => {
  const directory = mkdtempSync(
    join(realpathSync(tmpdir()), "bootstrap-telemetry-"),
  );
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  writeFileSync(join(directory, "telemetry"), "");
  const telemetry = createTelemetry(config, directory);
  const { host, audit } = hostFixture(directory, telemetry, true);
  t.after(() => audit.close());
  const result = await host.runWorker({
    sandbox: {},
    command: { argv: ["/fixture"], timeoutMs: 500 },
    collectPaths: [],
  });
  await telemetry.shutdown();
  assert.equal(host.observerFailures, 0);
  assert.equal(result.outcome, "ok");
  assert.equal(audit.read(result.id).at(-1)?.outcome, "ok");
});

test("default exporters publish OTLP JSONL files at shutdown", async (t) => {
  const directory = mkdtempSync(
    join(realpathSync(tmpdir()), "bootstrap-telemetry-"),
  );
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const telemetry = createTelemetry(config, directory);
  const run = events(telemetry);
  run.start();
  run.emit("network.connect.decided", {
    connectionId: "fixture",
    policyId: "b".repeat(64),
    protocol: "tcp",
    decision: "deny",
    reasonCode: "auth-failed",
  });
  run.emit("execution.finished", { outcome: "succeeded", durationMs: 10 });
  await telemetry.shutdown();
  for (const signal of ["traces", "metrics", "logs"])
    assert.match(
      readdirSync(join(directory, "telemetry", signal)).join(),
      /^\d{4}-\d{2}-\d{2}-\d+\.jsonl$/,
    );
});
