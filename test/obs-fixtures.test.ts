import assert from "node:assert/strict";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { ROOT_CONTEXT, ValueType, trace } from "@opentelemetry/api";
import { ExportResultCode } from "@opentelemetry/core";
import { resourceFromAttributes } from "@opentelemetry/resources";
import {
  LoggerProvider,
  SimpleLogRecordProcessor,
} from "@opentelemetry/sdk-logs";
import {
  AggregationTemporality,
  DataPointType,
  type ResourceMetrics,
} from "@opentelemetry/sdk-metrics";
import { SimpleSpanProcessor, TracerProvider } from "@opentelemetry/sdk-trace";
import { SqliteAudit, type AuditInput } from "../src/audit.ts";
import { exportAudit } from "../src/audit-export.ts";
import { createOtlpFileExporters } from "../src/otlp-file-exporters.ts";

const fixtureDir = fileURLToPath(new URL("./fixtures/obs/", import.meta.url));
const run = "719fcff0-ee4f-4adc-a9af-124be8115e72";
const failedRun = "f6abac75-6df0-4775-a035-f2290f54f819";
const openRun = "6d0c4a77-b72d-4474-95a8-3ec70ab43268";
const sandbox = "bootstrap-4f2c634d-6fb3-43aa-b405-8ecff42b565a";
const otherSandbox = "bootstrap-646d6540-8497-4ec9-9576-ad47d52c9317";
const flow = "b4741cf7-5b33-42d5-a8ef-ecf08e3475b9";
const openFlow = "300ae758-9b30-49af-81a4-fd20e1337aff";
const traceId = "0123456789abcdef0123456789abcdef";
const parentId = "0123456789abcdef";
const policyId = "a".repeat(64);
const now = () => new Date("2026-11-23T00:00:00.000Z");
const file = "2026-11-23-0001.jsonl";

function produceAudit(root: string, obs: string): void {
  const db = join(root, "audit.sqlite");
  const audit = new SqliteAudit(db);
  try {
    for (const [executionId, sandboxId] of [
      [run, sandbox],
      [failedRun, otherSandbox],
    ] as const) {
      audit.append({ invocationId: executionId, kind: "invocation.started" });
      audit.appendExecutionContext({
        executionId,
        traceContext: { traceparent: `00-${traceId}-${parentId}-01` },
      });
      audit.appendSandboxBinding({
        invocationId: executionId,
        sandboxId,
        runtimeKind: "microsandbox",
        egressMode: "gateway",
        netRuleDigest: policyId,
        gatewayPolicyId: policyId,
        gatewayPolicyDigest: policyId,
      });
    }

    function operation(
      action: NonNullable<AuditInput["operation"]>,
      outcome?: "ok",
    ) {
      const request = {
        invocationId: run,
        operation: action,
        role: "Worker",
      } as const;
      audit.append({ ...request, kind: "operation.requested" });
      audit.append({ ...request, kind: "operation.allowed" });
      if (outcome)
        audit.append({ ...request, kind: "operation.finished", outcome });
    }
    operation("sandbox.create", "ok");
    operation("sandbox.exec");
    audit.appendProcessResult({
      invocationId: run,
      operation: "sandbox.exec",
      exitCode: 0,
      signal: null,
      guestReported: true,
    });

    const allowed = {
      invocationId: run,
      sandboxId: sandbox,
      connectionId: flow,
      destinationIp: "2001:db8::1",
      destinationPort: 443,
      hostname: "provider.example",
      channel: "provider-egress",
      decision: "allow",
      reasonCode: "allowlisted-host",
      policyId,
    } as const;
    audit.appendNetwork(allowed);
    audit.appendNetwork({ ...allowed, connectionId: openFlow });
    // Flow IDs are scoped to the execution and sandbox.
    audit.appendNetwork({
      invocationId: failedRun,
      sandboxId: otherSandbox,
      connectionId: flow,
      destinationIp: "192.0.2.1",
      destinationPort: 80,
      channel: "egress",
      decision: "deny",
      reasonCode: "not-allowlisted",
      policyId,
    });
    audit.appendDnsQuery({
      invocationId: failedRun,
      sandboxId: otherSandbox,
      queryId: "0b5199ae-74fa-43c9-8075-6b6133c27f25",
      qname: "denied.example",
      qtype: 1,
      protocol: "udp",
      decision: "deny",
      reasonCode: "dns-not-allowlisted",
      policyId,
      answerIps: [],
    });
    audit.appendResourceEvent({
      invocationId: failedRun,
      sandboxId: otherSandbox,
      kind: "timed-out",
    });
    audit.append({
      invocationId: failedRun,
      kind: "invocation.finished",
      outcome: "timed-out",
    });
    exportAudit(db, obs, { now });

    audit.appendNetworkFinished({
      invocationId: run,
      sandboxId: sandbox,
      connectionId: flow,
      result: "connected",
      endReason: "upstream-closed",
      bytesSent: 42,
      bytesReceived: 72,
      durationMs: 3.5,
    });
    operation("sandbox.destroy", "ok");
    audit.append({
      invocationId: run,
      kind: "invocation.finished",
      outcome: "ok",
    });
    exportAudit(db, obs, { now });
    audit.append({ invocationId: openRun, kind: "invocation.started" });
    exportAudit(db, obs, { now });
    audit.append({
      invocationId: openRun,
      kind: "invocation.finished",
      outcome: "ok",
    });
    exportAudit(db, obs, { now });
  } finally {
    audit.close();
  }
}

async function produceTelemetry(
  obs: string,
  includeSamplingStatus = false,
): Promise<void> {
  const exporter = createOtlpFileExporters(obs, { writerOptions: { now } });
  const resource = resourceFromAttributes({
    "service.name": "agent-bootstrap",
  });
  const epoch = now().getTime();
  let spanId = 0;
  const traces = new TracerProvider({
    resource,
    idGenerator: {
      generateTraceId: () => "f".repeat(32),
      generateSpanId: () => String(++spanId).padStart(16, "0"),
    },
    spanProcessors: [new SimpleSpanProcessor({ exporter: exporter.traces })],
  });
  const tracer = traces.getTracer("agent-bootstrap");
  const parent = trace.setSpanContext(ROOT_CONTEXT, {
    traceId,
    spanId: parentId,
    traceFlags: 1,
    isRemote: true,
  });
  for (const [executionId, sandboxId, outcome, duration, startup] of [
    [run, sandbox, "succeeded", 100, 20],
    [failedRun, otherSandbox, "timed_out", 200, 10],
  ] as const) {
    const attributes = {
      "agent_bootstrap.execution_id": executionId,
      "agent_bootstrap.sandbox_id": sandboxId,
      role: "Worker",
      profile: "base",
      "agent.kind": "codex",
    };
    const execution = tracer.startSpan(
      "execution",
      {
        attributes: {
          ...attributes,
          outcome,
          ...(includeSamplingStatus &&
            executionId === failedRun && {
              "resource.sampling.status": "unavailable",
            }),
        },
        startTime: epoch,
      },
      parent,
    );
    tracer
      .startSpan(
        "sandbox.create",
        {
          attributes: { ...attributes, outcome: "succeeded" },
          startTime: epoch,
        },
        trace.setSpan(ROOT_CONTEXT, execution),
      )
      .end(epoch + startup);
    execution.end(epoch + duration);
  }
  // An execution-attributed span on a different trace exercises both joins.
  tracer
    .startSpan(
      "process.exec",
      {
        attributes: { "agent_bootstrap.execution_id": run },
        startTime: epoch + 20,
      },
      ROOT_CONTEXT,
    )
    .end(epoch + 80);
  await traces.shutdown();

  for (const [offset, cpu, memory] of [
    [1, 2000, 4096],
    [2, 4000, 8192],
  ] as const) {
    const metrics: ResourceMetrics = {
      resource,
      scopeMetrics: [
        {
          scope: { name: "agent-bootstrap" },
          metrics: [
            { name: "sandbox.cpu.time", unit: "ns", first: 2000, value: cpu },
            {
              name: "sandbox.memory.usage",
              unit: "By",
              first: 4096,
              value: memory,
            },
          ].map(({ name, unit, first, value }) => ({
            descriptor: {
              name,
              unit,
              description: "",
              valueType: ValueType.INT,
            },
            aggregationTemporality: AggregationTemporality.CUMULATIVE,
            dataPointType: DataPointType.HISTOGRAM,
            dataPoints: [
              {
                attributes: {
                  role: "Worker",
                  profile: "base",
                  "agent.kind": "codex",
                },
                startTime: [epoch / 1000, 0],
                endTime: [epoch / 1000 + offset, 0],
                value: {
                  min: first,
                  max: value,
                  sum: offset === 1 ? first : first + value,
                  count: offset,
                  buckets: { boundaries: [1024], counts: [0, offset] },
                },
              },
            ],
          })),
        },
      ],
    };
    const result = await new Promise<ExportResultCode>((resolve) =>
      exporter.metrics.export(metrics, ({ code }) => resolve(code)),
    );
    assert.equal(result, ExportResultCode.SUCCESS);
  }
  await exporter.metrics.shutdown();

  const logs = new LoggerProvider({
    resource,
    processors: [new SimpleLogRecordProcessor({ exporter: exporter.logs })],
  });
  logs.getLogger("agent-bootstrap").emit({
    body: "network.dns.query",
    timestamp: epoch,
    observedTimestamp: epoch,
  });
  await logs.shutdown();
}

type AuditLine = { recordedAt: string };
function normalizeAudit(line: AuditLine): AuditLine {
  assert.match(
    line.recordedAt,
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u,
  );
  return { ...line, recordedAt: now().toISOString() };
}

test("OBS-15 fixtures match the audit and OTLP file exporters", async (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "obs-fixtures-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const obs = join(root, "obs");
  produceAudit(root, obs);
  await produceTelemetry(obs);

  function auditLines(index: string): string {
    const raw = fs.readFileSync(
      join(obs, `audit/2026-11-23-${index}.jsonl`),
      "utf8",
    );
    assert.ok(raw.endsWith("\n"));
    return (
      raw
        .slice(0, -1)
        .split("\n")
        .map((line) => JSON.stringify(normalizeAudit(JSON.parse(line))))
        .join("\n") + "\n"
    );
  }

  const unpublishedOutcome = auditLines("0004");
  const expected = {
    [`audit/${file}`]: auditLines("0001"),
    "audit/2026-11-23-0002.jsonl": auditLines("0002"),
    "audit/2026-11-23-0003.jsonl":
      auditLines("0003") + unpublishedOutcome.slice(0, 45),
    "audit/2026-11-23-0004.jsonl": unpublishedOutcome.slice(0, -1),
    "audit/2026-11-23-0005.jsonl.partial": unpublishedOutcome,
    [`telemetry/traces/${file}`]: fs.readFileSync(
      join(obs, "telemetry/traces", file),
      "utf8",
    ),
    [`telemetry/metrics/${file}`]: fs.readFileSync(
      join(obs, "telemetry/metrics", file),
      "utf8",
    ),
    [`telemetry/logs/${file}`]: fs.readFileSync(
      join(obs, "telemetry/logs", file),
      "utf8",
    ),
  };

  for (const [name, contents] of Object.entries(expected)) {
    const path = join(fixtureDir, name);
    assert.equal(fs.readFileSync(path, "utf8"), contents, name);
  }
});

test("sampling status distinguishes unavailable resources in OTLP fixtures", async (t) => {
  const obs = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "obs-sampling-")));
  t.after(() => fs.rmSync(obs, { recursive: true, force: true }));
  await produceTelemetry(obs, true);
  const spans = fs
    .readFileSync(join(obs, "telemetry", "traces", file), "utf8")
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line).resourceSpans[0].scopeSpans[0].spans[0]);
  const unavailable = spans.find(
    (span) =>
      span.name === "execution" &&
      span.attributes.some(
        ({ key, value }: { key: string; value: { stringValue?: string } }) =>
          key === "agent_bootstrap.execution_id" &&
          value.stringValue === failedRun,
      ),
  );
  const noSandbox = spans.find((span) => span.name === "process.exec");
  for (const span of [unavailable, noSandbox]) {
    assert.ok(span);
    assert.equal(
      span.attributes.some(
        ({ key }: { key: string }) =>
          key === "sandbox.cpu.time" || key === "sandbox.memory.usage",
      ),
      false,
    );
  }
  assert.deepEqual(
    unavailable.attributes.find(
      ({ key }: { key: string }) => key === "resource.sampling.status",
    )?.value,
    { stringValue: "unavailable" },
  );
  assert.equal(
    noSandbox.attributes.find(
      ({ key }: { key: string }) => key === "resource.sampling.status",
    ),
    undefined,
  );
});
