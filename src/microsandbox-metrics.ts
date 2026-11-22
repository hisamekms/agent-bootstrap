import type { ResourceSample } from "./sandbox-runtime.ts";

export const METRICS_OUTPUT_BYTES = 16 * 1024;

const fields = {
  cpu_percent: "cpuPercent",
  cpus: "cpus",
  vcpu_time_ns: "vcpuTimeNs",
  memory_bytes: "memoryBytes",
  memory_available_bytes: "memoryAvailableBytes",
  memory_limit_bytes: "memoryLimitBytes",
  memory_host_resident_bytes: "memoryHostResidentBytes",
  disk_read_bytes: "diskReadBytes",
  disk_write_bytes: "diskWriteBytes",
  net_rx_bytes: "netRxBytes",
  net_tx_bytes: "netTxBytes",
  upper_used_bytes: "upperUsedBytes",
  upper_free_bytes: "upperFreeBytes",
  upper_host_allocated_bytes: "upperHostAllocatedBytes",
  uptime_secs: "uptimeSecs",
} as const satisfies Record<string, keyof ResourceSample>;

export function parseMicrosandboxMetrics(
  bytes: Uint8Array,
): ResourceSample | null {
  if (bytes.byteLength > METRICS_OUTPUT_BYTES) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    );
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
    return null;

  const record = parsed as Record<string, unknown>;
  const sample: Partial<Record<keyof ResourceSample, number>> = {};
  for (const [source, target] of Object.entries(fields)) {
    if (!Object.hasOwn(record, source)) continue;
    const value = record[source];
    if (value === null) continue;
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0)
      return null;
    if (
      target !== "cpuPercent" &&
      target !== "uptimeSecs" &&
      !Number.isSafeInteger(value)
    )
      return null;
    sample[target] = value;
  }
  return Object.keys(sample).length ? sample : null;
}
