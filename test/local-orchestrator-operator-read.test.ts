import assert from "node:assert/strict";
import { test } from "node:test";
import { goalBranch } from "../src/local-orchestrator/model.ts";
import {
  operatorGoalList,
  operatorProblems,
  operatorProposal,
  operatorTask,
} from "../src/local-orchestrator/operator-read.ts";
import { orchestratorFixture } from "./local-orchestrator-fixture.ts";
import { isProposal } from "../src/operator-ui/web/protocol.ts";

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

test("proposal detail returns checked scope and screens each model field before escape", async () => {
  using state = orchestratorFixture("lo-read-");
  const { store } = state;
  const description = "A <tag>\u202e description\r\nSecond line\nThird\rline";
  const acceptance = ["screen this criterion"];
  const proposed = store.proposeGoal(
    { ...goal, description, acceptance },
    { kind: "actor", actor: "Concierge" },
  );
  const details = await operatorProposal(
    store,
    state.root,
    proposed.id,
    async (...fields) => {
      if (fields.includes(acceptance[0]!)) throw new Error();
    },
  );
  assert.ok(isProposal(details));
  assert.partialDeepStrictEqual(details, {
    digest: proposed.digest,
    origin: { kind: "actor", actor: "Concierge" },
    effectivePolicy: "human",
    paths: goal.scope.paths,
    budgets: goal.scope.budgets,
    pathViolations: [],
    modelText: {
      description: "A <tag>\\u202e description\nSecond line\nThird\\u000dline",
      acceptance: { withheld: true },
    },
  });
  assert.ok(!JSON.stringify(details).includes(acceptance[0]!));

  const { goalId } = store.decide(proposed.id, {
    digest: proposed.digest,
    decision: "approve",
    answerer: { kind: "human" },
  });
  const synthetic = "bearer " + "x".repeat(24);
  const task = store.proposeTask(
    {
      title: "Task",
      goalId,
      description: synthetic,
      acceptance: ["First\r\nSecond\nThird\tline"],
      actor: "Executor",
      profile: "base",
      paths: ["outside/file.ts", "src/ok.ts"],
      budgets: goal.scope.budgets,
      dependsOn: [],
    },
    host,
  );
  const taskDetail = await operatorProposal(store, state.root, task.id);
  assert.ok(isProposal(taskDetail));
  assert.partialDeepStrictEqual(taskDetail, {
    digest: task.digest,
    origin: host,
    pathViolations: ["outside/file.ts"],
    modelText: {
      description: { withheld: true },
      acceptance: ["First\nSecond\nThird\\u0009line"],
    },
  });
  assert.ok(!JSON.stringify(taskDetail).includes(synthetic));
});

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

test("Task detail and journal bound package changes and retain totals", () => {
  using state = orchestratorFixture("lo-read-package-diff-");
  const { store } = state;
  const id = setup(store).task("Dependencies");
  assert.ok(store.claimTask(id));
  const review = store.createExecution({
    taskId: id,
    actor: "Reviewer",
    mode: "review",
    requestedBy: host,
  }).id;
  store.startExecution(review);
  const packageDiff = {
    added: Array.from(
      { length: 320 },
      (_, index) => `@scope/package-${index}@1.0.0`,
    ),
    removed: Array.from({ length: 80 }, (_, index) => `removed-${index}@2.0.0`),
    changed: Array.from({ length: 96 }, (_, index) => ({
      name: `changed-${index}`,
      from: ["1.0.0", "1.1.0", "1.2.0", "1.3.0", "1.4.0"],
      to: ["2.0.0", "3.0.0"],
    })),
  };
  store.recordTaskPackageDiff(review, packageDiff);
  const expected = {
    added: packageDiff.added.slice(0, 64),
    removed: packageDiff.removed.slice(0, 64),
    changed: packageDiff.changed
      .slice(0, 64)
      .map((row) => ({ ...row, from: row.from.slice(0, 4) })),
    totals: { added: 320, removed: 80, changed: 96 },
  };
  assert.deepEqual(store.taskPackageDiff(id), expected);
  assert.deepEqual(operatorTask(store, id)?.packageDiff, expected);
  const evidence = JSON.stringify(
    store.listEvents({ subjectId: review, limit: 100 }),
  );
  assert.ok(!evidence.includes("package-319"));
  assert.ok(!evidence.includes("removed-79"));
  assert.ok(!evidence.includes("changed-95"));
});
