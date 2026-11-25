import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ContractError } from "../src/local-orchestrator/model.ts";
import {
  OrchestratorStore,
  OrchestratorStoreError,
  type Answerer,
  type Operator,
  type Origin,
} from "../src/local-orchestrator/store.ts";

const { Database } = createRequire(import.meta.url)("bun:sqlite") as {
  Database: new (filename: string) => {
    exec(sql: string): unknown;
    query(sql: string): { get(...values: string[]): unknown };
    close(): void;
  };
};

const operator: Operator = { kind: "operator" };
const human: Answerer = { kind: "human" };
const host = { kind: "host" } as const;

function reviewerAnswer(executionId: string) {
  return { kind: "agent", executionId, model: "claude-test" } as const;
}
const budgets = { maxExecutionMs: 1000, maxRetries: 1, maxTokens: 500 };
const goal = {
  title: "Goal",
  description: "",
  acceptance: ["Pass"],
  scope: {
    paths: ["src/x/"],
    profiles: ["base"],
    actors: ["Executor"],
    maxTasks: 3,
    budgets,
  },
};
const task = {
  title: "Task",
  description: "",
  acceptance: ["Pass"],
  actor: "Executor",
  profile: "base",
  paths: ["src/x/a.ts"],
  dependsOn: [],
  budgets,
};

let folder: string;
let filename: string;
let store: OrchestratorStore;

beforeEach(() => {
  folder = mkdtempSync(join(tmpdir(), "local-orchestrator-"));
  filename = join(folder, "state.sqlite");
  store = OrchestratorStore.open(filename);
});

afterEach(() => {
  store.close();
  rmSync(folder, { recursive: true, force: true });
});

function approve(
  proposal: { id: string; digest: string },
  answerer: Answerer = human,
) {
  return store.decide(proposal.id, {
    digest: proposal.digest,
    decision: "approve",
    answerer,
  });
}

function goalId(content: unknown = goal): string {
  const registered = approve(store.proposeGoal(content, operator));
  if (!registered.goalId) throw new Error("Goal registration failed");
  return registered.goalId;
}

function startReviewer(
  context: {
    goalId?: string;
    taskId?: string;
    approvalProposalId?: string;
  } = {},
) {
  const execution = store.createExecution({
    actor: "Reviewer",
    mode: "approval",
    requestedBy: host,
    ...context,
  });
  store.startExecution(execution.id);
  return reviewerAnswer(execution.id);
}

test("discard refuses busy goals before Git and rolls back a failed audit write", async () => {
  const id = goalId();
  const registered = store.proposeTask({ ...task, goalId: id }, operator);
  assert.equal(registered.status, "registered");
  if (registered.status !== "registered")
    throw new Error("Task registration failed");
  const { taskId } = registered;
  let refChecks = 0;
  const discard = () =>
    store.discardGoal(id, null, async (head) => {
      assert.equal(head, null);
      refChecks++;
    });
  const goalRun = store.createExecution({
    actor: "Planner",
    mode: "plan",
    requestedBy: host,
    goalId: id,
  });
  await assert.rejects(discard(), { code: "goal-busy" });
  store.finishExecution(goalRun.id, "cancelled");
  const taskRun = startReviewer({ taskId });
  await assert.rejects(discard(), { code: "goal-busy" });
  store.finishExecution(taskRun.executionId, "succeeded");
  const db = new Database(filename);
  try {
    for (const status of ["running", "awaiting-integration"]) {
      db.query("UPDATE tasks SET status = ? WHERE id = ? RETURNING id").get(
        status,
        taskId,
      );
      await assert.rejects(discard(), { code: "goal-busy" });
    }
    db.query(
      "UPDATE tasks SET status = 'registered' WHERE id = ? RETURNING id",
    ).get(taskId);
    assert.equal(refChecks, 0);
    db.exec(`
      CREATE TRIGGER deny_goal_status BEFORE INSERT ON events
      WHEN NEW.kind = 'goal.status'
      BEGIN SELECT RAISE(ABORT, 'audit failure'); END
    `);
    await assert.rejects(discard(), { code: "goal-discard-record-failed" });
    assert.equal(refChecks, 1);
    assert.equal(store.getGoal(id)?.status, "active");
    assert.equal(store.getTask(taskId)?.status, "registered");
    assert.ok(
      !store
        .listEvents({ subjectId: taskId, limit: 20 })
        .some(({ kind }) => kind === "task.status"),
    );
  } finally {
    db.close();
  }
});

test("persists private WAL state, approvals and immutable read records across reopen", () => {
  assert.equal(statSync(filename).mode & 0o777, 0o600);
  const pending = store.proposeGoal(goal, {
    kind: "actor",
    actor: "Planner",
    sessionId: "session-1",
    executionId: "execution-1",
  });
  assert.partialDeepStrictEqual(pending, {
    gate: "goal-registration",
    policy: "human",
    source: "default",
    loosening: [],
  });
  assert.deepEqual(
    store.listProposals({ status: "pending" }).map((row) => row.id),
    [pending.id],
  );
  assert.deepEqual(store.listGoals(), []);
  assert.partialDeepStrictEqual(
    store.listEvents({ subjectId: pending.id, limit: 1 })[0],
    {
      kind: "goal.proposed",
      executionId: "execution-1",
      sessionId: "session-1",
    },
  );

  const { goalId } = approve(pending);
  assert.ok(goalId);
  store.close();
  store = OrchestratorStore.open(filename);
  const registered = store.getGoal(goalId!);
  assert.partialDeepStrictEqual(registered, {
    status: "active",
    digest: pending.digest,
    proposalId: pending.id,
    content: goal,
  });
  assert.equal(Object.isFrozen(registered?.content.scope.paths), true);
  assert.equal(Object.isFrozen(store.listGoals()), true);
  assert.equal(store.getProposal(pending.id)?.status, "approved");
  assert.deepEqual(
    store.listEvents({ limit: 3 }).map((event) => event.kind),
    ["goal.registered", "proposal.decided", "goal.proposed"],
  );

  const db = new Database(filename);
  try {
    assert.deepEqual(db.query("PRAGMA journal_mode").get(), {
      journal_mode: "wal",
    });
    assert.deepEqual(
      db
        .query(
          "SELECT gate, digest, policy, policy_source, answerer_kind, decision FROM approvals WHERE proposal_id = ?",
        )
        .get(pending.id),
      {
        gate: "goal-registration",
        digest: pending.digest,
        policy: "human",
        policy_source: "default",
        answerer_kind: "human",
        decision: "approve",
      },
    );
  } finally {
    db.close();
  }
});

test("rejects stale decisions and agent answers under a human policy without writing", () => {
  const proposal = store.proposeGoal(goal, operator);
  const agent = startReviewer();
  assert.throws(
    () => approve({ ...proposal, digest: "stale" }),
    new OrchestratorStoreError("stale-digest"),
  );
  assert.throws(
    () => approve(proposal, agent),
    new OrchestratorStoreError("approval-forbidden"),
  );
  assert.equal(
    store.listEvents({ subjectId: proposal.id, limit: 10 }).length,
    1,
  );
  assert.equal(store.getProposal(proposal.id)?.status, "pending");
  assert.deepEqual(
    store.decide(proposal.id, {
      digest: proposal.digest,
      decision: "reject",
      answerer: human,
    }),
    { status: "rejected" },
  );
  assert.throws(
    () => approve(proposal),
    new OrchestratorStoreError("invalid-transition"),
  );
  assert.deepEqual(store.listGoals(), []);
});

test("validates delegation before writing and records it as a human approval", () => {
  const pending = store.proposeGoal(goal, operator);
  const delegate = {
    agent: "claude-code",
    session: "s".repeat(200),
    authorization: "a".repeat(500),
  } as const;
  for (const invalid of [
    undefined,
    null,
    { ...delegate, agent: "other" },
    { ...delegate, session: "bad session" },
    { ...delegate, authorization: "control\u009b" },
    { ...delegate, extra: true },
    { agent: delegate.agent, session: delegate.session },
  ]) {
    assert.throws(
      () => approve(pending, { kind: "human", delegate: invalid } as Answerer),
      ContractError,
    );
  }
  assert.equal(store.getProposal(pending.id)?.status, "pending");
  assert.ok(approve(pending, { kind: "human", delegate }).goalId);

  const db = new Database(filename);
  try {
    assert.deepEqual(
      db
        .query(
          "SELECT answerer_kind, json_extract(answerer_json, '$.delegate.agent') AS agent, json_extract(answerer_json, '$.delegate.session') AS session, json_extract(answerer_json, '$.delegate.authorization') AS authorization FROM approvals WHERE proposal_id = ?",
        )
        .get(pending.id),
      { answerer_kind: "human", ...delegate },
    );
  } finally {
    db.close();
  }
});

test("allows an eligible reviewer and refuses the producer and Concierge origins", () => {
  store.setProjectDefaults({ "goal-registration": "agent" }, operator);
  assert.deepEqual(store.effectivePolicy("integration"), {
    policy: "human",
    source: "default",
  });
  const agent = startReviewer();
  const own = store.proposeGoal(goal, {
    kind: "actor",
    actor: "Planner",
    executionId: agent.executionId,
  });
  const concierge = store.proposeGoal(goal, {
    kind: "actor",
    actor: "Concierge",
  });
  assert.equal(own.policy, "agent");
  assert.throws(
    () => approve(own, agent),
    new OrchestratorStoreError("approval-forbidden"),
  );
  assert.throws(
    () => approve(concierge, agent),
    new OrchestratorStoreError("approval-forbidden"),
  );
  const other = startReviewer();
  assert.ok(approve(own, other).goalId);
  assert.partialDeepStrictEqual(
    store.listEvents({ subjectId: own.id, limit: 1 })[0],
    {
      executionId: other.executionId,
    },
  );
  assert.equal(
    store.listEvents({ subjectId: "project", limit: 1 })[0]?.kind,
    "project.defaults-set",
  );
});

test("an eligible Reviewer can reject a goal that loosens integration policy", () => {
  store.setProjectDefaults({ "goal-registration": "agent" }, operator);
  const { id, digest } = store.proposeGoal(
    { ...goal, policies: { integration: "agent" } },
    operator,
  );
  assert.deepEqual(
    store.decide(id, {
      digest,
      decision: "reject",
      answerer: startReviewer(),
    }),
    { status: "rejected" },
  );
});

test("rejects fabricated, non-Reviewer, non-approval, queued and finished executions", () => {
  store.setProjectDefaults({ "goal-registration": "agent" }, operator);
  const proposal = store.proposeGoal(goal, operator);
  const concierge = store.createExecution({
    actor: "Concierge",
    mode: "approval",
    requestedBy: host,
  });
  store.startExecution(concierge.id);
  const review = store.createExecution({
    actor: "Reviewer",
    mode: "review",
    requestedBy: host,
  });
  store.startExecution(review.id);
  const queued = store.createExecution({
    actor: "Reviewer",
    mode: "approval",
    requestedBy: host,
  });
  const finished = startReviewer();
  store.finishExecution(finished.executionId, "succeeded");

  for (const id of [
    "fabricated",
    concierge.id,
    review.id,
    queued.id,
    finished.executionId,
  ]) {
    assert.throws(
      () => approve(proposal, reviewerAnswer(id)),
      new OrchestratorStoreError("approval-forbidden"),
      id,
    );
  }
  assert.throws(
    () =>
      store.decide(proposal.id, {
        digest: proposal.digest,
        decision: "reject",
        answerer: finished,
      }),
    new OrchestratorStoreError("approval-forbidden"),
  );
  assert.equal(store.getProposal(proposal.id)?.status, "pending");
  assert.equal(
    store.listEvents({ subjectId: proposal.id, limit: 10 }).length,
    1,
  );
});

test("requires a host origin for Reviewer approval executions", () => {
  const planner: Origin = { kind: "actor", actor: "Planner" };
  for (const [actor, requestedBy] of [
    ["Reviewer", planner],
    ["Reviewer", operator],
    ["Planner", planner],
  ] as const) {
    assert.throws(
      () => store.createExecution({ actor, mode: "approval", requestedBy }),
      new OrchestratorStoreError("approval-forbidden"),
    );
  }
  assert.deepEqual(store.listEvents({ limit: 10 }), []);

  store.setProjectDefaults({ "goal-registration": "agent" }, operator);
  const proposal = store.proposeGoal(goal, operator);
  const agent = startReviewer();
  const db = new Database(filename);
  try {
    // Simulate an operator-origin approval execution persisted before the guard.
    db.exec(`UPDATE executions SET requested_by_json = '{"kind":"operator"}'`);
  } finally {
    db.close();
  }
  assert.throws(
    () => approve(proposal, agent),
    new OrchestratorStoreError("approval-forbidden"),
  );
  assert.equal(store.getProposal(proposal.id)?.status, "pending");
});

test("requires the Reviewer execution's goal to match a task proposal", () => {
  const id = goalId();
  const unrelatedGoal = goalId();
  const unrelated = store.proposeTask(
    { ...task, goalId: unrelatedGoal },
    operator,
  );
  if (unrelated.status !== "registered")
    throw new Error("Expected registration");
  const related = store.proposeTask({ ...task, goalId: id }, operator);
  if (related.status !== "registered") throw new Error("Expected registration");
  store.setProjectDefaults({ "task-registration": "agent" }, operator);
  const proposal = store.proposeTask(
    { ...task, goalId: id, paths: ["other/file"] },
    operator,
  );
  for (const agent of [
    startReviewer(),
    startReviewer({ goalId: unrelatedGoal }),
    startReviewer({ taskId: unrelated.taskId }),
  ]) {
    assert.throws(
      () => approve(proposal, agent),
      new OrchestratorStoreError("approval-forbidden"),
    );
  }
  const agent = startReviewer({ taskId: related.taskId });
  assert.ok(approve(proposal, agent).taskId);
});

test("holds goal loosening until human approval, even with an agent registration default", () => {
  const agent = startReviewer();
  const content = {
    ...goal,
    policies: { integration: "agent", "goal-registration": "agent" },
  };
  const proposal = store.proposeGoal(content, operator);
  assert.partialDeepStrictEqual(proposal, {
    policy: "human",
    source: "default",
    loosening: ["goal-registration", "integration"],
  });
  assert.throws(
    () => approve(proposal, agent),
    new OrchestratorStoreError("approval-forbidden"),
  );
  const registered = approve(proposal);
  assert.deepEqual(
    store.effectivePolicy("integration", { goalId: registered.goalId! }),
    { policy: "agent", source: "goal" },
  );
  assert.deepEqual(store.effectivePolicy("integration"), {
    policy: "human",
    source: "default",
  });

  store.setProjectDefaults({ "goal-registration": "agent" }, operator);
  const crossGate = store.proposeGoal(
    { ...goal, policies: { integration: "agent" } },
    operator,
  );
  assert.deepEqual(crossGate.loosening, ["integration"]);
  assert.throws(
    () => approve(crossGate, agent),
    new OrchestratorStoreError("approval-forbidden"),
  );
  assert.ok(approve(crossGate).goalId);
});

test("auto-registers in scope and accepts only existing dependencies from the same goal", () => {
  const id = goalId();
  const first = store.proposeTask({ ...task, goalId: id }, operator);
  if (first.status !== "registered")
    throw new Error("Expected automatic registration");
  const second = store.proposeTask(
    { ...task, goalId: id, dependsOn: [first.taskId] },
    operator,
  );
  assert.equal(second.status, "registered");
  assert.equal(store.getProposal(first.id)?.status, "registered");
  assert.partialDeepStrictEqual(store.listTasks(id)[0], {
    id: first.taskId,
    status: "registered",
    attempts: 0,
    digest: first.digest,
  });
  assert.equal(
    store.listEvents({ subjectId: first.taskId, limit: 1 })[0]?.kind,
    "task.auto-registered",
  );
  const unrelated = store.proposeTask(
    { ...task, goalId: goalId(), dependsOn: [first.taskId] },
    operator,
  );
  assert.partialDeepStrictEqual(unrelated, {
    status: "pending",
    reasons: ["dependsOn"],
  });
  assert.throws(
    () => approve(unrelated),
    new OrchestratorStoreError("task-constraints"),
  );
  assert.equal(store.getProposal(unrelated.id)?.status, "pending");
});

test("registers explicit scope exceptions and policy changes, while rechecking hard limits", () => {
  const id = goalId({ ...goal, scope: { ...goal.scope, maxTasks: 1 } });
  const agent = startReviewer({ goalId: id });
  const outOfScope = store.proposeTask(
    {
      ...task,
      goalId: id,
      paths: [],
      actor: "Researcher",
      profile: "db",
    },
    operator,
  );
  assert.partialDeepStrictEqual(outOfScope, {
    status: "pending",
    reasons: ["profile", "actor"],
    gate: "task-registration",
    policy: "human",
  });
  const loosened = store.proposeTask(
    { ...task, goalId: id, policies: { integration: "agent" } },
    operator,
  );
  assert.partialDeepStrictEqual(loosened, {
    status: "pending",
    reasons: ["policy-loosening"],
    loosening: ["integration"],
  });
  assert.throws(
    () => approve(loosened, agent),
    new OrchestratorStoreError("approval-forbidden"),
  );
  const otherBudget = store.proposeTask(
    { ...task, goalId: goalId(), budgets: { ...budgets, maxTokens: 501 } },
    operator,
  );
  assert.partialDeepStrictEqual(otherBudget, { status: "registered" });
  assert.ok(approve(outOfScope).taskId);
  assert.throws(
    () => approve(loosened),
    new OrchestratorStoreError("task-constraints"),
  );

  const overCount = store.proposeTask({ ...task, goalId: id }, operator);
  assert.partialDeepStrictEqual(overCount, {
    status: "pending",
    reasons: ["maxTasks"],
  });
  assert.throws(
    () => approve(overCount),
    new OrchestratorStoreError("task-constraints"),
  );
  const otherGoalId = goalId();
  const other = store.proposeTask(
    { ...task, goalId: otherGoalId, policies: { integration: "agent" } },
    operator,
  );
  const { taskId } = approve(other);
  assert.deepEqual(store.effectivePolicy("integration", { taskId: taskId! }), {
    policy: "agent",
    source: "task",
  });
  assert.throws(
    () => store.effectivePolicy("integration", { goalId: id, taskId: taskId! }),
    new OrchestratorStoreError("context-mismatch"),
  );
});

test("uses the prior task gate but honors a request that requires a human", () => {
  const id = goalId({ ...goal, policies: { "task-registration": "agent" } });
  const agent = startReviewer({ goalId: id });
  const pending = store.proposeTask(
    {
      ...task,
      goalId: id,
      paths: ["other/file"],
      policies: { "task-registration": "human" },
    },
    operator,
  );
  assert.throws(
    () => approve(pending, agent),
    new OrchestratorStoreError("approval-forbidden"),
  );
  assert.ok(approve(pending).taskId);
});

test("keeps events append-only, including replacement", () => {
  store.proposeGoal(goal, operator);
  const db = new Database(filename);
  try {
    assert.throws(
      () => db.exec("UPDATE events SET kind = 'edited'"),
      /append-only/,
    );
    assert.throws(() => db.exec("DELETE FROM events"), /append-only/);
    assert.throws(
      () => db.exec("INSERT OR REPLACE INTO events SELECT * FROM events"),
      /append-only/,
    );
    assert.throws(
      () =>
        db.exec(`INSERT OR REPLACE INTO events(rowid,id,at,kind,subject_kind,subject_id,session_id,execution_id,data)
      SELECT rowid, 'replacement', at, kind, subject_kind, subject_id, session_id, execution_id, data FROM events`),
      /append-only/,
    );
  } finally {
    db.close();
  }
  assert.equal(store.listEvents({ limit: 10 }).length, 1);
});

test("rolls back an approval and its preceding event when registration evidence cannot be written", () => {
  const proposal = store.proposeGoal(goal, operator);
  const db = new Database(filename);
  try {
    db.exec(`CREATE TRIGGER test_event_failure BEFORE INSERT ON events
      WHEN NEW.kind = 'goal.registered' BEGIN SELECT RAISE(IGNORE); END`);
    assert.throws(
      () => approve(proposal),
      new OrchestratorStoreError("write-failed"),
    );
    assert.equal(store.getProposal(proposal.id)?.status, "pending");
    assert.deepEqual(store.listGoals(), []);
    assert.deepEqual(
      store.listEvents({ limit: 10 }).map((event) => event.kind),
      ["goal.proposed"],
    );
    assert.deepEqual(
      db.query("SELECT count(*) AS count FROM approvals").get(),
      {
        count: 0,
      },
    );
  } finally {
    db.close();
  }
});

test("enforces execution and session transitions and keeps results out of events", () => {
  const session = store.startSession("Concierge", "runtime-1");
  const execution = store.createExecution({
    actor: "Planner",
    mode: "plan",
    requestedBy: { kind: "actor", actor: "Concierge", sessionId: session.id },
  });
  assert.partialDeepStrictEqual(store.getExecution(execution.id), {
    status: "queued",
    startedAt: null,
    finishedAt: null,
  });
  assert.throws(
    () => store.finishExecution(execution.id, "succeeded"),
    new OrchestratorStoreError("invalid-transition"),
  );
  store.startExecution(execution.id);
  assert.throws(
    () => store.startExecution(execution.id),
    new OrchestratorStoreError("invalid-transition"),
  );
  assert.throws(
    () => store.finishExecution(execution.id, "succeeded", "é".repeat(131_072)),
    ContractError,
  );
  assert.equal(store.getExecution(execution.id)?.status, "running");
  store.finishExecution(execution.id, "succeeded", {
    output: ["private result"],
  });
  const finished = store.getExecution(execution.id);
  assert.partialDeepStrictEqual(finished, {
    status: "succeeded",
    result: { output: ["private result"] },
  });
  assert.ok(finished);
  assert.equal(
    Object.isFrozen((finished.result as { output: string[] }).output),
    true,
  );
  assert.throws(
    () => store.finishExecution(execution.id, "failed"),
    new OrchestratorStoreError("invalid-transition"),
  );
  const queued = store.createExecution({
    actor: "Reviewer",
    mode: "approval",
    requestedBy: host,
  });
  store.finishExecution(queued.id, "cancelled");
  assert.partialDeepStrictEqual(store.getExecution(queued.id), {
    status: "cancelled",
    startedAt: null,
  });
  store.endSession(session.id);
  assert.throws(
    () => store.endSession(session.id),
    new OrchestratorStoreError("invalid-transition"),
  );
  const events = store.listEvents({ subjectId: execution.id, limit: 10 });
  assert.deepEqual(
    events.map(({ kind, executionId, sessionId }) => [
      kind,
      executionId,
      sessionId,
    ]),
    ["execution.finished", "execution.started", "execution.queued"].map(
      (kind) => [kind, execution.id, session.id],
    ),
  );
  assert.doesNotMatch(JSON.stringify(events), /private result/);
  assert.deepEqual(
    store
      .listEvents({ subjectId: session.id, limit: 2 })
      .map((event) => event.kind),
    ["session.ended", "session.started"],
  );
});

test("Goal and rule settings apply to Task registrations and preserve the recorded deciding rule", () => {
  const id = goalId();
  const planner = { kind: "actor", actor: "Planner" } as const;
  const rule = {
    id: "small-source",
    name: "Small source change",
    gate: "task-registration",
    action: "agent",
    enabled: true,
    order: 0,
    conditions: {
      pathsWithin: ["src/**"],
      maxTokens: 500,
      categories: ["bugfix"],
    },
  };
  store.setRules([rule], "cli");
  const unmatched = store.proposeTask(
    { ...task, goalId: id, category: "docs" },
    planner,
  );
  assert.partialDeepStrictEqual(unmatched, {
    status: "pending",
    policy: "human",
    source: "default",
  });
  const pending = store.proposeTask(
    {
      ...task,
      goalId: id,
      category: "bugfix",
      policies: { "task-registration": "human" },
    },
    planner,
  );
  assert.partialDeepStrictEqual(pending, {
    status: "pending",
    policy: "agent",
    source: "rule",
    ruleId: rule.id,
  });
  store.setGoalPolicy(id, "task-registration", "human", "operator-ui");
  const agent = startReviewer({ goalId: id });
  assert.throws(() => approve(pending, agent), { code: "approval-forbidden" });
  assert.partialDeepStrictEqual(store.getProposalDetails(pending.id), {
    source: "operator-goal",
    policy: "human",
  });
  store.setGoalPolicy(id, "task-registration", "inherit", "operator-ui");
  assert.throws(() => approve(pending, agent), { code: "approval-forbidden" });
  const other = store.proposeTask(
    { ...task, goalId: id, category: "bugfix" },
    planner,
  );
  const bound = startReviewer({ goalId: id, approvalProposalId: other.id });
  assert.throws(() => approve(pending, bound), { code: "approval-forbidden" });
  const { taskId } = store.decide(pending.id, {
    digest: pending.digest,
    decision: "approve",
    answerer: startReviewer({ goalId: id, approvalProposalId: pending.id }),
    reasons: ["Meets the pinned scope."],
  });
  const setting = {
    policy: "agent",
    source: "rule",
    ruleId: rule.id,
    ruleName: rule.name,
  };
  assert.partialDeepStrictEqual(
    store.listEvents({ subjectId: pending.id, limit: 1 })[0]?.data,
    {
      ...setting,
      answererKind: "agent",
    },
  );
  assert.equal(store.policySettings().rules[0]?.hitsLast7Days, 1);
  store.setRules([{ ...rule, name: "Renamed", enabled: false }], "operator-ui");
  assert.partialDeepStrictEqual(store.getProposalDetails(pending.id), setting);
  assert.partialDeepStrictEqual(store.decisionHistory(1)[0], {
    goalId: id,
    taskId,
    setting,
    result: "approve",
    reasons: ["Meets the pinned scope."],
  });
  assert.partialDeepStrictEqual(
    store.listEvents({ subjectId: "project", limit: 1 })[0],
    {
      kind: "project.rule-set",
      data: {
        origin: "operator-ui",
        before: rule,
        after: { name: "Renamed", enabled: false },
      },
    },
  );
  assert.partialDeepStrictEqual(
    store.listEvents({ subjectId: id, limit: 1 })[0],
    {
      kind: "goal.policy-set",
      data: { origin: "operator-ui", before: "human", after: "inherit" },
    },
  );
});

test("model loosening needs human approval even when the Goal delegates Task registration", () => {
  const id = goalId();
  store.setGoalPolicy(id, "task-registration", "agent", "operator-ui");
  const pending = store.proposeTask(
    { ...task, goalId: id, policies: { integration: "agent" } },
    operator,
  );
  assert.partialDeepStrictEqual(store.getProposalDetails(pending.id), {
    source: "operator-goal",
    humanApprovalRequired: true,
    loosening: ["integration"],
  });
  assert.throws(() => approve(pending, startReviewer({ goalId: id })), {
    code: "approval-forbidden",
  });
  assert.ok(approve(pending).taskId);
  assert.partialDeepStrictEqual(store.getProposalDetails(pending.id), {
    policy: "human",
    source: "invariant",
    invariant: "policy-loosening",
  });
});

test("an explicit project default supersedes legacy model delegation after a Goal registers", () => {
  const id = goalId({ ...goal, policies: { integration: "agent" } });
  assert.deepEqual(store.effectivePolicy("integration", { goalId: id }), {
    policy: "agent",
    source: "goal",
  });
  store.setProjectDefaults({ integration: "human" }, operator, "operator-ui");
  assert.deepEqual(store.effectivePolicy("integration", { goalId: id }), {
    policy: "human",
    source: "default",
  });
  assert.partialDeepStrictEqual(
    store.listEvents({ subjectId: "project", limit: 1 })[0]?.data,
    {
      origin: "operator-ui",
      before: { integration: "human" },
      after: { integration: "human" },
      beforeExplicit: [],
      afterExplicit: ["integration"],
    },
  );
});
