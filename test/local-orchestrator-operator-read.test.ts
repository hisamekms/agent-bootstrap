import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { test } from "node:test";
import { createCredentialScanner } from "../src/local-orchestrator/credential-scan.ts";
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
  const task = (title: string, paths = ["src/a.ts"]) => {
    const receipt = store.proposeTask(
      {
        title,
        goalId,
        description: "",
        acceptance: ["Pass"],
        actor: "Executor",
        profile: "base",
        paths,
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
  const synthetic = "sk-ant-" + "x".repeat(24);
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
    maskedFields: ["description"],
    origin: host,
    pathViolations: ["outside/file.ts"],
    modelText: {
      description: "［伏せ字］",
      acceptance: ["First\nSecond\nThird\\u0009line"],
    },
  });
  assert.ok(!JSON.stringify(taskDetail).includes(synthetic));
  const scoped = await operatorProposal(
    store,
    state.root,
    task.id,
    createCredentialScanner(
      { leakPatterns: ["^outside/file\\.ts$"] },
      state.root,
      () => {},
    ),
  );
  assert.partialDeepStrictEqual(scoped, {
    paths: { withheld: true },
    pathViolations: { withheld: true },
    maskedFields: ["description"],
  });
});

test("configured proposal screening masks fields and withholds on failed re-scan, timeout or bounds", async () => {
  using state = orchestratorFixture("lo-mask-");
  const { root, store } = state;
  const token = "sk-ant-" + "x".repeat(30);
  const origin = { kind: "operator" } as const;
  const proposal = store.proposeGoal(
    {
      ...goal,
      description: `Use ${token} for the example.`,
      acceptance: ["Keep demo-12 private", "Keep demo-34 private"],
    },
    origin,
  );
  const scanner = (leakPatterns: string[]) =>
    createCredentialScanner({ leakPatterns }, root, () => {});
  const masked = await operatorProposal(
    store,
    root,
    proposal.id,
    scanner(["demo-\\d+"]),
  );
  assert.ok(isProposal(masked));
  assert.partialDeepStrictEqual(masked, {
    digest: proposal.digest,
    maskedFields: ["description", "acceptance"],
    modelText: {
      description: "Use ［伏せ字］ for the example.",
      acceptance: ["Keep ［伏せ字］ private", "Keep ［伏せ字］ private"],
    },
  });
  assert.doesNotMatch(JSON.stringify(masked), /sk-ant-|demo-/);
  const stored = store.getProposal(proposal.id);
  assert.ok(stored?.kind === "goal");
  assert.equal(stored.content.description, `Use ${token} for the example.`);

  const check = async (acceptance: string[], patterns: string[]) => {
    const { id } = store.proposeGoal({ ...goal, acceptance }, origin);
    return operatorProposal(store, root, id, scanner(patterns));
  };
  for (const display of [
    await check(["Keep demo-12 private"], ["demo-\\d+", "伏せ字"]),
    await check(["a".repeat(120) + "!"], ["(a+)+$"]),
    await check(
      Array.from(
        { length: 11 },
        (_, index) => `${index} ${Array(3).fill(token).join(" ")}`,
      ),
      [],
    ),
    await check(["alpha", "beta"], ['"alpha","beta"']),
    await check(["alpha", "beta"], ['alpha","beta', "alpha"]),
  ]) {
    assert.ok(display?.kind === "goal");
    assert.deepEqual(display.modelText.acceptance, { withheld: true });
    assert.equal(display.maskedFields, undefined);
  }
});

test("display reads record credential evidence once per digest", async () => {
  using state = orchestratorFixture("lo-mask-");
  const { root, store } = state;
  const evidence = () =>
    readdirSync(root).filter((file) => file.startsWith("credential-leak-"));
  const token = "demo-" + "x".repeat(30);
  const scan = createCredentialScanner(
    { leakPatterns: ["demo-x{6}"] },
    root,
    () => {},
  );
  const create = (title: string) =>
    store.proposeGoal(
      {
        ...goal,
        title,
        description: `Use ${token} here`,
        acceptance: [`Keep password=${token} private`],
      },
      { kind: "operator" },
    );
  const first = create("First");
  const displays = await Promise.all(
    Array.from({ length: 3 }, () =>
      operatorProposal(store, root, first.id, scan),
    ),
  );
  for (const display of displays) {
    assert.partialDeepStrictEqual(display, {
      maskedFields: ["description", "acceptance"],
      modelText: {
        description: "Use ［伏せ字］ here",
        acceptance: ["Keep ［伏せ字］ private"],
      },
    });
  }
  assert.equal(evidence().length, 1);
  await operatorProposal(store, root, create("Second").id, scan);
  assert.equal(evidence().length, 2);
  await assert.rejects(scan(token), { code: "credential-leak" });
  await assert.rejects(scan(token), { code: "credential-leak" });
  assert.equal(evidence().length, 4);
});

test("the proposal read withholds distributed credentials and fails closed when evidence cannot be written", async () => {
  using state = orchestratorFixture("lo-mask-");
  const { root, filename, store } = state;
  const origin = { kind: "operator" } as const;
  const split = store.proposeGoal(
    {
      ...goal,
      description: '"accessToken":"demo-access"',
      acceptance: ['"refreshToken":"demo-refresh", "expiresAt":123'],
    },
    origin,
  );
  const splitDisplay = await operatorProposal(store, root, split.id);
  assert.ok(isProposal(splitDisplay));
  assert.deepEqual(splitDisplay.modelText, {
    description: { withheld: true },
    acceptance: { withheld: true },
  });
  assert.doesNotMatch(JSON.stringify(splitDisplay), /demo-access|demo-refresh/);

  const crossField = store.proposeGoal(
    {
      ...goal,
      description: "demo-alpha",
      acceptance: ["keep demo-beta private"],
    },
    origin,
  );
  const crossFieldScan = createCredentialScanner(
    {
      leakPatterns: [
        "demo-alpha",
        String.raw`demo-alpha","acceptance":\["keep demo-beta`,
      ],
    },
    root,
    () => {},
  );
  const crossFieldDisplay = await operatorProposal(
    store,
    root,
    crossField.id,
    crossFieldScan,
  );
  assert.ok(isProposal(crossFieldDisplay));
  assert.deepEqual(crossFieldDisplay.modelText, {
    description: { withheld: true },
    acceptance: { withheld: true },
  });
  assert.doesNotMatch(
    JSON.stringify(crossFieldDisplay),
    /demo-alpha|demo-beta/,
  );

  const proposal = store.proposeGoal(
    { ...goal, description: "demo-project-key" },
    origin,
  );
  const scan = createCredentialScanner(
    { leakPatterns: ["demo-project-key"] },
    filename,
    () => {},
  );
  const display = await operatorProposal(store, root, proposal.id, scan);
  assert.ok(isProposal(display) && display.kind === "goal");
  assert.deepEqual(display.modelText.description, { withheld: true });
});

test("a credential in a changed path withholds both the paths and the Git stat", async () => {
  using state = orchestratorFixture("lo-mask-path-");
  const { store } = state;
  const { goalId, task } = setup(store);
  const taskId = task("T", ["src/"]);
  store.claimTask(taskId);
  const review = store.createExecution({
    taskId,
    actor: "Reviewer",
    mode: "review",
    requestedBy: host,
  }).id;
  store.startExecution(review);
  const pin = { base, candidate: "b".repeat(40), digest: "c".repeat(64) };
  store.finishExecution(review, "succeeded", { review: "pass", pin });
  const token = "sk-ant-" + "x".repeat(30);
  const proposal = store.proposeIntegration(
    {
      taskId,
      goalId,
      branch: goalBranch(goalId),
      ...pin,
      changedPaths: [`src/${token}@example.ts`],
      review: { result: "pass", notes: `Example: ${token}` },
    },
    review,
  );
  const display = await operatorProposal(store, state.root, proposal.id);
  assert.ok(isProposal(display));
  assert.partialDeepStrictEqual(display, {
    digest: proposal.digest,
    maskedFields: ["findings"],
    changedPaths: { withheld: true },
    diffStat: { withheld: true },
    modelText: { verdict: "pass", findings: "Example: ［伏せ字］" },
  });
  assert.ok(!JSON.stringify(display).includes(token));
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
