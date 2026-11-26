import assert from "node:assert/strict";
import { test } from "node:test";
import {
  activityLabel,
  planningDraft,
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
  isProposal,
  isRef,
  retryCommand,
  statusRepository,
  type Activity,
  type PanelInboxItem,
  type Problem,
} from "../src/operator-ui/web/protocol.ts";

test("the activity pill reports waiting, queued work and human turns", () => {
  const idle: Activity = {
    running: [],
    queued: [],
    queuedCount: 0,
    yourTurn: 0,
  };
  assert.equal(activityLabel(idle), "AI は待機中");
  assert.equal(
    activityLabel({ ...idle, yourTurn: 1 }),
    "AI は待機中 · あなたの番 1",
  );
  assert.equal(
    activityLabel({ ...idle, queuedCount: 2 }),
    "AI は待機中 · 待ち 2",
  );
  assert.equal(
    activityLabel({
      ...idle,
      queuedCount: 2,
      yourTurn: 3,
      running: [
        {
          id: "exec",
          status: "running",
          actor: "Executor",
          mode: "task",
          goalId: "goal",
          goalRef: "G1",
          goalTitle: "Goal",
          taskId: "task",
          taskRef: "G1-1",
          taskTitle: "Task",
          startedAt: "2026-11-26T00:00:00Z",
        },
      ],
    }),
    "AI 作業中 1 · 待ち 2 · あなたの番 3",
  );
  assert.equal(
    planningDraft("G12", "ログを見やすくする"),
    "G12「ログを見やすくする」が承認されました。Task に分けてください。",
  );
});

test("only canonical Goal and Task refs pass protocol validation", () => {
  for (const value of ["G1", "G123", "G1-1", "G123-456"])
    assert.equal(isRef(value), true);
  for (const value of [
    null,
    "",
    "g1",
    "G0",
    "G01",
    "G1-0",
    "G1-01",
    "G1-2-3",
    "G1\n",
  ])
    assert.equal(isRef(value), false);
});

test("connection metadata only accepts a project and a relative repository path", () => {
  assert.equal(statusRepository({ counts: {} }), null);
  for (const repositoryPath of [".", "Team/Repository"])
    assert.deepEqual(statusRepository({ project: "demo", repositoryPath }), {
      project: "demo",
      repositoryPath,
    });
  for (const repositoryPath of [
    undefined,
    "/repo",
    "../repo",
    "a/../repo",
    "a//b",
    "",
  ])
    assert.throws(
      () => statusRepository({ project: "demo", repositoryPath }),
      /invalid-response/,
    );
});

test("proposal messages reject malformed field markers, controls, and review evidence", () => {
  const details = {
    id: "proposal",
    digest: "a".repeat(64),
    status: "pending",
    kind: "integration",
    gate: "integration",
    effectivePolicy: "human",
    policySource: "default",
    loosening: [],
    origin: { kind: "host" },
    changedPaths: ["a.txt"],
    changedFiles: 1,
    changedLines: null,
    diffStat: "stat\n",
    budgets: { maxExecutionMs: 1000, maxRetries: 1, maxTokens: 500 },
    pathViolations: [],
    reviewExecutionId: "review",
    modelText: { verdict: "pass", findings: { withheld: true } },
  };
  assert.ok(isProposal(details));
  assert.ok(
    isProposal({
      ...details,
      modelText: { verdict: "pass", findings: "First\nSecond" },
    }),
  );
  for (const replacement of [
    { changedFiles: 2 },
    { changedLines: -1 },
    { changedPaths: ["a\nb.txt"] },
    { reviewExecutionId: null },
    { ruleName: "First\nSecond" },
    { modelText: { verdict: "revise", findings: null } },
    { modelText: { verdict: "pass", findings: "First\nwith\u202econtrols" } },
    {
      modelText: {
        verdict: "pass",
        findings: { withheld: true, text: "extra" },
      },
    },
  ])
    assert.ok(!isProposal({ ...details, ...replacement }));
});

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
    ref: "G1-1",
    goalRef: "G1",
    taskRef: "G1-1",
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
    ref: "G1-1",
    goalRef: "G1",
    taskRef: "G1-1",
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
