import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
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
import { runCli } from "../src/local-orchestrator/cli.ts";
import {
  contentDigest,
  goalBranch,
  type PolicySet,
  type TaskContent,
} from "../src/local-orchestrator/model.ts";
import { ActorRunner } from "../src/local-orchestrator/runner.ts";
import { OrchestratorStore } from "../src/local-orchestrator/store.ts";
import {
  createTaskExecutor,
  integrateApprovedProposal,
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
    review: { result: "pass", notes: "Good" },
  });
  assert.equal(proposal.digest, contentDigest(proposal.content));
  assert.equal(proposal.policy, "human");
  assert.equal(store.getTask(taskId)?.status, "awaiting-integration");
  assert.throws(
    () => integrateApprovedProposal({ ...proposal, status: "approved" }),
    {
      message: "stage-3",
    },
  );
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
  const { executor } = fixture();
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
            usage: {
              input_tokens: 1,
              output_tokens: 2,
              cache_read_input_tokens: 3,
              cache_creation_input_tokens: 4,
            },
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
    result: { tokens: 10 },
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

test("concerns, actor failures and cumulative token usage stop the task", async () => {
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
  assert.deepEqual(failure(timedOut), {
    status: "failed",
    code: "usage-unavailable",
  });

  const capped = task(goalId);
  const { executor } = fixture({
    async worker(_id, _revise, observed) {
      observed.tokens = 30;
      return pin;
    },
    async review(_id, observed) {
      observed.tokens = 21;
      return { ...pin, review: "pass" };
    },
  });
  await runner(executor).drain();
  assert.deepEqual(failure(capped), {
    status: "failed",
    code: "budget-exceeded",
  });
  assert.equal(store.taskTokens(capped), 51);
  assert.equal(store.pendingIntegrations().length, 0);
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

  const directory = join(repoRoot, ".local", "local-orchestrator");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const scratch = join(root, "scratch");
  mkdirSync(join(scratch, "docs"), { recursive: true });
  writeFileSync(join(scratch, "docs", "a.md"), "after\n");
  const link = join(scratch, "docs", "link");
  symlinkSync("../README.md", link);
  const attack = "`printf INJECTED` $(printf INJECTED) ' \"";
  const goalId = goal();
  const taskId = task(goalId, { description: attack });
  const calls: string[] = [];
  const invocationIds: string[] = [];
  const executor = createTaskExecutor({
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
    verification: { command: { argv: ["/bin/true"], timeoutMs: 1 } },
    host: {
      async runWorker(plan, id, _context, options) {
        assert.equal(plan.command.timeoutMs, 240_000);
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
        const review =
          calls.filter((call) => call === "verification").length === 1
            ? "revise"
            : "pass";
        return {
          id: id!,
          outcome: "ok",
          response: Buffer.from(JSON.stringify({ review })),
        };
      },
      async runReviewer(plan, id) {
        calls.push("review");
        invocationIds.push(id!);
        assert.equal(plan.command.timeoutMs, 240_000);
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
              result: '{"review":"pass","notes":"Looks good"}',
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
    changedPaths: ["docs/a.md", "docs/link"],
    symlinks: ["docs/link"],
    review: { notes: "Looks good" },
  });
  assert.equal(git(["rev-parse", "main"]), base);
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
    });
  }
  assert.equal(store.taskTokens(taskId), 34);
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
  assert.equal(await runCli(["--db", filename, "show", proposal.id], io), 1);
  assert.equal(
    await runCli(
      ["--db", filename, "--repo", repoRoot, "show", proposal.id],
      io,
    ),
    0,
  );
  assert.deepEqual(JSON.parse(output).content.changedPaths, [
    "docs/a.md",
    "docs/link",
  ]);
  assert.match(JSON.parse(output).diffStat, /docs\/a\.md/);
  assert.equal(
    await runCli(
      ["--db", filename, "--repo", repoRoot, "approve", proposal.id],
      io,
    ),
    0,
  );
  assert.equal(store.getProposal(proposal.id)?.status, "approved");
  assert.equal(store.getTask(taskId)?.status, "awaiting-integration");
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

test("missing Task usage stops execution and an existing token balance carries into a rerun", async () => {
  const goalId = goal();
  const unknown = task(goalId);
  const missing = fixture({
    async worker() {
      return pin;
    },
  });
  await runner(missing.executor).drain();
  assert.deepEqual(failure(unknown), {
    status: "failed",
    code: "usage-unavailable",
  });
  assert.deepEqual(missing.calls, []);

  const rerun = task(goalId);
  assert.ok(store.claimTask(rerun));
  const prior = store.createExecution({
    actor: "Executor",
    mode: "task",
    taskId: rerun,
    requestedBy: { kind: "host" },
  });
  store.startExecution(prior.id);
  store.finishExecution(prior.id, "failed", { tokens: 49 });
  const db = new Database(filename);
  db.query("UPDATE tasks SET status = 'registered' WHERE id = ?").run(rerun);
  db.close();
  const next = fixture({
    async worker(_id, _revise, observed) {
      observed.tokens = 2;
      return pin;
    },
  });
  await runner(next.executor).drain();
  assert.deepEqual(failure(rerun), {
    status: "failed",
    code: "budget-exceeded",
  });
  assert.equal(store.taskTokens(rerun), 51);
  assert.deepEqual(next.calls, []);
});

test("a failed integration approval allows one retry and fails closed on missing usage", async () => {
  const taskId = task(goal({ integration: "agent" }));
  const { executor } = fixture();
  const calls: string[] = [];
  const work = runner(executor, {
    async runReviewer(_plan, id) {
      calls.push(id);
      return {
        id,
        outcome: "ok",
        response: Buffer.from(
          JSON.stringify({
            result:
              calls.length === 1
                ? "invalid verdict"
                : '{"decision":"approve","reasons":[]}',
            ...(calls.length === 2
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
    result: { code: "contract-violation", tokens: 5 },
  });
  assert.partialDeepStrictEqual(store.getExecution(calls[1]!), {
    status: "failed",
    result: { code: "usage-unavailable" },
  });
  const [proposal] = store.pendingIntegrations();
  assert.ok(proposal);
  await assert.rejects(work.requestApproval(proposal.id), {
    code: "invalid-transition",
  });
  assert.equal(store.taskTokens(taskId), 5);
});
