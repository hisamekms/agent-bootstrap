import type {
  ResourceSample,
  SandboxHandle,
  SandboxRuntime,
} from "./sandbox-runtime.ts";

export interface ResourceSamplingTimer {
  /** Schedule the first tick after one interval. Return a cancellation function. */
  setInterval(tick: () => void, intervalMs: number): () => void;
}

const systemTimer: ResourceSamplingTimer = {
  setInterval(tick, intervalMs) {
    const interval = setInterval(tick, intervalMs);
    interval.unref();
    return () => clearInterval(interval);
  },
};

const deltaFields = [
  "diskReadBytes",
  "diskWriteBytes",
  "netRxBytes",
  "netTxBytes",
] as const;
type DeltaField = (typeof deltaFields)[number];

const sampleFields = [
  ...deltaFields,
  "cpuPercent",
  "cpus",
  "vcpuTimeNs",
  "memoryBytes",
  "memoryAvailableBytes",
  "memoryLimitBytes",
  "memoryHostResidentBytes",
  "upperUsedBytes",
  "upperFreeBytes",
  "upperHostAllocatedBytes",
  "uptimeSecs",
] as const satisfies readonly (keyof ResourceSample)[];

export interface ResourceSamplingSummary {
  readonly status: "available" | "unavailable";
  readonly sampleCount: number;
  readonly skippedTicks: number;
  readonly failures: number;
  /** Terminal sample when available, otherwise the latest periodic sample. */
  readonly lastSample?: ResourceSample;
  readonly sampledPeakMemoryBytes?: number;
  readonly firstVcpuTimeNs?: number;
  readonly lastVcpuTimeNs?: number;
  /** Bytes between the first and last observations of each counter. */
  readonly deltas: Readonly<Partial<Record<DeltaField, number>>>;
}

export interface ResourceSampler {
  /** Stop polling before destroy. In-flight telemetry cannot delay cleanup. */
  stop(): void;
  /** Read the adapter's final sample after destroy. Safe to call repeatedly. */
  finish(): ResourceSamplingSummary;
}

export function createResourceSampler(
  runtime: Pick<SandboxRuntime, "sampleResources" | "finalResourceSample">,
  handle: SandboxHandle,
  resourceSamplingIntervalMs: number,
  timer: ResourceSamplingTimer = systemTimer,
): ResourceSampler {
  let cancelTimer: (() => void) | undefined;
  let stopped = false;
  let pending = false;
  let summary: ResourceSamplingSummary | undefined;
  let failures = 0;
  let skippedTicks = 0;
  let sampleCount = 0;
  let lastSample: ResourceSample | undefined;
  let sampledPeakMemoryBytes: number | undefined;
  let firstVcpuTimeNs: number | undefined;
  let lastVcpuTimeNs: number | undefined;
  const counters = new Map<
    DeltaField,
    { first: number; last: number; observations: number; reset: boolean }
  >();

  function record(sample: ResourceSample | null): void {
    const values: Partial<Record<keyof ResourceSample, number>> = {};
    for (const field of sampleFields) {
      // Keep adapter metadata and accessors out of telemetry.
      const value: unknown =
        sample && Object.getOwnPropertyDescriptor(sample, field)?.value;
      if (
        typeof value === "number" &&
        value >= 0 &&
        (field === "cpuPercent" || field === "uptimeSecs"
          ? Number.isFinite(value)
          : Number.isSafeInteger(value))
      )
        values[field] = value;
    }
    if (Object.keys(values).length === 0) {
      failures++;
      return;
    }

    sampleCount++;
    lastSample = Object.freeze(values);
    if (values.memoryBytes !== undefined)
      sampledPeakMemoryBytes = Math.max(
        sampledPeakMemoryBytes ?? values.memoryBytes,
        values.memoryBytes,
      );
    if (values.vcpuTimeNs !== undefined) {
      firstVcpuTimeNs ??= values.vcpuTimeNs;
      lastVcpuTimeNs = values.vcpuTimeNs;
    }
    for (const field of deltaFields) {
      const value = values[field];
      if (value === undefined) continue;
      const counter = counters.get(field);
      if (counter) {
        counter.reset ||= value < counter.last;
        counter.last = value;
        counter.observations++;
      } else {
        counters.set(field, {
          first: value,
          last: value,
          observations: 1,
          reset: false,
        });
      }
    }
  }

  async function tick(): Promise<void> {
    if (stopped) return;
    if (pending) {
      skippedTicks++;
      return;
    }
    pending = true;
    try {
      const sample = await runtime.sampleResources?.(handle);
      if (!stopped) record(sample ?? null);
    } catch {
      // Polls can be cancelled by the adapter during destroy.
      if (!stopped) failures++;
    } finally {
      pending = false;
    }
  }

  try {
    if (runtime.sampleResources) {
      cancelTimer = timer.setInterval(
        () => void tick(),
        resourceSamplingIntervalMs,
      );
    }
  } catch {
    failures++;
  }

  function stop(): void {
    if (stopped) return;
    stopped = true;
    try {
      cancelTimer?.();
    } catch {
      failures++;
    }
  }

  return {
    stop,
    finish() {
      if (summary) return summary;
      stop();
      try {
        if (runtime.finalResourceSample)
          record(runtime.finalResourceSample(handle));
      } catch {
        failures++;
      }

      const deltas: Partial<Record<DeltaField, number>> = {};
      for (const [field, counter] of counters) {
        if (counter.observations >= 2 && !counter.reset)
          deltas[field] = counter.last - counter.first;
      }
      summary = Object.freeze({
        status: sampleCount > 0 ? "available" : "unavailable",
        sampleCount,
        skippedTicks,
        failures,
        ...(lastSample === undefined ? {} : { lastSample }),
        ...(sampledPeakMemoryBytes === undefined
          ? {}
          : { sampledPeakMemoryBytes }),
        ...(firstVcpuTimeNs === undefined ? {} : { firstVcpuTimeNs }),
        ...(lastVcpuTimeNs === undefined ? {} : { lastVcpuTimeNs }),
        deltas: Object.freeze(deltas),
      });
      return summary;
    },
  };
}
