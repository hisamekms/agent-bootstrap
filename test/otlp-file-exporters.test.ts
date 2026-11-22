import assert from "node:assert/strict";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { afterEach, beforeEach } from "node:test";
import { ExportResultCode, type ExportResult } from "@opentelemetry/core";
import { resourceFromAttributes } from "@opentelemetry/resources";
import {
  LoggerProvider,
  SimpleLogRecordProcessor,
} from "@opentelemetry/sdk-logs";
import {
  MeterProvider,
  PeriodicExportingMetricReader,
} from "@opentelemetry/sdk-metrics";
import {
  SimpleSpanProcessor,
  TracerProvider,
  type ReadableSpan,
} from "@opentelemetry/sdk-trace";
import { createOtlpFileExporters } from "../src/otlp-file-exporters.ts";

const filename = "2026-11-23-0001.jsonl";
const now = () => new Date("2026-11-23T00:00:00Z");
const resource = resourceFromAttributes({ "service.name": "agent-bootstrap" });
let root: string;

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "otlp-files-")));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function signalDir(signal: string): string {
  return join(root, "telemetry", signal);
}

function readLines(signal: string) {
  assert.deepEqual(fs.readdirSync(signalDir(signal)), [filename]);
  const lines = fs
    .readFileSync(join(signalDir(signal), filename), "utf8")
    .split("\n");
  assert.equal(lines.pop(), "");
  return lines.map((line) => JSON.parse(line));
}

function exportOnce<T>(
  exporter: { export(data: T, callback: (result: ExportResult) => void): void },
  data: T,
  expected: ExportResultCode,
): ExportResult {
  const results: ExportResult[] = [];
  exporter.export(data, (result) => results.push(result));
  assert.equal(results.length, 1);
  const result = results[0]!;
  assert.equal(result.code, expected);
  return result;
}

test("the SDKs write one OTLP request per export and publish on shutdown", async () => {
  const exporters = createOtlpFileExporters(root, { writerOptions: { now } });
  const tracerProvider = new TracerProvider({
    resource,
    spanProcessors: [new SimpleSpanProcessor({ exporter: exporters.traces })],
  });
  const meterProvider = new MeterProvider({
    resource,
    readers: [
      new PeriodicExportingMetricReader({ exporter: exporters.metrics }),
    ],
  });
  const loggerProvider = new LoggerProvider({
    resource,
    processors: [new SimpleLogRecordProcessor({ exporter: exporters.logs })],
  });
  try {
    const tracer = tracerProvider.getTracer("obs-test");
    tracer.startSpan("execution").end();
    tracer.startSpan("sandbox.create").end();
    const meter = meterProvider.getMeter("obs-test");
    exporters.registerDroppedCounter(meter);
    meter.createHistogram("execution.duration").record(42);
    loggerProvider.getLogger("obs-test").emit({ body: "network.decided" });

    await tracerProvider.forceFlush();
    assert.ok(fs.existsSync(join(signalDir("traces"), `${filename}.partial`)));
  } finally {
    await Promise.all([
      tracerProvider.shutdown(),
      meterProvider.shutdown(),
      loggerProvider.shutdown(),
    ]);
  }

  const spans = readLines("traces").map(
    (request) => request.resourceSpans[0].scopeSpans[0].spans[0],
  );
  assert.deepEqual(
    spans.map((span) => span.name),
    ["execution", "sandbox.create"],
  );
  for (const span of spans) {
    assert.match(span.traceId, /^[a-f0-9]{32}$/u);
    assert.match(span.spanId, /^[a-f0-9]{16}$/u);
  }
  const [metricRequest] = readLines("metrics");
  const metrics = metricRequest.resourceMetrics[0].scopeMetrics[0].metrics;
  assert.equal(
    metrics.find((m: { name: string }) => m.name === "execution.duration")
      .histogram.dataPoints[0].sum,
    42,
  );
  assert.equal(
    metrics.find((m: { name: string }) => m.name === "obs.telemetry.dropped")
      .sum.dataPoints[0].asInt,
    0,
  );
  const [logRequest] = readLines("logs");
  assert.equal(
    logRequest.resourceLogs[0].scopeLogs[0].logRecords[0].body.stringValue,
    "network.decided",
  );
  assert.equal(exporters.dropped, 0);
});

test("ENOSPC drops metrics, rate-limits diagnostics, and leaves traces working", async () => {
  const diagnostics: string[] = [];
  let elapsed = 0;
  let diskFull = true;
  const exporters = createOtlpFileExporters(root, {
    monotonicNow: () => elapsed,
    writeDiagnostic: (line) => diagnostics.push(line),
    writerOptions: {
      now,
      fs: {
        ...fs,
        writeSync(fd, data) {
          if (
            diskFull &&
            data.toString("utf8").startsWith('{"resourceMetrics"')
          ) {
            throw Object.assign(new Error("sensitive disk error details"), {
              code: "ENOSPC",
            });
          }
          return fs.writeSync(fd, data);
        },
      },
    },
  });
  const metrics = { resource, scopeMetrics: [] };
  const failure = exportOnce(
    exporters.metrics,
    metrics,
    ExportResultCode.FAILED,
  );
  assert.equal(failure.error?.message, "OTLP file export: disk-full");
  elapsed = 59_999;
  exportOnce(exporters.metrics, metrics, ExportResultCode.FAILED);
  assert.deepEqual(diagnostics, [
    "obs.telemetry.dropped signal=metrics kind=disk-full\n",
  ]);
  elapsed = 60_000;
  exportOnce(exporters.metrics, metrics, ExportResultCode.FAILED);
  assert.equal(diagnostics.length, 2);

  const tracerProvider = new TracerProvider({
    resource,
    spanProcessors: [new SimpleSpanProcessor({ exporter: exporters.traces })],
  });
  tracerProvider.getTracer("obs-test").startSpan("execution").end();
  await tracerProvider.forceFlush();
  await tracerProvider.shutdown();
  assert.equal(readLines("traces").length, 1);

  diskFull = false;
  const meterProvider = new MeterProvider({
    resource,
    readers: [
      new PeriodicExportingMetricReader({ exporter: exporters.metrics }),
    ],
  });
  exporters.registerDroppedCounter(meterProvider.getMeter("obs-test"));
  await meterProvider.shutdown();
  assert.equal(exporters.dropped, 3);
  assert.deepEqual(fs.readdirSync(signalDir("metrics")).sort(), [
    `${filename}.partial`,
    "2026-11-23-0002.jsonl.partial",
    "2026-11-23-0003.jsonl.partial",
    "2026-11-23-0004.jsonl",
  ]);
  const recovered = JSON.parse(
    fs.readFileSync(
      join(signalDir("metrics"), "2026-11-23-0004.jsonl"),
      "utf8",
    ),
  );
  const [counter] = recovered.resourceMetrics[0].scopeMetrics[0].metrics;
  assert.equal(counter.name, "obs.telemetry.dropped");
  assert.equal(counter.sum.dataPoints[0].asInt, 3);
});

test("refuses a symlinked signal directory when the SDK first exports", async () => {
  const diagnostics: string[] = [];
  const target = join(root, "target");
  fs.mkdirSync(target);
  fs.mkdirSync(join(root, "telemetry"));
  fs.symlinkSync(target, signalDir("logs"));
  const exporters = createOtlpFileExporters(root, {
    writeDiagnostic: (line) => diagnostics.push(line),
  });
  exportOnce(exporters.logs, [], ExportResultCode.FAILED);
  await exporters.logs.shutdown();
  assert.equal(exporters.dropped, 1);
  assert.deepEqual(diagnostics, [
    "obs.telemetry.dropped signal=logs kind=unsafe-directory\n",
  ]);
  assert.deepEqual(fs.readdirSync(target), []);
});

test("serialization and shutdown failures are counted without exposing raw errors", async () => {
  const diagnostics: string[] = [];
  const exporters = createOtlpFileExporters(root, {
    writeDiagnostic(line) {
      diagnostics.push(line);
      throw new Error("stderr unavailable");
    },
    writerOptions: {
      now,
      fs: {
        ...fs,
        fsyncSync() {
          throw Object.assign(new Error("sensitive path"), { code: "ENOSPC" });
        },
      },
    },
  });
  const invalid: ReadableSpan[] = [];
  Object.defineProperty(invalid, 0, {
    get() {
      throw new Error("sensitive payload");
    },
  });
  assert.equal(
    exportOnce(exporters.traces, invalid, ExportResultCode.FAILED).error
      ?.message,
    "OTLP file export: serialization-failed",
  );
  exportOnce(exporters.traces, [], ExportResultCode.SUCCESS);
  await exporters.traces.shutdown();
  await exporters.traces.shutdown();
  assert.equal(exporters.dropped, 2);
  assert.deepEqual(diagnostics, [
    "obs.telemetry.dropped signal=traces kind=serialization-failed\n",
    "obs.telemetry.dropped signal=traces kind=disk-full\n",
  ]);
  assert.deepEqual(fs.readdirSync(signalDir("traces")), [
    `${filename}.partial`,
  ]);
  exportOnce(exporters.traces, [], ExportResultCode.FAILED);
});
