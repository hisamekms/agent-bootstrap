import assert from "node:assert/strict";
import { test } from "node:test";
import {
  chunkInput,
  clampSize,
  decodeBase64,
  encodeBase64,
  orderInbox,
} from "../src/operator-ui/web/protocol.ts";

test("base64 preserves all byte values and split UTF-8 sequences", () => {
  const bytes = Uint8Array.from({ length: 256 }, (_, index) => index);
  assert.equal(encodeBase64(bytes), Buffer.from(bytes).toString("base64"));
  assert.deepEqual(decodeBase64(encodeBase64(bytes)), bytes);
  assert.deepEqual(decodeBase64(""), new Uint8Array());
  assert.throws(() => decodeBase64("!"));

  const utf8 = new TextEncoder().encode("猫");
  assert.deepEqual(
    decodeBase64(encodeBase64(utf8.subarray(0, 1))),
    utf8.subarray(0, 1),
  );
  assert.deepEqual(
    decodeBase64(encodeBase64(utf8.subarray(1))),
    utf8.subarray(1),
  );
});

test("input chunks preserve bytes and fit the 16 KiB decoded limit", () => {
  const limit = 16 * 1024;
  const bytes = Uint8Array.from(
    { length: limit * 2 + 1 },
    (_, index) => index % 251,
  );
  const chunks = [...chunkInput(bytes)];
  assert.deepEqual(
    chunks.map((chunk) => chunk.length),
    [limit, limit, 1],
  );
  assert.deepEqual(
    Buffer.concat(chunks.map((chunk) => decodeBase64(encodeBase64(chunk)))),
    Buffer.from(bytes),
  );
  assert.deepEqual([...chunkInput(new Uint8Array())], []);
  assert.deepEqual(
    [...chunkInput(bytes.subarray(0, limit))].map((chunk) => chunk.length),
    [limit],
  );
});

test("resize uses integer dimensions within the host limits", () => {
  assert.deepEqual(clampSize(80, 24), { cols: 80, rows: 24 });
  assert.deepEqual(clampSize(80.9, 24.9), { cols: 80, rows: 24 });
  assert.deepEqual(clampSize(0, -2), { cols: 20, rows: 5 });
  assert.deepEqual(clampSize(501, 201), { cols: 500, rows: 200 });
  assert.deepEqual(clampSize(Number.NaN, Number.POSITIVE_INFINITY), {
    cols: 20,
    rows: 200,
  });
});

test("inbox ordering puts action items first and preserves host order within each weight", () => {
  const items = [
    { weight: "info", id: "info-1" },
    { weight: "action", id: "action-1" },
    { weight: "info", id: "info-2" },
    { weight: "action", id: "action-2" },
  ] as const;
  assert.deepEqual(
    orderInbox(items).map(({ id }) => id),
    ["action-1", "action-2", "info-1", "info-2"],
  );
  assert.equal(items[0].id, "info-1");
});
