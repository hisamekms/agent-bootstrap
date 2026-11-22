import assert from "node:assert/strict";
import test from "node:test";
import { parseExecutionContext } from "../src/execution-context.ts";

const executionId = "f1107e26-13f4-4e8e-a8bd-d61bba1aa111";
const invalidContext = {
  name: "TypeError",
  message: "Invalid execution context",
};
const traceparent = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";

test("parses a minimal context and snapshots and freezes a populated one", () => {
  assert.deepEqual(parseExecutionContext({ executionId }), { executionId });

  const attributes = {
    "task.name": "sample",
    "attempt.number": 2,
    cached: true,
  };
  const traceContext = {
    traceparent,
    tracestate: "tenant@vendor=alpha, vendor=2",
  };
  const input = {
    executionId,
    sessionId: "01234567-abcd-7abc-8def-0123456789ab",
    retryOfExecutionId: "2f81ea2b-a4db-4d2d-b6aa-d8e26791b14d",
    correlationId: "8b21790d-0e46-4df0-8a21-5214926bf2d1",
    attributes,
    traceContext,
  };

  const parsed = parseExecutionContext(input);
  assert.deepEqual(parsed, input);
  attributes["task.name"] = "changed";
  traceContext.tracestate = "vendor=3";
  assert.equal(parsed.attributes?.["task.name"], "sample");
  assert.equal(
    parsed.traceContext?.tracestate,
    "tenant@vendor=alpha, vendor=2",
  );
  assert.equal(Object.isFrozen(parsed), true);
  assert.equal(Object.isFrozen(parsed.attributes), true);
  assert.equal(Object.isFrozen(parsed.traceContext), true);
});

test("rejects unknown keys and invalid or missing IDs", () => {
  for (const input of [
    null,
    [],
    {},
    { executionId: executionId.toUpperCase() },
    { executionId: "01234567-abcd-7abc-8def-0123456789ab" },
    { executionId, sessionId: "no" },
    { executionId, retryOfExecutionId: "01234567-abcd-7abc-8def-0123456789ab" },
    { executionId, correlationId: undefined },
    { executionId, unknown: 1 },
    { executionId, [Symbol("unknown")]: 1 },
    { executionId, traceContext: { traceparent, extra: true } },
    Object.assign(Object.create({ sessionId: executionId }), { executionId }),
  ]) {
    assert.throws(() => parseExecutionContext(input), invalidContext);
  }
});

test("rejects accessors and proxies at every level without running traps", () => {
  let reads = 0;
  const get = (): never => {
    reads++;
    throw new Error("Unexpected accessor or proxy trap");
  };
  const proxy = new Proxy({}, { getPrototypeOf: get, ownKeys: get });
  const attributes = Object.defineProperty({}, "task", { get });
  const traceContext = Object.defineProperty({}, "traceparent", { get });
  for (const input of [
    Object.defineProperty({ executionId }, "sessionId", { get }),
    { executionId, attributes },
    { executionId, traceContext },
    proxy,
    { executionId, attributes: proxy },
    { executionId, traceContext: proxy },
  ]) {
    assert.throws(() => parseExecutionContext(input), invalidContext);
  }
  assert.equal(reads, 0);
});

test("bounds attribute count, key syntax and UTF-8 values", () => {
  const atLimit = Object.fromEntries(
    Array.from({ length: 16 }, (_, index) => [`a${index}`, "é".repeat(128)]),
  );
  assert.deepEqual(
    parseExecutionContext({ executionId, attributes: atLimit }).attributes,
    atLimit,
  );
  const longestKey = "x".repeat(64);
  assert.deepEqual(
    parseExecutionContext({ executionId, attributes: { [longestKey]: 1 } })
      .attributes,
    { [longestKey]: 1 },
  );

  for (const attributes of [
    { ...atLimit, overflow: true },
    { ["a".repeat(65)]: 1 },
    { "a\n": 1 },
    { "A-name": "worker" },
    { label: "é".repeat(129) },
    { count: Infinity },
    { count: NaN },
    { label: null },
    { label: ["sample"] },
    { label: "unsafe\r\nline" },
  ]) {
    assert.throws(
      () => parseExecutionContext({ executionId, attributes }),
      invalidContext,
    );
  }
});

test("refuses credential-shaped metadata with value-free diagnostics", () => {
  const secret = "EXAMPLE.private";
  for (const attributes of [
    { aws_access_key: secret },
    { msb_token: secret },
    { client_secret: secret },
    { "provider.password": secret },
    { dbpassword: secret },
    { "app.token.count": 1 },
    { label: `Bearer ${secret}` },
    { label: `password=${secret}` },
    { label: JSON.stringify({ password: secret }) },
    { label: "sk-example-example-1234" },
    { label: "eyJsample.eyJexample.signature" },
    { label: "-----BEGIN PRIVATE KEY-----" },
    { label: "ab".repeat(32) },
    { label: "https://example.invalid/checkout" },
    { label: "/tmp/example" },
    { label: "src/example.ts" },
    { label: "path=/tmp/example" },
  ]) {
    assert.throws(
      () => parseExecutionContext({ executionId, attributes }),
      invalidContext,
    );
  }
});

test("validates traceparent version, syntax and nonzero identifiers", () => {
  const withOtherFlags = traceparent.slice(0, -2) + "03";
  assert.deepEqual(
    parseExecutionContext({
      executionId,
      traceContext: { traceparent: withOtherFlags },
    }).traceContext,
    { traceparent: withOtherFlags },
  );
  for (const parent of [
    undefined,
    "00-short-00f067aa0ba902b7-01",
    traceparent.toUpperCase(),
    traceparent.replace(/^00/, "ff"),
    traceparent.replace(/^00/, "01"),
    traceparent.replace(/-.*?-/, `-${"0".repeat(32)}-`),
    traceparent.replace(/-00f067aa0ba902b7-/, "-0000000000000000-"),
    traceparent + "-extra",
    traceparent + "\n",
  ]) {
    assert.throws(
      () =>
        parseExecutionContext({
          executionId,
          traceContext: { traceparent: parent },
        }),
      invalidContext,
    );
  }
});

test("bounds and validates tracestate without admitting credential-shaped members", () => {
  const atLimit = `a=${"a".repeat(256)},b=${"b".repeat(251)}`;
  assert.equal(
    parseExecutionContext({
      executionId,
      traceContext: { traceparent, tracestate: atLimit },
    }).traceContext?.tracestate,
    atLimit,
  );

  for (const tracestate of [
    atLimit + "b",
    "a=" + "t".repeat(257),
    Array.from({ length: 33 }, (_, index) => `a${index}=1`).join(","),
    "a=1,a=2",
    "a=1,",
    "A=1",
    "a=1\r\n",
    "a=é",
    "api_token=example",
    "authorization@vendor=example",
    "sk-example-example-1234=1",
    "a=Bearer example",
    'a={"password":"example"}',
  ]) {
    assert.throws(
      () =>
        parseExecutionContext({
          executionId,
          traceContext: { traceparent, tracestate },
        }),
      invalidContext,
    );
  }
});
