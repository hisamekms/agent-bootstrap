import assert from "node:assert/strict";
import { test } from "node:test";
import {
  chunkInput,
  clampSize,
  decodeBase64,
  encodeBase64,
  estimateLabel,
  formatDuration,
  formatTimestamp,
  formatTokens,
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

test("panel shows one rounded estimate with the current-plan qualification", () => {
  assert.equal(estimateLabel(null), "");
  assert.equal(estimateLabel(0), "");
  assert.equal(estimateLabel(1), "あと約 1 分（現時点の計画では）");
  assert.equal(estimateLabel(120_001), "あと約 2 分（現時点の計画では）");
});

test("panel formats timestamps in local time or as recent ages", () => {
  const date = new Date(2026, 10, 25, 9, 40, 34, 4);
  const at = date.toISOString();
  const now = date.getTime();
  assert.equal(formatTimestamp(at, now), "たった今");
  assert.equal(formatTimestamp(at, now + 8 * 60_000), "8 分前");
  assert.equal(formatTimestamp(at, now + 86_400_000), "11/25 09:40");
  assert.equal(formatTimestamp(at, now - 1), "11/25 09:40");
  assert.equal(formatTimestamp(null, now), "—");
});

test("panel formats whole minutes and groups token counts", () => {
  assert.equal(formatDuration(59_999), "1 分未満");
  assert.equal(formatDuration(60_000), "1 分");
  assert.equal(formatDuration(245_000), "4 分");
  assert.equal(formatDuration(1_800_000), "30 分");
  assert.equal(
    `${formatTokens(22_140)} / ${formatTokens(200_000)}`,
    "22,140 / 200,000",
  );
  assert.equal(formatTokens(null), "—");
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
