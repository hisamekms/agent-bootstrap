import assert from "node:assert/strict";
import { test } from "node:test";
import {
  goalEstimate,
  meanTaskWallTime,
  taskEstimate,
  taskStage,
  taskStageMeans,
} from "../src/local-orchestrator/operator-estimates.ts";

test("Goal estimate multiplies available successful wall times by the remaining count", () => {
  const samples = [
    { startedAt: "2026-11-25T12:00:00Z", finishedAt: "2026-11-25T12:01:00Z" },
    { startedAt: "2026-11-25T12:00:00Z", finishedAt: "2026-11-25T12:03:00Z" },
    { startedAt: "2026-11-25T12:10:00Z", finishedAt: "2026-11-25T12:00:00Z" },
  ];
  assert.deepEqual(goalEstimate(3, meanTaskWallTime([])), {
    remainingMs: null,
    basis: "current-plan",
  });
  assert.deepEqual(goalEstimate(3, meanTaskWallTime(samples)), {
    remainingMs: 360_000,
    basis: "current-plan",
  });
  assert.equal(goalEstimate(0, meanTaskWallTime(samples)).remainingMs, 0);
});

test("Task estimate sums remaining stage means and caps elapsed time at the current stage", () => {
  const means = taskStageMeans([
    {
      registered: 0,
      running: 10,
      review: 40,
      "awaiting-integration": 60,
      done: 80,
    },
    {
      registered: 0,
      running: 30,
      review: 80,
      "awaiting-integration": 120,
      done: 160,
    },
  ]);
  assert.deepEqual(means, {
    registered: 20,
    running: 40,
    review: 30,
    "awaiting-integration": 30,
  });
  assert.equal(taskEstimate("registered", 0, means).remainingMs, 120);
  assert.equal(taskEstimate("running", 3, means).remainingMs, 97);
  assert.equal(taskEstimate("running", 100, means).remainingMs, 60);
  assert.equal(taskEstimate("awaiting-integration", 3, means).remainingMs, 27);
  assert.equal(taskEstimate("done", 0, means).remainingMs, 0);
  assert.equal(taskEstimate("failed", 0, means).remainingMs, null);
  assert.equal(
    taskEstimate("registered", 0, taskStageMeans([])).remainingMs,
    null,
  );
  const partial = taskStageMeans([{ "awaiting-integration": 2, done: 9 }]);
  assert.equal(taskEstimate("review", 0, partial).remainingMs, null);
  assert.equal(taskEstimate("awaiting-integration", 0, partial).remainingMs, 7);
});

test("Task stages use the running execution only while the Task is running", () => {
  const review = { actor: "Reviewer", mode: "review" } as const;
  for (const status of [
    "registered",
    "failed",
    "cancelled",
    "awaiting-integration",
  ] as const)
    assert.equal(taskStage(status, review), status);
  assert.equal(taskStage("succeeded"), "done");
  assert.equal(
    taskStage("running", { actor: "Executor", mode: "task" }),
    "running",
  );
  assert.equal(taskStage("running"), "running");
  assert.equal(taskStage("running", review), "review");
  assert.equal(
    taskStage("running", { ...review, mode: "verification" }),
    "review",
  );
  assert.equal(
    taskStage("running", { ...review, mode: "approval" }),
    "running",
  );
});

test("a Task that is integrating stays at the awaiting-integration stage", () => {
  for (const code of ["integration-in-progress", "integration-uncertain"])
    assert.equal(taskStage("running", undefined, code), "awaiting-integration");
  assert.equal(taskStage("running", undefined, "other"), "running");
});
