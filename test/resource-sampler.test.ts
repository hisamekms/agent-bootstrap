import assert from "node:assert/strict";
import test from "node:test";
import {
  createResourceSampler,
  type ResourceSamplingTimer,
} from "../src/resource-sampler.ts";
import type { ResourceSample, SandboxRuntime } from "../src/sandbox-runtime.ts";

const handle = { id: "sandbox" };

function fakeTimer() {
  let callback: (() => void) | undefined;
  let interval: number | undefined;
  let cancellations = 0;
  const timer: ResourceSamplingTimer = {
    setInterval(tick, intervalMs) {
      assert.equal(callback, undefined);
      callback = tick;
      interval = intervalMs;
      return () => {
        cancellations++;
      };
    },
  };
  return {
    timer,
    get interval() {
      return interval;
    },
    get cancellations() {
      return cancellations;
    },
    async tick() {
      // Deliver even a queued callback to exercise the stop guard.
      callback?.();
      await Promise.resolve();
    },
  };
}

test("skips pending polls and summarizes periodic and terminal samples", async () => {
  const clock = fakeTimer();
  const first = Promise.withResolvers<ResourceSample>();
  let calls = 0;
  let finalCalls = 0;
  const runtime: Pick<
    SandboxRuntime,
    "sampleResources" | "finalResourceSample"
  > = {
    sampleResources(actual) {
      assert.equal(actual, handle);
      calls++;
      return calls === 1
        ? first.promise
        : Promise.resolve({
            memoryBytes: 40,
            diskReadBytes: 29,
            diskWriteBytes: 8,
            netTxBytes: 4,
          });
    },
    finalResourceSample(actual) {
      assert.equal(actual, handle);
      finalCalls++;
      return {
        vcpuTimeNs: 55,
        memoryBytes: 30,
        memoryHostResidentBytes: 60,
        diskReadBytes: 42,
        diskWriteBytes: 8,
        netRxBytes: 9,
        netTxBytes: 15,
      };
    },
  };
  const sampler = createResourceSampler(runtime, handle, 450, clock.timer);
  assert.equal(clock.interval, 450);
  assert.equal(calls, 0);
  assert.equal(finalCalls, 0);

  await clock.tick();
  await clock.tick();
  await clock.tick();
  assert.equal(calls, 1);
  first.resolve({
    vcpuTimeNs: 10,
    memoryBytes: 20,
    diskReadBytes: 20,
    diskWriteBytes: 8,
    netRxBytes: 0,
  });
  await first.promise;
  await clock.tick();
  assert.equal(calls, 2);

  sampler.stop();
  await clock.tick();
  assert.equal(calls, 2);
  assert.equal(finalCalls, 0);
  const summary = sampler.finish();
  assert.deepEqual(summary, {
    status: "available",
    sampleCount: 3,
    skippedTicks: 2,
    failures: 0,
    lastSample: {
      vcpuTimeNs: 55,
      memoryBytes: 30,
      memoryHostResidentBytes: 60,
      diskReadBytes: 42,
      diskWriteBytes: 8,
      netRxBytes: 9,
      netTxBytes: 15,
    },
    sampledPeakMemoryBytes: 40,
    firstVcpuTimeNs: 10,
    lastVcpuTimeNs: 55,
    deltas: {
      diskReadBytes: 22,
      diskWriteBytes: 0,
      netRxBytes: 9,
      netTxBytes: 11,
    },
  });
  assert.equal(sampler.finish(), summary);
  assert.equal(finalCalls, 1);
  assert.equal(clock.cancellations, 1);
});

test("short runs report only the final sample and preserve zero values", () => {
  const clock = fakeTimer();
  const sampler = createResourceSampler(
    {
      sampleResources() {
        assert.fail("Unexpected periodic poll");
      },
      finalResourceSample: () => ({
        vcpuTimeNs: 22,
        memoryBytes: 0,
        diskReadBytes: 700,
      }),
    },
    handle,
    1000,
    clock.timer,
  );
  assert.deepEqual(sampler.finish(), {
    status: "available",
    sampleCount: 1,
    skippedTicks: 0,
    failures: 0,
    lastSample: { vcpuTimeNs: 22, memoryBytes: 0, diskReadBytes: 700 },
    sampledPeakMemoryBytes: 0,
    firstVcpuTimeNs: 22,
    lastVcpuTimeNs: 22,
    deltas: {},
  });
});

test("counts failed reads and recovers on subsequent ticks", async () => {
  const clock = fakeTimer();
  let calls = 0;
  const sampler = createResourceSampler(
    {
      sampleResources() {
        calls++;
        if (calls === 1) throw new Error("synchronous failure");
        if (calls === 2) return Promise.reject(new Error("rejected poll"));
        return Promise.resolve(calls === 3 ? null : { memoryBytes: 15 });
      },
      finalResourceSample() {
        throw new Error("terminal read failure");
      },
    },
    handle,
    1000,
    clock.timer,
  );
  for (let poll = 0; poll < 4; poll++) await clock.tick();
  assert.deepEqual(sampler.finish(), {
    status: "available",
    sampleCount: 1,
    skippedTicks: 0,
    failures: 4,
    lastSample: { memoryBytes: 15 },
    sampledPeakMemoryBytes: 15,
    deltas: {},
  });
});

test("unsupported sampling and empty samples report unavailable values", async () => {
  const expected = {
    status: "unavailable",
    sampleCount: 0,
    skippedTicks: 0,
    failures: 0,
    deltas: {},
  };
  const clock = fakeTimer();
  assert.deepEqual(
    createResourceSampler({}, handle, 1000, clock.timer).finish(),
    expected,
  );
  assert.equal(clock.interval, undefined);
  const sampler = createResourceSampler(
    {
      sampleResources: async () => ({}),
      finalResourceSample: () => null,
    },
    handle,
    1000,
    clock.timer,
  );
  await clock.tick();
  assert.deepEqual(sampler.finish(), { ...expected, failures: 2 });
});

test("a counter reset leaves its delta absent even after the counter recovers", async () => {
  const clock = fakeTimer();
  const samples = [{ diskReadBytes: 10, netRxBytes: 1 }, { diskReadBytes: 2 }];
  const sampler = createResourceSampler(
    {
      sampleResources: async () => samples.shift() ?? null,
      finalResourceSample: () => ({ diskReadBytes: 20, netRxBytes: 8 }),
    },
    handle,
    1000,
    clock.timer,
  );
  await clock.tick();
  await clock.tick();
  assert.deepEqual(sampler.finish().deltas, { netRxBytes: 7 });
});

test("finish uses the final sample even if a poll is still pending", async () => {
  const clock = fakeTimer();
  const pending = Promise.withResolvers<ResourceSample>();
  const sampler = createResourceSampler(
    {
      sampleResources: () => pending.promise,
      finalResourceSample: () => ({ memoryBytes: 5 }),
    },
    handle,
    1000,
    clock.timer,
  );
  await clock.tick();
  sampler.stop();
  const summary = sampler.finish();
  pending.resolve({ memoryBytes: 1000 });
  await pending.promise;
  await clock.tick();
  assert.equal(sampler.finish(), summary);
  assert.equal(summary.sampleCount, 1);
  assert.equal(summary.sampledPeakMemoryBytes, 5);
  assert.equal(summary.skippedTicks, 0);
});

test("only recognized numeric data fields reach the summary", () => {
  const sample = {
    memoryBytes: 10,
    netTxBytes: Number.POSITIVE_INFINITY,
    diagnostics: "adapter detail",
    get netRxBytes(): number {
      return assert.fail("Unexpected accessor read");
    },
  };
  const summary = createResourceSampler(
    { finalResourceSample: () => sample },
    handle,
    1000,
    fakeTimer().timer,
  ).finish();
  assert.deepEqual(summary.lastSample, { memoryBytes: 10 });
});
