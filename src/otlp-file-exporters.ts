import { write } from "node:fs";
import { setImmediate as nextTurn } from "node:timers/promises";
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
  TelemetryJsonlDirectory,
  type TelemetryJsonlOptions,
  type TelemetrySignal as Signal,
} from "./jsonl-files.ts";
import { DEFAULT_TELEMETRY_MAX_TOTAL_BYTES } from "./observability-config.ts";

type FailureKind =
  JsonlFileError["code"] | "queue-full" | "serialization-failed";

export type OtlpFileExporterOptions = {
  readonly maxTotalBytes?: number;
  readonly writerOptions?: TelemetryJsonlOptions;
  readonly monotonicNow?: () => number;
  readonly writeDiagnostic?: (line: string) => void;
};

// Bound pending work including the active export. Flush and shutdown only
// add barriers, and can still run when the queue is full.
export const MAX_PENDING_EXPORTS = 256;

export function createExportQueue() {
  let tail = Promise.resolve();
  let pending = 0;

  function afterPending(work: () => Promise<void>): Promise<void> {
    const task = tail.then(work);
    tail = task.catch(() => {});
    return task;
  }

  return {
    enqueue(work: () => Promise<void>): boolean {
      if (pending >= MAX_PENDING_EXPORTS) return false;
      pending++;
      void afterPending(async () => {
        try {
          await nextTurn();
          await work();
        } finally {
          pending--;
        }
      });
      return true;
    },
    flush: () => tail,
    afterPending,
  };
}

export function writeTelemetryDiagnostic(line: string): void {
  write(2, line, () => {});
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
  const writeDiagnostic = options.writeDiagnostic ?? writeTelemetryDiagnostic;
  const lastDiagnostic = new Map<FailureKind, number>();
  let dropped = 0;
  const queue = createExportQueue();
  const writer = new TelemetryJsonlDirectory(
    join(obsDir, "telemetry"),
    options.maxTotalBytes ?? DEFAULT_TELEMETRY_MAX_TOTAL_BYTES,
    options.writerOptions,
  );

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
    const decoder = new TextDecoder();
    let closing: Promise<void> | undefined;

    async function write(data: Input): Promise<ExportResult> {
      let record: object;
      try {
        record = JSON.parse(decoder.decode(serialize(data)));
      } catch {
        return failure(signal, "serialization-failed");
      }
      try {
        await writer.write(signal, record);
      } catch (error) {
        return failure(signal, writerFailure(error));
      }
      return { code: ExportResultCode.SUCCESS };
    }

    return {
      export(data: Input, callback: (result: ExportResult) => void): void {
        if (closing) callback(failure(signal, "closed"));
        else if (!queue.enqueue(async () => callback(await write(data))))
          callback(failure(signal, "queue-full"));
      },
      forceFlush: queue.flush,
      shutdown(): Promise<void> {
        return (closing ??= queue.afterPending(async () => {
          try {
            await writer.close(signal);
          } catch (error) {
            failure(signal, writerFailure(error));
          }
        }));
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
