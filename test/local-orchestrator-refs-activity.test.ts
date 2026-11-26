import assert from "node:assert/strict";
import { Duplex } from "node:stream";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { execFile, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import {
  acceptConciergeWatch,
  conciergeWatchEvents,
  createConciergeWatch,
} from "../src/local-orchestrator/concierge-watch.ts";
import { createConciergeTerminalHub } from "../src/local-orchestrator/concierge-terminal.ts";
import {
  draftToConcierge,
  operatorAction,
  readOperatorGoal,
} from "../src/local-orchestrator/operator-api.ts";
import {
  operatorActivity,
  operatorActivityRevision,
  operatorGoal,
  operatorGoalList,
  operatorProblems,
  operatorTask,
  operatorTaskList,
} from "../src/local-orchestrator/operator-read.ts";
import { projectInbox } from "../src/local-orchestrator/inbox.ts";
import { goalBranch } from "../src/local-orchestrator/model.ts";
import { readGoalBranchHead } from "../src/local-orchestrator/tasks.ts";
import type { OrchestratorStore } from "../src/local-orchestrator/store.ts";
import type { TerminalExit } from "../src/sandbox-runtime.ts";
import {
  openTestStore,
  orchestratorFixture,
} from "./local-orchestrator-fixture.ts";

const { Database } = createRequire(import.meta.url)("bun:sqlite");

const operator = { kind: "operator" } as const;
const host = { kind: "host" } as const;
const budgets = { maxExecutionMs: 1000, maxRetries: 1, maxTokens: 500 };
const goalContent = {
  title: "Draft release notes",
  description: "",
  acceptance: ["Pass"],
  scope: {
    paths: ["docs/"],
    actors: ["Executor"],
    profiles: ["base"],
    maxTasks: 20,
    budgets,
  },
};
const taskContent = {
  title: "Collect changes",
  description: "",
  acceptance: ["Pass"],
  actor: "Executor",
  profile: "base",
  paths: ["docs/changes.md"],
  budgets,
  dependsOn: [],
};

function goal(store: OrchestratorStore) {
  const { id, digest } = store.proposeGoal(goalContent, operator);
  const receipt = store.decide(id, {
    digest,
    decision: "approve",
    answerer: { kind: "human" },
  });
  return receipt.goalId!;
}

function task(store: OrchestratorStore, goalId: string) {
  const receipt = store.proposeTask({ ...taskContent, goalId }, host);
  assert.equal(receipt.status, "registered");
  return receipt.taskId;
}

test("v6 migration backfills by timestamp then rowid and allocates after migration", () => {
  using state = orchestratorFixture("refs-migration-");
  const { store, filename } = state;
  const first = goal(store);
  const second = goal(store);
  const third = goal(store);
  const earlier = task(store, second);
  const later = task(store, second);
  const tied = task(store, second);
  const separate = task(store, first);
  store.close();

  const db = new Database(filename);
  db.exec(`
    DROP TRIGGER goals_ref_required;
    DROP TRIGGER goals_ref_immutable;
    DROP TRIGGER tasks_ref_required;
    DROP TRIGGER tasks_ref_immutable;
    DROP INDEX goals_ref;
    DROP INDEX tasks_ref;
    ALTER TABLE goals DROP COLUMN ref;
    ALTER TABLE tasks DROP COLUMN ref;
    UPDATE goals SET created_at = '2026-01-02T00:00:00.000Z';
    UPDATE tasks SET created_at = '2026-01-02T00:00:00.000Z';
    PRAGMA user_version=6;
  `);
  db.query(
    "UPDATE goals SET created_at = '2026-01-01T00:00:00.000Z' WHERE id = ?",
  ).run(second);
  db.query(
    "UPDATE tasks SET created_at = '2026-01-01T00:00:00.000Z' WHERE id = ?",
  ).run(later);
  db.close();

  using migrated = openTestStore(filename);
  const reopened = migrated.store;
  assert.equal(reopened.getGoal("g1")?.id, second);
  assert.equal(reopened.getGoal("G2")?.id, first);
  assert.equal(reopened.getGoal("G3")?.id, third);
  assert.equal(reopened.getTask("g1-1")?.id, later);
  assert.equal(reopened.getTask("G1-2")?.id, earlier);
  assert.equal(reopened.getTask("G1-3")?.id, tied);
  assert.equal(reopened.getTask("G2-1")?.id, separate);
  assert.equal(reopened.getGoal(goal(reopened))?.ref, "G4");
  assert.equal(reopened.getTask(task(reopened, second))?.ref, "G1-4");
});

test("separate simultaneous writers allocate unique goal and task sequences", async () => {
  using state = orchestratorFixture("refs-concurrent-");
  const parent = goal(state.store);
  const module = pathToFileURL(
    `${process.cwd()}/src/local-orchestrator/store.ts`,
  ).href;
  const script = `
    import { OrchestratorStore } from ${JSON.stringify(module)};
    const store = OrchestratorStore.open(process.argv[1]);
    try {
      const proposal = store.proposeGoal(${JSON.stringify(goalContent)}, { kind: "operator" });
      store.decide(proposal.id, { digest: proposal.digest, decision: "approve", answerer: { kind: "human" } });
      store.proposeTask(${JSON.stringify({ ...taskContent, goalId: parent })}, { kind: "host" });
    } finally {
      store.close();
    }
  `;
  const execute = promisify(execFile);
  const children = await Promise.allSettled(
    Array.from({ length: 5 }, () =>
      execute(process.execPath, ["-e", script, state.filename]),
    ),
  );
  assert.deepEqual(
    children.map(({ status }) => status),
    Array(5).fill("fulfilled"),
  );
  assert.deepEqual(
    state.store.listGoals().map(({ ref }) => ref),
    ["G1", "G2", "G3", "G4", "G5", "G6"],
  );
  assert.deepEqual(
    state.store.listTasks(parent).map(({ ref }) => ref),
    ["G1-1", "G1-2", "G1-3", "G1-4", "G1-5"],
  );
});

test("mixed aliases for a dependency are rejected without quarantining the writer", () => {
  using state = orchestratorFixture("refs-dependencies-");
  const { store } = state;
  const parent = goal(store);
  const dependency = task(store, parent);
  assert.throws(
    () =>
      store.proposeTask(
        {
          ...taskContent,
          goalId: "g1",
          dependsOn: [dependency, "g1-1"],
        },
        host,
      ),
    { code: "task-constraints" },
  );
  const receipt = store.proposeTask(
    { ...taskContent, goalId: "g1", dependsOn: ["g1-1"] },
    host,
  );
  assert.equal(receipt.status, "registered");
  assert.deepEqual(store.getTask(receipt.taskId)?.content.dependsOn, [
    dependency,
  ]);
  assert.partialDeepStrictEqual(store.getProposalDetails(receipt.id), {
    ref: "G1",
    goalRef: "G1",
    taskRef: "G1-2",
  });
});

test("activity lists parallel executions and waiting tasks, and derives goal turns", async () => {
  using state = orchestratorFixture("refs-turn-");
  const { store, root } = state;
  const id = goal(store);
  const other = goal(store);
  const turn = () => operatorGoal(store, "g1")!.turn;
  const activity = () => operatorActivity({ store, target: root });
  const execution = () =>
    store.createExecution({
      actor: "Planner",
      mode: "task-decomposition",
      goalId: id,
      requestedBy: host,
    }).id;
  const revision = store.activityRevision();
  assert.deepEqual(turn(), { owner: "idle", reason: { kind: "not-planned" } });
  const first = execution();
  const second = execution();
  assert.ok(store.activityRevision() > revision);
  assert.deepEqual(turn(), { owner: "ai", reason: { kind: "queued" } });
  assert.deepEqual(
    activity().queued.map(({ id }) => id),
    [first, second],
  );
  store.startExecution(first);
  store.startExecution(second);
  assert.deepEqual(turn(), { owner: "ai", reason: { kind: "planning" } });
  assert.deepEqual(
    activity().running.map(({ id, goalRef, taskRef }) => [
      id,
      goalRef,
      taskRef,
    ]),
    [
      [first, "G1", null],
      [second, "G1", null],
    ],
  );
  store.finishExecution(first, "succeeded", {});
  store.finishExecution(second, "failed", {});
  assert.deepEqual(turn(), { owner: "idle", reason: { kind: "idle" } });
  const taskId = task(store, "g1");
  task(store, other);
  assert.equal(activity().queuedCount, 2);
  assert.deepEqual(
    activity().queued.map(({ taskRef }) => taskRef),
    ["G1-1", "G2-1"],
  );
  assert.equal(operatorTaskList(store, "g1")?.[0]?.id, taskId);
  assert.equal(operatorTask(store, "g1-1")?.ref, "G1-1");
  assert.equal(operatorTask(store, "g2-9"), null);
  assert.equal(operatorGoal(store, "g9"), null);
  assert.equal(store.claimTask("g1-1")?.id, taskId);
  const work = store.createExecution({
    taskId: "g1-1",
    goalId: "g1",
    actor: "Executor",
    mode: "task",
    requestedBy: host,
  }).id;
  store.startExecution(work);
  assert.deepEqual(turn(), {
    owner: "ai",
    reason: { kind: "running", taskRef: "G1-1", actor: "Executor" },
  });
  store.finishExecution(work, "failed", {});
  store.failTask("g1-1", "example-failure");
  assert.equal(store.getTask(taskId)?.status, "failed");
  assert.equal(
    store.listEvents({ subjectId: taskId, limit: 1 })[0]?.subjectId,
    taskId,
  );
  const parallel = task(store, "g1");
  assert.equal(store.claimTask("g1-2")?.id, parallel);
  assert.deepEqual(turn(), {
    owner: "stopped",
    reason: { kind: "failed", taskRef: "G1-1", code: "example-failure" },
  });
  const proposal = store.proposeTask(
    { ...taskContent, goalId: id, paths: ["outside"] },
    operator,
  );
  assert.equal(proposal.status, "pending");
  assert.deepEqual(turn(), {
    owner: "human",
    reason: { kind: "approvals", count: 1 },
  });
  assert.deepEqual(
    operatorGoalList(store).find((goal) => goal.id === id)?.turn,
    turn(),
  );
  store.markInboxSeen([`task-registration:${proposal.id}`]);
  assert.equal(activity().yourTurn, 2);
  assert.equal(store.getProposalDetails(proposal.id)?.ref, "G1");
  assert.deepEqual(
    await operatorAction(store, root, "goal.discard", {
      id: "g2",
      confirm: "G2",
      expectedHead: null,
    }),
    {
      result: { id: other, ref: "G2", status: "cancelled" },
    },
  );
  assert.deepEqual(operatorGoal(store, other)?.turn, {
    owner: "stopped",
    reason: { kind: "cancelled" },
  });

  store.decide(proposal.id, {
    digest: proposal.digest,
    decision: "reject",
    answerer: { kind: "human" },
  });
  store.recordGoalCommit("g1", "a".repeat(40), "base");
  assert.equal(store.getGoal(id)?.baseCommit, "a".repeat(40));
  const db = new Database(state.filename);
  db.query("UPDATE tasks SET status = 'succeeded' WHERE goal_id = ?").run(id);
  db.close();
  assert.deepEqual(turn(), { owner: "done", reason: { kind: "exportable" } });
});

test("operator retry and discard enforce current state and store the operator audit", async () => {
  using state = orchestratorFixture("refs-actions-");
  const { store, root } = state;
  const goalId = goal(store);
  const taskId = task(store, goalId);
  const call = (method: "task.retry" | "goal.discard", params: object) =>
    operatorAction(store, root, method, params);
  assert.deepEqual(
    await call("task.retry", { id: taskId, expectedRetries: 0 }),
    { error: { code: "invalid-transition" } },
  );
  assert.deepEqual(
    await call("goal.discard", {
      id: goalId,
      confirm: "g1",
      expectedHead: null,
    }),
    {
      error: { code: "confirmation-mismatch" },
    },
  );
  assert.ok(store.claimTask(taskId));
  assert.deepEqual(
    await call("goal.discard", {
      id: goalId,
      confirm: "G1",
      expectedHead: null,
    }),
    {
      error: { code: "goal-busy" },
    },
  );
  store.failTask(taskId, "test-failed");
  assert.partialDeepStrictEqual(operatorProblems(store)[0], {
    ref: "G1-1",
    goalRef: "G1",
    expectedRetries: 0,
  });
  assert.deepEqual(
    await call("task.retry", { id: "g1-1", expectedRetries: 0 }),
    { result: { id: taskId, ref: "G1-1", status: "registered", retries: 1 } },
  );
  assert.deepEqual(
    await call("task.retry", { id: "g1-1", expectedRetries: 0 }),
    { error: { code: "task-retry-changed" } },
  );
  assert.partialDeepStrictEqual(
    store.listEvents({ subjectId: "g1-1", limit: 1 })[0],
    {
      kind: "task.retried",
      data: {
        origin: { kind: "operator", channel: "operator-ui" },
        budgetReset: true,
      },
    },
  );
  assert.deepEqual(
    await call("goal.discard", { id: "g1", confirm: "G1", expectedHead: null }),
    {
      result: { id: goalId, ref: "G1", status: "cancelled" },
    },
  );
  assert.deepEqual(
    await call("goal.discard", {
      id: goalId,
      confirm: "G1",
      expectedHead: null,
    }),
    {
      error: { code: "goal-inactive" },
    },
  );
  assert.equal(store.getTask(taskId)?.status, "cancelled");
  assert.equal(store.getGoal(goal(store))?.ref, "G2");
  assert.deepEqual(
    store.listEvents({ subjectId: "G1", limit: 2 }).map(({ kind }) => kind),
    ["goal.status", "goal.discard-authorized"],
  );
});

test("discard rejects a moved Goal branch before authorizing deletion", async () => {
  using state = orchestratorFixture("refs-stale-discard-");
  const { root, store } = state;
  const id = goal(store);
  const repository = join(root, "repository.git");
  mkdirSync(repository, { mode: 0o700 });
  const git = (args: string[], input?: string) => {
    const result = spawnSync(
      "/usr/bin/git",
      [`--git-dir=${repository}`, ...args],
      {
        encoding: "utf8",
        input,
        env: { GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
      },
    );
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git(["init", "--bare", "--template="]);
  const tree = git(["mktree"], "");
  const commit = (message: string) =>
    git(
      ["hash-object", "-t", "commit", "-w", "--stdin"],
      `tree ${tree}\nauthor Test <test@localhost> 1700000000 +0000\ncommitter Test <test@localhost> 1700000000 +0000\n\n${message}\n`,
    );
  const ref = `refs/heads/${goalBranch(id)}`;
  const base = commit("First");
  const next = commit("Second");
  git(["update-ref", ref, base]);
  const expectedHead = await readGoalBranchHead(root, id);
  assert.equal(expectedHead, base);
  git(["update-ref", ref, next]);
  const discard = (params: object) =>
    operatorAction(store, root, "goal.discard", {
      id: "g1",
      confirm: "G1",
      ...params,
    });
  assert.deepEqual(await discard({}), { error: { code: "invalid-params" } });
  for (const stale of [null, expectedHead]) {
    assert.deepEqual(await discard({ expectedHead: stale }), {
      error: { code: "stale-base" },
    });
  }
  assert.equal(await readGoalBranchHead(root, id), next);
  assert.equal(store.getGoal(id)?.status, "active");
  assert.ok(
    !store
      .listEvents({ subjectId: id, limit: 10 })
      .some(({ kind }) => kind === "goal.discard-authorized"),
  );
  assert.deepEqual(await discard({ expectedHead: next }), {
    result: { id, ref: "G1", status: "cancelled" },
  });
  assert.equal(await readGoalBranchHead(root, id), null);
});

test("an unreadable branch preserves Goal detail and blocks discard before audit", async () => {
  using state = orchestratorFixture("refs-unreadable-head-");
  const { root, store } = state;
  const id = goal(store);
  const available = await readOperatorGoal(store, root, "G1");
  assert.equal(available?.head, null);
  assert.equal(available?.headAvailable, true);

  const repository = join(root, "repository.git");
  const result = spawnSync(
    "/usr/bin/git",
    ["init", "--bare", "--template=", repository],
    {
      env: { GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
    },
  );
  assert.equal(result.status, 0);
  mkdirSync(join(repository, "refs", "heads", "lo"), { recursive: true });
  writeFileSync(
    join(repository, "refs", "heads", goalBranch(id)),
    "malformed-ref\n",
  );

  const detail = await readOperatorGoal(store, root, "g1");
  assert.equal(detail?.ref, "G1");
  assert.equal(detail?.title, goalContent.title);
  assert.equal(detail?.head, null);
  assert.equal(detail?.headAvailable, false);
  assert.deepEqual(
    await operatorAction(store, root, "goal.discard", {
      id: "G1",
      confirm: "G1",
      expectedHead: null,
    }),
    { error: { code: "goal-head-unavailable" } },
  );
  assert.equal(store.getGoal(id)?.status, "active");
  assert.ok(
    !store
      .listEvents({ subjectId: id, limit: 10 })
      .some(({ kind }) => kind === "goal.discard-authorized"),
  );
});

test("activity counts the same unresolved actions as the bounded inbox", () => {
  using state = orchestratorFixture("refs-inbox-alignment-");
  const { store } = state;
  const source = {
    store,
    target: "fixture",
    secretTests: () =>
      Array.from({ length: 201 }, (_, index) => ({
        variable: `FIXTURE_${index}`,
        version: "1",
        passed: false,
      })),
  };
  store.proposeGoal(goalContent, operator);
  const visibleActions = projectInbox(source).filter(
    ({ state, weight }) => weight === "action" && state !== "resolved",
  );
  assert.equal(visibleActions.length, 200);
  assert.equal(operatorActivity(source).yourTurn, visibleActions.length);
});

test("activity counts decisions and groups a Task failure with its over-budget execution", () => {
  using state = orchestratorFixture("refs-activity-problems-");
  const { store } = state;
  const source = { store, target: "fixture" };
  const goalId = goal(store);
  const { id: sessionId } = store.startSession("Concierge", "budget-watch");
  const cursor = store.conciergeWatchStart(sessionId);
  const taskId = task(store, goalId);
  assert.ok(store.claimTask(taskId));
  const { id } = store.createExecution({
    taskId,
    goalId,
    actor: "Executor",
    mode: "task",
    requestedBy: host,
  });
  store.startExecution(id);
  store.finishExecution(id, "failed", { tokens: 501 });
  store.failTask(taskId, "budget-exceeded");
  for (let index = 0; index < 3; index++)
    store.proposeGoal(goalContent, operator);

  assert.deepEqual(
    conciergeWatchEvents(source, store.conciergeWatchRows(cursor)),
    ["task-failed G1-1 budget-exceeded", "decision-needed 3"],
  );
  const problems = operatorProblems(store);
  assert.deepEqual(problems.map((row) => [row.taskId, row.kind]).sort(), [
    [taskId, "execution-over-budget"],
    [taskId, "task-failed"],
  ]);
  assert.match(
    problems.find((row) => row.kind === "task-failed")!.detail,
    /予算超過/,
  );
  assert.doesNotMatch(
    problems.find((row) => row.kind === "task-failed")!.detail,
    /budget-exceeded/,
  );
  assert.equal(operatorActivity(source).yourTurn, 4);
});

test("the activity revision changes when visible inbox history crosses the cutoff", () => {
  using state = orchestratorFixture("refs-activity-cutoff-");
  const { store } = state;
  const source = { store, target: "fixture" };
  const goalId = goal(store);
  const db = new Database(state.filename);
  try {
    db.query("UPDATE goals SET status = 'done' WHERE id = ?").run(goalId);
  } finally {
    db.close();
  }
  const completed = projectInbox(source).find(
    ({ kind }) => kind === "goal-completed",
  );
  assert.ok(completed?.at);
  const boundary = Date.parse(completed.at) + 7 * 86_400_000;
  assert.equal(
    operatorActivityRevision(source, boundary - 1),
    operatorActivityRevision(source, boundary),
  );
  assert.notEqual(
    operatorActivityRevision(source, boundary),
    operatorActivityRevision(source, boundary + 1),
  );
});

test("Goal base updates and discard write to canonical subjects when given refs", async () => {
  using state = orchestratorFixture("refs-store-writes-");
  const { store } = state;
  const id = goal(store);
  const base = "a".repeat(40);
  const next = "b".repeat(40);
  store.recordGoalCommit("g1", base, "base");
  await store.updateGoalBase("g1", base, next, async () => {});
  assert.equal(store.getGoal(id)?.baseCommit, next);
  await store.discardGoal("g1", next, async (head) => assert.equal(head, next));
  assert.equal(store.getGoal(id)?.status, "cancelled");
  assert.deepEqual(
    store
      .listEvents({ subjectId: id, limit: 4 })
      .map(({ kind, subjectId }) => [kind, subjectId]),
    [
      "goal.status",
      "goal.discard-authorized",
      "goal.base-updated",
      "goal.base-pinned",
    ].map((kind) => [kind, id]),
  );
});

test("draft sends capped bracketed paste through the owned terminal after durable audit", async () => {
  using state = orchestratorFixture("refs-draft-");
  const terminal = createConciergeTerminalHub();
  const owner = () => {};
  const stranger = () => {};
  const call = (text: string, client = owner) =>
    draftToConcierge(state.store, terminal, client, { text });
  assert.deepEqual(call("draft"), { error: { code: "terminal-unavailable" } });
  const written: Buffer[] = [];
  const { promise: finished, resolve } = Promise.withResolvers<TerminalExit>();
  terminal.start({
    finished,
    terminal: {
      write: (input) => {
        assert.equal(
          state.store.listEvents({ subjectId: "Concierge", limit: 1 })[0]?.kind,
          "concierge.draft-authorized",
        );
        written.push(Buffer.from(input));
      },
      resize: () => {},
    },
  });
  terminal.attach(owner);
  assert.deepEqual(call("draft", stranger), {
    error: { code: "terminal-read-only" },
  });
  assert.deepEqual(call("\x1b\n\r"), { error: { code: "invalid-params" } });
  const controls =
    "\0\r\n\x1b[201~\x7f\x85\x9b\u202e\u2066\u200b\ufeff\u2028\u2029";
  assert.deepEqual(call("A" + controls + "日" + "🛠".repeat(2100)), {
    result: { characters: 2000 },
  });
  const sanitized = "A[201~日" + "🛠".repeat(1993);
  assert.deepEqual(written, [Buffer.from(`\x1b[200~${sanitized}\x1b[201~`)]);
  assert.ok(!written[0]!.some((byte) => byte === 13 || byte === 10));
  assert.equal(written[0]!.filter((byte) => byte === 27).length, 2);
  const data = state.store.listEvents({ subjectId: "Concierge", limit: 1 })[0]
    ?.data;
  assert.deepEqual(data, {
    origin: { kind: "operator", channel: "operator-ui" },
    characters: 2000,
    sha256: createHash("sha256").update(sanitized).digest("hex"),
  });
  resolve({ exitCode: 0 });
  await finished;
  assert.deepEqual(call("draft"), { error: { code: "terminal-exited" } });
});

test("audit write refusal prevents retry, discard, and terminal input", async () => {
  for (const method of [
    "task.retry",
    "goal.discard",
    "concierge.draft",
  ] as const) {
    using state = orchestratorFixture("refs-audit-");
    const { store, filename, root } = state;
    const goalId = goal(store);
    const taskId = task(store, goalId);
    store.claimTask(taskId);
    store.failTask(taskId, "tests");
    const db = new Database(filename);
    db.exec(`CREATE TRIGGER reject_operator_audit BEFORE INSERT ON events
      BEGIN SELECT RAISE(ABORT, 'test audit refusal'); END;`);
    db.close();
    if (method === "concierge.draft") {
      const terminal = createConciergeTerminalHub();
      const client = () => {};
      let writes = 0;
      terminal.start({
        finished: new Promise(() => {}),
        terminal: {
          write: () => {
            writes++;
          },
          resize: () => {},
        },
      });
      terminal.attach(client);
      assert.deepEqual(
        draftToConcierge(store, terminal, client, { text: "Draft" }),
        { error: { code: "write-failed" } },
      );
      assert.equal(writes, 0);
    } else {
      const params =
        method === "task.retry"
          ? { id: taskId, expectedRetries: 0 }
          : { id: goalId, confirm: "G1", expectedHead: null };
      assert.deepEqual(await operatorAction(store, root, method, params), {
        error: { code: "write-failed" },
      });
      assert.equal(store.getGoal(goalId)?.status, "active");
      assert.equal(store.getTask(taskId)?.status, "failed");
      assert.equal(store.getTask(taskId)?.retries, 0);
    }
  }
});

test("Concierge watch tails the session journal, coalesces decisions and discards input", () => {
  using state = orchestratorFixture("concierge-watch-");
  const { store, filename } = state;
  const source = { store, target: "/fixture" };
  goal(store);
  const { id: sessionId } = store.startSession("Concierge", "watch-run");
  const approved = goal(store);
  store.proposeGoal({ ...goalContent, title: "Pending one" }, operator);
  store.proposeGoal({ ...goalContent, title: "Pending two" }, operator);

  const { id } = store.createExecution({
    actor: "Planner",
    mode: "task-decomposition",
    goalId: approved,
    requestedBy: host,
  });
  store.startExecution(id);
  store.finishExecution(id, "succeeded", {});

  const watch = createConciergeWatch(source, sessionId);
  const lines: string[] = [];
  const socket = new Duplex({
    read() {},
    write(bytes, _encoding, done) {
      lines.push(String(bytes));
      done();
    },
  });
  const revision = operatorActivityRevision(source);
  assert.equal(operatorActivity(source).conciergeWatching, false);
  acceptConciergeWatch(watch, socket);
  assert.equal(operatorActivity(source).conciergeWatching, true);
  assert.notEqual(operatorActivityRevision(source), revision);
  assert.equal(socket.readableFlowing, true);
  assert.equal(socket.listenerCount("data"), 0);
  socket.push("request_planner attacker-input\n");
  const second = new Duplex({ read() {} });
  acceptConciergeWatch(watch, second);
  assert.equal(second.destroyed, true);
  watch.poll();
  watch.poll();
  assert.deepEqual(lines, [
    "event goal-approved G2\n",
    "event plan-ready G2\n",
    "event decision-needed 2\n",
  ]);
  const connectedRevision = operatorActivityRevision(source);
  watch.disconnect();
  assert.equal(socket.destroyed, true);
  assert.equal(operatorActivity(source).conciergeWatching, false);
  assert.notEqual(operatorActivityRevision(source), connectedRevision);
  const db = new Database(filename, { readonly: true });
  try {
    assert.deepEqual(
      db
        .query(
          "SELECT kind, data FROM events WHERE kind LIKE 'concierge-watch.%' ORDER BY rowid",
        )
        .all()
        .map(({ kind, data }: { kind: string; data: string }) => [
          kind,
          JSON.parse(data),
        ]),
      [
        ["concierge-watch.connected", {}],
        ["concierge-watch.sent", { eventKind: "goal-approved", ref: "G2" }],
        ["concierge-watch.sent", { eventKind: "plan-ready", ref: "G2" }],
        ["concierge-watch.sent", { eventKind: "decision-needed", count: 2 }],
        ["concierge-watch.disconnected", {}],
      ],
    );
  } finally {
    db.close();
  }
});

test("Concierge watch caps lines and stops before output if the audit fails", () => {
  using state = orchestratorFixture("watch-audit-");
  const { store } = state;
  const { id } = store.startSession("Concierge", "watch-run");
  const source = { store, target: "/fixture" };
  const original = store.conciergeWatchRows.bind(store);
  store.conciergeWatchRows = (after) =>
    original(after).flatMap((row) => [
      { ...row, goalRef: `G${"9".repeat(100)}` },
      row,
    ]);
  const watch = createConciergeWatch(source, id);
  const socket = new Duplex({
    read() {},
    write() {
      assert.fail("audit failure must prevent delivery");
    },
  });
  acceptConciergeWatch(watch, socket);
  watch.poll();
  goal(store);
  const record = store.recordConciergeWatch.bind(store);
  let attempts = 0;
  store.recordConciergeWatch = (...args) => {
    if (args[1] === "sent") {
      attempts++;
      assert.equal(args[2], "goal-approved G1");
      throw new Error("audit unavailable");
    }
    record(...args);
  };
  watch.poll();
  assert.equal(attempts, 1);
  assert.equal(watch.failed, true);
  assert.equal(socket.destroyed, true);
  assert.equal(operatorActivity(source).conciergeWatching, false);
});

test("watch reconnects are cooled down and capped without recording refused connections", () => {
  using state = orchestratorFixture("watch-reconnect-");
  const { store } = state;
  const { id } = store.startSession("Concierge", "watch-run");
  const source = { store, target: "/fixture" };
  let now = 0;
  const watch = createConciergeWatch(source, id, () => now);
  for (let i = 0; i < 12; i++) {
    const socket = new Duplex({ read() {} });
    acceptConciergeWatch(watch, socket);
    assert.equal(socket.destroyed, false);
    watch.disconnect();
    assert.equal(socket.destroyed, true);
    const revision = operatorActivityRevision(source);
    const retry = new Duplex({ read() {} });
    acceptConciergeWatch(watch, retry);
    assert.equal(retry.destroyed, true);
    assert.equal(operatorActivityRevision(source), revision);
    now += 5000;
  }
  const revision = operatorActivityRevision(source);
  const capped = new Duplex({ read() {} });
  acceptConciergeWatch(watch, capped);
  assert.equal(capped.destroyed, true);
  assert.equal(operatorActivityRevision(source), revision);
  assert.equal(
    store
      .listEvents({ subjectId: id, limit: 30 })
      .filter(({ kind }) => kind.startsWith("concierge-watch.")).length,
    24,
  );
});
