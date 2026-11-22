import assert from "node:assert/strict";
import test from "node:test";
import {
  METRICS_OUTPUT_BYTES,
  parseMicrosandboxMetrics,
} from "../src/microsandbox-metrics.ts";

const parse = (text: string) =>
  parseMicrosandboxMetrics(new TextEncoder().encode(text));

test("projects the numeric fields reported by Microsandbox 0.7.16", () => {
  const fixture = {
    cpu_percent: 4.25,
    cpus: 2,
    vcpu_time_ns: 585_322_121,
    memory_bytes: 72_351_744,
    memory_available_bytes: 62_914_560,
    memory_limit_bytes: 134_217_728,
    memory_host_resident_bytes: 83_886_080,
    disk_read_bytes: 0,
    disk_write_bytes: 52_428_800,
    net_rx_bytes: 432,
    net_tx_bytes: 448,
    upper_used_bytes: 52_428_800,
    upper_free_bytes: 128_974_848,
    upper_host_allocated_bytes: 53_477_376,
    uptime_secs: 3.5,
    state: "running",
    timestamp: "2026-11-23T00:00:00Z",
    unrecognized: { message: "ignore backend metadata" },
  };
  assert.deepEqual(parse(JSON.stringify(fixture)), {
    cpuPercent: 4.25,
    cpus: 2,
    vcpuTimeNs: 585_322_121,
    memoryBytes: 72_351_744,
    memoryAvailableBytes: 62_914_560,
    memoryLimitBytes: 134_217_728,
    memoryHostResidentBytes: 83_886_080,
    diskReadBytes: 0,
    diskWriteBytes: 52_428_800,
    netRxBytes: 432,
    netTxBytes: 448,
    upperUsedBytes: 52_428_800,
    upperFreeBytes: 128_974_848,
    upperHostAllocatedBytes: 53_477_376,
    uptimeSecs: 3.5,
  });
});

test("omits null and missing metrics while preserving zero in terminal samples", () => {
  assert.deepEqual(
    parse(
      '{"state":"exited","cpu_percent":null,"vcpu_time_ns":72,"memory_bytes":null,"net_rx_bytes":0}',
    ),
    { vcpuTimeNs: 72, netRxBytes: 0 },
  );
  assert.equal(parse('{"state":"exited","memory_bytes":null}'), null);
});

test("rejects malformed or oversized output and invalid known values", () => {
  for (const text of [
    "",
    "{bad json",
    "null",
    "[]",
    "1",
    '{"cpu_percent":1e999}',
    '{"vcpu_time_ns":9007199254740992}',
    '{"memory_bytes":2.5}',
    '{"net_rx_bytes":-1}',
    '{"disk_read_bytes":"42","disk_write_bytes":12}',
    '{"memory_bytes":[]}',
    '{"cpus":true}',
    " ".repeat(METRICS_OUTPUT_BYTES) + '{"cpus":2}',
  ])
    assert.equal(parse(text), null, text.slice(0, 60));
  assert.equal(parseMicrosandboxMetrics(Uint8Array.of(0xff)), null);
});
