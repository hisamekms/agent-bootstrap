import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, writeFileSync } from "node:fs";
import { once } from "node:events";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { test } from "node:test";
import { projectStateDirectory } from "../src/config/layers.ts";
import { addProject } from "../src/config/projects.ts";
import { projectInbox } from "../src/local-orchestrator/inbox.ts";
import { LocalGitIntegration } from "../src/git-integration.ts";
import { operatorProposal } from "../src/local-orchestrator/operator-read.ts";
import { goalBranch } from "../src/local-orchestrator/model.ts";
import { OrchestratorStore } from "../src/local-orchestrator/store.ts";
import { prepareTargetDirectory } from "../src/local-orchestrator/target.ts";
import { configEnv, fixtureGit, initConfigRepo } from "./config-fixture.ts";
import {
  orchestratorFixture,
  openTestStore,
} from "./local-orchestrator-fixture.ts";

const operator = { kind: "operator" } as const;
const host = { kind: "host" } as const;
const budgets = { maxExecutionMs: 1000, maxRetries: 1, maxTokens: 500 };
const inboxGoal = {
  title: "Model\u202e Goal",
  description: "",
  acceptance: ["Pass"],
  scope: {
    paths: ["src/"],
    profiles: ["base"],
    actors: ["Executor"],
    maxTasks: 4,
    budgets,
  },
};
const taskContent = {
  title: "Model Task",
  description: "",
  acceptance: ["Pass"],
  actor: "Executor",
  profile: "base",
  paths: ["src/a.ts"],
  budgets,
  dependsOn: [],
};

function answer(
  store: OrchestratorStore,
  { id, digest }: { id: string; digest: string },
  decision: "approve" | "reject" = "approve",
) {
  return store.decide(id, { digest, decision, answerer: { kind: "human" } });
}

const { Database } = createRequire(import.meta.url)("bun:sqlite") as {
  Database: new (filename: string) => {
    exec(sql: string): void;
    query(sql: string): { run(...params: string[]): unknown };
    close(): void;
  };
};

test("inbox projects gates, failure, retry, budget, integration, and completion", async (t) => {
  using state = orchestratorFixture("inbox-");
  const { store } = state;
  const target = "/example/it's a target";
  const pending = store.proposeGoal(inboxGoal, operator);
  const read = (includeResolved = false) =>
    projectInbox({ store, target }, { includeResolved });
  const [gate] = read();
  assert.partialDeepStrictEqual(gate, {
    id: `goal-registration:${pending.id}`,
    state: "open",
    modelText: "Model\\u202e Goal",
    subject: { proposalId: pending.id },
    next: `agent-bootstrap --target '/example/it'\\''s a target' approve ${pending.id}`,
  });
  assert.doesNotMatch(gate!.title, /Model/);
  store.markInboxSeen([gate!.id, gate!.id]);
  {
    using reopened = openTestStore(state.filename);
    assert.equal(
      projectInbox({ store: reopened.store, target })[0]?.state,
      "seen",
    );
  }
  const { goalId } = answer(store, pending);
  assert.ok(goalId);
  assert.equal(read().length, 0);
  assert.equal(read(true)[0]?.state, "resolved");
  assert.equal(read(true)[0]?.id, gate!.id);

  const scoped = store.proposeTask(
    { ...taskContent, goalId, paths: ["other/a.ts"] },
    host,
  );
  assert.equal(read()[0]?.kind, "task-registration");
  assert.equal(read()[0]?.subject.proposalId, scoped.id);
  answer(store, scoped, "reject");
  const task = store.proposeTask({ ...taskContent, goalId }, host);
  assert.equal(task.status, "registered");
  if (task.status !== "registered") throw new Error("Task was not registered");
  const { taskId } = task;
  const checkout = initConfigRepo(join(state.root, "checkout"));
  const base = fixtureGit(checkout, "rev-parse", "HEAD");
  store.recordGoalCommit(goalId, base, "base");
  assert.ok(store.claimTask(taskId));
  const firstRun = read().find(({ kind }) => kind === "task-running");
  assert.ok(firstRun);
  store.failTask(taskId, "path-violation", [
    { path: "private/rejected", symlink: false },
  ]);
  const [failed] = read();
  assert.equal(failed?.kind, "task-failed");
  assert.match(failed!.title, /path-violation, 1 rejected paths recorded/);
  assert.doesNotMatch(JSON.stringify(failed), /private\/rejected/);
  assert.match(failed!.next, / retry-task /);
  assert.equal(
    read(true).find(({ id }) => id === firstRun.id)?.state,
    "resolved",
  );
  store.retryTask(taskId, 0);
  assert.equal(read()[0]?.id, failed?.id);
  assert.match(read()[0]!.next, / show /);
  assert.ok(store.claimTask(taskId));
  assert.ok(!read().some(({ id }) => id === failed?.id || id === firstRun.id));
  assert.equal(
    read(true).find(({ id }) => id === failed?.id)?.state,
    "resolved",
  );

  const execution = store.createExecution({
    actor: "Executor",
    mode: "task",
    taskId,
    goalId,
    requestedBy: host,
  });
  store.startExecution(execution.id);
  store.finishExecution(execution.id, "succeeded", {
    tokens: 501,
    usage: "unavailable",
  });
  assert.partialDeepStrictEqual(
    read().find(({ kind }) => kind === "execution-over-budget"),
    {
      state: "open",
      subject: { executionId: execution.id, taskId },
    },
  );

  mkdirSync(join(checkout, "src"));
  writeFileSync(join(checkout, "src", "a.ts"), "export {};\n");
  fixtureGit(checkout, "add", "src/a.ts");
  fixtureGit(checkout, "commit", "-m", "candidate");
  const candidate = fixtureGit(checkout, "rev-parse", "HEAD");
  const repository = join(state.root, "repository.git");
  fixtureGit(
    state.root,
    "init",
    "--bare",
    "--template=",
    "--object-format=sha1",
    repository,
  );
  cpSync(join(checkout, ".git", "objects"), join(repository, "objects"), {
    recursive: true,
  });
  const git = new LocalGitIntegration({
    binary: "/usr/bin/git",
    repository,
    stagingRoot: join(state.root, "worktrees"),
    branch: goalBranch(goalId),
  });
  const digest = createHash("sha256")
    .update(await git.diff(base, candidate))
    .digest("hex");
  const review = store.createExecution({
    actor: "Reviewer",
    mode: "review",
    taskId,
    goalId,
    requestedBy: host,
  });
  store.startExecution(review.id);
  store.finishExecution(review.id, "succeeded", {
    review: "pass",
    pin: { base, candidate, digest },
  });
  const integration = store.proposeIntegration(
    {
      taskId,
      goalId,
      branch: goalBranch(goalId),
      base,
      candidate,
      digest,
      changedPaths: ["src/a.ts"],
      review: { result: "pass", notes: "Findings\u202e <tag>\r\nMore\nEnd" },
    },
    review.id,
    { changedFiles: 1, changedLines: 1 },
  );
  assert.throws(
    () => store.finishExecution(review.id, "succeeded", { review: "revise" }),
    /invalid-transition/,
  );
  assert.partialDeepStrictEqual(
    read().find(({ kind }) => kind === "integration"),
    {
      subject: { taskId, goalId, proposalId: integration.id },
      state: "open",
    },
  );
  const details = await operatorProposal(store, state.root, integration.id);
  assert.partialDeepStrictEqual(details, {
    digest: integration.digest,
    effectivePolicy: "human",
    origin: host,
    changedPaths: ["src/a.ts"],
    changedFiles: 1,
    changedLines: 1,
    budgets,
    pathViolations: [],
    reviewExecutionId: review.id,
    modelText: {
      verdict: "pass",
      findings: "Findings\\u202e <tag>\nMore\nEnd",
    },
  });
  const screened = await operatorProposal(
    store,
    state.root,
    integration.id,
    async (...fields) => {
      if (
        fields.some(
          (field) => typeof field === "string" && field.startsWith("Findings"),
        )
      )
        throw new Error();
    },
  );
  assert.partialDeepStrictEqual(screened, {
    digest: integration.digest,
    reviewExecutionId: review.id,
    modelText: { verdict: "pass", findings: { withheld: true } },
  });
  assert.ok(typeof details?.diffStat === "string");
  const { diffStat } = details;
  assert.match(details.diffStat, /src\/a\.ts.*1 \+/);
  assert.ok(!details.diffStat.includes("export"));
  const hiddenStat = await operatorProposal(
    store,
    state.root,
    integration.id,
    async (...fields) => {
      if (fields.includes(diffStat)) throw new Error();
    },
  );
  assert.partialDeepStrictEqual(hiddenStat, {
    changedPaths: ["src/a.ts"],
    diffStat: { withheld: true },
  });
  const hiddenPath = await operatorProposal(
    store,
    state.root,
    integration.id,
    async (...fields) => {
      if (fields.includes("src/a.ts")) throw new Error();
    },
  );
  assert.partialDeepStrictEqual(hiddenPath, {
    changedPaths: { withheld: true },
    diffStat: { withheld: true },
    changedFiles: 1,
  });
  const stat = t.mock.method(
    LocalGitIntegration.prototype,
    "diffStat",
    async () => " bearer " + "x".repeat(24) + " | 1 +\n",
  );
  try {
    assert.partialDeepStrictEqual(
      await operatorProposal(store, state.root, integration.id),
      { changedPaths: ["src/a.ts"], diffStat: { withheld: true } },
    );
  } finally {
    stat.mock.restore();
  }
  answer(store, integration);
  const { approvalId } = store.approvedIntegration(integration.id);
  store.beginIntegration(integration.id, integration.digest, approvalId);
  store.finishIntegration(integration.id, "completed", "ok");
  assert.equal(
    read().find(({ kind }) => kind === "task-succeeded")?.subject.taskId,
    taskId,
  );
  assert.equal(
    read(true).find(({ id }) => id === `integration:${integration.id}`)?.state,
    "resolved",
  );
  assert.equal(
    read(true).find(({ kind }) => kind === "execution-over-budget")?.state,
    "resolved",
  );

  // Current launchers have no Goal completion command. Exercise the durable state.
  const db = new Database(state.filename);
  try {
    db.query("UPDATE goals SET status = 'done' WHERE id = ?").run(goalId);
  } finally {
    db.close();
  }
  assert.equal(
    read().find(({ kind }) => kind === "goal-completed")?.subject.goalId,
    goalId,
  );
  const future = projectInbox(
    { store, target },
    { now: Date.now() + 8 * 86400_000, includeResolved: true },
  );
  assert.ok(!future.some(({ weight }) => weight === "info"));

  const reopen = new Database(state.filename);
  try {
    reopen.query("UPDATE goals SET status = 'active' WHERE id = ?").run(goalId);
  } finally {
    reopen.close();
  }
  const pendingTask = store.proposeTask(
    { ...taskContent, goalId, paths: ["other/a.ts"] },
    host,
  );
  const planning = store.createExecution({
    actor: "Planner",
    mode: "plan",
    goalId,
    requestedBy: host,
  });
  store.startExecution(planning.id);
  store.finishExecution(planning.id, "succeeded", { tokens: 501 });
  const open = read();
  assert.deepEqual(open.map(({ kind }) => kind).sort(), [
    "execution-over-budget",
    "task-registration",
    "task-succeeded",
  ]);
  assert.ok(open.some(({ subject }) => subject.proposalId === pendingTask.id));
  await store.discardGoal(goalId, null, async () => {});
  assert.deepEqual(read(), []);
  const history = read(true);
  for (const { id } of open)
    assert.equal(history.find((item) => item.id === id)?.state, "resolved");
  assert.match(
    history.find(({ subject }) => subject.proposalId === pendingTask.id)!.title,
    /closed$/,
  );
});

test("inbox bounds its history and keeps the secret check ID through a pass", () => {
  using state = orchestratorFixture("inbox-");
  const { store } = state;
  const read = (
    passed: boolean,
    includeResolved = false,
    version = "version-1",
  ) =>
    projectInbox(
      {
        store,
        target: "/repo",
        secretTests: () => [{ variable: "FIXTURE_VALUE", version, passed }],
      },
      { includeResolved },
    );
  const [check] = read(false);
  assert.partialDeepStrictEqual(check, {
    kind: "secret-test-required",
    weight: "action",
    state: "open",
    at: null,
  });
  assert.equal(
    check?.next,
    "agent-bootstrap secrets test FIXTURE_VALUE --target /repo",
  );
  assert.ok(!check?.id.includes("FIXTURE_VALUE"));
  store.markInboxSeen([check!.id]);
  assert.equal(read(false)[0]?.state, "seen");
  assert.equal(read(true).length, 0);
  assert.partialDeepStrictEqual(read(true, true)[0], {
    id: check!.id,
    state: "resolved",
  });
  assert.notEqual(read(false, false, "version-2")[0]?.id, check?.id);
  for (let i = 0; i < 205; i++) store.proposeGoal(inboxGoal, operator);
  const items = read(false);
  assert.equal(items.length, 200);
  assert.equal(new Set(items.map(({ id }) => id)).size, 200);
  assert.equal(items[0]?.id, check?.id);
});

test("version four stores acquire seen marks without losing pending proposals", () => {
  using state = orchestratorFixture("inbox-migration-");
  const { id } = state.store.proposeGoal(inboxGoal, operator);
  state.store.close();
  const db = new Database(state.filename);
  try {
    db.exec(`
      DROP TABLE inbox_seen;
      DROP TABLE delegation_rules;
      DROP TABLE goal_policy;
      DROP TABLE task_policy;
      DROP TABLE integration_policy_facts;
      DROP INDEX events_decisions_at;
      ALTER TABLE project_policy DROP COLUMN explicit_json;
      ALTER TABLE proposal_approval_runs RENAME TO integration_approval_runs;
      ALTER TABLE approvals DROP COLUMN policy_details_json;
      ALTER TABLE approvals DROP COLUMN reasons_json;
      PRAGMA user_version=4;
    `);
  } finally {
    db.close();
  }
  using migrated = openTestStore(state.filename);
  const source = { store: migrated.store, target: "/repo" };
  const [item] = projectInbox(source);
  assert.equal(item?.subject.proposalId, id);
  migrated.store.markInboxSeen([item!.id]);
  assert.equal(projectInbox(source)[0]?.state, "seen");
});

test(
  "inbox CLI prints marked model text and watch streams a changed gate without a TTY",
  { timeout: 10000 },
  async () => {
    using state = orchestratorFixture("inbox-cli-");
    const repo = initConfigRepo(join(state.root, "target with spaces"));
    const env = configEnv(state.root);
    addProject(repo, "inbox-test", env);
    const root = fileURLToPath(new URL("..", import.meta.url));
    const directory = await prepareTargetDirectory(
      root,
      projectStateDirectory("inbox-test", env),
      env,
    );
    using db = openTestStore(join(directory, "state.db"));
    const pending = db.store.proposeGoal(inboxGoal, operator);
    const entry = join(root, "bin", "agent-bootstrap.ts");
    const run = (args: string[]) =>
      spawn(process.execPath, [entry, "--target", repo, ...args], {
        env: { ...env, PATH: "/usr/bin:/bin" },
        stdio: ["ignore", "pipe", "pipe"],
      });
    const inbox = run(["inbox"]);
    let human = "";
    inbox.stdout!.on("data", (data) => (human += data));
    assert.deepEqual(await once(inbox, "close"), [0, null]);
    assert.match(human, /\[action\] goal-registration open/);
    assert.match(human, /\| untrusted model text: "Model\\u202e Goal"\n$/);
    assert.ok(
      human.includes(
        `agent-bootstrap --target '${repo}' approve ${pending.id}`,
      ),
    );
    const json = run(["inbox", "--all", "--json"]);
    let output = "";
    json.stdout!.on("data", (data) => (output += data));
    assert.deepEqual(await once(json, "close"), [0, null]);
    assert.equal(JSON.parse(output)[0].subject.proposalId, pending.id);

    const watch = run(["watch"]);
    const closed = once(watch, "close");
    const lines = createInterface({ input: watch.stdout! })[
      Symbol.asyncIterator
    ]();
    try {
      assert.match((await lines.next()).value!, /goal-registration open/);
      answer(db.store, pending, "reject");
      assert.match((await lines.next()).value!, /goal-registration resolved/);
      watch.kill("SIGINT");
      assert.deepEqual(await closed, [0, null]);
    } finally {
      watch.kill();
    }
  },
);
