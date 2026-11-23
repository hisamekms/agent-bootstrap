import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, test } from "node:test";
import { claudeRoleHarness } from "../src/actors.ts";
import { CLAUDE_WORKER_USAGE_MARKER } from "../src/claude-code.ts";
import { LocalGitIntegration } from "../src/git-integration.ts";
import { IntegrationJournal } from "../src/integration-journal.ts";
import { runCli } from "../src/local-orchestrator/cli.ts";
import { snapshotConciergeRepo } from "../src/local-orchestrator/concierge.ts";
import {
  contentDigest,
  goalBranch,
  type PolicySet,
  type TaskContent,
} from "../src/local-orchestrator/model.ts";
import { ActorRunner } from "../src/local-orchestrator/runner.ts";
import {
  OrchestratorStore,
  OrchestratorStoreError,
} from "../src/local-orchestrator/store.ts";
import {
  prepareTargetDirectory,
  resolveTarget,
} from "../src/local-orchestrator/target.ts";
import { configuredVerification } from "../src/local-orchestrator/verification.ts";
import {
  createTaskExecutor,
  type TaskExecutor,
  type TaskFlow,
} from "../src/local-orchestrator/tasks.ts";

const { Database } = createRequire(import.meta.url)("bun:sqlite") as {
  Database: new (path: string) => {
    exec(sql: string): void;
    query<T>(sql: string): {
      get(...args: string[]): T;
      all(...args: string[]): T[];
      run(...args: string[]): void;
    };
    close(): void;
  };
};

const budgets = { maxExecutionMs: 300_000, maxRetries: 5, maxTokens: 50 };
const model = "claude-fixture";
const harness = claudeRoleHarness({
  auth: { mode: "api-key", credential: "host-secret" },
  model,
  tools: [],
});
const pin = {
  base: "a".repeat(40),
  candidate: "b".repeat(40),
  digest: "c".repeat(64),
};
const flags = { kind: "human", decision: "approve" } as const;
const origin = { kind: "operator" } as const;
const planner = { kind: "actor", actor: "Planner" } as const;
let root: string;
let filename: string;
let store: OrchestratorStore;

beforeEach(() => {
  root = mkdtempSync(join(realpathSync(tmpdir()), "lo-tasks-"));
  filename = join(root, "state.db");
  store = OrchestratorStore.open(filename);
});
afterEach(() => {
  store.close();
  rmSync(root, { force: true, recursive: true });
});

function approve(proposal: { id: string; digest: string }) {
  return store.decide(proposal.id, {
    decision: flags.decision,
    answerer: { kind: flags.kind },
    digest: proposal.digest,
  });
}
function goal(policies?: PolicySet) {
  return approve(
    store.proposeGoal(
      {
        title: "Goal",
        description: "",
        acceptance: ["Valid docs"],
        scope: {
          paths: ["docs/"],
          profiles: ["base"],
          actors: ["Executor"],
          maxTasks: 8,
          budgets,
        },
        ...(policies ? { policies } : {}),
      },
      origin,
    ),
  ).goalId!;
}
function task(goalId: string, overrides: Partial<TaskContent> = {}) {
  const draft = store.proposeTask(
    {
      goalId,
      title: "Task",
      description: "",
      acceptance: ["Valid docs"],
      actor: "Executor",
      profile: "base",
      paths: ["docs/"],
      dependsOn: [],
      budgets,
      ...overrides,
    },
    planner,
  );
  return draft.status === "registered" ? draft.taskId : approve(draft).taskId!;
}

function fixture(overrides: Partial<TaskFlow> = {}) {
  const calls: string[] = [];
  const executions: string[] = [];
  const flow: TaskFlow = {
    async worker(id, revision, observed) {
      calls.push(revision ? "revise" : "worker");
      executions.push(id);
      observed.invocationId = id;
      observed.tokens = 0;
      return pin;
    },
    async review(id, observed) {
      observed.tokens = 0;
      calls.push("review");
      executions.push(id);
      return { ...pin, review: "pass", notes: "Good" };
    },
    async reject() {
      calls.push("reject");
    },
    async changes() {
      return [{ path: "docs/a.md", newMode: "100644" }];
    },
    ...overrides,
  };
  const executor: TaskExecutor = {
    async open() {
      return flow;
    },
    async diff() {
      return Buffer.from("candidate body");
    },
  };
  return { calls, executions, executor };
}

function runner(
  tasks: TaskExecutor,
  overrides: Partial<ConstructorParameters<typeof ActorRunner>[0]> = {},
) {
  return new ActorRunner({
    store,
    model,
    harness,
    tasks,
    context: async () => [],
    runPlanner: async () => {
      throw new Error("unexpected Planner");
    },
    runReviewer: async () => {
      throw new Error("unexpected approval");
    },
    ...overrides,
  });
}

function failure(taskId: string) {
  return store.listEvents({ subjectId: taskId, limit: 1 })[0]?.data;
}

test("drain serializes actors, bounds the queue and waits for integrated dependencies", async () => {
  const goalId = goal();
  const first = task(goalId);
  const dependent = task(goalId, { dependsOn: [first] });
  const independent = task(goalId);
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let calls = 0;
  let active = 0;
  let peak = 0;
  const { executor } = fixture({
    async worker(_id, _revision, observed) {
      observed.tokens = 0;
      peak = Math.max(peak, ++active);
      if (++calls === 1) {
        entered.resolve();
        await release.promise;
      }
      active--;
      return pin;
    },
    async review(_id, observed) {
      observed.tokens = 0;
      peak = Math.max(peak, ++active);
      await Promise.resolve();
      active--;
      return { ...pin, review: "pass" };
    },
  });
  const work = runner(executor, { limits: { maxQueued: 1 } });
  const drain = work.drain();
  await entered.promise;
  assert.equal(work.drain(), drain);
  assert.equal(store.getTask(first)?.status, "running");
  assert.equal(store.getTask(independent)?.status, "registered");
  release.resolve();
  await drain;
  assert.equal(peak, 1);
  assert.equal(calls, 2);
  assert.equal(store.getTask(dependent)?.status, "registered");
  assert.equal(store.getTask(first)?.status, "awaiting-integration");
  const proposal = store
    .pendingIntegrations(goalId)
    .find((row) => row.kind === "integration" && row.content.taskId === first)!;
  approve(proposal);
  await work.drain();
  assert.equal(store.getTask(dependent)?.status, "registered");
  // Stage 3 owns this transition. Seed its outcome to test Stage 2 scheduling.
  const db = new Database(filename);
  db.query("UPDATE tasks SET status = 'succeeded' WHERE id = ?").run(first);
  db.close();
  await work.drain();
  assert.equal(calls, 3);
  assert.equal(store.getTask(dependent)?.status, "awaiting-integration");
});

test("pass creates one digest-bound human proposal with correlated executions", async () => {
  const goalId = goal();
  const taskId = task(goalId);
  const { executor, calls, executions } = fixture();
  const work = runner(executor);
  await work.drain();
  await work.drain();
  assert.deepEqual(calls, ["worker", "review"]);
  const [proposal, duplicate] = store.pendingIntegrations(goalId);
  assert.equal(duplicate, undefined);
  assert.ok(proposal?.kind === "integration");
  assert.deepEqual(proposal.content, {
    ...pin,
    goalId,
    taskId,
    branch: goalBranch(goalId),
    changedPaths: ["docs/a.md"],
    symlinks: [],
    verified: false,
    review: { result: "pass", notes: "Good" },
  });
  assert.equal(proposal.digest, contentDigest(proposal.content));
  assert.equal(proposal.policy, "human");
  assert.equal(store.getTask(taskId)?.status, "awaiting-integration");
  for (const [index, id] of executions.entries())
    assert.partialDeepStrictEqual(store.getExecution(id), {
      goalId,
      taskId,
      actor: index ? "Reviewer" : "Executor",
      mode: index ? "review" : "task",
      status: "succeeded",
    });
  assert.equal(store.getTask(taskId)?.attempts, 1);
  const approval = store.createExecution({
    actor: "Reviewer",
    mode: "approval",
    requestedBy: { kind: "host" },
    taskId,
  });
  store.startExecution(approval.id);
  assert.throws(
    () =>
      store.decide(proposal.id, {
        decision: "approve",
        digest: proposal.digest,
        answerer: { kind: "agent", executionId: approval.id, model },
      }),
    { code: "approval-forbidden" },
  );
  await assert.rejects(work.requestApproval(proposal.id), {
    code: "approval-forbidden",
  });
  assert.equal(approve(proposal).status, "approved");
  assert.equal(store.getTask(taskId)?.status, "awaiting-integration");
});

test("agent policy requests dedicated approval with the candidate diff under the task timeout", async () => {
  const taskId = task(goal({ integration: "agent" }), {
    budgets: { ...budgets, maxExecutionMs: 1234 },
  });
  const { executor } = fixture({
    async verify() {
      return true;
    },
  });
  let approvalId: string | undefined;
  const work = runner(executor, {
    async runReviewer(plan, id) {
      approvalId = id;
      assert.equal(plan.command.timeoutMs, 1234);
      const diff = plan.sandbox.readOnlyFiles?.find(
        (file) => file.path === "candidate.diff",
      );
      assert.equal(Buffer.from(diff!.bytes).toString(), "candidate body");
      const proposal = store.pendingIntegrations()[0]!;
      assert.throws(
        () =>
          store.decide(proposal.id, {
            digest: proposal.digest,
            decision: "approve",
            answerer: {
              kind: "agent",
              executionId: "different-execution",
              model,
            },
          }),
        { code: "approval-forbidden" },
      );
      return {
        id,
        outcome: "ok",
        response: Buffer.from(
          JSON.stringify({
            result: '{"decision":"approve","reasons":[]}',
          }),
        ),
      };
    },
  });
  await work.drain();
  assert.ok(approvalId);
  const [proposal] = store
    .listProposals({ status: "approved" })
    .filter((row) => row.kind === "integration");
  assert.ok(proposal);
  assert.partialDeepStrictEqual(store.getExecution(approvalId), {
    taskId,
    actor: "Reviewer",
    mode: "approval",
    status: "succeeded",
    result: {
      tokens: null,
      usage: "unavailable",
      maxTokens: 50,
    },
  });
  assert.equal(store.getTask(taskId)?.status, "awaiting-integration");
});

test("revision and path violations share the retry cap", async () => {
  const goalId = goal();
  const revised = task(goalId, { budgets: { ...budgets, maxRetries: 1 } });
  let checked = 0;
  const { executor, calls } = fixture({
    async changes() {
      return [
        {
          path: ++checked === 1 ? "docs-other/a.md" : "docs/a.md",
          newMode: "100644",
        },
      ];
    },
    async review(_id, observed) {
      observed.tokens = 0;
      calls.push("review");
      return { ...pin, review: "revise" };
    },
  });
  await runner(executor).drain();
  assert.deepEqual(calls, ["worker", "reject", "revise", "review"]);
  assert.equal(store.getTask(revised)?.attempts, 2);
  assert.deepEqual(failure(revised), {
    status: "failed",
    code: "revision-limit",
  });
  const denied = task(goalId, { budgets: { ...budgets, maxRetries: 0 } });
  const other = fixture({
    async changes() {
      return [{ path: "docs-other/a.md", newMode: "100644" }];
    },
  });
  await runner(other.executor).drain();
  assert.deepEqual(other.calls, ["worker", "reject"]);
  assert.deepEqual(failure(denied), {
    status: "failed",
    code: "path-violation",
  });
  assert.equal(store.pendingIntegrations().length, 0);
});

test("review concerns and timeouts still stop the task", async () => {
  const goalId = goal();
  const concerned = task(goalId);
  await runner(
    fixture({
      async review(_id, observed) {
        observed.tokens = 0;
        return { ...pin, review: "concern" };
      },
    }).executor,
  ).drain();
  assert.deepEqual(failure(concerned), {
    status: "failed",
    code: "review-concern",
  });

  const timedOut = task(goalId);
  await runner(
    fixture({
      async worker(_id, _revise, observed) {
        observed.outcome = "timed-out";
        throw new Error("guest detail");
      },
    }).executor,
  ).drain();
  assert.deepEqual(failure(timedOut), { status: "failed", code: "timed-out" });
  assert.partialDeepStrictEqual(store.getHostApiStatus().recentExecutions[0], {
    status: "timed-out",
    usage: "unavailable",
    maxTokens: 50,
  });
});

test("crossing the Task token budget emits one advisory and allows verification, review and approval", async () => {
  const taskId = task(goal({ integration: "agent" }));
  const { executor, calls } = fixture({
    async worker(_id, _revision, observed) {
      observed.tokens = 51;
      observed.usage = {
        input: 45,
        output: 1,
        cacheCreation: 2,
        cacheRead: 30,
      };
      return pin;
    },
    async verify() {
      calls.push("verify");
      return true;
    },
    async review(_id, observed) {
      calls.push("review");
      observed.tokens = 21;
      observed.usage = { input: 20, output: 1, cacheCreation: 0, cacheRead: 0 };
      return { ...pin, review: "pass" };
    },
  });
  const work = runner(executor, {
    async runReviewer(_plan, id) {
      calls.push("approve");
      return {
        id,
        outcome: "ok",
        response: Buffer.from(
          JSON.stringify({
            result: '{"decision":"approve","reasons":[]}',
            usage: {
              input_tokens: 1,
              output_tokens: 1,
              cache_creation_input_tokens: 0,
              cache_read_input_tokens: 3,
            },
          }),
        ),
      };
    },
  });
  await work.drain();
  assert.deepEqual(calls, ["verify", "review", "approve"]);
  assert.equal(store.getTask(taskId)?.status, "awaiting-integration");
  assert.equal(store.pendingIntegrations().length, 0);
  assert.deepEqual(store.taskUsage(taskId), {
    tokens: 75,
    maxTokens: 50,
    overBudget: true,
    usage: { input: 66, output: 3, cacheCreation: 2, cacheRead: 33 },
  });
  const advisories = store
    .listEvents({ subjectId: taskId, limit: 20 })
    .filter(({ kind }) => kind === "task.budget-exceeded");
  assert.equal(advisories.length, 1);
  const workerUsage = {
    tokens: 51,
    maxTokens: 50,
    overBudget: true,
    usage: { input: 45, output: 1, cacheCreation: 2, cacheRead: 30 },
  };
  assert.deepEqual(advisories[0]?.data, workerUsage);
  assert.partialDeepStrictEqual(
    store.getExecution(advisories[0]!.executionId!),
    {
      status: "succeeded",
      result: workerUsage,
    },
  );
});

function command(
  executable: string,
  cwd: string,
  args: string[],
  encoding?: "utf8",
) {
  const result = spawnSync(executable, args, {
    cwd,
    encoding,
    env: {
      PATH: "/usr/bin:/bin",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_AUTHOR_NAME: "Fixture",
      GIT_AUTHOR_EMAIL: "fixture@localhost",
      GIT_COMMITTER_NAME: "Fixture",
      GIT_COMMITTER_EMAIL: "fixture@localhost",
      COPYFILE_DISABLE: "1",
    },
  });
  assert.equal(result.status, 0, String(result.stderr));
  return result.stdout;
}

function goalBaseFixture(recordBase = true, policies?: PolicySet) {
  const repoRoot = join(root, "source");
  const directory = join(repoRoot, ".local", "local-orchestrator");
  const bare = join(directory, "repository.git");
  mkdirSync(bare, { recursive: true, mode: 0o700 });
  const git = (args: string[]) =>
    String(command("/usr/bin/git", repoRoot, args, "utf8")).trim();
  const bareGit = (args: string[]) => git([`--git-dir=${bare}`, ...args]);
  git(["init", "--template=", "--initial-branch=main"]);
  git(["commit", "--allow-empty", "-m", "old main"]);
  const base = git(["rev-parse", "HEAD"]);
  const goalId = goal(policies);
  const ref = `refs/heads/${goalBranch(goalId)}`;
  bareGit(["init", "--bare", "--template="]);
  git(["push", bare, `${base}:${ref}`]);
  if (recordBase) store.recordGoalCommit(goalId, base, "base");
  writeFileSync(join(repoRoot, "on-new-main"), "new main\n");
  git(["add", "on-new-main"]);
  git(["commit", "-m", "new main"]);
  const next = git(["rev-parse", "HEAD"]);
  git(["checkout", "-b", "work", base]);
  const phrase = `update-goal-base ${goalId} ${next.slice(0, 12)}`;
  const events = () =>
    store
      .listEvents({ subjectId: goalId, limit: 50 })
      .filter(({ kind }) => kind === "goal.base-updated");
  async function cli(
    args: string[],
    isTTY = true,
    prompt: (question: string) => string = () => phrase,
    dbOnly?: string,
  ) {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const questions: string[] = [];
    const code = await runCli(
      [
        "--db",
        dbOnly ?? filename,
        ...(dbOnly === undefined ? ["--repo", repoRoot] : []),
        ...args,
      ],
      {
        stdin: new PassThrough(),
        stdout: { write: (text) => stdout.push(text) },
        stderr: { write: (text) => stderr.push(text) },
        isTTY,
        prompt(question) {
          questions.push(question);
          return prompt(question);
        },
      },
      repoRoot,
    );
    return { code, stdout, stderr, questions };
  }
  return {
    bare,
    bareGit,
    base,
    cli,
    directory,
    events,
    git,
    goalId,
    next,
    phrase,
    ref,
    repoRoot,
    args: ["update-goal-base", goalId],
    head: () => bareGit(["rev-parse", ref]),
  };
}

test("update-goal-base confirms current local main, imports it and records the new base", async () => {
  const f = goalBaseFixture();
  const taskId = task(f.goalId);
  assert.ok(store.claimTask(taskId));
  store.failTask(taskId, "review-concern");
  const before = store.getTask(taskId);
  const nonTTY = await f.cli(f.args, false);
  assert.equal(nonTTY.code, 1);
  assert.match(nonTTY.stderr.join(""), /requires a terminal/);
  assert.deepEqual(nonTTY.questions, []);
  const wrong = await f.cli(f.args, true, () => "yes");
  assert.match(wrong.stderr.join(""), /Confirmation did not match/);
  assert.equal(f.head(), f.base);
  assert.deepEqual(f.events(), []);

  const result = await f.cli(f.args);
  assert.equal(result.code, 0, result.stderr.join(""));
  assert.deepEqual(result.questions, [`Type "${f.phrase}" to confirm: `]);
  assert.equal(f.head(), f.next);
  assert.equal(f.bareGit(["show", `${f.ref}:on-new-main`]), "new main");
  assert.equal(store.getGoal(f.goalId)?.baseCommit, f.next);
  assert.deepEqual(
    f.events().map(({ data }) => data),
    [{ from: f.base, to: f.next }],
  );
  const shown = await f.cli(["show", f.goalId], false);
  assert.equal(JSON.parse(shown.stdout.join("")).baseCommit, f.next);
  assert.deepEqual(store.getTask(taskId), before);
  const retry = await f.cli(
    ["retry-task", taskId],
    true,
    () => `retry-task ${taskId}`,
  );
  assert.equal(retry.code, 0, retry.stderr.join(""));
  assert.equal(store.getTask(taskId)?.retries, 1);
});

test("update-goal-base records the Goal branch head as the previous base for a legacy Goal", async () => {
  const f = goalBaseFixture(false);
  assert.equal(store.getGoal(f.goalId)?.baseCommit, null);
  assert.equal(store.getGoal(f.goalId)?.planningCommit, null);

  const result = await f.cli(f.args);
  assert.equal(result.code, 0, result.stderr.join(""));
  assert.deepEqual(JSON.parse(result.stdout[0]!), {
    goalId: f.goalId,
    from: f.base,
    to: f.next,
  });
  assert.equal(f.head(), f.next);
  assert.equal(store.getGoal(f.goalId)?.baseCommit, f.next);
  assert.deepEqual(
    f.events().map(({ data }) => data),
    [{ from: f.base, to: f.next, legacyBase: true }],
  );
});

test("update-goal-base refuses a legacy Goal with a rejected integration proposal", async () => {
  const f = goalBaseFixture(false);
  const taskId = task(f.goalId);
  const content = {
    ...pin,
    goalId: f.goalId,
    taskId,
    branch: goalBranch(f.goalId),
    changedPaths: ["docs/a.md"],
    symlinks: [],
    review: { result: "pass", notes: "Good" },
  };
  const db = new Database(filename);
  try {
    // Seed the proposal alone to exercise the proposal check independently
    // of the Task status history normally recorded alongside it.
    db.query(
      `INSERT INTO proposals VALUES (?, 'integration', ?, ?, '{"kind":"host"}', 'rejected', ?, ?)`,
    ).run(
      randomUUID(),
      JSON.stringify(content),
      contentDigest(content),
      new Date().toISOString(),
      new Date().toISOString(),
    );
    const refused = await f.cli(f.args);
    assert.equal(refused.code, 1);
    assert.deepEqual(refused.stderr, [
      "Goal base update refused (ineligible).\n",
    ]);
    assert.deepEqual(refused.questions, []);
    assert.deepEqual(f.events(), []);
    assert.equal(f.head(), f.base);
    assert.equal(store.getGoal(f.goalId)?.baseCommit, null);
  } finally {
    db.close();
  }
});

test("update-goal-base rechecks legacy history after confirmation", async () => {
  const f = goalBaseFixture(false);
  const taskId = task(f.goalId);
  const db = new Database(filename);
  try {
    const refused = await f.cli(f.args, true, () => {
      db.query(
        `INSERT INTO events VALUES (?, ?, 'task.status', 'task', ?, NULL, NULL, '{"status":"awaiting-integration","code":null}')`,
      ).run(randomUUID(), new Date().toISOString(), taskId);
      return f.phrase;
    });
    assert.equal(refused.code, 1);
    assert.deepEqual(refused.stderr, [
      "Goal base update refused (ineligible).\n",
    ]);
    assert.equal(f.head(), f.base);
    assert.equal(store.getGoal(f.goalId)?.baseCommit, null);
    assert.deepEqual(f.events(), []);
  } finally {
    db.close();
  }
});

test("update-goal-base refuses ineligible Goal and Task states with a fixed message", async () => {
  const f = goalBaseFixture();
  const taskId = task(f.goalId);
  const db = new Database(filename);
  async function refused(args = f.args) {
    const result = await f.cli(args);
    assert.equal(result.code, 1);
    assert.deepEqual(result.stderr, [
      "Goal base update refused (ineligible).\n",
    ]);
    assert.deepEqual(result.questions, []);
  }
  try {
    await refused(["update-goal-base", randomUUID()]);
    await refused(["update-goal-base", goal()]);
    db.query("UPDATE goals SET status = 'done' WHERE id = ?").run(f.goalId);
    await refused();
    db.query("UPDATE goals SET status = 'active' WHERE id = ?").run(f.goalId);
    for (const status of ["running", "awaiting-integration", "succeeded"]) {
      db.query("UPDATE tasks SET status = ? WHERE id = ?").run(status, taskId);
      await refused();
    }
    db.query("UPDATE tasks SET status = 'registered' WHERE id = ?").run(taskId);
    const { executor } = fixture();
    await runner(executor).drain();
    assert.equal(store.pendingIntegrations(f.goalId).length, 1);
    db.query("UPDATE tasks SET status = 'failed' WHERE id = ?").run(taskId);
    await refused();
    assert.deepEqual(f.events(), []);
    assert.equal(f.head(), f.base);
  } finally {
    db.close();
  }
});

test("update-goal-base refuses a Task claim or ref change during confirmation", async () => {
  const f = goalBaseFixture();
  const taskId = task(f.goalId);
  const claimed = await f.cli(f.args, true, () => {
    assert.ok(store.claimTask(taskId));
    return f.phrase;
  });
  assert.deepEqual(claimed.stderr, [
    "Goal base update refused (ineligible).\n",
  ]);
  assert.equal(f.head(), f.base);
  store.failTask(taskId, "review-concern");
  const changedMain = await f.cli(f.args, true, () => {
    f.git(["update-ref", "refs/heads/main", f.base, f.next]);
    return f.phrase;
  });
  assert.deepEqual(changedMain.stderr, [
    "Goal base update refused (stale-base).\n",
  ]);
  assert.equal(f.head(), f.base);
  f.git(["update-ref", "refs/heads/main", f.next, f.base]);
  f.git(["push", f.bare, `${f.next}:refs/heads/next`]);
  const changed = await f.cli(f.args, true, () => {
    f.bareGit(["update-ref", f.ref, f.next, f.base]);
    return f.phrase;
  });
  assert.deepEqual(changed.stderr, [
    "Goal base update refused (stale-base).\n",
  ]);
  assert.equal(f.head(), f.next);
  const stale = await f.cli(f.args);
  assert.deepEqual(stale.stderr, ["Goal base update refused (stale-base).\n"]);
  assert.deepEqual(stale.questions, []);
  assert.equal(store.getGoal(f.goalId)?.baseCommit, f.base);
  assert.deepEqual(f.events(), []);
});

test("Goal branch CAS refuses a different head installed immediately before Git prepares the update", async () => {
  const f = goalBaseFixture();
  const winner = f.git(["commit-tree", `${f.base}^{tree}`, "-m", "winner"]);
  f.git([
    "push",
    f.bare,
    `${winner}:refs/heads/winner`,
    `${f.next}:refs/heads/next`,
  ]);
  const binary = join(root, "racing-git");
  writeFileSync(
    binary,
    `#!/bin/sh
case " $* " in
  *" update-ref --stdin "*) /usr/bin/git "$1" update-ref ${f.ref} ${winner} ${f.base} || exit 1 ;;
esac
exec /usr/bin/git "$@"
`,
    { mode: 0o700 },
  );
  const git = new LocalGitIntegration({
    binary,
    repository: f.bare,
    stagingRoot: join(f.directory, "worktrees"),
    branch: goalBranch(f.goalId),
  });
  await assert.rejects(
    store.updateGoalBase(f.goalId, f.base, f.next, () =>
      git.updateGoalBranch(f.base, f.next),
    ),
    { code: "stale-base" },
  );
  assert.equal(f.head(), winner);
  assert.equal(store.getGoal(f.goalId)?.baseCommit, f.base);
  assert.deepEqual(f.events(), []);
});

test("update-goal-base reports recording failure after a successful ref move", async () => {
  const f = goalBaseFixture();
  const db = new Database(filename);
  try {
    db.exec(`
      CREATE TRIGGER deny_base_update BEFORE INSERT ON events
      WHEN NEW.kind = 'goal.base-updated'
      BEGIN SELECT RAISE(ABORT, 'audit failure'); END
    `);
    const result = await f.cli(f.args);
    assert.equal(result.code, 1);
    assert.match(
      result.stderr.join(""),
      /branch update completed.*recording.*failed/,
    );
    assert.equal(f.head(), f.next);
    assert.equal(store.getGoal(f.goalId)?.baseCommit, f.base);
    assert.deepEqual(f.events(), []);
  } finally {
    db.close();
  }
});

test("real Git composes tree mode, path rejection, verification, review and operator CLI", async () => {
  const repoRoot = join(root, "source");
  mkdirSync(repoRoot);
  const git = (args: string[]) =>
    String(command("/usr/bin/git", repoRoot, args, "utf8")).trim();
  git(["init", "--template=", "--initial-branch=main"]);
  mkdirSync(join(repoRoot, "docs"));
  writeFileSync(join(repoRoot, "docs", "a.md"), "before\n");
  git(["add", "."]);
  git(["commit", "-m", "initial"]);
  const base = git(["rev-parse", "HEAD"]);
  git(["checkout", "-b", "work"]);
  writeFileSync(join(repoRoot, "only-on-work"), "ignored\n");
  git(["add", "."]);
  git(["commit", "-m", "work only"]);
  const advancedMain = git([
    "commit-tree",
    base + "^{tree}",
    "-p",
    base,
    "-m",
    "main advanced",
  ]);
  git(["update-ref", "refs/heads/main", advancedMain, base]);

  const target = await resolveTarget(repoRoot, root);
  const { directory } = target;
  await prepareTargetDirectory(target.bootstrapRoot, directory);
  const scratch = join(root, "scratch");
  mkdirSync(join(scratch, "docs"), { recursive: true });
  writeFileSync(join(scratch, "docs", "a.md"), "after\n");
  const link = join(scratch, "docs", "link");
  symlinkSync("../README.md", link);
  const attack = "`printf INJECTED` $(printf INJECTED) ' \"";
  const goalId = goal();
  const taskId = task(goalId, {
    description: attack,
    budgets: { ...budgets, maxExecutionMs: 125_000 },
  });
  const calls: string[] = [];
  const invocationIds: string[] = [];
  const executor = createTaskExecutor({
    store,
    snapshotCommit: base,
    repoRoot,
    directory,
    worker: () =>
      claudeRoleHarness({
        auth: { mode: "api-key", credential: "host-secret" },
        model,
        tools: [],
        reportWorkerUsage: true,
      }),
    reviewer: harness,
    verification: configuredVerification({
      profile: "base",
      argv: ["test", "-f", "docs/passed"],
    }),
    host: {
      async runWorker(plan, id, _context, options) {
        assert.equal(plan.command.timeoutMs, 125_000);
        assert.match(
          plan.command.argv[2]!,
          /head -c 65537 \/tmp\/claude-out\.json >&2/,
        );
        options?.onWorkerStderr?.(
          Buffer.from(
            "diagnostic\n" +
              CLAUDE_WORKER_USAGE_MARKER +
              JSON.stringify({
                result: "x".repeat(10_000),
                usage: {
                  input_tokens: 1,
                  output_tokens: 1,
                  cache_read_input_tokens: 2,
                  cache_creation_input_tokens: 3,
                },
              }),
          ),
          id!,
        );
        assert.equal(
          plan.command.argv.some(
            (arg, i) => i !== 4 && arg.includes("INJECTED"),
          ),
          false,
        );
        assert.ok(plan.command.argv[4]?.includes("INJECTED"));
        invocationIds.push(id!);
        if (calls.length === 1) {
          unlinkSync(link);
          symlinkSync("a.md", link);
        }
        if (calls.length > 0) {
          const note = plan.sandbox.readOnlyFiles?.find(
            ({ path }) => path === "review-notes.txt",
          );
          assert.match(
            Buffer.from(note!.bytes).toString(),
            calls.at(-1) === "verification"
              ? /verification suite failed/
              : /outside the Task/,
          );
        }
        if (calls.at(-1) === "verification") {
          assert.deepEqual(store.pendingIntegrations(goalId), []);
          writeFileSync(join(scratch, "docs", "passed"), "");
        }
        calls.push("worker");
        return {
          id: id!,
          outcome: "ok",
          artifacts: {
            files: [],
            tree: Buffer.from(
              command("/usr/bin/tar", scratch, [
                "--format",
                "ustar",
                "-cf",
                "-",
                "docs",
              ]),
            ),
          },
        };
      },
      async runVerification(plan, id) {
        calls.push("verification");
        invocationIds.push(id!);
        assert.ok(plan.sandbox.repository);
        assert.equal(plan.sandbox.profile, "base");
        assert.equal(plan.command.timeoutMs, 125_000);
        const [binary, ...args] = plan.command.argv;
        const { tree } = plan.sandbox.repository;
        const workspace = mkdtempSync(join(root, "verify-"));
        const unpacked = spawnSync("/usr/bin/tar", ["-xf", tree], {
          cwd: workspace,
        });
        assert.equal(unpacked.status, 0, String(unpacked.stderr));
        const response = command(binary!, workspace, args);
        return {
          id: id!,
          outcome: "ok",
          response: Buffer.from(response),
        };
      },
      async runReviewer(plan, id) {
        calls.push("review");
        invocationIds.push(id!);
        assert.equal(plan.command.timeoutMs, 125_000);
        const [instructions, data, noteLimit, contract] =
          plan.command.argv[4]!.split("\n");
        assert.match(
          instructions!,
          /\/review\/candidate\.diff and \/review\/candidate\.message/,
        );
        assert.match(instructions!, /Do not edit anything/);
        assert.doesNotMatch(
          plan.command.argv[4]!,
          /\/workspace|commit message|review-notes|\/tmp\/agent-bootstrap/,
        );
        assert.deepEqual(JSON.parse(data!), {
          title: "Task",
          description: attack,
          acceptance: ["Valid docs"],
          paths: ["docs/"],
        });
        assert.equal(noteLimit, "Keep revision notes within 2048 UTF-8 bytes.");
        assert.equal(
          contract,
          'Reply with only one JSON object, no code fences, no other text: {"review":"pass"} or {"review":"revise","notes":"..."} with notes at most 1500 characters.',
        );
        assert.ok(plan.command.argv[4]!.endsWith(contract!));
        assert.ok(
          plan.sandbox.readOnlyFiles?.find(
            (file) => file.path === "candidate.diff",
          ),
        );
        return {
          id: id!,
          outcome: "ok",
          response: Buffer.from(
            JSON.stringify({
              result:
                '  ```json\n{"review":"pass","notes":"Looks good"}\n```\n',
              usage: {
                input_tokens: 5,
                output_tokens: 6,
                cache_read_input_tokens: 1,
                cache_creation_input_tokens: 1,
              },
            }),
          ),
        };
      },
    },
  });
  await runner(executor).drain();
  assert.deepEqual(
    calls,
    ["worker", "worker", "verification", "worker", "verification", "review"],
    JSON.stringify(failure(taskId)),
  );
  const [proposal] = store.pendingIntegrations(goalId);
  assert.ok(proposal?.kind === "integration");
  assert.partialDeepStrictEqual(proposal.content, {
    base,
    taskId,
    changedPaths: ["docs/a.md", "docs/link", "docs/passed"],
    symlinks: ["docs/link"],
    verified: true,
    review: { notes: "Looks good" },
  });
  assert.equal(git(["rev-parse", "main"]), advancedMain);
  assert.equal(store.getGoal(goalId)?.baseCommit, base);
  assert.partialDeepStrictEqual(
    store.listEvents({ subjectId: goalId, limit: 1 })[0],
    {
      kind: "goal.base-pinned",
      data: { baseCommit: base },
    },
  );
  const branch = String(
    command(
      "/usr/bin/git",
      join(directory, "repository.git"),
      ["rev-parse", goalBranch(goalId)],
      "utf8",
    ),
  ).trim();
  assert.equal(branch, base);
  assert.deepEqual(
    invocationIds.map((id) => store.getExecution(id)?.status),
    ["failed", "succeeded", "failed", "succeeded", "succeeded", "succeeded"],
  );

  for (const index of [2, 4]) {
    assert.partialDeepStrictEqual(store.getExecution(invocationIds[index]!), {
      taskId,
      actor: "Reviewer",
      mode: "verification",
      result: { tokens: 0 },
    });
  }
  for (const index of [0, 1, 3]) {
    assert.partialDeepStrictEqual(store.getExecution(invocationIds[index]!), {
      result: {
        tokens: 6,
        usage: { input: 1, output: 1, cacheRead: 2, cacheCreation: 3 },
      },
    });
  }
  assert.partialDeepStrictEqual(store.getExecution(invocationIds[5]!), {
    result: {
      tokens: 13,
      usage: { input: 5, output: 6, cacheRead: 1, cacheCreation: 1 },
    },
  });
  assert.equal(store.taskTokens(taskId), 31);
  let output = "";
  const io = {
    stdin: new PassThrough(),
    stdout: {
      write(text: string) {
        output += text;
      },
    },
    stderr: { write() {} },
    isTTY: true,
    prompt: () => `approve ${proposal.digest.slice(0, 12)}`,
  };
  assert.equal(await runCli(["--db", filename, "show", goalId], io), 0);
  assert.equal(JSON.parse(output).baseCommit, base);
  output = "";
  assert.equal(await runCli(["--db", filename, "show", taskId], io), 0);
  assert.partialDeepStrictEqual(JSON.parse(output), {
    budgetTokens: 31,
    totalTokens: 31,
  });
  output = "";
  assert.equal(await runCli(["--db", filename, "show", proposal.id], io), 1);
  assert.equal(
    await runCli(
      ["--db", filename, "--target", repoRoot, "show", proposal.id],
      io,
      root,
    ),
    0,
  );
  assert.deepEqual(JSON.parse(output).content.changedPaths, [
    "docs/a.md",
    "docs/link",
    "docs/passed",
  ]);
  assert.match(JSON.parse(output).diffStat, /docs\/a\.md/);
  assert.equal(
    await runCli(
      ["--db", filename, "--target", repoRoot, "approve", proposal.id],
      io,
      root,
    ),
    0,
  );
  assert.equal(store.getProposal(proposal.id)?.status, "approved");
  assert.equal(store.getTask(taskId)?.status, "awaiting-integration");

  assert.equal(
    await runCli(
      ["--db", filename, "--target", repoRoot, "export-goal-branch", goalId],
      {
        ...io,
        prompt: () => `export-goal-branch ${goalId} ${base.slice(0, 12)}`,
      },
      root,
    ),
    0,
  );
  assert.equal(git(["rev-parse", goalBranch(goalId)]), base);
  assert.equal(existsSync(join(repoRoot, ".local")), false);

  command("/usr/bin/git", join(directory, "repository.git"), [
    "update-ref",
    "refs/heads/" + goalBranch(goalId),
    proposal.content.candidate,
    base,
  ]);
  await assert.rejects(executor.open(store.getTask(taskId)!), {
    message: "goal-base-mismatch",
  });

  renameSync(join(repoRoot, ".git"), join(root, "retired-git"));
  const pinned = await snapshotConciergeRepo(
    repoRoot,
    randomUUID(),
    base,
    true,
    target,
  );
  assert.equal(pinned.commit, base);
  assert.equal(
    readFileSync(join(pinned.dir, "docs", "a.md"), "utf8"),
    "before\n",
  );
});

test("strict review concerns retain raw answers and operator retries start fresh journals", async () => {
  const repoRoot = join(root, "source");
  const directory = join(root, "runtime");
  mkdirSync(repoRoot);
  mkdirSync(directory, { mode: 0o700 });
  const git = (args: string[]) => command("/usr/bin/git", repoRoot, args);
  git(["init", "--template=", "--initial-branch=main"]);
  const docs = join(repoRoot, "docs");
  mkdirSync(docs);
  const file = join(docs, "a.md");
  writeFileSync(file, "before\n");
  git(["add", "."]);
  git(["commit", "-m", "initial"]);
  writeFileSync(file, "after\n");
  const tree = Buffer.from(
    command("/usr/bin/tar", repoRoot, [
      "--format",
      "ustar",
      "-cf",
      "-",
      "docs",
    ]),
  );
  const taskId = task(goal());
  const prose = 'Here is the verdict: {"review":"pass"}'.padEnd(4094, "x");
  const longNotes = JSON.stringify({
    review: "revise",
    notes: "é".repeat(1100),
  });
  const answers = [prose + "😀", longNotes, '\n```\n{"review":"pass"}\n```  '];
  const reviewerIds: string[] = [];
  const claudeResult = (result: string) =>
    JSON.stringify({
      result,
      usage: {
        input_tokens: 1,
        output_tokens: 1,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
    });
  const executor = createTaskExecutor({
    store,
    repoRoot,
    directory,
    worker: () => harness,
    reviewer: harness,
    host: {
      async runWorker(_plan, id, _context, options) {
        options?.onWorkerStderr?.(
          Buffer.from("\n" + CLAUDE_WORKER_USAGE_MARKER + claudeResult("done")),
          id!,
        );
        return { id: id!, outcome: "ok", artifacts: { files: [], tree } };
      },
      async runReviewer(_plan, id) {
        const answer = answers[reviewerIds.length]!;
        reviewerIds.push(id!);
        return {
          id: id!,
          outcome: "ok",
          response: Buffer.from(claudeResult(answer)),
        };
      },
      async runVerification() {
        throw new Error("unexpected verification");
      },
    },
  });
  const work = runner(executor);
  for (const [index, rawAnswer] of [prose, longNotes].entries()) {
    await work.drain();
    assert.deepEqual(failure(taskId), {
      status: "failed",
      code: "review-concern",
    });
    assert.partialDeepStrictEqual(store.getExecution(reviewerIds[index]!), {
      status: "failed",
      result: { review: "concern", rawAnswer },
    });
    store.retryTask(taskId, index);
  }
  await work.drain();
  assert.equal(store.getTask(taskId)?.status, "awaiting-integration");
  const lastReview = store.getExecution(reviewerIds[2]!);
  assert.partialDeepStrictEqual(lastReview, {
    status: "succeeded",
    result: { review: "pass" },
  });
  assert.equal(Object.hasOwn(lastReview?.result as object, "rawAnswer"), false);
  assert.equal(store.taskTokens(taskId), 12);
  assert.equal(store.getExecution(reviewerIds[0]!)?.status, "failed");
});

test("opens a populated Stage 1 database and migrates its proposal and task checks", async () => {
  filename = join(root, "stage1.db");
  writeFileSync(filename, "", { mode: 0o600 });
  const db = new Database(filename);
  db.exec(`PRAGMA application_id=0x4c4f5231;

  CREATE TABLE project_policy (
    id INTEGER PRIMARY KEY CHECK (id = 1), policies_json TEXT NOT NULL
  ) STRICT;
  INSERT INTO project_policy VALUES (1, '{"goal-registration":"human","task-registration":"human","integration":"human"}');
  CREATE TABLE proposals (
    id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN ('goal', 'task')),
    content_json TEXT NOT NULL, digest TEXT NOT NULL, source_json TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected', 'registered')),
    created_at TEXT NOT NULL, decided_at TEXT
  ) STRICT;
  CREATE TABLE goals (
    id TEXT PRIMARY KEY, proposal_id TEXT NOT NULL UNIQUE REFERENCES proposals(id),
    content_json TEXT NOT NULL, digest TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('active', 'done', 'cancelled')), created_at TEXT NOT NULL
  ) STRICT;
  CREATE TABLE tasks (
    id TEXT PRIMARY KEY, goal_id TEXT NOT NULL REFERENCES goals(id),
    proposal_id TEXT NOT NULL UNIQUE REFERENCES proposals(id),
    content_json TEXT NOT NULL, digest TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('registered', 'running', 'succeeded', 'failed', 'cancelled')),
    attempts INTEGER NOT NULL CHECK (attempts >= 0), created_at TEXT NOT NULL
  ) STRICT;
  CREATE INDEX tasks_goal ON tasks(goal_id);
  CREATE TABLE approvals (
    id TEXT PRIMARY KEY, proposal_id TEXT NOT NULL UNIQUE REFERENCES proposals(id),
    gate TEXT NOT NULL CHECK (gate IN ('goal-registration', 'task-registration', 'integration')),
    digest TEXT NOT NULL, policy TEXT NOT NULL CHECK (policy IN ('human', 'agent')),
    policy_source TEXT NOT NULL CHECK (policy_source IN ('default', 'request', 'goal', 'task')),
    answerer_kind TEXT NOT NULL CHECK (answerer_kind IN ('human', 'agent')), answerer_json TEXT NOT NULL,
    decision TEXT NOT NULL CHECK (decision IN ('approve', 'reject')), at TEXT NOT NULL
  ) STRICT;
  CREATE TABLE executions (
    id TEXT PRIMARY KEY, actor TEXT NOT NULL, mode TEXT NOT NULL, requested_by_json TEXT NOT NULL,
    goal_id TEXT REFERENCES goals(id), task_id TEXT REFERENCES tasks(id),
    status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'timed-out', 'cancelled')),
    result_json TEXT, started_at TEXT, finished_at TEXT
  ) STRICT;
  CREATE TABLE actor_sessions (
    id TEXT PRIMARY KEY, actor TEXT NOT NULL, runtime_id TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('active', 'ended')), started_at TEXT NOT NULL, ended_at TEXT
  ) STRICT;
  CREATE TABLE events (
    id TEXT PRIMARY KEY, at TEXT NOT NULL, kind TEXT NOT NULL, subject_kind TEXT NOT NULL,
    subject_id TEXT NOT NULL, session_id TEXT, execution_id TEXT,
    data TEXT NOT NULL CHECK (length(CAST(data AS BLOB)) <= 4096 AND json_valid(data))
  ) STRICT;
  CREATE INDEX events_subject ON events(subject_id);
  CREATE TRIGGER events_no_update BEFORE UPDATE ON events BEGIN SELECT RAISE(ABORT, 'append-only'); END;
  CREATE TRIGGER events_no_delete BEFORE DELETE ON events BEGIN SELECT RAISE(ABORT, 'append-only'); END;
  CREATE TRIGGER events_no_replace BEFORE INSERT ON events
    WHEN EXISTS (SELECT 1 FROM events WHERE id = NEW.id OR rowid = NEW.rowid)
    BEGIN SELECT RAISE(ABORT, 'append-only'); END;
`);
  const goalId = "aaaaaaaa-0000-4000-8000-000000000000";
  const taskId = "bbbbbbbb-0000-4000-8000-000000000000";
  const oldTask = {
    goalId,
    title: "Migrated task",
    description: "",
    acceptance: ["Valid docs"],
    actor: "Executor",
    profile: "base",
    paths: ["docs/"],
    dependsOn: [],
    budgets,
  };
  const oldGoal = {
    title: "Migrated goal",
    description: "",
    acceptance: ["Valid docs"],
    scope: {
      paths: ["docs/"],
      profiles: ["base"],
      actors: ["Executor"],
      maxTasks: 8,
      budgets,
    },
  };
  const seed = db.query(
    "INSERT INTO proposals VALUES (?, ?, ?, ?, '{\"kind\":\"operator\"}', 'registered', 'before', 'before')",
  );
  seed.run(
    "goal-proposal",
    "goal",
    JSON.stringify(oldGoal),
    contentDigest(oldGoal),
  );
  seed.run(
    "task-proposal",
    "task",
    JSON.stringify(oldTask),
    contentDigest(oldTask),
  );
  db.query(
    "INSERT INTO goals VALUES (?, 'goal-proposal', ?, ?, 'active', 'before')",
  ).run(goalId, JSON.stringify(oldGoal), contentDigest(oldGoal));
  db.query(
    "INSERT INTO tasks VALUES (?, ?, 'task-proposal', ?, ?, 'registered', 0, 'before')",
  ).run(taskId, goalId, JSON.stringify(oldTask), contentDigest(oldTask));
  db.query(
    "INSERT INTO executions VALUES ('old-execution', 'Executor', 'task', '{\"kind\":\"host\"}', ?, ?, 'failed', NULL, NULL, NULL)",
  ).run(goalId, taskId);
  assert.throws(() =>
    db.exec("UPDATE tasks SET status = 'awaiting-integration'"),
  );
  assert.throws(() => db.exec("UPDATE proposals SET kind = 'integration'"));
  db.close();
  store.close();
  store = OrchestratorStore.open(filename);
  assert.equal(store.getExecution("old-execution")?.taskId, taskId);
  await runner(fixture().executor).drain();
  assert.equal(store.getTask(taskId)?.status, "awaiting-integration");
  assert.equal(store.pendingIntegrations(goalId).length, 1);
  store.close();
  store = OrchestratorStore.open(filename);
  const upgraded = new Database(filename);
  assert.deepEqual(upgraded.query("PRAGMA foreign_key_check").all(), []);
  assert.throws(() =>
    upgraded.exec("UPDATE tasks SET status = 'unrecognized'"),
  );
  assert.throws(() =>
    upgraded.exec("UPDATE proposals SET kind = 'unrecognized'"),
  );
  upgraded.close();
});

test("out-of-scope symlink targets fail before review and in-scope links require a human", async () => {
  const goalId = goal({ integration: "agent" });
  const denied = task(goalId, { budgets: { ...budgets, maxRetries: 0 } });
  const unsafe = fixture({
    async changes() {
      return [{ path: "docs/link", newMode: "120000", target: "../README.md" }];
    },
  });
  await runner(unsafe.executor).drain();
  assert.deepEqual(unsafe.calls, ["worker", "reject"]);
  assert.deepEqual(failure(denied), {
    status: "failed",
    code: "path-violation",
  });

  task(goalId);
  const safe = fixture({
    async verify() {
      return true;
    },
    async changes() {
      return [{ path: "docs/sub/link", newMode: "120000", target: "../a.md" }];
    },
  });
  const work = runner(safe.executor);
  await work.drain();
  const [proposal] = store.pendingIntegrations();
  assert.ok(proposal?.kind === "integration");
  assert.deepEqual(proposal.content.symlinks, ["docs/sub/link"]);
  assert.equal(
    store.getProposalDetails(proposal.id)?.humanAnswerRequired,
    true,
  );
  await assert.rejects(work.requestApproval(proposal.id), {
    code: "approval-forbidden",
  });
  const approval = store.createExecution({
    actor: "Reviewer",
    mode: "approval",
    requestedBy: { kind: "host" },
    taskId: proposal.content.taskId,
  });
  store.startExecution(approval.id);
  for (const decision of ["approve", "reject"] as const) {
    assert.throws(
      () =>
        store.decide(proposal.id, {
          decision,
          digest: proposal.digest,
          answerer: { kind: "agent", executionId: approval.id, model },
        }),
      { code: "approval-forbidden" },
    );
  }
  assert.equal(approve(proposal).status, "approved");
});

test("missing Task usage is advisory and retries reset the window but preserve history", async () => {
  const goalId = goal();
  const unknown = task(goalId);
  const missing = fixture({
    async worker() {
      return pin;
    },
  });
  await runner(missing.executor).drain();
  assert.equal(store.getTask(unknown)?.status, "awaiting-integration");
  assert.deepEqual(missing.calls, ["review"]);
  assert.partialDeepStrictEqual(store.taskUsage(unknown), {
    tokens: 0,
    maxTokens: 50,
    usage: "unavailable",
  });
  assert.equal(store.taskUsage(unknown).overBudget, undefined);
  assert.partialDeepStrictEqual(store.getHostApiStatus().recentExecutions[1], {
    status: "succeeded",
    tokens: null,
    usage: "unavailable",
  });

  const rerunGoal = goal({ integration: "agent" });
  const rerun = task(rerunGoal);
  assert.ok(store.claimTask(rerun));
  const prior = store.createExecution({
    actor: "Executor",
    mode: "task",
    taskId: rerun,
    requestedBy: { kind: "host" },
  });
  store.startExecution(prior.id);
  store.finishExecution(prior.id, "failed", { tokens: 51 });
  store.failTask(rerun, "host-error");
  assert.equal(store.taskBudgetTokens(rerun), 51);
  store.retryTask(rerun, 0);
  assert.equal(store.taskBudgetTokens(rerun), 0);
  const next = fixture({
    async verify() {
      return true;
    },
    async worker(_id, _revise, observed) {
      observed.tokens = 2;
      return pin;
    },
  });
  const work = runner(next.executor, {
    async runReviewer(_plan, id) {
      return {
        id,
        outcome: "ok",
        response: Buffer.from(
          JSON.stringify({
            result: '{"decision":"approve","reasons":[]}',
            usage: {
              input_tokens: 1,
              output_tokens: 1,
              cache_read_input_tokens: 409,
              cache_creation_input_tokens: 0,
            },
          }),
        ),
      };
    },
  });
  await work.drain();
  assert.equal(store.getTask(rerun)?.status, "awaiting-integration");
  const approved = store
    .listProposals({ status: "approved" })
    .find(
      (proposal) =>
        proposal.kind === "integration" && proposal.content.taskId === rerun,
    );
  assert.ok(approved);
  assert.equal(store.taskBudgetTokens(rerun), 45);
  assert.equal(store.taskTokens(rerun), 96);
  assert.deepEqual(next.calls, ["review"]);
});

test("a late completion contributes to its original retry window", () => {
  const taskId = task(goal());
  const begin = () => {
    const { id } = store.createExecution({
      actor: "Executor",
      mode: "task",
      taskId,
      requestedBy: { kind: "host" },
    });
    store.startExecution(id);
    return id;
  };
  const finish = (id: string, tokens: number) =>
    store.finishExecution(id, "succeeded", {
      tokens,
      usage: { input: tokens, output: 0, cacheCreation: 0, cacheRead: 0 },
    });
  assert.ok(store.claimTask(taskId));
  finish(begin(), 50);
  assert.equal(store.taskUsage(taskId).overBudget, false);
  const late = begin();
  store.failTask(taskId, "host-error");
  store.retryTask(taskId, 0);
  assert.ok(store.claimTask(taskId));
  const current = begin();
  finish(current, 51);
  finish(late, 2);
  finish(begin(), 1);

  assert.equal(store.taskUsage(taskId).tokens, 52);
  assert.deepEqual(
    store
      .listEvents({ subjectId: taskId, limit: 20 })
      .filter(({ kind }) => kind === "task.budget-exceeded")
      .map(({ executionId, data }) => ({ executionId, data })),
    [
      {
        executionId: late,
        data: {
          tokens: 52,
          maxTokens: 50,
          overBudget: true,
          usage: { input: 52, output: 0, cacheCreation: 0, cacheRead: 0 },
        },
      },
      {
        executionId: current,
        data: {
          tokens: 51,
          maxTokens: 50,
          overBudget: true,
          usage: { input: 51, output: 0, cacheCreation: 0, cacheRead: 0 },
        },
      },
    ],
  );
});

test("a failed integration approval allows one retry even with missing usage", async () => {
  const taskId = task(goal({ integration: "agent" }));
  const { executor } = fixture({
    async verify() {
      return true;
    },
  });
  const calls: string[] = [];
  const work = runner(executor, {
    async runReviewer(_plan, id) {
      calls.push(id);
      return {
        id,
        outcome: "ok",
        response: Buffer.from(
          JSON.stringify({
            result: "invalid verdict",
            ...(calls.length === 1
              ? {}
              : {
                  usage: {
                    input_tokens: 1,
                    output_tokens: 1,
                    cache_read_input_tokens: 3,
                    cache_creation_input_tokens: 0,
                  },
                }),
          }),
        ),
      };
    },
  });
  await work.drain();
  await work.drain();
  assert.equal(calls.length, 2);
  assert.partialDeepStrictEqual(store.getExecution(calls[0]!), {
    status: "failed",
    result: {
      code: "contract-violation",
      tokens: null,
      usage: "unavailable",
      rawAnswer: "invalid verdict",
    },
  });
  assert.partialDeepStrictEqual(store.getExecution(calls[1]!), {
    status: "failed",
    result: {
      code: "contract-violation",
      tokens: 3,
      usage: { input: 1, output: 1, cacheRead: 3, cacheCreation: 0 },
      rawAnswer: "invalid verdict",
    },
  });
  const [proposal] = store.pendingIntegrations();
  assert.ok(proposal);
  await assert.rejects(work.requestApproval(proposal.id), {
    code: "invalid-transition",
  });
  assert.equal(store.taskTokens(taskId), 3);
});

test("approval keeps usage when a human answers while the Reviewer runs", async () => {
  const taskId = task(goal({ integration: "agent" }));
  const { executor } = fixture({
    async verify() {
      return true;
    },
  });
  let approvalId: string | undefined;
  const work = runner(executor, {
    async runReviewer(_plan, id) {
      approvalId = id;
      const [proposal] = store.pendingIntegrations();
      assert.ok(proposal);
      assert.equal(approve(proposal).status, "approved");
      return {
        id,
        outcome: "ok",
        response: Buffer.from(
          JSON.stringify({
            result: '{"decision":"approve","reasons":[]}',
            usage: {
              input_tokens: 1,
              output_tokens: 2,
              cache_read_input_tokens: 31,
              cache_creation_input_tokens: 4,
            },
          }),
        ),
      };
    },
  });
  await work.drain();
  assert.ok(approvalId);
  assert.partialDeepStrictEqual(store.getExecution(approvalId), {
    status: "failed",
    result: {
      code: "invalid-transition",
      tokens: 11,
      usage: { input: 1, output: 2, cacheRead: 31, cacheCreation: 4 },
    },
  });
  assert.equal(store.taskBudgetTokens(taskId), 11);
  assert.equal(store.taskTokens(taskId), 11);
});

function stage3Fixture(
  policies?: PolicySet,
  verification?: "pass" | "deny-integration",
  runnerOverrides?: Parameters<typeof runner>[1],
) {
  const f = goalBaseFixture(true, policies);
  const taskId = task(f.goalId);
  const scratch = join(root, "candidate");
  mkdirSync(join(scratch, "docs"), { recursive: true });
  let workers = 0;
  let verifications = 0;
  const executor = createTaskExecutor({
    repoRoot: f.repoRoot,
    directory: f.directory,
    store,
    worker: () => harness,
    reviewer: harness,
    ...(verification
      ? { verification: { command: { argv: ["verify"], timeoutMs: 1000 } } }
      : {}),
    host: {
      async runWorker(_plan, id) {
        writeFileSync(join(scratch, "docs/a.md"), `Candidate ${++workers}\n`);
        return {
          id: id!,
          outcome: "ok",
          artifacts: {
            files: [],
            tree: Buffer.from(
              command("/usr/bin/tar", scratch, [
                "--format",
                "ustar",
                "-cf",
                "-",
                "docs",
              ]),
            ),
          },
        };
      },
      async runReviewer(_plan, id) {
        return {
          id: id!,
          outcome: "ok",
          response: Buffer.from(
            JSON.stringify({ result: '{"review":"pass"}' }),
          ),
        };
      },
      async runVerification(_plan, id) {
        verifications++;
        return {
          id: id!,
          outcome: "ok",
          response: Buffer.from(
            JSON.stringify({
              review:
                verification === "deny-integration" && verifications === 2
                  ? "revise"
                  : "pass",
            }),
          ),
        };
      },
    },
  });
  const journal = new IntegrationJournal(
    join(f.directory, "integrations", taskId),
    taskId,
  );
  const work = runner(executor, runnerOverrides);
  return {
    ...f,
    taskId,
    work,
    journal,
    verifications: () => verifications,
    async proposal() {
      await work.drain();
      const proposal = store
        .pendingIntegrations()
        .find(
          ({ kind, content }) =>
            kind === "integration" &&
            "taskId" in content &&
            content.taskId === taskId,
        );
      assert.ok(
        proposal?.kind === "integration",
        JSON.stringify(failure(taskId)),
      );
      return proposal;
    },
  };
}

test("integrates a verified approval and uses its committed head for a dependent", async () => {
  const f = stage3Fixture(undefined, "pass");
  const dependent = task(f.goalId, { dependsOn: [f.taskId] });
  const proposal = await f.proposal();
  assert.equal(proposal.content.verified, true);
  assert.equal(store.getTask(dependent)?.status, "registered");

  approve(proposal);
  await f.work.drain();
  assert.equal(f.verifications(), 3); // Review both pins and integrate the first.
  assert.equal(f.head(), proposal.content.candidate);
  assert.equal(store.getTask(f.taskId)?.status, "succeeded");
  const event = store.listEvents({ subjectId: f.taskId, limit: 1 })[0];
  assert.equal(event?.kind, "task.integrated");
  assert.deepEqual(event?.data, {
    proposalId: proposal.id,
    branch: goalBranch(f.goalId),
    base: f.base,
    head: proposal.content.candidate,
  });
  const [approval] = store.listEvents({ subjectId: proposal.id, limit: 1 });
  assert.ok(approval);
  const decision = (await f.journal.read()).find(
    ({ kind }) => kind === "human.decided",
  );
  assert.ok(decision?.kind === "human.decided");
  assert.equal(decision.answererKind, "human");
  assert.equal(decision.delegated, false);
  assert.equal(
    decision.approvalId,
    (approval.data as { approvalId: string }).approvalId,
  );
  const [next] = store.pendingIntegrations();
  assert.ok(next?.kind === "integration");
  assert.equal(next.content.taskId, dependent);
  assert.equal(next.content.base, proposal.content.candidate);
  assert.equal(store.getGoal(f.goalId)?.baseCommit, f.base);
  await f.work.drain();
  assert.equal(f.verifications(), 3);
});

test("integration verification denial fails the Task before moving the branch", async () => {
  const f = stage3Fixture(undefined, "deny-integration");
  const proposal = await f.proposal();
  approve(proposal);
  await f.work.drain();
  assert.equal(f.verifications(), 2);
  assert.equal(f.head(), f.base);
  assert.deepEqual(failure(f.taskId), {
    status: "failed",
    code: "verification",
  });
});

test("a deterministic M5 decision failure leaves the Goal schedulable", async () => {
  const f = stage3Fixture();
  const proposal = await f.proposal();
  const dependent = task(f.goalId);
  const events = await f.journal.read();
  await f.journal.append(events.length, { kind: "denied", reason: "evidence" });
  approve(proposal);
  await f.work.drain();
  assert.deepEqual(failure(f.taskId), {
    status: "failed",
    code: "integration-evidence",
  });
  assert.equal(f.head(), f.base);
  assert.equal(store.getTask(dependent)?.status, "awaiting-integration");
  assert.equal((await f.journal.read()).at(-1)?.kind, "denied");
});

test("runner skips raced integrations and processes another Goal in the same drain", async () => {
  const codes = [
    "invalid-transition",
    "goal-inactive",
    "integration-uncertain",
  ] as const;
  for (let i = 0; i <= codes.length; i++) task(goal());
  const { executor } = fixture();
  await runner(executor).drain();
  const proposals = store.pendingIntegrations();
  assert.equal(proposals.length, codes.length + 1);
  for (const proposal of proposals) approve(proposal);
  const calls: string[] = [];
  await runner({
    ...executor,
    async integrate(id) {
      calls.push(id);
      const index = proposals.findIndex((proposal) => proposal.id === id);
      const code = codes[index];
      if (code) throw new OrchestratorStoreError(code);
      store.rejectApprovedIntegration(id, "integration-evidence");
    },
  }).drain();
  assert.deepEqual(
    calls,
    proposals.map(({ id }) => id),
  );
});

test("a verified agent approval records the agent answer in M5", async () => {
  const f = stage3Fixture({ integration: "agent" }, "pass", {
    async runReviewer(_plan, id) {
      return {
        id,
        outcome: "ok",
        response: Buffer.from(
          JSON.stringify({
            result: '{"decision":"approve","reasons":[]}',
          }),
        ),
      };
    },
  });
  await f.work.drain();
  assert.equal(store.getTask(f.taskId)?.status, "succeeded");
  assert.partialDeepStrictEqual(
    (await f.journal.read()).find(({ kind }) => kind === "human.decided"),
    { answererKind: "agent", delegated: false },
  );
});

test("a legacy unverified proposal can be approved and integrated without a rewrite", async () => {
  const f = stage3Fixture();
  const proposal = await f.proposal();
  const { verified: _verified, ...content } = proposal.content;
  const digest = contentDigest(content);
  const db = new Database(filename);
  try {
    db.query(
      "UPDATE proposals SET content_json = ?, digest = ? WHERE id = ?",
    ).run(JSON.stringify(content), digest, proposal.id);
  } finally {
    db.close();
  }
  approve({ id: proposal.id, digest });
  await f.work.drain();
  assert.equal(f.verifications(), 0);
  assert.equal(f.head(), proposal.content.candidate);
  assert.equal(store.getTask(f.taskId)?.status, "succeeded");
});

test("unverified integration refuses an agent answer and accepts a delegated human", async () => {
  const f = stage3Fixture({ integration: "agent" });
  const proposal = await f.proposal();
  assert.equal(proposal.content.verified, false);
  assert.equal(proposal.policy, "agent");
  await assert.rejects(f.work.requestApproval(proposal.id), {
    code: "approval-forbidden",
  });
  const approval = store.createExecution({
    actor: "Reviewer",
    mode: "approval",
    taskId: f.taskId,
    requestedBy: { kind: "host" },
  });
  store.startExecution(approval.id);
  assert.throws(
    () =>
      store.decide(proposal.id, {
        decision: "approve",
        digest: proposal.digest,
        answerer: { kind: "agent", executionId: approval.id, model },
      }),
    { code: "approval-forbidden" },
  );
  store.finishExecution(approval.id, "failed", { code: "approval-forbidden" });
  store.decide(proposal.id, {
    decision: "approve",
    digest: proposal.digest,
    answerer: {
      kind: "human",
      delegate: {
        agent: "claude-code",
        session: "session-1",
        authorization: "operator approved",
      },
    },
  });
  await f.work.drain();
  assert.equal(f.verifications(), 0);
  assert.equal(f.head(), proposal.content.candidate);
  assert.equal(store.getTask(f.taskId)?.status, "succeeded");
  assert.partialDeepStrictEqual(
    (await f.journal.read()).find(({ kind }) => kind === "human.decided"),
    { answererKind: "human", delegated: true },
  );
});

for (const mismatch of [
  "approval digest",
  "candidate",
  "base",
  "paths",
  "stale-base",
]) {
  test(`approved integration refuses ${mismatch} before the M5 decision`, async () => {
    const f = stage3Fixture();
    const proposal = await f.proposal();
    const events = await f.journal.read();
    approve(proposal);
    const db = new Database(filename);
    try {
      if (mismatch === "stale-base") {
        f.git(["push", f.bare, `${f.next}:${f.ref}`]);
      } else if (mismatch === "approval digest") {
        db.query("UPDATE approvals SET digest = ? WHERE proposal_id = ?").run(
          "0".repeat(64),
          proposal.id,
        );
      } else {
        const content = {
          ...proposal.content,
          ...(mismatch === "candidate" && { candidate: "0".repeat(40) }),
          ...(mismatch === "base" && { base: f.next }),
          ...(mismatch === "paths" && { changedPaths: ["docs/other.md"] }),
        };
        const digest = contentDigest(content);
        db.query(
          "UPDATE proposals SET content_json = ?, digest = ? WHERE id = ?",
        ).run(JSON.stringify(content), digest, proposal.id);
        db.query("UPDATE approvals SET digest = ? WHERE proposal_id = ?").run(
          digest,
          proposal.id,
        );
      }
    } finally {
      db.close();
    }
    await f.work.drain();
    assert.deepEqual(await f.journal.read(), events);
    assert.equal(f.head(), mismatch === "stale-base" ? f.next : f.base);
    assert.deepEqual(failure(f.taskId), {
      status: "failed",
      code:
        mismatch === "stale-base"
          ? mismatch
          : mismatch === "approval digest"
            ? "stale-digest"
            : "candidate-mismatch",
    });
  });
}

test("an earlier approval cannot consume a retried Task's proposal", async () => {
  const f = stage3Fixture();
  const first = await f.proposal();
  approve(first);
  f.git(["push", f.bare, `${f.next}:${f.ref}`]);
  await f.work.drain();
  assert.equal(store.getTask(f.taskId)?.status, "failed");
  f.bareGit(["update-ref", f.ref, f.base, f.next]);
  store.retryTask(f.taskId, 0);

  const second = await f.proposal();
  assert.notEqual(first.id, second.id);
  assert.equal(store.getTask(f.taskId)?.status, "awaiting-integration");
  assert.equal(f.head(), f.base);
  approve(second);
  await f.work.drain();
  assert.equal(store.getTask(f.taskId)?.status, "succeeded");
  assert.equal(f.head(), second.content.candidate);
});

for (const updated of [false, true]) {
  test(`an uncertain integration pauses its Goal and reconcile handles ${updated ? "an advanced ref" : "an unchanged ref"}`, async () => {
    const f = stage3Fixture();
    const proposal = await f.proposal();
    const next = task(f.goalId);
    approve(proposal);
    const lock = join(f.bare, f.ref + ".lock");
    writeFileSync(lock, "");
    await f.work.drain();
    unlinkSync(lock);
    assert.equal(
      (await f.journal.read()).at(-1)?.kind,
      "integration.uncertain",
    );
    assert.equal(store.getTask(f.taskId)?.code, "integration-uncertain");
    assert.equal(store.getTask(next)?.status, "registered");

    if (updated)
      f.bareGit(["update-ref", f.ref, proposal.content.candidate, f.base]);
    const result = await f.cli(["reconcile"], true, () => "reconcile 1");
    assert.equal(result.code, 0, result.stderr.join(""));
    assert.equal(
      store.getTask(f.taskId)?.status,
      updated ? "succeeded" : "failed",
    );
    await f.work.drain();
    assert.equal(store.getTask(next)?.status, "awaiting-integration");
  });
}

test("export creates and fast-forwards only the local Goal ref and refuses divergence", async () => {
  const f = stage3Fixture();
  const proposal = await f.proposal();
  const branch = goalBranch(f.goalId);
  const checkout = join(root, "operator");
  f.git(["worktree", "add", "--detach", checkout, f.base]);
  const operator = (args: string[]) =>
    String(command("/usr/bin/git", checkout, args, "utf8")).trim();
  const args = ["export-goal-branch", f.goalId, "--repo", checkout];
  const exportAt = (to: string) =>
    f.cli(
      args,
      true,
      () => `export-goal-branch ${f.goalId} ${to.slice(0, 12)}`,
    );
  const initialHead = operator(["rev-parse", "HEAD"]);
  const dirty = join(checkout, "operator.txt");
  writeFileSync(dirty, "preserve me\n");
  assert.match(
    (await f.cli(args, false)).stderr.join(""),
    /requires a terminal/,
  );
  assert.match(
    (await f.cli(args, true, () => "yes")).stderr.join(""),
    /Confirmation did not match/,
  );

  const hook = join(f.repoRoot, ".git", "reference-transaction");
  writeFileSync(hook, "#!/bin/sh\nexit 99\n", { mode: 0o700 });
  f.git(["config", "core.hooksPath", join(f.repoRoot, ".git")]);
  const created = await exportAt(f.base);
  assert.equal(created.code, 0, created.stderr.join(""));
  assert.match(created.stdout.join(""), /open a pull request to main/);
  assert.equal(operator(["rev-parse", f.ref]), f.base);

  approve(proposal);
  await f.work.drain();
  const advanced = await exportAt(proposal.content.candidate);
  assert.equal(advanced.code, 0, advanced.stderr.join(""));
  assert.equal(operator(["show", `${branch}:docs/a.md`]), "Candidate 1");
  assert.equal(operator(["rev-parse", f.ref]), proposal.content.candidate);
  assert.equal(operator(["rev-parse", "HEAD"]), initialHead);
  assert.equal(operator(["rev-parse", "main"]), f.next);
  assert.equal(readFileSync(dirty, "utf8"), "preserve me\n");
  assert.deepEqual(
    store
      .listEvents({ subjectId: f.goalId, limit: 50 })
      .filter(({ kind }) => kind === "goal.exported")
      .map(({ data }) => data),
    [
      { branch, from: f.base, to: proposal.content.candidate },
      { branch, from: null, to: f.base },
    ],
  );

  operator(["-c", "core.hooksPath=/dev/null", "update-ref", f.ref, f.next]);
  const refused = await exportAt(proposal.content.candidate);
  assert.equal(refused.code, 1);
  assert.match(refused.stderr.join(""), /non-fast-forward/);
  assert.equal(operator(["rev-parse", f.ref]), f.next);
  operator(["-c", "core.hooksPath=/dev/null", "switch", branch]);
  const checkedOut = await exportAt(proposal.content.candidate);
  assert.equal(checkedOut.code, 1);
  assert.match(checkedOut.stderr.join(""), /branch-checked-out/);
});

test("export refuses an unaudited private head before and after confirmation", async () => {
  const f = stage3Fixture();
  const proposal = await f.proposal();
  approve(proposal);
  await f.work.drain();
  const head = proposal.content.candidate;
  const args = ["export-goal-branch", f.goalId];
  const setHead = (to: string) => f.bareGit(["update-ref", f.ref, to]);
  const reply = () => `export-goal-branch ${f.goalId} ${head.slice(0, 12)}`;
  const unusedDb = join(root, "unused-export.db");
  const missingRepo = await f.cli(
    [...args, "--repo", f.repoRoot],
    true,
    reply,
    unusedDb,
  );
  assert.equal(missingRepo.code, 1);
  assert.match(
    missingRepo.stderr.join(""),
    /custom --db, pass --target for the launcher target/,
  );
  assert.deepEqual(missingRepo.questions, []);
  assert.equal(existsSync(unusedDb), false);

  setHead(f.base);
  const preview = await f.cli(args, true, reply);
  assert.equal(preview.code, 1);
  assert.match(preview.stderr.join(""), /export-head-mismatch/);
  assert.deepEqual(preview.questions, []);

  setHead(head);
  const apply = await f.cli(args, true, () => {
    setHead(f.base);
    return reply();
  });
  assert.equal(apply.code, 1);
  assert.match(apply.stderr.join(""), /export-head-mismatch/);
  assert.equal(apply.questions.length, 1);
  assert.equal(f.git(["for-each-ref", f.ref]), "");
  assert.ok(
    store
      .listEvents({ subjectId: f.goalId, limit: 50 })
      .every(({ kind }) => !kind.startsWith("goal.export")),
  );
});
