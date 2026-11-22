import { writeSync } from "node:fs";
import { join } from "node:path";
import { ValueType, type Meter } from "@opentelemetry/api";
import { ExportResultCode, type ExportResult } from "@opentelemetry/core";
import {
  JsonLogsSerializer,
  JsonMetricsSerializer,
  JsonTraceSerializer,
} from "@opentelemetry/otlp-transformer";
import type { LogRecordExporter } from "@opentelemetry/sdk-logs";
import type { PushMetricExporter } from "@opentelemetry/sdk-metrics";
import type { SpanExporter } from "@opentelemetry/sdk-trace";
import {
  JsonlFileError,
  JsonlWriter,
  type JsonlWriterOptions,
} from "./jsonl-files.ts";

type Signal = "traces" | "metrics" | "logs";
type FailureKind = JsonlFileError["code"] | "serialization-failed";

export type OtlpFileExporterOptions = {
  readonly writerOptions?: JsonlWriterOptions;
  readonly monotonicNow?: () => number;
  readonly writeDiagnostic?: (line: string) => void;
};

function writeStderr(line: string): void {
  writeSync(2, line);
}

function writerFailure(error: unknown): FailureKind {
  return error instanceof JsonlFileError ? error.code : "write-failed";
}

/**
 * Export telemetry from trusted host instrumentation. Callers must select
 * safe attributes and log bodies before submitting records to the SDK.
 */
export function createOtlpFileExporters(
  obsDir: string,
  options: OtlpFileExporterOptions = {},
) {
  const monotonicNow = options.monotonicNow ?? (() => performance.now());
  const writeDiagnostic = options.writeDiagnostic ?? writeStderr;
  const lastDiagnostic = new Map<FailureKind, number>();
  let dropped = 0;

  function failure(signal: Signal, kind: FailureKind): ExportResult {
    dropped++;
    try {
      const now = monotonicNow();
      const last = lastDiagnostic.get(kind);
      if (last === undefined || now - last >= 60_000) {
        lastDiagnostic.set(kind, now);
        writeDiagnostic(
          `obs.telemetry.dropped signal=${signal} kind=${kind}\n`,
        );
      }
    } catch {
      // An unavailable diagnostic sink must not prevent delivery of the result.
    }
    return {
      code: ExportResultCode.FAILED,
      error: new Error(`OTLP file export: ${kind}`),
    };
  }

  function exporter<Input>(
    signal: Signal,
    serialize: (data: Input) => Uint8Array | undefined,
  ) {
    const dir = join(obsDir, "telemetry", signal);
    const decoder = new TextDecoder();
    let writer: JsonlWriter | undefined;
    let closed = false;

    function write(data: Input): ExportResult {
      if (closed) return failure(signal, "closed");

      let record: object;
      try {
        record = JSON.parse(decoder.decode(serialize(data)));
      } catch {
        return failure(signal, "serialization-failed");
      }
      try {
        // Acquire each lock on demand so open failures are reported as drops
        // and a later export can retry.
        writer ??= new JsonlWriter(dir, options.writerOptions);
        writer.write(record);
      } catch (error) {
        return failure(signal, writerFailure(error));
      }
      return { code: ExportResultCode.SUCCESS };
    }

    return {
      export(data: Input, callback: (result: ExportResult) => void): void {
        callback(write(data));
      },
      // Exports are synchronous. Shutdown publishes the active file.
      forceFlush(): Promise<void> {
        return Promise.resolve();
      },
      async shutdown(): Promise<void> {
        closed = true;
        try {
          writer?.close();
        } catch (error) {
          failure(signal, writerFailure(error));
        } finally {
          writer = undefined;
        }
      },
    };
  }

  return {
    traces: exporter(
      "traces",
      JsonTraceSerializer.serializeRequest,
    ) satisfies SpanExporter,
    metrics: exporter(
      "metrics",
      JsonMetricsSerializer.serializeRequest,
    ) satisfies PushMetricExporter,
    logs: exporter(
      "logs",
      JsonLogsSerializer.serializeRequest,
    ) satisfies LogRecordExporter,
    get dropped(): number {
      return dropped;
    },
    registerDroppedCounter(meter: Meter): void {
      meter
        .createObservableCounter("obs.telemetry.dropped", {
          valueType: ValueType.INT,
        })
        .addCallback((result) => result.observe(dropped));
    },
  };
}
