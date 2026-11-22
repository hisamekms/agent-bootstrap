import assert from "node:assert/strict";
import test from "node:test";
import { context, trace } from "@opentelemetry/api";
import { resourceFromAttributes } from "@opentelemetry/resources";
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
  TracerProvider,
} from "@opentelemetry/sdk-trace";
import {
  AggregationTemporality,
  InMemoryMetricExporter,
  MeterProvider,
  PeriodicExportingMetricReader,
} from "@opentelemetry/sdk-metrics";
import {
  InMemoryLogRecordExporter,
  LoggerProvider,
  SimpleLogRecordProcessor,
} from "@opentelemetry/sdk-logs";
import { JsonTraceSerializer } from "@opentelemetry/otlp-transformer";

// DEP-1: the pinned OpenTelemetry packages load and work under Bun, and the
// official serializer produces OTLP JSON. No exporter talks to a network.
test("pinned OpenTelemetry SDKs work under Bun and serialize OTLP JSON", async () => {
  const resource = resourceFromAttributes({
    "service.name": "agent-bootstrap",
  });
  const spans = new InMemorySpanExporter();
  const tracer = new TracerProvider({
    resource,
    spanProcessors: [new SimpleSpanProcessor({ exporter: spans })],
  }).getTracer("compat");
  tracer.startActiveSpan("execution", (span) => {
    span.setAttribute("agent_bootstrap.execution_id", "e-1");
    span.end();
  });
  const [finished] = spans.getFinishedSpans();
  assert.equal(finished?.name, "execution");
  const json = JSON.parse(
    new TextDecoder().decode(JsonTraceSerializer.serializeRequest([finished!])),
  );
  assert.equal(json.resourceSpans[0].scopeSpans[0].spans[0].name, "execution");
  assert.ok(trace.getSpan(context.active()) === undefined);

  const metrics = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
  const reader = new PeriodicExportingMetricReader({
    exporter: metrics,
    exportIntervalMillis: 60_000,
  });
  const meterProvider = new MeterProvider({ resource, readers: [reader] });
  meterProvider.getMeter("compat").createCounter("runs").add(1);
  await reader.forceFlush();
  assert.ok(metrics.getMetrics().length > 0);
  await meterProvider.shutdown();

  const logs = new InMemoryLogRecordExporter();
  const loggerProvider = new LoggerProvider({
    resource,
    processors: [new SimpleLogRecordProcessor({ exporter: logs })],
  });
  loggerProvider.getLogger("compat").emit({ body: "hello" });
  assert.equal(logs.getFinishedLogRecords()[0]?.body, "hello");
});
