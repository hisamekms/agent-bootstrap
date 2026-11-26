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
  pendingDecisions,
  groupProblems,
  retryCommand,
  type PanelInboxItem,
  type Problem,
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

function inboxItem(
  kind: PanelInboxItem["kind"],
  extra: Partial<PanelInboxItem> = {},
): PanelInboxItem {
  return {
    id: kind,
    kind,
    weight: "action",
    state: "open",
    title: kind,
    at: null,
    subject: {},
    next: "agent-bootstrap inbox",
    ...extra,
  };
}

test("decision cards keep unresolved approvals and checklist actions in host order", () => {
  const task = inboxItem("task-registration", { state: "seen" });
  const integration = inboxItem("integration");
  const checklist = inboxItem("secret-test-required");
  const rows = [
    inboxItem("task-running", { weight: "info" }),
    task,
    inboxItem("execution-over-budget"),
    inboxItem("goal-registration", { state: "resolved" }),
    integration,
    inboxItem("task-failed"),
    checklist,
  ];
  assert.deepEqual(pendingDecisions(rows), [task, integration, checklist]);
});

test("problem cards group each Task's reports and keep unrelated reports distinct", () => {
  const failed = {
    at: "2026-11-26T00:00:00.000Z",
    goalId: "goal",
    taskId: "task",
    title: "Task",
    kind: "task-failed",
    code: "unknown",
    canRetry: true,
    detail: "Task failed",
  } as const satisfies Problem;
  const over = {
    at: "2026-11-26T00:00:00.000Z",
    goalId: "goal",
    taskId: "task",
    title: "Task",
    kind: "execution-over-budget",
    executionId: "one",
    detail: "Budget exceeded",
  } as const satisfies Problem;
  const other = { ...over, taskId: null, executionId: "two" };
  const third = { ...over, taskId: null, executionId: "three" };
  assert.deepEqual(groupProblems([over, other, failed, third]), [
    [over, failed],
    [other],
    [third],
  ]);
});

test("the retry action copies the host's target-qualified CLI command for the same Task", () => {
  const command = `agent-bootstrap --target '/project with spaces' retry-task task-full-id`;
  const failure = inboxItem("task-failed", {
    subject: { taskId: "task-full-id" },
    next: command,
  });
  assert.equal(retryCommand("task-full-id", [failure]), command);
  assert.equal(retryCommand("task", [failure]), undefined);
  assert.equal(
    retryCommand("task-full-id", [{ ...failure, state: "resolved" }]),
    undefined,
  );
  assert.equal(
    retryCommand("task-full-id", [
      { ...failure, next: "agent-bootstrap show task-full-id" },
    ]),
    undefined,
  );
});
