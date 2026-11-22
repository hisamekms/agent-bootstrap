import assert from "node:assert/strict";
import test from "node:test";
import {
  SequenceSource,
  type RuntimeEvent,
  type RuntimeObserver,
} from "../src/runtime-events.ts";

type Allow<T extends "network.connect.decided" | "network.dns.query"> = Extract<
  RuntimeEvent<T>["payload"],
  { decision: "allow" }
>;
type ProcessExit = RuntimeEvent<"process.exited">["payload"];
type IsAssignable<Value, Allowed> = Value extends Allowed ? true : false;
type MustBeFalse<Value extends false> = Value;
export type InvalidPayloadCombinations = [
  MustBeFalse<
    IsAssignable<
      "reserved-range",
      Allow<"network.connect.decided">["reasonCode"]
    >
  >,
  MustBeFalse<
    IsAssignable<"dns-type-refused", Allow<"network.dns.query">["reasonCode"]>
  >,
  MustBeFalse<
    IsAssignable<
      Omit<ProcessExit, "exitCode" | "guestReported"> & {
        exitCode: number;
        guestReported: false;
      },
      ProcessExit
    >
  >,
];

function observedValue(event: RuntimeEvent) {
  switch (event.eventType) {
    case "execution.started":
      return event.payload.context.executionId;
    case "execution.finished":
    case "sandbox.created":
    case "sandbox.destroyed":
    case "process.started":
      return event.payload.outcome;
    case "sandbox.started":
    case "sandbox.stopped":
      return "reserved";
    case "process.exited":
      return event.payload.exitCode;
    case "policy.evaluated":
    case "network.connect.decided":
      return event.payload.decision;
    case "resource.limit_exceeded":
      return event.payload.kind;
    case "network.connect.requested":
      return event.payload.destinationIp;
    case "network.connect.finished":
      return event.payload.result;
    case "network.dns.query":
      return event.payload.qname;
    default: {
      const exhaustive: never = event;
      return exhaustive;
    }
  }
}

test("an observer receives the payload narrowed by event type", () => {
  const seen: unknown[] = [];
  const observer: RuntimeObserver = {
    observe(event) {
      seen.push(observedValue(event));
    },
  };
  const source = new SequenceSource("host");
  const envelope = {
    eventId: "f1107e26-13f4-4e8e-a8bd-d61bba1aa111",
    schemaVersion: 1,
    occurredAt: "2026-11-23T10:00:00.000Z",
    recordedAt: "2026-11-23T10:00:00.001Z",
    source: source.next(),
  } as const;
  const startFailure: RuntimeEvent<"process.started"> = {
    ...envelope,
    eventType: "process.started",
    payload: { outcome: "failed" },
  };
  observer.observe(startFailure);
  observer.observe({
    ...envelope,
    eventId: "2f81ea2b-a4db-4d2d-b6aa-d8e26791b14d",
    source: source.next(),
    eventType: "process.exited",
    payload: {
      durationMs: 3,
      outcome: "succeeded",
      exitCode: 0,
      signal: null,
      guestReported: true,
    },
  });
  observer.observe({
    ...envelope,
    eventId: "db7b5104-3045-490f-8c99-46652cdda1b1",
    source: source.next(),
    eventType: "network.connect.decided",
    payload: {
      protocol: "tcp",
      connectionId: "28c3fac7-3257-435d-8ebd-7b027a5e5830",
      reasonCode: "auth-failed",
      decision: "deny",
      policyId: "fixture",
    },
  });
  assert.deepEqual(seen, ["failed", 0, "deny"]);
});

test("each emitting instance has its own strictly increasing sequence", () => {
  const host = new SequenceSource("host", "host-instance");
  const gateway = new SequenceSource("gateway");
  const otherGateway = new SequenceSource("gateway");

  const first = host.next();
  assert.deepEqual(gateway.next(), {
    component: "gateway",
    instanceId: gateway.instanceId,
    sequence: 1,
  });
  assert.deepEqual(
    [first, host.next(), host.next()],
    [1, 2, 3].map((sequence) => ({
      component: "host",
      instanceId: "host-instance",
      sequence,
    })),
  );
  assert.notEqual(otherGateway.instanceId, gateway.instanceId);
  assert.equal(otherGateway.next().sequence, 1);
  assert.equal(gateway.next().sequence, 2);
});
