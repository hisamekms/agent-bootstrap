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

function startReviewer(context: { goalId?: string; taskId?: string } = {}) {
  const execution = store.createExecution({
    actor: "Reviewer",
    mode: "approval",
    requestedBy: host,
    ...context,
  });
  store.startExecution(execution.id);
  return reviewerAnswer(execution.id);
}

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
  store.setProjectDefaults({ "task-registration": "agent" }, operator);
  const id = goalId();
  const unrelatedGoal = goalId();
  const unrelated = store.proposeTask(
    { ...task, goalId: unrelatedGoal },
    operator,
  );
  if (unrelated.status !== "registered")
    throw new Error("Expected registration");
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
  const related = store.proposeTask({ ...task, goalId: id }, operator);
  if (related.status !== "registered") throw new Error("Expected registration");
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
  const overBudget = store.proposeTask(
    { ...task, goalId: id, budgets: { ...budgets, maxTokens: 501 } },
    operator,
  );
  assert.partialDeepStrictEqual(overBudget, {
    status: "pending",
    reasons: ["maxTokens"],
  });
  assert.throws(
    () => approve(overBudget),
    new OrchestratorStoreError("task-constraints"),
  );
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
  store.setProjectDefaults({ "task-registration": "agent" }, operator);
  const id = goalId();
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
