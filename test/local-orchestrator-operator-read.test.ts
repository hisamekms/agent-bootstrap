import assert from "node:assert/strict";
import { test } from "node:test";
import { goalBranch } from "../src/local-orchestrator/model.ts";
import {
  operatorGoalList,
  operatorProblems,
  operatorTask,
} from "../src/local-orchestrator/operator-read.ts";
import { orchestratorFixture } from "./local-orchestrator-fixture.ts";

const goal = {
  title: "A Goal",
  description: "",
  acceptance: ["Pass"],
  scope: {
    paths: ["src/"],
    profiles: ["base"],
    actors: ["Executor"],
    maxTasks: 4,
    budgets: { maxExecutionMs: 1000, maxRetries: 1, maxTokens: 500 },
  },
};
const host = { kind: "host" } as const;
const base = "a".repeat(40);

function setup(store: ReturnType<typeof orchestratorFixture>["store"]) {
  const approve = ({ id, digest }: { id: string; digest: string }) =>
    store.decide(id, {
      digest,
      decision: "approve",
      answerer: { kind: "human" },
    });
  const goalId = approve(store.proposeGoal(goal, { kind: "operator" })).goalId!;
  store.recordGoalCommit(goalId, base, "base");
  const task = (title: string) => {
    const receipt = store.proposeTask(
      {
        title,
        goalId,
        description: "",
        acceptance: ["Pass"],
        actor: "Executor",
        profile: "base",
        paths: ["src/a.ts"],
        budgets: goal.scope.budgets,
        dependsOn: [],
      },
      host,
    );
    assert.ok("taskId" in receipt);
    return receipt.taskId;
  };
  return { approve, goalId, task };
}

test("an integrating Task reads as awaiting integration, not running", () => {
  using state = orchestratorFixture("lo-read-");
  const { store } = state;
  const { approve, goalId, task } = setup(store);
  const id = task("T");
  store.claimTask(id);
  const review = store.createExecution({
    taskId: id,
    actor: "Reviewer",
    mode: "review",
    requestedBy: host,
  }).id;
  store.startExecution(review);
  const pin = { base, candidate: "b".repeat(40), digest: "c".repeat(64) };
  store.finishExecution(review, "succeeded", { review: "pass", pin });
  const integration = store.proposeIntegration(
    {
      taskId: id,
      goalId,
      branch: goalBranch(goalId),
      ...pin,
      changedPaths: ["src/a.ts"],
      review: { result: "pass" },
    },
    review,
  );
  approve(integration);
  const { approvalId } = store.approvedIntegration(integration.id);
  store.beginIntegration(integration.id, integration.digest, approvalId);
  assert.equal(operatorTask(store, id)?.stage, "awaiting-integration");
  store.finishIntegration(integration.id, "uncertain", "x");
  assert.equal(operatorTask(store, id)?.stage, "awaiting-integration");
  assert.ok(operatorGoalList(store)[0]);
});

test("a budget overrun stops being a current problem after a retry", () => {
  using state = orchestratorFixture("lo-read-");
  const { store } = state;
  const { task } = setup(store);
  const id = task("F");
  store.claimTask(id);
  const run = store.createExecution({
    taskId: id,
    actor: "Executor",
    mode: "task",
    requestedBy: host,
  }).id;
  store.startExecution(run);
  store.finishExecution(run, "failed", { tokens: 900 });
  store.failTask(id, "budget-exceeded");
  assert.ok(
    operatorProblems(store).some(
      (problem) =>
        problem.taskId === id && problem.kind === "execution-over-budget",
    ),
  );
  store.retryTask(id, 0);
  store.claimTask(id);
  assert.deepEqual(
    operatorProblems(store).filter((problem) => problem.taskId === id),
    [],
  );
});
