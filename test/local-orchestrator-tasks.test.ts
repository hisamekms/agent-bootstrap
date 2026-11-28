import { goalPublishConfirmation } from "../src/publish/protocol.ts";
import { buildGoalPullRequest, GoalPublisher } from "../src/publish/goals.ts";
import {
  PublishError,
  type PublishProvider,
  type PublishPullRequest,
} from "../src/publish/port.ts";
import { SqliteAudit } from "../src/audit.ts";
import { TrustedHost } from "../src/trusted-host.ts";
import { ProfileCatalog } from "../src/sandbox-profiles.ts";
import {
  VERIFICATION_FAILURE_VERDICT,
  VERIFICATION_TAIL_LIMIT,
  VERIFICATION_TAIL_PATH,
} from "../src/sandbox-runtime.ts";
import { EnvironmentStore } from "../src/environments/store.ts";
import { identifyEnvironment } from "../src/environments/adapter.ts";
import { bunAdapter } from "../src/environments/bun.ts";
import {
  operatorActivity,
  operatorGoalList,
  operatorProblems,
  operatorTask,
  readOperatorTask,
} from "../src/local-orchestrator/operator-read.ts";
import { failureLabel } from "../src/local-orchestrator/operator-attention.ts";
import { projectInbox } from "../src/local-orchestrator/inbox.ts";
import {
  readTar,
  writeWorkspaceTar,
  type TarEntryView,
} from "../src/oci-image.ts";
import {
  environmentLockMismatchNote,
  environmentOutputCollisionNote,
} from "../src/reviewed-integration.ts";
import { activityLabel } from "../src/operator-ui/web/protocol.ts";
import { codexFailureActions } from "../src/codex-exec.ts";
import {
  configRoot,
  projectStateDirectory,
  projectConfigDirectory,
  writePrivateConfig,
} from "../src/config/layers.ts";
import { addProject } from "../src/config/projects.ts";
import { configEnv } from "./config-fixture.ts";
import { createCredentialScanner } from "../src/local-orchestrator/credential-scan.ts";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempDisposableSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { claudeRoleHarness } from "../src/actors.ts";
import { CLAUDE_WORKER_USAGE_MARKER } from "../src/claude-code.ts";
import { LocalGitIntegration } from "../src/git-integration.ts";
import { IntegrationJournal } from "../src/integration-journal.ts";
import { runCli } from "../src/local-orchestrator/cli.ts";
import {
  goalPublishAction,
  operatorAction,
  readOperatorGoal,
} from "../src/local-orchestrator/operator-api.ts";
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
import { taskEnvironment } from "../src/local-orchestrator/task-environment.ts";
import {
  prepareTargetDirectory,
  resolveTarget,
} from "../src/local-orchestrator/target.ts";
import { configuredVerification } from "../src/local-orchestrator/verification.ts";
import {
  createTaskExecutor,
  previewGoalBaseUpdate,
  previewGoalBranchExport,
  runTask,
  type TaskExecutor,
  type TaskFlow,
} from "../src/local-orchestrator/tasks.ts";
import {
  openTestStore,
  orchestratorFixture,
} from "./local-orchestrator-fixture.ts";

const { Database } = createRequire(import.meta.url)("bun:sqlite") as {
  Database: new (path: string) => {
    exec(sql: string): void;
    query<T>(sql: string): {
      get(...args: string[]): T;
      all(...args: string[]): T[];
      run(...args: string[]): void;
    };
    close(): void;
    [Symbol.dispose](): void;
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
type TaskState = ReturnType<typeof orchestratorFixture>;

const gitTestOptions = { timeout: 30_000 };

function approve(
  store: OrchestratorStore,
  proposal: { id: string; digest: string },
) {
  return store.decide(proposal.id, {
    decision: flags.decision,
    answerer: { kind: flags.kind },
    digest: proposal.digest,
  });
}
function goal(
  store: OrchestratorStore,
  policies?: PolicySet,
  profile: TaskContent["profile"] = "base",
  title = "Goal",
) {
  return approve(
    store,
    store.proposeGoal(
      {
        title,
        description: "",
        acceptance: ["Valid docs"],
        scope: {
          paths:
            profile === "bun"
              ? ["package.json", "bun.lock", "packages/"]
              : ["docs/"],
          profiles: [profile],
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
function task(
  store: OrchestratorStore,
  goalId: string,
  overrides: Partial<TaskContent> = {},
) {
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
  return draft.status === "registered"
    ? draft.taskId
    : approve(store, draft).taskId!;
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
  store: OrchestratorStore,
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

function failure(store: OrchestratorStore, taskId: string) {
  return store.listEvents({ subjectId: taskId, limit: 1 })[0]?.data;
}

test("drain serializes actors, bounds the queue and waits for integrated dependencies", async () => {
  using state = orchestratorFixture("lo-tasks-");
  const { filename, store } = state;
  const goalId = goal(store);
  const first = task(store, goalId);
  const dependent = task(store, goalId, { dependsOn: [first] });
  const independent = task(store, goalId);
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
  const work = runner(store, executor, { limits: { maxQueued: 1 } });
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
  approve(store, proposal);
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
  using state = orchestratorFixture("lo-tasks-");
  const { store } = state;
  const goalId = goal(store);
  const taskId = task(store, goalId);
  const { executor, calls, executions } = fixture();
  const work = runner(store, executor);
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
  assert.equal(approve(store, proposal).status, "approved");
  assert.equal(store.getTask(taskId)?.status, "awaiting-integration");
});

test("agent policy requests dedicated approval with the candidate diff under the task timeout", async () => {
  using state = orchestratorFixture("lo-tasks-");
  const { store } = state;
  const taskId = task(store, goal(store, { integration: "agent" }), {
    budgets: { ...budgets, maxExecutionMs: 1234 },
  });
  const { executor } = fixture({
    async verify() {
      return true;
    },
  });
  let approvalId: string | undefined;
  const work = runner(store, executor, {
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
  using state = orchestratorFixture("lo-tasks-");
  const { store } = state;
  const goalId = goal(store);
  const revised = task(store, goalId, {
    budgets: { ...budgets, maxRetries: 1 },
  });
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
  await runner(store, executor).drain();
  assert.deepEqual(calls, ["worker", "reject", "revise", "review"]);
  assert.equal(store.getTask(revised)?.attempts, 2);
  assert.deepEqual(failure(store, revised), {
    status: "failed",
    code: "revision-limit",
  });
  const denied = task(store, goalId, {
    budgets: { ...budgets, maxRetries: 0 },
  });
  const other = fixture({
    async changes() {
      return [{ path: "docs-other/a.md", newMode: "100644" }];
    },
  });
  await runner(store, other.executor).drain();
  assert.deepEqual(other.calls, ["worker", "reject"]);
  assert.deepEqual(failure(store, denied), {
    status: "failed",
    code: "path-violation",
    rejectedPaths: [{ path: "docs-other/a.md", symlink: false }],
  });
  assert.equal(store.pendingIntegrations().length, 0);
});

test("review concerns and timeouts still stop the task", async () => {
  using state = orchestratorFixture("lo-tasks-");
  const { store } = state;
  const goalId = goal(store);
  const concerned = task(store, goalId);
  await runner(
    store,
    fixture({
      async review(_id, observed) {
        observed.tokens = 0;
        return { ...pin, review: "concern" };
      },
    }).executor,
  ).drain();
  assert.deepEqual(failure(store, concerned), {
    status: "failed",
    code: "review-concern",
  });

  const timedOut = task(store, goalId);
  await runner(
    store,
    fixture({
      async worker(_id, _revise, observed) {
        observed.outcome = "timed-out";
        throw new Error("guest detail");
      },
    }).executor,
  ).drain();
  assert.deepEqual(failure(store, timedOut), {
    status: "failed",
    code: "timed-out",
  });
  assert.partialDeepStrictEqual(store.getHostApiStatus().recentExecutions[0], {
    status: "timed-out",
    usage: "unavailable",
    maxTokens: 50,
  });
});

test("crossing the Task token budget emits one advisory and allows verification, review and approval", async () => {
  using state = orchestratorFixture("lo-tasks-");
  const { store } = state;
  const taskId = task(store, goal(store, { integration: "agent" }));
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
  const work = runner(store, executor, {
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

function goalBaseFixture(
  state: TaskState,
  recordBase = true,
  policies?: PolicySet,
  title?: string,
) {
  const { root, filename, store } = state;
  const repoRoot = join(root, "source");
  const env = configEnv(root);
  const directory = projectStateDirectory("source", env);
  const bare = join(directory, "repository.git");
  mkdirSync(repoRoot);
  const git = (args: string[]) =>
    String(command("/usr/bin/git", repoRoot, args, "utf8")).trim();
  const bareGit = (args: string[]) => git([`--git-dir=${bare}`, ...args]);
  git(["init", "--template=", "--initial-branch=main"]);
  git(["commit", "--allow-empty", "-m", "old main"]);
  addProject(repoRoot, undefined, env);
  mkdirSync(bare, { recursive: true, mode: 0o700 });
  const base = git(["rev-parse", "HEAD"]);
  const goalId = goal(store, policies, "base", title);
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
      root,
      env,
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

test(
  "Workplace Goal base update binds both commits and requires an eligible Goal",
  gitTestOptions,
  async () => {
    using state = orchestratorFixture("lo-ui-base-");
    const { store } = state;
    const f = goalBaseFixture(state);
    const target = { target: f.repoRoot };
    const read = () => readOperatorGoal(store, f.directory, f.goalId, target);
    const { ref } = store.getGoal(f.goalId)!;
    const confirm = `update-goal-base ${ref} ${f.next.slice(0, 12)}`;
    const params = { id: ref, confirm, from: f.base, to: f.next };
    const submit = (input: object) =>
      operatorAction(store, f.directory, "goal.updateBase", input, target);
    assert.deepEqual((await read())?.baseUpdatePreview, {
      from: f.base,
      to: f.next,
    });
    assert.deepEqual(await submit({ ...params, to: "bad" }), {
      error: { code: "invalid-params" },
    });
    assert.deepEqual(await submit({ ...params, confirm: "yes" }), {
      error: { code: "confirmation-mismatch" },
    });
    assert.deepEqual(await submit({ ...params, to: f.base }), {
      error: { code: "stale-base" },
    });
    const taskId = task(store, f.goalId);
    assert.ok(store.claimTask(taskId));
    assert.equal((await read())?.baseUpdatePreview, undefined);
    assert.deepEqual(await submit(params), {
      error: { code: "goal-base-ineligible" },
    });
    assert.equal(f.head(), f.base);
    store.failTask(taskId, "review-concern");
    const preview = await previewGoalBaseUpdate(
      store,
      f.repoRoot,
      f.directory,
      f.goalId,
      "operator-ui",
    );
    f.git(["update-ref", "refs/heads/main", f.base, f.next]);
    await assert.rejects(preview.apply(), { code: "stale-base" });
    assert.deepEqual(await submit(params), { error: { code: "stale-base" } });
    assert.equal(f.head(), f.base);
    assert.deepEqual(f.events(), []);
    f.git(["update-ref", "refs/heads/main", f.next, f.base]);
    assert.deepEqual(await submit(params), {
      result: { id: f.goalId, ref, from: f.base, to: f.next },
    });
    assert.equal(f.head(), f.next);
    assert.equal((await read())?.baseUpdatePreview, undefined);
    assert.deepEqual(await submit(params), { error: { code: "stale-base" } });
    assert.deepEqual(f.events()[0]?.data, {
      from: f.base,
      to: f.next,
      origin: "operator-ui",
    });
  },
);

test(
  "update-goal-base confirms current local main, imports it and records the new base",
  gitTestOptions,
  async () => {
    using state = orchestratorFixture("lo-tasks-");
    const { store } = state;
    const f = goalBaseFixture(state);
    const taskId = task(store, f.goalId);
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
  },
);

test(
  "update-goal-base records the Goal branch head as the previous base for a legacy Goal",
  gitTestOptions,
  async () => {
    using state = orchestratorFixture("lo-tasks-");
    const { store } = state;
    const f = goalBaseFixture(state, false);
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
  },
);

test(
  "update-goal-base refuses a legacy Goal with a rejected integration proposal",
  gitTestOptions,
  async () => {
    using state = orchestratorFixture("lo-tasks-");
    const { filename, store } = state;
    const f = goalBaseFixture(state, false);
    const taskId = task(store, f.goalId);
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
  },
);

test(
  "update-goal-base rechecks legacy history after confirmation",
  gitTestOptions,
  async () => {
    using state = orchestratorFixture("lo-tasks-");
    const { filename, store } = state;
    const f = goalBaseFixture(state, false);
    const taskId = task(store, f.goalId);
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
  },
);

test(
  "update-goal-base refuses ineligible Goal and Task states with a fixed message",
  gitTestOptions,
  async () => {
    using state = orchestratorFixture("lo-tasks-");
    const { filename, store } = state;
    const f = goalBaseFixture(state);
    const taskId = task(store, f.goalId);
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
      await refused(["update-goal-base", goal(store)]);
      db.query("UPDATE goals SET status = 'done' WHERE id = ?").run(f.goalId);
      await refused();
      db.query("UPDATE goals SET status = 'active' WHERE id = ?").run(f.goalId);
      for (const status of ["running", "awaiting-integration", "succeeded"]) {
        db.query("UPDATE tasks SET status = ? WHERE id = ?").run(
          status,
          taskId,
        );
        await refused();
      }
      db.query("UPDATE tasks SET status = 'registered' WHERE id = ?").run(
        taskId,
      );
      const { executor } = fixture();
      await runner(store, executor).drain();
      assert.equal(store.pendingIntegrations(f.goalId).length, 1);
      db.query("UPDATE tasks SET status = 'failed' WHERE id = ?").run(taskId);
      await refused();
      assert.deepEqual(f.events(), []);
      assert.equal(f.head(), f.base);
    } finally {
      db.close();
    }
  },
);

test(
  "update-goal-base refuses a Task claim or ref change during confirmation",
  gitTestOptions,
  async () => {
    using state = orchestratorFixture("lo-tasks-");
    const { store } = state;
    const f = goalBaseFixture(state);
    const taskId = task(store, f.goalId);
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
    assert.deepEqual(stale.stderr, [
      "Goal base update refused (stale-base).\n",
    ]);
    assert.deepEqual(stale.questions, []);
    assert.equal(store.getGoal(f.goalId)?.baseCommit, f.base);
    assert.deepEqual(f.events(), []);
  },
);

test(
  "Goal branch CAS refuses a different head installed immediately before Git prepares the update",
  gitTestOptions,
  async () => {
    using state = orchestratorFixture("lo-tasks-");
    const { root, store } = state;
    const f = goalBaseFixture(state);
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

    f.bareGit(["update-ref", f.ref, f.base, winner]);
    await assert.rejects(
      store.discardGoal(f.goalId, f.base, (head) => git.deleteGoalBranch(head)),
      { code: "stale-base" },
    );
    assert.equal(f.head(), winner);
    assert.equal(store.getGoal(f.goalId)?.status, "active");
  },
);

test(
  "update-goal-base reports recording failure after a successful ref move",
  gitTestOptions,
  async () => {
    using state = orchestratorFixture("lo-tasks-");
    const { filename, store } = state;
    const f = goalBaseFixture(state);
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
  },
);

test(
  "discard-goal confirms the private head, cancels registered tasks, and closes the goal",
  gitTestOptions,
  async () => {
    using state = orchestratorFixture("lo-tasks-");
    const { store } = state;
    const f = goalBaseFixture(state);
    f.git(["push", f.bare, `${f.next}:${f.ref}`]);
    const taskId = task(store, f.goalId);
    const failed = task(store, f.goalId);
    assert.ok(store.claimTask(failed));
    store.failTask(failed, "review-concern");
    const key = store.getGoal(f.goalId)!.ref.toLowerCase();
    const args = ["discard-goal", key];
    const phrase = `discard-goal ${key} ${f.next.slice(0, 12)}`;
    const mismatch = await f.cli(args, true, () => "wrong");
    assert.equal(mismatch.code, 1);
    assert.deepEqual(mismatch.stderr, [
      "Confirmation did not match. Operation cancelled.\n",
    ]);
    assert.deepEqual(mismatch.questions, [`Type "${phrase}" to confirm: `]);
    assert.deepEqual(JSON.parse(mismatch.stdout[0]!), {
      goalId: key,
      branch: goalBranch(f.goalId),
      head: f.next,
    });
    assert.equal(f.head(), f.next);
    assert.equal(store.getGoal(f.goalId)?.status, "active");

    const result = await f.cli(args, true, () => phrase);
    assert.equal(result.code, 0, result.stderr.join(""));
    assert.equal(JSON.parse(result.stdout[1]!).status, "cancelled");
    assert.equal(f.bareGit(["for-each-ref", "--format=%(refname)", f.ref]), "");
    assert.equal(store.getTask(taskId)?.status, "cancelled");
    assert.equal(store.getTask(failed)?.status, "failed");
    assert.throws(() => store.retryTask(failed, 0), { code: "goal-inactive" });
    assert.partialDeepStrictEqual(
      store.listEvents({ subjectId: taskId, limit: 1 })[0],
      { kind: "task.status", data: { status: "cancelled", code: null } },
    );
    assert.partialDeepStrictEqual(
      store.listEvents({ subjectId: f.goalId, limit: 1 })[0],
      {
        kind: "goal.status",
        data: { status: "cancelled", discardedHead: f.next },
      },
    );
    for (const [command, message] of [
      ["discard-goal", "Goal discard refused"],
      ["update-goal-base", "Goal base update refused"],
      ["export-goal-branch", "Goal branch export refused"],
    ]) {
      const refused = await f.cli([command!, f.goalId]);
      assert.equal(refused.code, 1);
      assert.deepEqual(refused.stderr, [`${message} (goal-inactive).\n`]);
      assert.deepEqual(refused.questions, []);
    }
    const shown = await f.cli(["show", f.goalId], false);
    assert.equal(JSON.parse(shown.stdout[0]!).status, "cancelled");
  },
);

test(
  "discard-goal verifies an absent ref again after confirmation",
  gitTestOptions,
  async () => {
    using state = orchestratorFixture("lo-tasks-");
    const { store } = state;
    const f = goalBaseFixture(state);
    const args = ["discard-goal", f.goalId];
    const phrase = `discard-goal ${f.goalId} none`;
    f.bareGit(["update-ref", "-d", f.ref, f.base]);
    const stale = await f.cli(args, true, () => {
      f.bareGit(["update-ref", f.ref, f.base]);
      return phrase;
    });
    assert.deepEqual(stale.stderr, ["Goal discard refused (stale-base).\n"]);
    assert.equal(f.head(), f.base);
    assert.equal(store.getGoal(f.goalId)?.status, "active");

    f.bareGit(["update-ref", "-d", f.ref, f.base]);
    const result = await f.cli(args, true, () => phrase);
    assert.equal(result.code, 0, result.stderr.join(""));
    assert.deepEqual(result.questions, [`Type "${phrase}" to confirm: `]);
    assert.deepEqual(JSON.parse(result.stdout[0]!), {
      goalId: f.goalId,
      branch: goalBranch(f.goalId),
      head: null,
    });
    assert.partialDeepStrictEqual(
      store.listEvents({ subjectId: f.goalId, limit: 1 })[0],
      {
        kind: "goal.status",
        data: { status: "cancelled", discardedHead: null },
      },
    );
  },
);

test(
  "discard-goal refuses busy goals and changed heads without deleting the ref",
  gitTestOptions,
  async () => {
    using state = orchestratorFixture("lo-tasks-");
    const { store, filename } = state;
    const f = goalBaseFixture(state);
    const taskId = task(store, f.goalId);
    const args = ["discard-goal", f.goalId];
    const phrase = `discard-goal ${f.goalId} ${f.base.slice(0, 12)}`;
    const busy = await f.cli(args, true, () => {
      assert.ok(store.claimTask(taskId));
      return phrase;
    });
    assert.deepEqual(busy.stderr, ["Goal discard refused (goal-busy).\n"]);
    assert.equal(f.head(), f.base);
    store.failTask(taskId, "review-concern");
    store.retryTask(taskId, 0);

    const { executor } = fixture();
    await runner(store, executor).drain();
    assert.equal(store.pendingIntegrations(f.goalId).length, 1);
    const db = new Database(filename);
    try {
      db.query("UPDATE tasks SET status = 'failed' WHERE id = ?").run(taskId);
      const pending = await f.cli(args);
      assert.deepEqual(pending.stderr, ["Goal discard refused (goal-busy).\n"]);
      assert.equal(f.head(), f.base);
      db.query(
        "UPDATE proposals SET status = 'rejected' WHERE kind = 'integration'",
      ).run();
    } finally {
      db.close();
    }

    f.git(["push", f.bare, `${f.next}:refs/heads/next`]);
    const stale = await f.cli(args, true, () => {
      f.bareGit(["update-ref", f.ref, f.next, f.base]);
      return phrase;
    });
    assert.deepEqual(stale.stderr, ["Goal discard refused (stale-base).\n"]);
    assert.equal(f.head(), f.next);
    assert.equal(store.getGoal(f.goalId)?.status, "active");
  },
);

test("Verification wrapper returns while a background child holds stdout", () => {
  using temp = mkdtempDisposableSync(
    join(realpathSync(tmpdir()), "lo-verify-"),
  );
  const tail = join(temp.path, "output", "tail");
  const [, flag, script, ...argv] = configuredVerification({
    profile: "base",
    argv: ["/bin/sh", "-c", "printf 'suite output'; sleep 3 & exit 0"],
  }).command.argv;
  const started = performance.now();
  const result = spawnSync(
    "/bin/sh",
    [
      flag!,
      script!.replace(VERIFICATION_TAIL_PATH, '"$VERIFICATION_TEST_TAIL"'),
      ...argv,
    ],
    {
      env: { ...process.env, VERIFICATION_TEST_TAIL: tail },
      encoding: "utf8",
      timeout: 5000,
    },
  );
  const elapsed = performance.now() - started;
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '{"review":"pass"}\n');
  assert.ok(elapsed < 2000, `Verification took ${elapsed} ms`);
  assert.equal(readFileSync(tail, "utf8"), "suite output");
  assert.equal(existsSync(`${tail}.full`), false);
});

for (const scenario of [
  "screened",
  "truncated",
  "truncated without a newline",
  "collection error",
  "masking error",
] as const) {
  test(
    `Verification revision notes with ${scenario}`,
    gitTestOptions,
    async () => {
      using state = orchestratorFixture("lo-tasks-verification-");
      const { root, store } = state;
      const { goalId, directory, repoRoot } = goalBaseFixture(state);
      const taskId = task(store, goalId);
      const token = `sk-ant-${"f".repeat(32)}`;
      const diagnostic = Buffer.concat([
        Buffer.from(`failure\x00\x1b\x7f\u202e\t${token}\n`),
        Uint8Array.of(0xff),
      ]);
      const tokenSuffix = token.slice("sk-ant-".length);
      let rawTail = diagnostic;
      if (scenario === "truncated") {
        rawTail = Buffer.concat([
          Buffer.from(tokenSuffix),
          Buffer.alloc(
            VERIFICATION_TAIL_LIMIT -
              diagnostic.length -
              tokenSuffix.length -
              1,
            " ",
          ),
          Buffer.from("\n"),
          diagnostic,
        ]);
      } else if (scenario === "truncated without a newline") {
        rawTail = Buffer.alloc(VERIFICATION_TAIL_LIMIT, "x");
        rawTail.write(tokenSuffix);
      }
      const audit = new SqliteAudit(join(root, "verify.sqlite"));
      try {
        let collected = false;
        let workerRuns = 0;
        const verifier = new TrustedHost(
          audit,
          {
            async create(spec) {
              assert.equal(spec.verification, true);
              assert.equal(spec.maxLifetimeMs, 450_000);
              return { id: "verification-fixture" };
            },
            async exec(_handle, command) {
              assert.equal(command.timeoutMs, 300_000);
              return {
                status: "exited",
                exitCode: 0,
                stdout: Buffer.from(
                  workerRuns === 1
                    ? VERIFICATION_FAILURE_VERDICT
                    : '{"review":"pass"}',
                ),
                stderr: Buffer.alloc(0),
              };
            },
            async collect(_handle, spec) {
              collected = true;
              assert.deepEqual(spec, { verificationTail: true });
              if (scenario === "collection error")
                throw new Error("fixture collection error");
              return {
                files: [{ path: VERIFICATION_TAIL_PATH, bytes: rawTail }],
              };
            },
            async destroy() {},
          },
          new ProfileCatalog({
            base: { image: `fixture.invalid/alpine@sha256:${"a".repeat(64)}` },
          }),
        );
        let revisionNote: Uint8Array | undefined;
        const executor = createTaskExecutor({
          repoRoot,
          directory,
          store,
          worker: () => harness,
          reviewer: harness,
          verification: configuredVerification({
            profile: "base",
            argv: ["fixture-verify"],
            timeoutMs: 600_000,
          }),
          ...(scenario === "masking error" && {
            async scan(...sources) {
              if (
                sources.some(
                  (source) =>
                    typeof source === "string" &&
                    source.startsWith("failure\t"),
                )
              )
                throw new Error("fixture scanner error");
            },
          }),
          host: {
            runVerification: verifier.runVerification.bind(verifier),
            async runReviewer() {
              throw new Error(
                "Review is unreachable for a failing Verification",
              );
            },
            async runWorker(plan, id) {
              assert.equal(plan.command.timeoutMs, 240_000);
              revisionNote = plan.sandbox.readOnlyFiles?.find(
                ({ path }) => path === "review-notes.txt",
              )?.bytes;
              return {
                id: id!,
                outcome: "ok",
                artifacts: {
                  files: [],
                  tree: writeWorkspaceTar([
                    {
                      path: "docs",
                      type: "directory",
                      mode: 0o755,
                      data: Buffer.alloc(0),
                      linkname: "",
                    },
                    {
                      path: "docs/a.md",
                      type: "file",
                      mode: 0o644,
                      data: Buffer.from(`Revision ${++workerRuns}\n`),
                      linkname: "",
                    },
                  ]),
                },
              };
            },
          },
        });
        const flow = await executor.open(store.getTask(taskId)!);
        await flow.worker(randomUUID(), false, {});
        const verificationId = randomUUID();
        assert.equal(await flow.verify!(verificationId, {}), false);
        assert.equal(collected, true);
        await flow.worker(randomUUID(), true, {});
        const journal = new IntegrationJournal(
          join(directory, "integrations", taskId),
          taskId,
        );
        const events = await journal.read();
        const finish = events.find(
          (event) => event.kind === "verification.finished",
        )!;
        assert.equal(finish.review, "revise");
        assert.equal(
          finish.tailDigest,
          scenario === "collection error"
            ? undefined
            : createHash("sha256").update(rawTail).digest("hex"),
        );
        assert.equal(
          audit
            .read(verificationId)
            .find(
              (event) =>
                event.operation === "sandbox.collect" &&
                event.kind === "operation.finished",
            )?.outcome,
          scenario === "collection error" ? "failed" : "ok",
        );
        const note = Buffer.from(revisionNote!).toString();
        if (scenario === "screened" || scenario === "truncated") {
          assert.match(note, /failure\t［伏せ字］\n�/);
          assert.equal(
            (await readOperatorTask(store, directory, taskId))
              ?.verificationNote,
            note,
          );
          assert.equal(
            events.find((event) => event.kind === "revision.requested")?.notes,
            finish.notes,
          );
          assert.equal(await flow.verify!(randomUUID(), {}), true);
          assert.equal(
            (await readOperatorTask(store, directory, taskId))
              ?.verificationNote,
            undefined,
          );
        } else {
          assert.match(note, /verification suite failed/);
          assert.equal(finish.notes, undefined);
          assert.equal(
            (await readOperatorTask(store, directory, taskId))
              ?.verificationNote,
            undefined,
          );
        }
        assert.ok(!note.includes(tokenSuffix));
      } finally {
        audit.close();
      }
    },
  );
}

test(
  "real Git composes tree mode, path rejection, verification, review and operator CLI",
  gitTestOptions,
  async () => {
    using state = orchestratorFixture("lo-tasks-");
    const { root, filename, store } = state;
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

    const env = configEnv(root);
    addProject(repoRoot, undefined, env);
    const target = await resolveTarget(repoRoot, root, env);
    const { directory } = target;
    await prepareTargetDirectory(target.bootstrapRoot, directory, env);
    const scratch = join(root, "scratch");
    mkdirSync(join(scratch, "docs"), { recursive: true });
    writeFileSync(join(scratch, "docs", "a.md"), "after\n");
    const link = join(scratch, "docs", "link");
    symlinkSync("../README.md", link);
    const attack = "`printf INJECTED` $(printf INJECTED) ' \"";
    const goalId = goal(store);
    const taskId = task(store, goalId, {
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
          assert.equal(Object.hasOwn(plan.sandbox, "environment"), false);
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
          assert.equal(Object.hasOwn(plan.sandbox, "environment"), false);
          calls.push("verification");
          invocationIds.push(id!);
          assert.ok(plan.sandbox.repository);
          assert.equal(plan.sandbox.profile, "base");
          assert.equal(plan.command.timeoutMs, 125_000);
          const [binary, flag, script, ...args] = plan.command.argv;
          const { tree } = plan.sandbox.repository;
          const workspace = mkdtempSync(join(root, "verify-"));
          const unpacked = spawnSync("/usr/bin/tar", ["-xf", tree], {
            cwd: workspace,
          });
          assert.equal(unpacked.status, 0, String(unpacked.stderr));
          const response = command(binary!, workspace, [
            flag!,
            script!.replace(VERIFICATION_TAIL_PATH, "./diagnostic/tail"),
            ...args,
          ]);
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
          assert.equal(
            noteLimit,
            "Keep revision notes within 2048 UTF-8 bytes.",
          );
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
    await runner(store, executor).drain();
    assert.deepEqual(
      calls,
      ["worker", "worker", "verification", "worker", "verification", "review"],
      JSON.stringify(failure(store, taskId)),
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
    assert.equal(
      await runCli(["--db", filename, "show", goalId], io, root, env),
      0,
    );
    assert.equal(JSON.parse(output).baseCommit, base);
    output = "";
    assert.equal(
      await runCli(["--db", filename, "show", taskId], io, root, env),
      0,
    );
    assert.partialDeepStrictEqual(JSON.parse(output), {
      budgetTokens: 31,
      totalTokens: 31,
    });
    output = "";
    assert.equal(
      await runCli(["--db", filename, "show", proposal.id], io, root, env),
      1,
    );
    assert.equal(
      await runCli(
        ["--db", filename, "--target", repoRoot, "show", proposal.id],
        io,
        root,
        env,
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
        env,
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
        env,
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
  },
);

test(
  "strict review concerns retain raw answers and operator retries start fresh journals",
  gitTestOptions,
  async () => {
    using state = orchestratorFixture("lo-tasks-");
    const { root, store } = state;
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
    const taskId = task(store, goal(store));
    const prose = 'Here is the verdict: {"review":"pass"}'.padEnd(4094, "x");
    const longNotes = JSON.stringify({
      review: "revise",
      notes: "é".repeat(1100),
    });
    const answers = [
      prose + "😀",
      longNotes,
      '\n```\n{"review":"pass"}\n```  ',
    ];
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
            Buffer.from(
              "\n" + CLAUDE_WORKER_USAGE_MARKER + claudeResult("done"),
            ),
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
    const work = runner(store, executor);
    for (const [index, rawAnswer] of [prose, longNotes].entries()) {
      await work.drain();
      assert.deepEqual(failure(store, taskId), {
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
    assert.equal(
      Object.hasOwn(lastReview?.result as object, "rawAnswer"),
      false,
    );
    assert.equal(store.taskTokens(taskId), 12);
    assert.equal(store.getExecution(reviewerIds[0]!)?.status, "failed");
  },
);

test("opens a populated Stage 1 database and migrates its proposal and task checks", async () => {
  using temp = mkdtempDisposableSync(join(realpathSync(tmpdir()), "lo-tasks-"));
  const filename = join(temp.path, "stage1.db");
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
  using migrated = openTestStore(filename);
  const { store } = migrated;
  assert.equal(store.getExecution("old-execution")?.taskId, taskId);
  await runner(store, fixture().executor).drain();
  assert.equal(store.getTask(taskId)?.status, "awaiting-integration");
  assert.equal(store.pendingIntegrations(goalId).length, 1);
  store.close();
  using _reopened = openTestStore(filename);
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
  using state = orchestratorFixture("lo-tasks-");
  const { store } = state;
  const goalId = goal(store, { integration: "agent" });
  const denied = task(store, goalId, {
    budgets: { ...budgets, maxRetries: 0 },
  });
  const unsafe = fixture({
    async changes() {
      return [{ path: "docs/link", newMode: "120000", target: "../README.md" }];
    },
  });
  await runner(store, unsafe.executor).drain();
  assert.deepEqual(unsafe.calls, ["worker", "reject"]);
  assert.deepEqual(failure(store, denied), {
    status: "failed",
    code: "path-violation",
    rejectedPaths: [{ path: "docs/link", symlink: true }],
  });

  task(store, goalId);
  const safe = fixture({
    async verify() {
      return true;
    },
    async changes() {
      return [{ path: "docs/sub/link", newMode: "120000", target: "../a.md" }];
    },
  });
  const work = runner(store, safe.executor);
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
    assert.throws(
      () =>
        store.decide(proposal.id, {
          decision,
          digest: proposal.digest,
          answerer: { kind: "human", channel: "operator-ui" },
          takeover: true,
        }),
      { code: "approval-forbidden" },
    );
  }
  assert.equal(approve(store, proposal).status, "approved");
});

test("missing Task usage is advisory and retries reset the window but preserve history", async () => {
  using state = orchestratorFixture("lo-tasks-");
  const { store } = state;
  const goalId = goal(store);
  const unknown = task(store, goalId);
  const missing = fixture({
    async worker() {
      return pin;
    },
  });
  await runner(store, missing.executor).drain();
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

  const rerunGoal = goal(store, { integration: "agent" });
  const rerun = task(store, rerunGoal);
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
  const work = runner(store, next.executor, {
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
  using state = orchestratorFixture("lo-tasks-");
  const { store } = state;
  const taskId = task(store, goal(store));
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
  using state = orchestratorFixture("lo-tasks-");
  const { store } = state;
  const taskId = task(store, goal(store, { integration: "agent" }));
  const { executor } = fixture({
    async verify() {
      return true;
    },
  });
  const calls: string[] = [];
  const work = runner(store, executor, {
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
  using state = orchestratorFixture("lo-tasks-");
  const { store } = state;
  const taskId = task(store, goal(store, { integration: "agent" }));
  const { executor } = fixture({
    async verify() {
      return true;
    },
  });
  let approvalId: string | undefined;
  const work = runner(store, executor, {
    async runReviewer(_plan, id) {
      approvalId = id;
      const [proposal] = store.pendingIntegrations();
      assert.ok(proposal);
      assert.equal(approve(store, proposal).status, "approved");
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
  state: TaskState,
  policies?: PolicySet,
  verification?: "pass" | "deny-integration" | "revise-review",
  runnerOverrides?: Parameters<typeof runner>[2],
  title?: string,
) {
  const { root, store } = state;
  const f = goalBaseFixture(state, true, policies, title);
  const taskId = task(store, f.goalId);
  const scratch = join(root, "candidate");
  mkdirSync(join(scratch, "docs"), { recursive: true });
  let workers = 0;
  const verificationIds: string[] = [];
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
            JSON.stringify({
              result: JSON.stringify({
                review:
                  verification === "revise-review" && workers === 1
                    ? "revise"
                    : "pass",
              }),
            }),
          ),
        };
      },
      async runVerification(_plan, id) {
        verificationIds.push(id!);
        return {
          id: id!,
          outcome: "ok",
          response: Buffer.from(
            JSON.stringify({
              review:
                verification === "deny-integration" &&
                verificationIds.length === 2
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
  const work = runner(store, executor, runnerOverrides);
  return {
    ...f,
    taskId,
    work,
    journal,
    verificationIds,
    verifications: () => verificationIds.length,
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
        JSON.stringify(failure(store, taskId)),
      );
      return proposal;
    },
  };
}

test(
  "integrates a verified approval and uses its committed head for a dependent",
  gitTestOptions,
  async () => {
    using state = orchestratorFixture("lo-tasks-");
    const { store } = state;
    const f = stage3Fixture(state, undefined, "pass");
    const dependent = task(store, f.goalId, { dependsOn: [f.taskId] });
    const proposal = await f.proposal();
    assert.equal(proposal.content.verified, true);
    assert.equal(store.getTask(dependent)?.status, "registered");

    approve(store, proposal);
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
  },
);

test(
  "integration verification denial fails the Task before moving the branch",
  gitTestOptions,
  async () => {
    using state = orchestratorFixture("lo-tasks-");
    const { store } = state;
    const f = stage3Fixture(state, undefined, "deny-integration");
    const proposal = await f.proposal();
    approve(store, proposal);
    await f.work.drain();
    assert.equal(f.verifications(), 2);
    assert.partialDeepStrictEqual(store.getExecution(f.verificationIds[1]!), {
      taskId: f.taskId,
      mode: "verification",
      status: "failed",
      result: {
        code: "verification-failed",
        phase: "integration",
        tokens: 0,
        costUsd: null,
      },
    });
    assert.equal(f.head(), f.base);
    assert.deepEqual(failure(store, f.taskId), {
      status: "failed",
      code: "verification",
    });
  },
);

test(
  "a deterministic M5 decision failure leaves the Goal schedulable",
  gitTestOptions,
  async () => {
    using state = orchestratorFixture("lo-tasks-");
    const { store } = state;
    const f = stage3Fixture(state);
    const proposal = await f.proposal();
    const dependent = task(store, f.goalId);
    const events = await f.journal.read();
    await f.journal.append(events.length, {
      kind: "denied",
      reason: "evidence",
    });
    approve(store, proposal);
    await f.work.drain();
    assert.deepEqual(failure(store, f.taskId), {
      status: "failed",
      code: "integration-evidence",
    });
    assert.equal(f.head(), f.base);
    assert.equal(store.getTask(dependent)?.status, "awaiting-integration");
    assert.equal((await f.journal.read()).at(-1)?.kind, "denied");
  },
);

test("runner skips raced integrations and processes another Goal in the same drain", async () => {
  using state = orchestratorFixture("lo-tasks-");
  const { store } = state;
  const codes = [
    "invalid-transition",
    "goal-inactive",
    "goal-pr-open",
    "integration-uncertain",
  ] as const;
  for (let i = 0; i <= codes.length; i++) task(store, goal(store));
  const { executor } = fixture();
  await runner(store, executor).drain();
  const proposals = store.pendingIntegrations();
  assert.equal(proposals.length, codes.length + 1);
  for (const proposal of proposals) approve(store, proposal);
  const calls: string[] = [];
  await runner(store, {
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

test(
  "a verified agent approval records the agent answer in M5",
  gitTestOptions,
  async () => {
    using state = orchestratorFixture("lo-tasks-");
    const { store } = state;
    const f = stage3Fixture(state, { integration: "agent" }, "pass", {
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
  },
);

test(
  "a legacy unverified proposal can be approved and integrated without a rewrite",
  gitTestOptions,
  async () => {
    using state = orchestratorFixture("lo-tasks-");
    const { filename, store } = state;
    const f = stage3Fixture(state);
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
    approve(store, { id: proposal.id, digest });
    await f.work.drain();
    assert.equal(f.verifications(), 0);
    assert.equal(f.head(), proposal.content.candidate);
    assert.equal(store.getTask(f.taskId)?.status, "succeeded");
  },
);

test(
  "unverified integration refuses an agent answer and accepts a delegated human",
  gitTestOptions,
  async () => {
    using state = orchestratorFixture("lo-tasks-");
    const { store } = state;
    const f = stage3Fixture(state, { integration: "agent" });
    const proposal = await f.proposal();
    assert.equal(proposal.content.verified, false);
    assert.equal(proposal.policy, "human");
    assert.equal(proposal.source, "invariant");
    assert.equal(proposal.invariant, "integration-verification");
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
    store.finishExecution(approval.id, "failed", {
      code: "approval-forbidden",
    });
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
  },
);

for (const mismatch of [
  "approval digest",
  "candidate",
  "base",
  "paths",
  "stale-base",
]) {
  test(
    `approved integration refuses ${mismatch} before the M5 decision`,
    gitTestOptions,
    async () => {
      using state = orchestratorFixture("lo-tasks-");
      const { filename, store } = state;
      const f = stage3Fixture(state);
      const proposal = await f.proposal();
      const events = await f.journal.read();
      approve(store, proposal);
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
      assert.deepEqual(failure(store, f.taskId), {
        status: "failed",
        code:
          mismatch === "stale-base"
            ? mismatch
            : mismatch === "approval digest"
              ? "stale-digest"
              : "candidate-mismatch",
      });
    },
  );
}

test(
  "an earlier approval cannot consume a retried Task's proposal",
  gitTestOptions,
  async () => {
    using state = orchestratorFixture("lo-tasks-");
    const { store } = state;
    const f = stage3Fixture(state);
    const first = await f.proposal();
    approve(store, first);
    f.git(["push", f.bare, `${f.next}:${f.ref}`]);
    await f.work.drain();
    assert.equal(store.getTask(f.taskId)?.status, "failed");
    f.bareGit(["update-ref", f.ref, f.base, f.next]);
    store.retryTask(f.taskId, 0);

    const second = await f.proposal();
    assert.notEqual(first.id, second.id);
    assert.equal(store.getTask(f.taskId)?.status, "awaiting-integration");
    assert.equal(f.head(), f.base);
    approve(store, second);
    await f.work.drain();
    assert.equal(store.getTask(f.taskId)?.status, "succeeded");
    assert.equal(f.head(), second.content.candidate);
  },
);

for (const updated of [false, true]) {
  test(
    `an uncertain integration pauses its Goal and reconcile handles ${updated ? "an advanced ref" : "an unchanged ref"}`,
    gitTestOptions,
    async () => {
      using state = orchestratorFixture("lo-tasks-");
      const { store } = state;
      const f = stage3Fixture(state);
      const proposal = await f.proposal();
      const next = task(store, f.goalId);
      approve(store, proposal);
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
      const detail = await readOperatorGoal(store, f.directory, f.goalId, {
        target: f.repoRoot,
        scan: async () => {},
      });
      assert.equal(detail?.exportPreview, null);
      assert.equal(detail?.exportBlockReason, null);

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
    },
  );
}

test(
  "export creates and fast-forwards only the local Goal ref and refuses divergence",
  gitTestOptions,
  async () => {
    using state = orchestratorFixture("lo-tasks-");
    const { root, store } = state;
    const f = stage3Fixture(state);
    const proposal = await f.proposal();
    const branch = goalBranch(f.goalId);
    const checkout = join(root, "operator");
    f.git(["worktree", "add", "--detach", checkout, f.base]);
    const operator = (args: string[]) =>
      String(command("/usr/bin/git", checkout, args, "utf8")).trim();
    const key = store.getGoal(f.goalId)!.ref.toLowerCase();
    const args = ["export-goal-branch", key, "--repo", checkout];
    const exportAt = (to: string) =>
      f.cli(args, true, () => `export-goal-branch ${key} ${to.slice(0, 12)}`);
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
    assert.match(created.stdout.join(""), /into the operator checkout/);
    assert.equal(operator(["rev-parse", f.ref]), f.base);

    approve(store, proposal);
    await f.work.drain();
    const notes: string[] = [];
    await assert.rejects(
      previewGoalBranchExport(
        store,
        checkout,
        f.directory,
        f.goalId,
        createCredentialScanner(
          { leakPatterns: ["Candidate 1"] },
          root,
          (note) => notes.push(note),
        ),
      ),
      { code: "credential-leak" },
    );
    assert.equal(notes.length, 1);
    assert.equal(operator(["rev-parse", f.ref]), f.base);
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
    assert.match(refused.stderr.join(""), /commits that are not in the Goal/);
    operator(["-c", "core.hooksPath=/dev/null", "switch", branch]);
    const checkedOut = await exportAt(proposal.content.candidate);
    assert.equal(checkedOut.code, 1);
    assert.match(checkedOut.stderr.join(""), /branch-checked-out/);
    assert.match(checkedOut.stderr.join(""), /Switch that worktree/);

    operator(["-c", "core.hooksPath=/dev/null", "switch", "--detach", f.base]);
    operator(["-c", "core.hooksPath=/dev/null", "update-ref", f.ref, f.base]);
    const switched = await f.cli(args, true, () => {
      operator(["-c", "core.hooksPath=/dev/null", "switch", branch]);
      return `export-goal-branch ${key} ${proposal.content.candidate.slice(0, 12)}`;
    });
    assert.equal(switched.code, 1);
    assert.equal(switched.questions.length, 1);
    assert.match(switched.stderr.join(""), /branch-checked-out/);
    assert.equal(operator(["rev-parse", f.ref]), f.base);
  },
);

test(
  "a checkout made during the fetch stops export before the ref transaction",
  gitTestOptions,
  async () => {
    using state = orchestratorFixture("lo-tasks-");
    const f = goalBaseFixture(state);
    const branch = goalBranch(f.goalId);
    f.git(["push", f.bare, `${f.next}:${f.ref}`]);
    f.git(["branch", branch, f.base]);
    const binary = join(state.root, "git-export-test");
    writeFileSync(
      binary,
      `#!/bin/sh
for arg do
  case "$arg" in
    --no-write-fetch-head)
      /usr/bin/git "$@" || exit $?
      exec /usr/bin/git switch --quiet ${branch}
      ;;
    update-ref) touch "$0.update-ref" ;;
  esac
done
exec /usr/bin/git "$@"
`,
      { mode: 0o700 },
    );
    const git = new LocalGitIntegration({
      binary,
      branch,
      repository: f.bare,
      stagingRoot: join(f.directory, "worktrees"),
    });
    const preview = await git.previewGoalExport(f.repoRoot, f.next);
    let authorized = false;
    await assert.rejects(
      preview.apply(() => {
        authorized = true;
      }),
      { code: "branch-checked-out" },
    );
    assert.equal(authorized, true);
    assert.equal(f.git(["symbolic-ref", "HEAD"]), f.ref);
    assert.equal(f.git(["rev-parse", f.ref]), f.base);
    assert.equal(existsSync(binary + ".update-ref"), false);
  },
);

test(
  "operator export previews read-only, checks confirmation and scanning, and audits like the CLI",
  gitTestOptions,
  async () => {
    using state = orchestratorFixture("lo-tasks-");
    const { root, store } = state;
    const f = stage3Fixture(state);
    const proposal = await f.proposal();
    assert.partialDeepStrictEqual(
      await readOperatorGoal(store, f.directory, f.goalId, {
        target: f.repoRoot,
        scan: async () => {},
      }),
      { head: f.base, exportPreview: null, exportBlockReason: null },
    );
    approve(store, proposal);
    await f.work.drain();
    const to = proposal.content.candidate;
    const branch = goalBranch(f.goalId);
    const { ref } = store.getGoal(f.goalId)!;
    const confirm = `export-goal-branch ${ref} ${to.slice(0, 12)}`;
    const params = { id: ref.toLowerCase(), confirm, expectedHead: to };
    let scans = 0;
    const destination = {
      target: f.repoRoot,
      repository: { project: "demo", repositoryPath: "source" },
      scan: async () => {
        scans++;
      },
    };
    const call = (input: object, options = destination) =>
      operatorAction(store, f.directory, "goal.export", input, options);
    const exportedRef = () =>
      f.git(["for-each-ref", "--format=%(objectname)", f.ref]);
    const audit = () =>
      store
        .listEvents({ subjectId: f.goalId, limit: 50 })
        .filter(
          ({ kind }) =>
            kind === "goal.exported" || kind === "goal.export-authorized",
        )
        .map(({ kind, subjectKind, subjectId, data }) => ({
          kind,
          subjectKind,
          subjectId,
          data,
        }));

    const detail = await readOperatorGoal(store, f.directory, ref, destination);
    assert.deepEqual(detail?.exportPreview, {
      branch,
      from: null,
      to,
      target: "demo",
    });
    assert.equal(scans, 0);
    assert.equal(exportedRef(), "");
    assert.deepEqual(audit(), []);

    assert.deepEqual(await call({ ...params, checkout: root }), {
      error: { code: "invalid-params" },
    });
    assert.deepEqual(
      await operatorAction(store, f.directory, "goal.export", params, {
        target: f.repoRoot,
      }),
      {
        error: { code: "export-unavailable" },
      },
    );
    assert.deepEqual(await call({ ...params, confirm: "yes" }), {
      error: { code: "confirmation-mismatch" },
    });
    assert.deepEqual(await call({ ...params, expectedHead: f.base }), {
      error: { code: "stale-base" },
    });
    assert.equal(scans, 0);
    f.bareGit(["update-ref", f.ref, f.base, to]);
    assert.deepEqual(await call(params), { error: { code: "stale-base" } });
    f.bareGit(["update-ref", f.ref, to, f.base]);
    assert.deepEqual(
      await call(params, {
        ...destination,
        scan: async () => {
          f.bareGit(["update-ref", f.ref, f.base, to]);
        },
      }),
      { error: { code: "stale-base" } },
    );
    f.bareGit(["update-ref", f.ref, to, f.base]);

    f.git(["update-ref", f.ref, f.next]);
    assert.deepEqual(await call(params), {
      error: { code: "non-fast-forward" },
    });
    assert.partialDeepStrictEqual(
      await readOperatorGoal(store, f.directory, ref, destination),
      { exportPreview: null, exportBlockReason: "non-fast-forward" },
    );
    f.git(["update-ref", "-d", f.ref, f.next]);

    const checkout = join(root, "export-checkout");
    f.git(["worktree", "add", "-b", branch, checkout, f.base]);
    assert.deepEqual(await call(params), {
      error: { code: "branch-checked-out" },
    });
    assert.partialDeepStrictEqual(
      await readOperatorGoal(store, f.directory, ref, destination),
      { exportPreview: null, exportBlockReason: "branch-checked-out" },
    );
    f.git(["worktree", "remove", checkout]);
    assert.deepEqual(
      await call(params, {
        ...destination,
        scan: async () => {
          f.git(["worktree", "add", checkout, branch]);
        },
      }),
      { error: { code: "branch-checked-out" } },
    );
    assert.equal(exportedRef(), f.base);
    f.git(["worktree", "remove", checkout]);
    f.git(["update-ref", "-d", f.ref, f.base]);

    const cancelled = goal(store);
    assert.partialDeepStrictEqual(
      await readOperatorGoal(store, f.directory, cancelled, destination),
      { exportPreview: null, exportBlockReason: null },
    );
    assert.deepEqual(
      await operatorAction(store, f.directory, "goal.discard", {
        id: cancelled,
        confirm: store.getGoal(cancelled)!.ref,
        expectedHead: null,
      }),
      {
        result: {
          id: cancelled,
          ref: store.getGoal(cancelled)!.ref,
          status: "cancelled",
        },
      },
    );
    assert.deepEqual(await call({ ...params, id: cancelled }), {
      error: { code: "goal-inactive" },
    });
    const legacy = new Database(state.filename);
    legacy
      .query("UPDATE goals SET base_commit = NULL WHERE id = ?")
      .run(f.goalId);
    legacy.close();
    assert.equal(store.getGoal(f.goalId)?.baseCommit, null);
    assert.deepEqual(
      await call(params, {
        ...destination,
        scan: createCredentialScanner(
          { leakPatterns: ["Candidate 1"] },
          root,
          () => {},
        ),
      }),
      { error: { code: "credential-leak" } },
    );
    assert.deepEqual(
      await call(params, {
        ...destination,
        scan: async () => {
          throw new Error("fixture scanner failed");
        },
      }),
      { error: { code: "write-failed" } },
    );
    assert.equal(exportedRef(), "");
    assert.deepEqual(audit(), []);
    const bothScanned = Promise.withResolvers<void>();
    const overlapping = {
      ...destination,
      async scan() {
        if (++scans === 2) bothScanned.resolve();
        await bothScanned.promise;
      },
    };
    const concurrent = await Promise.all([
      call({ ...params, id: f.goalId }, overlapping),
      call(params, overlapping),
    ]);
    assert.deepEqual(
      concurrent.find((reply) => "result" in reply),
      {
        result: { id: f.goalId, ref, branch, from: null, to },
      },
    );
    assert.deepEqual(
      concurrent.find((reply) => "error" in reply),
      {
        error: { code: "stale-base" },
      },
    );
    assert.equal(exportedRef(), to);
    const uiAudit = audit();
    assert.deepEqual(
      uiAudit.map(({ kind, data }) => ({ kind, data })),
      [
        { kind: "goal.exported", data: { branch, from: null, to } },
        { kind: "goal.export-authorized", data: { branch, from: null, to } },
      ],
    );

    assert.partialDeepStrictEqual(
      await readOperatorGoal(store, f.directory, ref, destination),
      {
        exportPreview: null,
        turn: { owner: "done", reason: { kind: "exported", branch } },
      },
    );
    assert.deepEqual(await call(params), {
      error: { code: "already-exported" },
    });
    const noOp = await f.cli(["export-goal-branch", ref], true, () => confirm);
    assert.equal(noOp.code, 1);
    assert.deepEqual(noOp.questions, []);
    assert.match(noOp.stderr.join(""), /already points to the Goal head/);
    assert.deepEqual(audit(), uiAudit);

    f.git(["update-ref", "-d", f.ref, to]);
    const cli = await f.cli(["export-goal-branch", ref], true, () => confirm);
    assert.equal(cli.code, 0);
    assert.deepEqual(audit(), [...uiAudit, ...uiAudit]);

    f.git(["update-ref", "-d", f.ref, to]);
    const db = new Database(state.filename);
    try {
      db.exec(`
        CREATE TRIGGER reject_export_authorization BEFORE INSERT ON events
        WHEN NEW.kind = 'goal.export-authorized'
        BEGIN SELECT RAISE(ABORT, 'audit failure'); END
      `);
      assert.deepEqual(await call(params), { error: { code: "write-failed" } });
      assert.equal(exportedRef(), "");
      assert.deepEqual(audit(), [...uiAudit, ...uiAudit]);
      db.exec(`
        DROP TRIGGER reject_export_authorization;
        CREATE TRIGGER reject_export_completion BEFORE INSERT ON events
        WHEN NEW.kind = 'goal.exported'
        BEGIN SELECT RAISE(ABORT, 'audit failure'); END
      `);
      // An audit write failure quarantines that store connection.
      const reopened = OrchestratorStore.open(state.filename);
      try {
        assert.deepEqual(
          await operatorAction(
            reopened,
            f.directory,
            "goal.export",
            params,
            destination,
          ),
          { error: { code: "goal-export-record-failed" } },
        );
      } finally {
        reopened.close();
      }
      assert.equal(exportedRef(), to);
      assert.deepEqual(audit(), [uiAudit[1], ...uiAudit, ...uiAudit]);
    } finally {
      db.close();
    }
  },
);

test(
  "export refuses an unaudited private head before and after confirmation",
  gitTestOptions,
  async () => {
    using state = orchestratorFixture("lo-tasks-");
    const { root, store } = state;
    const f = stage3Fixture(state);
    const proposal = await f.proposal();
    approve(store, proposal);
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
  },
);

test(
  "credential text in candidate content, commit messages, or review answers fails the Task",
  gitTestOptions,
  async () => {
    using state = orchestratorFixture("lo-tasks-");
    const { root, store } = state;
    const repoRoot = join(root, "repo");
    mkdirSync(repoRoot);
    const git = (args: string[]) => command("/usr/bin/git", repoRoot, args);
    git(["init", "--template=", "--initial-branch=main"]);
    mkdirSync(join(repoRoot, "docs"));
    writeFileSync(join(repoRoot, "docs", "file"), "before\n");
    git(["add", "."]);
    git(["commit", "-m", "initial"]);
    const env = configEnv(root);
    addProject(repoRoot, undefined, env);
    const target = await resolveTarget(repoRoot, root, env);
    const { directory } = target;
    await prepareTargetDirectory(target.bootstrapRoot, directory, env);
    const scratch = join(root, "scratch");
    mkdirSync(join(scratch, "docs"), { recursive: true });
    const secret = "sk-ant-6XX4TbRwxwZyOuIuFZzWa5vP6KJ";
    for (const input of ["file", "message", "review"] as const) {
      const notes: string[] = [];
      let reviews = 0;
      const scan = createCredentialScanner({}, root, (note) =>
        notes.push(note),
      );
      const executor = createTaskExecutor({
        store,
        repoRoot,
        directory,
        scan,
        worker: () => harness,
        reviewer: harness,
        host: {
          async runWorker(_, id) {
            writeFileSync(
              join(scratch, "docs", "file"),
              input === "file" ? secret : "after\n",
            );
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
                ...(input === "message"
                  ? { message: Buffer.from(secret) }
                  : {}),
              },
            };
          },
          async runVerification() {
            throw new Error("Unexpected verification");
          },
          async runReviewer(_, id) {
            reviews++;
            return {
              id: id!,
              outcome: "ok",
              response: Buffer.from(
                JSON.stringify({
                  result: JSON.stringify({ review: "revise", notes: secret }),
                }),
              ),
            };
          },
        },
      });
      const goalId = goal(store);
      const id = task(store, goalId);
      await runTask(store, executor, id, undefined, scan);
      assert.equal(store.getTask(id)?.status, "failed");
      assert.equal(store.pendingIntegrations(goalId).length, 0);
      assert.deepEqual(store.listEvents({ subjectId: id, limit: 1 })[0]?.data, {
        status: "failed",
        code: "credential-leak",
      });
      assert.ok(
        !JSON.stringify(
          store.listEvents({ subjectId: id, limit: 50 }),
        ).includes(secret),
      );
      assert.equal(reviews, input === "review" ? 1 : 0);
      assert.equal(notes.length, 1);
    }
  },
);

test(
  "integration rules use real Git counts and are outranked by Goal and Task settings",
  gitTestOptions,
  async () => {
    using state = orchestratorFixture("lo-tasks-");
    const { store } = state;
    const f = stage3Fixture(state, undefined, "pass");
    const proposal = await f.proposal();
    assert.equal(proposal.source, "default");
    const rule = {
      id: "one-file",
      name: "One Markdown file",
      gate: "integration",
      order: 0,
      action: "agent",
      enabled: true,
      conditions: {
        pathsWithin: ["docs/*.md"],
        maxChangedFiles: 1,
        maxChangedLines: 100,
      },
    };
    store.setRules(
      [{ ...rule, conditions: { ...rule.conditions, maxChangedLines: 0 } }],
      "operator-ui",
    );
    assert.equal(store.getProposalDetails(proposal.id)?.source, "default");
    store.setRules([rule], "operator-ui");
    assert.partialDeepStrictEqual(store.getProposalDetails(proposal.id), {
      policy: "agent",
      source: "rule",
      ruleId: rule.id,
    });
    store.setGoalPolicy(f.goalId, "integration", "human", "operator-ui");
    assert.partialDeepStrictEqual(store.getProposalDetails(proposal.id), {
      policy: "human",
      source: "operator-goal",
    });
    store.setTaskIntegrationPolicy(f.taskId, "agent", "operator-ui");
    assert.partialDeepStrictEqual(
      store.effectivePolicy("integration", { taskId: f.taskId }),
      { policy: "agent", source: "operator-task" },
    );
    store.setTaskIntegrationPolicy(f.taskId, "rule", "operator-ui");
    store.setGoalPolicy(f.goalId, "integration", "inherit", "operator-ui");
    assert.partialDeepStrictEqual(store.getProposalDetails(proposal.id), {
      policy: "agent",
      source: "rule",
    });
    await assert.rejects(
      Promise.resolve().then(() =>
        store.decide(proposal.id, {
          digest: proposal.digest,
          decision: "approve",
          answerer: { kind: "human", channel: "operator-ui" },
        }),
      ),
      { code: "approval-forbidden" },
    );
  },
);

test("a deleted symlink reserves integration for a human even with a Task override", async () => {
  using state = orchestratorFixture("lo-tasks-");
  const { store } = state;
  const goalId = goal(store);
  const taskId = task(store, goalId);
  const gone = fixture({
    async verify() {
      return true;
    },
    async changes() {
      return [{ path: "docs/link", oldMode: "120000", newMode: "000000" }];
    },
  });
  store.setGoalPolicy(goalId, "integration", "agent", "operator-ui");
  store.setTaskIntegrationPolicy(taskId, "agent", "operator-ui");
  await runner(store, gone.executor).drain();
  const [proposal] = store.pendingIntegrations();
  assert.ok(proposal?.kind === "integration");
  assert.deepEqual(proposal.content.symlinks, ["docs/link"]);
  assert.partialDeepStrictEqual(proposal, {
    policy: "human",
    source: "invariant",
    invariant: "integration-symlinks",
  });
  assert.partialDeepStrictEqual(
    store.effectivePolicy("integration", { taskId }),
    {
      policy: "human",
      source: "invariant",
      invariant: "integration-symlinks",
    },
  );
});

test("a file-count rule still matches when Git cannot supply a line count", async () => {
  using state = orchestratorFixture("lo-tasks-");
  const { store } = state;
  const goalId = goal(store);
  task(store, goalId);
  const noStat = fixture({
    async verify() {
      return true;
    },
  });
  const rule = {
    id: "small",
    name: "Small change",
    gate: "integration",
    action: "human",
    enabled: true,
    order: 1,
    conditions: { maxChangedFiles: 1 },
  };
  store.setRules(
    [
      {
        ...rule,
        id: "needs-lines",
        action: "agent",
        order: 0,
        conditions: { maxChangedLines: 1 },
      },
      rule,
    ],
    "cli",
  );
  await runner(store, noStat.executor).drain();
  assert.partialDeepStrictEqual(store.pendingIntegrations()[0], {
    policy: "human",
    source: "rule",
    ruleId: rule.id,
  });
});

test("Task detail records the Codex Executor and its auth recovery action", async () => {
  using state = orchestratorFixture("local-codex-task-");
  const { store } = state;
  const goalId = goal(store);
  for (const code of Object.keys(
    codexFailureActions,
  ) as (keyof typeof codexFailureActions)[]) {
    const taskId = task(store, goalId);
    const agent = { harness: "codex", model: "fixture-model" } as const;
    const { executor, calls } = fixture({
      workerAgent: agent,
      async worker(_id, _revision, observed) {
        observed.outcome = "failed";
        observed.code = code;
        throw new Error("Worker did not produce an eligible change");
      },
    });
    await runTask(store, executor, taskId);
    const detail = operatorTask(store, taskId);
    assert.equal(detail?.failure?.code, code);
    assert.equal(detail?.failure?.next, codexFailureActions[code]);
    const execution = detail?.executions[0];
    assert.equal(execution?.harness, agent.harness);
    assert.equal(execution?.model, agent.model);
    assert.equal(execution?.status, "failed");
    assert.deepEqual(calls, []);
    const stored = store.getExecution(execution!.id);
    assert.equal(stored?.harness, agent.harness);
    assert.equal(stored?.model, agent.model);
    assert.deepEqual(
      store
        .listEvents({ subjectId: execution!.id, limit: 10 })
        .find(({ kind }) => kind === "execution.started")?.data,
      agent,
    );
  }
});

test("a saved guest auth report uses the current execution guidance", () => {
  using state = orchestratorFixture("local-codex-task-");
  const { store } = state;
  const taskId = task(store, goal(store));
  assert.ok(store.claimTask(taskId));
  const execution = store.createExecution({
    actor: "Executor",
    mode: "task",
    taskId,
    requestedBy: { kind: "host" },
  });
  store.startExecution(execution.id);
  store.finishExecution(execution.id, "failed", {
    code: "codex-auth",
    next: "Run agent-bootstrap codex authorize, then retry the Task.",
  });
  assert.deepEqual(store.getExecution(execution.id)?.result, {
    code: "codex-auth",
    next: "The Executor reported that the provider rejected the credential. Inspect the execution.",
  });
});

test("Task environment records failures when the profile or commit is unavailable", async () => {
  using fixture = orchestratorFixture("task-environment-preflight-");
  const env = configEnv(fixture.root);
  const digest = "a".repeat(64);
  const events: Parameters<OrchestratorStore["recordTaskEnvironment"]>[1][] =
    [];
  const executionId = randomUUID();
  const ensure = taskEnvironment(
    {
      profile: {
        image: `localhost/agent-bootstrap/bun@sha256:${digest}`,
        recipeDigest: digest,
        memoryMiB: 2048,
        cpus: 2,
      },
      allow: [],
      requireAudit(id) {
        assert.equal(id, executionId);
      },
      host: {
        env,
        store: new EnvironmentStore("a".repeat(12), env),
        async run() {
          assert.fail("unexpected provisioning command");
        },
        async openGateway() {
          assert.fail("unexpected gateway");
        },
      },
    },
    {
      recordTaskEnvironment(id, event) {
        assert.equal(id, executionId);
        events.push(event);
      },
    },
    join(fixture.root, "missing.git"),
  );

  for (const profile of ["base", "bun"] as const) {
    await assert.rejects(
      ensure({
        role: "Executor",
        commit: "a".repeat(40),
        profile,
        executionId,
      }),
      { code: "env-build-failed" },
    );
    assert.equal(events.length, 2);
    const [started, finished] = events.splice(0);
    assert.equal(started?.kind, "environment.started");
    assert.equal(finished?.kind, "environment.finished");
    assert.equal(finished.invocationId, started.invocationId);
    assert.equal(started.key, undefined);
    assert.equal(finished.key, undefined);
    assert.equal(finished.failure, "env-build-failed");
  }
});

for (const scenario of [
  "build",
  "executor cache miss",
  "verification cache miss",
  "integration cache miss",
  "workspace outputs",
  "output collision",
  "tracked output collision",
  "mismatch",
  "resolve",
  "resolve without suite",
  "resolve failure without suite",
  "resolve disabled without suite",
  "update",
  "update disabled",
  "update workspace excluded",
  "update audit unavailable",
  "invalid manifest",
  "candidate invalid manifest",
  "tampered",
  "truncated",
  "audit unavailable",
  "worker failure",
] as const)
  test(
    `local Task environment handles ${scenario}`,
    gitTestOptions,
    async (t) => {
      using fixture = orchestratorFixture("task-environment-");
      const { root, store, filename } = fixture;
      const repoRoot = join(root, "source");
      mkdirSync(repoRoot);
      const git = (args: string[]) =>
        String(command("/usr/bin/git", repoRoot, args, "utf8")).trim();
      git(["init", "--template=", "--initial-branch=main"]);
      const trackedOutput = scenario === "tracked output collision";
      const outputCollision = scenario === "output collision" || trackedOutput;
      const workspace = scenario === "workspace outputs" || outputCollision;
      const noSuite = scenario.endsWith("without suite");
      const resolveFails = scenario === "resolve failure without suite";
      const resolveDisabled = scenario === "resolve disabled without suite";
      const resolves =
        scenario === "resolve" || scenario === "resolve without suite";
      const excludedWorkspace = scenario === "update workspace excluded";
      const updating = scenario.startsWith("update");
      const successful = scenario === "build" || workspace || resolves;
      const update = {
        adapter: "bun",
        packages: ["@fixture/a"],
        allowMajor: true,
      } as const;
      const revise = scenario === "mismatch" || outputCollision;
      const executorMiss = scenario === "executor cache miss";
      const verificationMiss = scenario === "verification cache miss";
      const integrationMiss = scenario === "integration cache miss";
      const candidateInvalidManifest =
        scenario === "candidate invalid manifest";
      const manifest =
        scenario === "invalid manifest"
          ? '{"workspaces":false}'
          : excludedWorkspace
            ? '{"name":"fixture","workspaces":["packages/*"]}'
            : updating
              ? '\uFEFF{"name":"fixture","dependencies":{"@fixture/a":"^1.0.0"}}'
              : '{"name":"fixture"}';
      const changedManifest = workspace
        ? '{"name":"candidate","workspaces":["packages/*"]}'
        : updating
          ? manifest.replace("^1.0.0", "^2.0.0")
          : '{"name":"candidate"}';
      const packageManifest = '{"name":"a"}';
      const bunLock = '{"lockfileVersion":1,"packages":{}}';
      const changedLock =
        '{"lockfileVersion":1,"packages":{"@fixture/a":["@fixture/a@2.0.0"]}}';
      writeFileSync(join(repoRoot, "package.json"), manifest);
      writeFileSync(join(repoRoot, "bun.lock"), bunLock);
      if (excludedWorkspace) {
        mkdirSync(join(repoRoot, "packages/a"), { recursive: true });
        writeFileSync(
          join(repoRoot, "packages/a/package.json"),
          packageManifest,
        );
      }
      const trackedPath = "packages/a/node_modules/tracked";
      if (trackedOutput) {
        mkdirSync(join(repoRoot, "packages/a/node_modules"), {
          recursive: true,
        });
        writeFileSync(join(repoRoot, trackedPath), "tracked in base");
      }
      git(["add", "."]);
      git(["commit", "-m", "base"]);

      const env = configEnv(root);
      addProject(repoRoot, undefined, env);
      const target = await resolveTarget(repoRoot, root, env);
      const { directory } = target;
      await prepareTargetDirectory(target.bootstrapRoot, directory, env);
      const goalId = goal(
        store,
        noSuite ? { integration: "agent" } : undefined,
        "bun",
      );
      const taskId = task(store, goalId, {
        profile: "bun",
        ...(updating && { environment: { update } }),
        paths:
          updating || noSuite || resolves || scenario === "mismatch"
            ? ["package.json", "bun.lock"]
            : workspace
              ? ["package.json", "packages/"]
              : candidateInvalidManifest
                ? ["package.json", "node_modules/"]
                : ["package.json"],
        budgets: { ...budgets, maxRetries: 1 },
      });
      const cache = new EnvironmentStore(target.project.id, env);
      const digest = "a".repeat(64);
      const keyFor = async (
        content: string,
        workspace = false,
        lock = bunLock,
      ) =>
        (
          await identifyEnvironment(
            {
              paths: [
                "bun.lock",
                "package.json",
                ...(workspace ? ["packages/a/package.json"] : []),
              ],
              async read(path) {
                return Buffer.from(
                  path === "bun.lock"
                    ? lock
                    : path === "package.json"
                      ? content
                      : packageManifest,
                );
              },
            },
            digest,
            bunAdapter,
          )
        ).key;
      const baseKey = await keyFor(
        scenario === "invalid manifest" ? '{"name":"fixture"}' : manifest,
        excludedWorkspace,
      );
      const candidateKey = await keyFor(
        changedManifest,
        workspace,
        resolves || updating ? changedLock : bunLock,
      );
      const entry = (
        path: string,
        type: TarEntryView["type"],
        content = "",
      ) => ({
        path,
        type,
        mode: type === "directory" ? 0o755 : 0o644,
        linkname: "",
        data: Buffer.from(content),
      });
      const archive = writeWorkspaceTar([entry("node_modules", "directory")]);
      const updatedArchive = writeWorkspaceTar([
        entry("node_modules", "directory"),
        entry("node_modules/updated", "file", "updated"),
      ]);
      if (!executorMiss)
        await cache.publish(
          {
            key: baseKey,
            adapter: "bun",
            profileDigest: digest,
            hasLock: true,
            packages: [],
            size: archive.length,
            createdAt: new Date().toISOString(),
          },
          archive,
        );
      if (scenario === "truncated")
        writeFileSync(
          join(cache.directory, "entries", baseKey, "outputs.tar"),
          "",
        );
      if (scenario === "tampered")
        writeFileSync(
          join(cache.directory, "entries", baseKey, "outputs.tar"),
          writeWorkspaceTar([entry("outside", "directory")]),
        );

      let workerRuns = 0;
      let verifyRuns = 0;
      let reviewerRuns = 0;
      let provisionerCommands = 0;
      const provisioning: string[] = [];
      const operations: string[] = [];
      const executor = createTaskExecutor({
        repoRoot,
        directory,
        store,
        worker: () => harness,
        reviewer: harness,
        ...(!noSuite && {
          verification: configuredVerification({
            profile: "bun",
            argv: ["bun", "test"],
          }),
        }),
        environment: {
          ...(successful ||
          resolveFails ||
          revise ||
          (updating && scenario !== "update disabled")
            ? { autoBuild: true }
            : {}),
          profile: {
            image: `localhost/agent-bootstrap/bun@sha256:${digest}`,
            recipeDigest: digest,
            memoryMiB: 2048,
            cpus: 2,
          },
          allow: [],
          requireAudit() {
            if (
              scenario === "audit unavailable" ||
              scenario === "update audit unavailable"
            )
              throw new Error("audit unavailable");
          },
          host: {
            env,
            store: cache,
            async run(args) {
              provisionerCommands++;
              const script = args.at(-1) ?? "";
              if (args[0] === "exec") {
                const operation = script.includes("'update'")
                  ? "update"
                  : script.includes("'install'")
                    ? script.includes("'--frozen-lockfile'")
                      ? "build"
                      : "resolve"
                    : undefined;
                if (operation) {
                  operations.push(operation);
                  assert.match(
                    activityLabel(
                      operatorActivity({ store, target: repoRoot }),
                    ),
                    operation === "build" ? /環境を準備中/ : /依存を解決中/,
                  );
                  if (operation === "update")
                    assert.match(script, /--latest.*@fixture\/a/);
                  if (
                    scenario === "mismatch" ||
                    (resolves && operations.length === 1) ||
                    (resolveFails &&
                      (operation === "build" || operation === "resolve"))
                  )
                    return { code: 1, stdout: "", stderr: "frozen lockfile" };
                }
              }
              if (args[0] === "copy") {
                const resource = args[1]!;
                writeFileSync(
                  args[2]!,
                  resource.endsWith("declarations.tar")
                    ? writeWorkspaceTar([
                        entry(
                          "package.json",
                          "file",
                          scenario === "update"
                            ? '{"dependencies":{"@fixture/a":"^2.0.0"},"name":"fixture"}\n'
                            : changedManifest,
                        ),
                      ])
                    : resource.endsWith("bun.lock")
                      ? changedLock
                      : workspace
                        ? writeWorkspaceTar([
                            entry("node_modules", "directory"),
                            entry("packages/a/node_modules", "directory"),
                          ])
                        : updating
                          ? updatedArchive
                          : archive,
                );
              }
              return { code: 0, stdout: "" };
            },
            async openGateway({ executionId }) {
              provisioning.push(executionId);
              return {
                socksPort: 19100,
                dnsPort: 19153,
                username: "fake",
                password: "fixture",
                quarantined: false,
                async close() {},
              };
            },
          },
        },
        host: {
          async runWorker(plan, id) {
            workerRuns++;
            assert.ok(plan.sandbox.environment);
            assert.match(plan.command.argv[2]!, /AGENT_BOOTSTRAP_ENV_PATH/);
            assert.deepEqual(
              cache.prune({ keep: 0 }),
              updating && workerRuns === 1 ? [baseKey] : [],
            );
            if (updating) {
              assert.deepEqual(
                plan.sandbox.environment.archive,
                updatedArchive,
              );
              const tree = readTar(
                readFileSync(plan.sandbox.repository!.tree),
                undefined,
                true,
              );
              assert.equal(
                Buffer.from(
                  tree.find(({ path }) => path === "package.json")!.data,
                ).toString(),
                changedManifest,
              );
              assert.equal(
                Buffer.from(
                  tree.find(({ path }) => path === "bun.lock")!.data,
                ).toString(),
                changedLock,
              );
              assert.ok(cache.get(candidateKey));
            } else {
              assert.deepEqual(
                cache.list().map(({ key }) => key),
                [baseKey],
              );
            }
            if (scenario === "worker failure")
              throw new Error("fixture worker failure");
            if (integrationMiss)
              await cache.publish(
                {
                  key: candidateKey,
                  adapter: "bun",
                  profileDigest: digest,
                  hasLock: true,
                  packages: [],
                  size: archive.length,
                  createdAt: new Date().toISOString(),
                },
                archive,
              );
            if (workerRuns === 2 && !updating) {
              if (trackedOutput) {
                const previous = readTar(
                  readFileSync(plan.sandbox.repository!.tree),
                  undefined,
                  true,
                );
                const tracked = previous.find(
                  ({ path }) => path === trackedPath,
                );
                assert.equal(
                  Buffer.from(tracked!.data).toString(),
                  "tracked in base",
                );
              }
              const notes = plan.sandbox.readOnlyFiles?.find(
                ({ path }) => path === "review-notes.txt",
              );
              assert.equal(
                Buffer.from(notes!.bytes).toString(),
                outputCollision
                  ? environmentOutputCollisionNote
                  : environmentLockMismatchNote,
              );
            }
            return {
              id: id!,
              outcome: "ok",
              artifacts: {
                files: [],
                message: Buffer.from(
                  "Change fixture manifest\n\nKeep the fixture in sync.",
                ),
                tree: writeWorkspaceTar([
                  entry(
                    "package.json",
                    "file",
                    candidateInvalidManifest
                      ? '{"workspaces":false}'
                      : changedManifest,
                  ),
                  entry("bun.lock", "file", updating ? changedLock : bunLock),
                  entry("node_modules", "directory"),
                  entry("node_modules/agent-write", "file", "discard this"),
                  ...(scenario === "workspace outputs"
                    ? [
                        entry(
                          "Node_modules/alias",
                          "file",
                          "discard this alias",
                        ),
                      ]
                    : []),
                  ...(workspace
                    ? [
                        entry(
                          "packages/a/package.json",
                          "file",
                          packageManifest,
                        ),
                        entry(
                          "packages/a/node_modules/generated",
                          "file",
                          "discard this too",
                        ),
                      ]
                    : []),
                  ...(scenario === "output collision" && workerRuns === 1
                    ? [
                        entry(
                          "packages/a/Node_modules/alias",
                          "file",
                          "remove on revision",
                        ),
                      ]
                    : []),
                  ...(trackedOutput && workerRuns === 1
                    ? [entry(trackedPath, "file", "modified in collection")]
                    : []),
                ]),
              },
            };
          },
          async runVerification(plan, id) {
            verifyRuns++;
            assert.ok(plan.sandbox.environment);
            assert.equal(cache.get(candidateKey)?.key, candidateKey);
            if (!updating)
              assert.deepEqual(cache.prune({ keep: 0 }), [baseKey]);
            return {
              id: id!,
              outcome: "ok",
              response: Buffer.from('{"review":"pass"}'),
            };
          },
          async runReviewer(plan, id) {
            reviewerRuns++;
            assert.equal(Object.hasOwn(plan.sandbox, "environment"), false);
            if (updating || resolves) {
              const packages = plan.sandbox.readOnlyFiles?.find(
                ({ path }) => path === "candidate.packages.json",
              );
              assert.deepEqual(
                JSON.parse(Buffer.from(packages!.bytes).toString()).added,
                ["@fixture/a@2.0.0"],
              );
            }
            const diff = plan.sandbox.readOnlyFiles?.find(
              ({ path }) => path === "candidate.diff",
            );
            const text = Buffer.from(diff!.bytes).toString();
            assert.doesNotMatch(
              text,
              /node_modules\/(?:generated|agent-write|alias)/i,
            );
            if (trackedOutput)
              assert.match(
                text,
                /--- a\/packages\/a\/node_modules\/tracked\n\+\+\+ \/dev\/null\n/,
              );
            if (workspace)
              assert.match(
                Buffer.from(diff!.bytes).toString(),
                /packages\/a\/package\.json/,
              );
            return {
              id: id!,
              outcome: "ok",
              response: Buffer.from(
                JSON.stringify({
                  result: JSON.stringify({
                    review: updating && reviewerRuns === 1 ? "revise" : "pass",
                  }),
                }),
              ),
            };
          },
        },
      });
      const hold = t.mock.method(cache, "hold");
      await runTask(store, executor, taskId);
      if (integrationMiss) {
        const [proposal] = store.pendingIntegrations();
        assert.ok(proposal?.kind === "integration");
        assert.deepEqual(cache.prune({ keep: 0 }), [candidateKey]);
        approve(store, proposal);
        const finish = t.mock.method(store, "finishIntegration");
        await executor.integrate!(proposal.id);
        assert.deepEqual(
          finish.mock.calls.map(({ arguments: args }) => args),
          [[proposal.id, "denied", "env-missing"]],
        );
        assert.equal(
          await executor.existingBase!(goalId),
          proposal.content.base,
        );
      }
      const detail = operatorTask(store, taskId)!;
      if (updating) {
        assert.deepEqual(detail.environment, { update });
        if (scenario !== "update") {
          assert.equal(
            workerRuns + verifyRuns + reviewerRuns + provisionerCommands,
            0,
          );
          assert.equal(
            detail.failure?.code,
            scenario === "update disabled"
              ? "env-update-disabled"
              : excludedWorkspace
                ? "env-lock-mismatch"
                : "host-error",
          );
          if (scenario === "update disabled")
            assert.match(detail.failure?.next ?? "", /environment.autoBuild/);
          return;
        }
        assert.equal(
          detail.status,
          "awaiting-integration",
          detail.failure?.code,
        );
        assert.deepEqual(detail.packageDiff, {
          added: ["@fixture/a@2.0.0"],
          removed: [],
          changed: [],
          totals: { added: 1, removed: 0, changed: 0 },
        });
        assert.deepEqual(operations, ["update", "build"]);
        assert.equal(workerRuns, 2);
        assert.equal(reviewerRuns, 2);
        assert.equal(verifyRuns, 2);
        const events = await new IntegrationJournal(
          join(directory, "integrations", taskId),
          taskId,
        ).read();
        const updated = events.find(
          ({ kind }) => kind === "environment.updated",
        );
        assert.ok(updated?.kind === "environment.updated");
        assert.deepEqual(updated.changedPaths, ["bun.lock", "package.json"]);
        assert.match(
          String(
            command(
              "/usr/bin/git",
              join(directory, "repository.git"),
              ["show", "-s", "--format=%B", updated.candidate],
              "utf8",
            ),
          ),
          new RegExp(`Agent-Bootstrap-Provisioner-Run: ${provisioning[0]}`),
        );
        const first = detail.executions
          .filter(({ mode }) => mode === "task")
          .at(-1)!;
        const updateEvents = store.listEvents({
          subjectId: first.id,
          limit: 20,
        });
        assert.ok(
          updateEvents.some(({ kind }) => kind === "environment.package-diff"),
        );
        const audit = new SqliteAudit(join(cache.directory, "audit.sqlite"), {
          readonly: true,
        });
        try {
          assert.ok(
            audit
              .read(provisioning[0]!)
              .some(
                ({ kind, role, detail }) =>
                  kind === "environment.finished" &&
                  role === "Provisioner" &&
                  JSON.stringify(detail).includes(
                    '"changedPaths":["bun.lock","package.json"]',
                  ),
              ),
          );
        } finally {
          audit.close();
        }
        const [firstProposal] = store.pendingIntegrations();
        assert.ok(firstProposal?.kind === "integration");
        store.decide(firstProposal.id, {
          decision: "reject",
          digest: firstProposal.digest,
          answerer: { kind: "human" },
        });
        store.retryTask(taskId, 0);
        await runTask(store, executor, taskId);
        const [retry] = store.pendingIntegrations();
        assert.ok(retry?.kind === "integration");
        assert.equal(retry.content.base, firstProposal.content.base);
        assert.deepEqual(operations, ["update", "build"]);
        assert.equal(workerRuns, 3);
        const retryJournal = await new IntegrationJournal(
          join(directory, "integrations", taskId, "retry-1"),
          taskId,
        ).read();
        assert.partialDeepStrictEqual(
          retryJournal.find(({ kind }) => kind === "environment.updated"),
          {
            candidate: updated.candidate,
            changedPaths: updated.changedPaths,
          },
        );
        return;
      }
      if (resolveFails || resolveDisabled) {
        assert.equal(detail.status, "failed");
        assert.equal(
          detail.failure?.code,
          resolveDisabled ? "env-missing" : "env-lock-mismatch",
        );
        assert.deepEqual(
          operations,
          resolveDisabled ? [] : ["build", "resolve"],
        );
        assert.equal(workerRuns, 1);
        assert.equal(verifyRuns + reviewerRuns, 0);
        return;
      }
      if (resolves) {
        assert.equal(detail.status, "awaiting-integration");
        assert.deepEqual(operations, ["build", "resolve", "build"]);
        assert.deepEqual(detail.packageDiff?.added, ["@fixture/a@2.0.0"]);
        const [proposal] = store.pendingIntegrations();
        assert.ok(proposal?.kind === "integration");
        assert.deepEqual(proposal.content.changedPaths, [
          "bun.lock",
          "package.json",
        ]);
        const events = await new IntegrationJournal(
          join(directory, "integrations", taskId),
          taskId,
        ).read();
        const authorized = events.find(
          (event) => event.kind === "environment.resolve-authorized",
        );
        assert.ok(authorized?.kind === "environment.resolve-authorized");
        assert.deepEqual(authorized.changedPaths, ["bun.lock"]);
        assert.match(
          String(
            command(
              "/usr/bin/git",
              join(directory, "repository.git"),
              ["show", "-s", "--format=%B", proposal.content.candidate],
              "utf8",
            ),
          ),
          new RegExp(
            String.raw`^Change fixture manifest\n\nKeep the fixture in sync\.\n\nAgent-Bootstrap-Worker-Run: .*\nAgent-Bootstrap-Provisioner-Paths: \["bun\.lock"\]\nAgent-Bootstrap-Provisioner-Run: ${provisioning[1]}`,
          ),
        );
        if (noSuite) {
          assert.equal(verifyRuns, 0);
          assert.equal(reviewerRuns, 1);
          assert.equal(proposal.content.verified, false);
          assert.equal(proposal.invariant, "integration-verification");
          assert.equal(
            store.getProposalDetails(proposal.id)?.humanAnswerRequired,
            true,
          );
          assert.equal(
            detail.executions.some(({ mode }) => mode === "verification"),
            false,
          );
          await assert.rejects(
            runner(store, executor).requestApproval(proposal.id),
            {
              code: "approval-forbidden",
            },
          );
          assert.equal(
            events.some(({ kind }) => kind.startsWith("verification.")),
            false,
          );
          approve(store, proposal);
          await executor.integrate!(proposal.id);
          assert.equal(store.getTask(taskId)?.status, "succeeded");
          return;
        }
      }
      if (executorMiss || verificationMiss || integrationMiss) {
        const key = executorMiss ? baseKey : candidateKey;
        const mode = executorMiss ? "task" : "verification";
        const message = executorMiss
          ? "このキーの環境がありません。agent-bootstrap environment build --target <dir> --allow-network を実行するか、environment.autoBuild を有効にしてください。"
          : "変更候補のキーの環境がありません。environment build はローカルの main にコミットされた内容だけをビルドします。変更候補が依存関係の宣言を変更して新しい環境が必要な場合は、environment.autoBuild を有効にしてください。";
        assert.equal(detail.status, "failed");
        assert.equal(detail.failure?.code, "env-missing");
        assert.equal(detail.failure?.next, message);
        assert.equal(failureLabel("env-missing"), "環境が未構築");
        const inboxItem = projectInbox({ store, target: repoRoot }).find(
          (item) =>
            item.kind === "task-failed" && item.subject.taskId === taskId,
        );
        assert.equal(
          inboxItem?.title,
          `Task ${detail.ref} failed (env-missing)`,
        );
        assert.ok(
          operatorProblems(store).some(
            (problem) =>
              problem.kind === "task-failed" &&
              problem.code === "env-missing" &&
              problem.detail.startsWith(message),
          ),
        );
        const execution = detail.executions.find(
          (run) => run.mode === mode && run.status === "failed",
        );
        assert.ok(execution);
        assert.deepEqual(execution.environment, {
          key,
          cacheHit: false,
          failure: "env-missing",
        });
        assert.partialDeepStrictEqual(store.getExecution(execution.id), {
          status: "failed",
          result: {
            code: "env-missing",
            next: message,
            ...(integrationMiss && { phase: "integration" }),
          },
        });
        const events = store
          .listEvents({ subjectId: execution.id, limit: 10 })
          .filter(({ kind }) => kind.startsWith("environment."))
          .reverse();
        assert.deepEqual(
          events.map(({ kind }) => kind),
          ["environment.started", "environment.finished"],
        );
        const [started, finished] = events.map(({ data }) => data);
        assert.partialDeepStrictEqual(started, { key, cacheHit: false });
        assert.partialDeepStrictEqual(finished, {
          key,
          cacheHit: false,
          failure: "env-missing",
          invocationId: (started as { invocationId: string }).invocationId,
        });
        assert.equal(provisionerCommands, 0);
        assert.deepEqual(provisioning, []);
        assert.equal(workerRuns, executorMiss ? 0 : 1);
        assert.equal(verifyRuns, integrationMiss ? 1 : 0);
        assert.equal(reviewerRuns, integrationMiss ? 1 : 0);
        if (executorMiss) assert.equal(hold.mock.callCount(), 0);
        if (verificationMiss)
          assert.deepEqual(cache.prune({ keep: 0 }), [baseKey]);
        if (!executorMiss) {
          assert.deepEqual(
            detail.executions.find((run) => run.mode === "task")?.environment,
            {
              key: baseKey,
              cacheHit: true,
            },
          );
          const journal = new IntegrationJournal(
            join(directory, "integrations", taskId),
            taskId,
          );
          const integrationEvents = await journal.read();
          if (integrationMiss)
            assert.partialDeepStrictEqual(integrationEvents.at(-1), {
              kind: "denied",
              reason: "verification",
            });
          assert.partialDeepStrictEqual(
            integrationEvents.at(integrationMiss ? -2 : -1),
            {
              kind: "verification.finished",
              run: execution.id,
              review: "failed",
              failure: "env-missing",
            },
          );
          assert.ok(
            !integrationEvents.some(
              ({ kind }) => kind === "revision.requested",
            ),
          );
        }
        let output = "";
        assert.equal(
          await runCli(
            ["--db", filename, "show", taskId],
            {
              stdin: new PassThrough(),
              stdout: {
                write(text: string) {
                  output += text;
                },
              },
              stderr: { write() {} },
              isTTY: true,
              prompt: () => "",
            },
            root,
            env,
          ),
          0,
        );
        assert.equal(JSON.parse(output).next, message);
        return;
      }
      if (
        scenario === "audit unavailable" ||
        scenario === "tampered" ||
        scenario === "truncated" ||
        scenario === "invalid manifest"
      ) {
        assert.equal(workerRuns, 0);
        assert.equal(provisioning.length, 0);
        if (scenario !== "audit unavailable") {
          assert.equal(detail.failure?.code, "env-build-failed");
          assert.equal(
            detail.executions[0]?.environment?.key,
            scenario === "invalid manifest" ? undefined : baseKey,
          );
        }
      } else {
        assert.deepEqual(
          detail.executions.find(({ mode }) => mode === "task")?.environment,
          { key: baseKey, cacheHit: true },
        );
      }
      if (scenario === "invalid manifest") {
        const [started, finished] = store
          .listEvents({ subjectId: detail.executions[0]!.id, limit: 10 })
          .filter(({ kind }) => kind.startsWith("environment."))
          .reverse();
        assert.equal(started?.kind, "environment.started");
        assert.equal(finished?.kind, "environment.finished");
        const start = started.data as { invocationId: string; key?: string };
        const finish = finished.data as {
          invocationId: string;
          key?: string;
          failure?: string;
        };
        assert.equal(finish.invocationId, start.invocationId);
        assert.equal(start.key, undefined);
        assert.equal(finish.key, undefined);
        assert.equal(finish.failure, "env-build-failed");
      }
      if (candidateInvalidManifest) {
        assert.equal(detail.failure?.code, "env-build-failed");
        const journal = new IntegrationJournal(
          join(directory, "integrations", taskId),
          taskId,
        );
        const created = (await journal.read()).find(
          ({ kind }) => kind === "candidate.created",
        );
        assert.ok(created?.kind === "candidate.created");
        const repository = join(directory, "repository.git");
        assert.equal(
          String(
            command(
              "/usr/bin/git",
              repository,
              [
                "diff-tree",
                "--no-commit-id",
                "--name-only",
                "-r",
                created.candidate,
              ],
              "utf8",
            ),
          ).trim(),
          "package.json",
        );
      }
      if (successful || scenario === "mismatch") {
        assert.deepEqual(
          detail.executions.find(({ mode }) => mode === "verification")
            ?.environment,
          { key: candidateKey, cacheHit: false },
        );
        const journal = new IntegrationJournal(
          join(directory, "integrations", taskId),
          taskId,
        );
        const events = await journal.read();
        assert.ok(
          events.some(({ kind }) => kind === "environment.outputs-excluded"),
        );
        if (revise)
          assert.ok(
            events.some(
              (event) =>
                event.kind === "verification.finished" &&
                event.review === "revise" &&
                event.failure ===
                  (outputCollision
                    ? "env-output-collision"
                    : "env-lock-mismatch"),
            ),
          );
        const audit = new SqliteAudit(join(cache.directory, "audit.sqlite"), {
          readonly: true,
        });
        try {
          assert.ok(
            audit
              .read(provisioning[0]!)
              .some(({ kind }) => kind === "environment.finished"),
          );
        } finally {
          audit.close();
        }
      }
      assert.equal(
        workerRuns,
        revise
          ? 2
          : successful ||
              candidateInvalidManifest ||
              scenario === "worker failure"
            ? 1
            : 0,
      );
      assert.equal(verifyRuns, successful ? 1 : 0);
      if (scenario !== "tampered" && scenario !== "truncated")
        assert.deepEqual(cache.prune({ keep: 0 }), [
          successful ? candidateKey : baseKey,
        ]);
    },
  );

for (const scenario of [
  "lock only",
  "declared lock only",
  "lock only resolve no-op",
  "retry no-op",
  "manifest conflict",
  "autoBuild off",
] as const) {
  test(
    `stale Task replays declarations and resolves only for ${scenario}`,
    gitTestOptions,
    async () => {
      using fixture = orchestratorFixture("task-lock-conflict-");
      const { root, store } = fixture;
      const repoRoot = join(root, "source");
      mkdirSync(repoRoot);
      const git = (args: string[]) =>
        String(command("/usr/bin/git", repoRoot, args, "utf8")).trim();
      git(["init", "--template=", "--initial-branch=main"]);
      const rootManifest = '{"name":"fixture","workspaces":["packages/*"]}';
      const workspace = (name: string, range: string) =>
        JSON.stringify({ name, dependencies: { fixture: range } });
      const lock = (version: string) =>
        JSON.stringify({
          lockfileVersion: 1,
          packages: { fixture: [`fixture@${version}`] },
        });
      const files = (
        a: string,
        b: string,
        version: string,
      ): Record<string, string> => ({
        "package.json": rootManifest,
        "packages/a/package.json": workspace("a", a),
        "packages/b/package.json": workspace("b", b),
        "bun.lock": lock(version),
      });
      const base = files("^1.0.0", "^1.0.0", "1.0.0");
      const upstream = files("^2.0.0", "^1.0.0", "2.0.0");
      const declaredLockOnly = scenario === "declared lock only";
      const retryNoop = scenario === "retry no-op";
      const declared = declaredLockOnly || retryNoop;
      const resolveNoop = scenario === "lock only resolve no-op";
      const canRebase =
        scenario === "lock only" || declaredLockOnly || resolveNoop;
      const change =
        scenario === "manifest conflict" || retryNoop
          ? files("^3.0.0", "^1.0.0", "3.0.0")
          : files("^1.0.0", declaredLockOnly ? "^1.0.0" : "^3.0.0", "3.0.0");
      const resolved = files(
        "^2.0.0",
        declared ? "^1.0.0" : "^3.0.0",
        resolveNoop ? "2.0.0" : "4.0.0",
      );
      for (const [path, value] of Object.entries(base)) {
        if (path.includes("/"))
          mkdirSync(join(repoRoot, path.slice(0, path.lastIndexOf("/"))), {
            recursive: true,
          });
        writeFileSync(join(repoRoot, path), value);
      }
      git(["add", "."]);
      git(["commit", "-m", "base"]);

      const env = configEnv(root);
      addProject(repoRoot, undefined, env);
      const target = await resolveTarget(repoRoot, root, env);
      const { directory } = target;
      await prepareTargetDirectory(target.bootstrapRoot, directory, env);
      const goalId = goal(store, undefined, "bun");
      const first = task(store, goalId, {
        profile: "bun",
        paths: ["bun.lock", "packages/"],
      });
      const second = task(store, goalId, {
        profile: "bun",
        paths: ["bun.lock", "package.json", "packages/"],
        ...(declared && {
          environment: {
            update: { adapter: "bun", packages: "all", allowMajor: false },
          },
        }),
      });
      const cache = new EnvironmentStore(target.project.id, env);
      const digest = "a".repeat(64);
      const tar = (files: Record<string, string>) =>
        writeWorkspaceTar(
          Object.entries(files).map(([path, value]) => ({
            path,
            type: "file",
            mode: 0o644,
            linkname: "",
            data: Buffer.from(value),
          })),
        );
      const archive = writeWorkspaceTar(
        [
          "node_modules",
          "packages/a/node_modules",
          "packages/b/node_modules",
        ].map((path) => ({
          path,
          type: "directory",
          mode: 0o755,
          linkname: "",
          data: Buffer.alloc(0),
        })),
      );
      for (const input of [base, upstream, change]) {
        const { key } = await identifyEnvironment(
          {
            paths: Object.keys(input),
            async read(path) {
              return input[path] ? Buffer.from(input[path]) : undefined;
            },
          },
          digest,
          bunAdapter,
        );
        await cache.publish(
          {
            key,
            adapter: "bun",
            profileDigest: digest,
            hasLock: true,
            packages: [],
            size: archive.byteLength,
            createdAt: new Date().toISOString(),
          },
          archive,
        );
      }
      let workerRuns = 0;
      let resolveRuns = 0;
      let updateRuns = 0;
      const mutationIds: string[] = [];
      let operation: "update" | "resolve" | "build" | undefined;
      let output = resolved;
      const executor = createTaskExecutor({
        repoRoot,
        directory,
        store,
        worker: () => harness,
        reviewer: harness,
        verification: configuredVerification({
          profile: "bun",
          argv: ["bun", "test"],
        }),
        environment: {
          autoBuild: scenario !== "autoBuild off",
          profile: {
            image: `localhost/agent-bootstrap/bun@sha256:${digest}`,
            recipeDigest: digest,
            memoryMiB: 2048,
            cpus: 2,
          },
          allow: [],
          requireAudit() {},
          host: {
            env,
            store: cache,
            async run(args) {
              const script = args.at(-1) ?? "";
              if (args[0] === "exec" && script.includes("'update'")) {
                operation = "update";
                updateRuns++;
                output =
                  updateRuns === 1
                    ? declaredLockOnly
                      ? change
                      : base
                    : resolved;
              }
              if (args[0] === "exec" && script.includes("'install'")) {
                operation = script.includes("'--frozen-lockfile'")
                  ? "build"
                  : "resolve";
                if (operation === "resolve") {
                  resolveRuns++;
                  output = resolved;
                }
              }
              if (args[0] === "copy") {
                const resource = args[1]!;
                writeFileSync(
                  args[2]!,
                  resource.endsWith("declarations.tar")
                    ? tar(
                        Object.fromEntries(
                          Object.entries(output).filter(([path]) =>
                            path.endsWith("package.json"),
                          ),
                        ),
                      )
                    : resource.endsWith("bun.lock")
                      ? output["bun.lock"]!
                      : archive,
                );
              }
              return { code: 0, stdout: "" };
            },
            async openGateway({ executionId }) {
              mutationIds.push(executionId);
              return {
                socksPort: 19100,
                dnsPort: 19153,
                username: "fake",
                password: "fixture",
                quarantined: false,
                async close() {},
              };
            },
          },
        },
        host: {
          async runWorker(_plan, id) {
            workerRuns++;
            assert.ok(workerRuns <= (retryNoop ? 3 : 2));
            return {
              id: id!,
              outcome: "ok",
              artifacts: {
                files: [],
                message: Buffer.from(
                  "Update fixture dependency\n\nExplain the dependency change.",
                ),
                tree: tar(
                  workerRuns === 1
                    ? upstream
                    : workerRuns === 2
                      ? change
                      : resolved,
                ),
              },
            };
          },
          async runVerification(_plan, id) {
            return {
              id: id!,
              outcome: "ok",
              response: Buffer.from('{"review":"pass"}'),
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
        },
      });
      for (const id of [first, second]) await runTask(store, executor, id);
      const proposals = store.pendingIntegrations();
      const firstProposal = proposals.find(
        (item) => item.kind === "integration" && item.content.taskId === first,
      )!;
      const secondProposal = proposals.find(
        (item) => item.kind === "integration" && item.content.taskId === second,
      )!;
      approve(store, firstProposal);
      await executor.integrate!(firstProposal.id);
      assert.equal(store.getTask(first)?.status, "succeeded");
      approve(store, secondProposal);
      await executor.integrate!(secondProposal.id);
      if (!canRebase) {
        assert.equal(operatorTask(store, second)?.failure?.code, "stale-base");
        assert.equal(store.getTask(second)?.retries, 0);
        assert.equal(resolveRuns, 0);
        assert.equal(workerRuns, 2);
        if (retryNoop) {
          assert.equal(updateRuns, 1);
          const previous = await new IntegrationJournal(
            join(directory, "integrations", second),
            second,
          ).read();
          assert.partialDeepStrictEqual(
            previous.find(({ kind }) => kind === "environment.updated"),
            {
              candidate:
                secondProposal.kind === "integration"
                  ? secondProposal.content.base
                  : undefined,
              changedPaths: [],
            },
          );
          store.retryTask(second, 0);
          await runTask(store, executor, second);
          assert.equal(updateRuns, 2);
          assert.equal(workerRuns, 3);
          assert.equal(resolveRuns, 0);
          const [proposal] = store.pendingIntegrations();
          assert.ok(proposal?.kind === "integration");
          assert.deepEqual(proposal.content.changedPaths, ["bun.lock"]);
        }
        return;
      }
      assert.equal(store.getTask(second)?.status, "registered");
      await runTask(store, executor, second);
      assert.equal(resolveRuns, declaredLockOnly ? 0 : 1);
      assert.equal(updateRuns, declaredLockOnly ? 2 : 0);
      assert.equal(workerRuns, 2);
      const [proposal] = store.pendingIntegrations();
      assert.ok(proposal?.kind === "integration");
      assert.notEqual(proposal.id, secondProposal.id);
      assert.equal(proposal.content.base, await executor.existingBase!(goalId));
      assert.deepEqual(
        proposal.content.changedPaths,
        declaredLockOnly
          ? ["bun.lock"]
          : resolveNoop
            ? ["packages/b/package.json"]
            : ["bun.lock", "packages/b/package.json"],
      );
      const journal = await new IntegrationJournal(
        join(directory, "integrations", second, "retry-1"),
        second,
      ).read();
      assert.partialDeepStrictEqual(
        journal.find(({ kind }) => kind === "environment.executor-base"),
        {
          candidate: proposal.content.candidate,
          changedPaths: resolveNoop ? [] : ["bun.lock"],
        },
      );
      const message = String(
        command(
          "/usr/bin/git",
          join(directory, "repository.git"),
          ["show", "-s", "--format=%B", proposal.content.candidate],
          "utf8",
        ),
      );
      assert.match(
        message,
        /^Update fixture dependency\n\nExplain the dependency change\.\n\nAgent-Bootstrap-Worker-Run: /,
      );
      if (resolveNoop)
        assert.doesNotMatch(message, /Agent-Bootstrap-Provisioner/);
      else {
        assert.ok(
          message.includes('Agent-Bootstrap-Provisioner-Paths: ["bun.lock"]'),
        );
        assert.ok(
          message.includes(
            `Agent-Bootstrap-Provisioner-Run: ${mutationIds[declaredLockOnly ? 1 : 0]}`,
          ),
        );
      }
      const tree = await LocalGitIntegration.committedTree(
        join(directory, "repository.git"),
        proposal.content.candidate,
      );
      for (const [path, content] of Object.entries(resolved))
        assert.equal(Buffer.from((await tree.read(path))!).toString(), content);
      assert.deepEqual(
        operatorTask(store, second)?.packageDiff?.changed,
        resolveNoop
          ? undefined
          : [{ name: "fixture", from: ["2.0.0"], to: ["4.0.0"] }],
      );
      approve(store, proposal);
      await executor.integrate!(proposal.id);
      assert.equal(store.getTask(second)?.status, "succeeded");
      assert.equal(
        await executor.existingBase!(goalId),
        proposal.content.candidate,
      );
    },
  );
}

function fakePublishRemote(
  initialChecks: NonNullable<PublishPullRequest["checks"]> = "pending",
) {
  const calls: string[] = [];
  const mutations: string[] = [];
  const files: Array<{ title: string; body: string }> = [];
  let remoteHead: string | null = null;
  const controls: {
    pr: PublishPullRequest | null;
    rejectPush?: true;
    rejectAutoMerge?: true;
    rejectDisarm?: boolean;
    rejectPoll?: boolean;
    loseCreateReply?: boolean;
    loseAutoMergeReply?: boolean;
    overrideReadHead?: string;
    staleReadAfterPush?: string;
    beforePush?: () => Promise<void>;
  } = { pr: null };
  let staleReadHead: string | undefined;
  const observedPr = () =>
    controls.pr && controls.overrideReadHead
      ? { ...controls.pr, head: controls.overrideReadHead }
      : controls.pr;
  const provider: PublishProvider = {
    async repository(remote) {
      assert.equal(remote, "origin");
      return "fixture/project";
    },
    async remoteHead() {
      calls.push("remote-head");
      return remoteHead;
    },
    async push(destination, head, expectedRemoteHead) {
      calls.push("push");
      await controls.beforePush?.();
      if (remoteHead !== expectedRemoteHead)
        throw new PublishError("publish-non-fast-forward");
      mutations.push(`push ${head}:${destination.branch}`);
      if (controls.rejectPush)
        throw new PublishError("publish-non-fast-forward");
      remoteHead = head;
      if (controls.pr) {
        staleReadHead = controls.staleReadAfterPush;
        controls.pr = { ...controls.pr, head };
      }
    },
    async findPullRequest(_destination, recoveringHead, afterPrNumber = 0) {
      calls.push("find-pr");
      const pr = observedPr();
      return pr &&
        pr.number > afterPrNumber &&
        (pr.state === "open" || pr.head === recoveringHead)
        ? pr
        : null;
    },
    async readPullRequest() {
      calls.push("read-pr");
      if (controls.rejectPoll || !controls.pr)
        throw new PublishError("publish-pr-failed");
      if (staleReadHead) {
        const head = staleReadHead;
        staleReadHead = undefined;
        return { ...controls.pr, head };
      }
      return observedPr()!;
    },
    async openPullRequest(destination, title, body) {
      calls.push("open-pr");
      mutations.push("open-pr");
      files.push({ title, body });
      assert.ok(remoteHead);
      assert.equal(destination.base, "main");
      const number = (controls.pr?.number ?? 11) + 1;
      controls.pr = {
        number,
        url: `https://github.com/fixture/project/pull/${number}`,
        head: remoteHead,
        state: "open",
        autoMerge: "off",
        checks: initialChecks,
      };
      if (controls.loseCreateReply) throw new PublishError("publish-pr-failed");
    },
    async mergePullRequest(_destination, number, method, head) {
      assert.equal(controls.pr?.number, number);
      assert.equal(controls.pr?.head, head);
      mutations.push(`merge-pr ${method}`);
      controls.pr = { ...controls.pr!, state: "merged", autoMerge: "off" };
    },
    async closePullRequest(_destination, number) {
      assert.equal(controls.pr?.number, number);
      mutations.push("close-pr");
      controls.pr = { ...controls.pr!, state: "closed", autoMerge: "off" };
    },
    async setAutoMerge(_destination, _number, method, head) {
      calls.push("auto-merge");
      mutations.push(`auto-merge ${method}`);
      assert.ok(controls.pr);
      assert.equal(head, observedPr()?.head);
      if (
        controls.rejectAutoMerge ||
        (method === "off" && controls.rejectDisarm)
      )
        throw new PublishError("auto-merge-unavailable");
      controls.pr = { ...controls.pr, autoMerge: method };
      if (controls.loseAutoMergeReply)
        throw new PublishError("publish-auto-merge-failed");
    },
  };
  return {
    controls,
    provider,
    calls,
    mutations,
    files,
    foreignPush(head: string) {
      assert.ok(controls.pr);
      controls.pr = { ...controls.pr, head };
      remoteHead = head;
    },
    deleteBranch() {
      remoteHead = null;
    },
  };
}

async function integratedGoal(state: TaskState, title?: string) {
  const fixture = stage3Fixture(state, undefined, undefined, undefined, title);
  const proposal = await fixture.proposal();
  approve(state.store, proposal);
  await fixture.work.drain();
  return { ...fixture, integratedHead: proposal.content.candidate };
}

// Model journal state from before Task changes were blocked while a PR was open.
async function withLegacyOpenPr<T>(
  store: OrchestratorStore,
  goalId: string,
  fn: () => T | Promise<T>,
) {
  const record = store.goalPublishRecord(goalId)!;
  assert.equal(record.pr?.state, "open");
  store.recordGoalPublish(goalId, "publish.polled", {
    ...record,
    pr: { ...record.pr!, state: "closed" },
  });
  try {
    return await fn();
  } finally {
    store.recordGoalPublish(goalId, "publish.polled", record);
  }
}

async function integrateNext(
  state: TaskState,
  f: ReturnType<typeof stage3Fixture>,
) {
  return withLegacyOpenPr(state.store, f.goalId, async () => {
    const taskId = task(state.store, f.goalId);
    await f.work.drain();
    const proposal = state.store
      .pendingIntegrations()
      .find(
        (item) => item.kind === "integration" && item.content.taskId === taskId,
      );
    assert.ok(proposal?.kind === "integration");
    approve(state.store, proposal);
    await f.work.drain();
    return proposal.content.candidate;
  });
}

function publishAudit(db: InstanceType<typeof Database>) {
  return db
    .query<{ kind: string; data: string }>(
      "SELECT kind, data FROM goal_publish_audit ORDER BY rowid",
    )
    .all();
}

test(
  "Workplace PR operations audit first, pin a fresh PR head and preserve the Goal lifecycle",
  gitTestOptions,
  async () => {
    using state = orchestratorFixture("lo-pr-actions-");
    const { store } = state;
    const f = await integratedGoal(state);
    const remote = fakePublishRemote();
    const publisher = new GoalPublisher(
      store,
      f.directory,
      f.repoRoot,
      remote.provider,
      { enabled: true, mergeMethod: "rebase" },
    );
    await publisher.publish(f.goalId, f.integratedHead);
    const source = { store, target: f.repoRoot };
    const detail = async () =>
      (await readOperatorGoal(store, f.directory, f.goalId))!;
    const assertTurn = async (kind: string, count: number, owner: string) => {
      assert.deepEqual(
        projectInbox(source)
          .map((row) => row.kind)
          .filter((kind) => kind.startsWith("pr-")),
        [kind],
      );
      assert.equal(operatorActivity(source).yourTurn, count);
      assert.equal((await detail()).turn.owner, owner);
    };
    const initialCount = operatorActivity(source).yourTurn;
    assert.ok(initialCount > 0);
    await assertTurn("pr-merge", initialCount, "human");
    assert.match(
      projectInbox(source).find(({ kind }) => kind === "pr-merge")!.next,
      / set-auto-merge G1 rebase$/,
    );
    remote.controls.pr = {
      ...remote.controls.pr!,
      checks: "passed",
      checkRuns: [{ name: "test", state: "pass" }],
      mergeable: "clean",
      review: "approved",
      additions: 6,
      deletions: 1,
      changedFiles: 2,
    };
    await publisher.tick(Date.now() + 100_000);
    const open = await detail();
    assert.partialDeepStrictEqual(open.publish, {
      checks: "passed",
      checkRuns: [{ name: "test", state: "pass" }],
      mergeable: "clean",
      review: "approved",
      additions: 6,
      deletions: 1,
      changedFiles: 2,
      mergeMethod: "rebase",
    });
    assert.deepEqual(operatorTask(store, open.tasks[0]!.id)?.pullRequest, {
      prNumber: 12,
      prUrl: open.publish.prUrl,
    });
    const { id } = open;
    assert.partialDeepStrictEqual(
      await goalPublishAction(store, publisher, "goal.setAutoMerge", {
        id,
        method: "merge",
        confirm: open.autoMergeConfirmations.merge,
      }),
      { result: { autoMerge: "merge" } },
    );
    await publisher.tick(Date.now() + 200_000);
    await assertTurn("pr-auto-merge", initialCount - 1, "ai");
    const armed = await detail();
    assert.partialDeepStrictEqual(
      await goalPublishAction(store, publisher, "goal.setAutoMerge", {
        id,
        method: "off",
        confirm: armed.autoMergeConfirmations.off,
      }),
      { result: { autoMerge: "off" } },
    );
    await publisher.tick(Date.now() + 300_000);
    await assertTurn("pr-merge", initialCount, "human");

    const params = {
      id,
      method: "rebase",
      confirm: open.prActions!.merge!.rebase,
    } as const;
    const merge = () =>
      goalPublishAction(store, publisher, "goal.merge", params);
    const close = () =>
      goalPublishAction(store, publisher, "goal.closePr", {
        id,
        confirm: open.prActions!.close,
      });
    const mutations = [...remote.mutations];
    await assert.rejects(
      publisher.actOnPullRequest(
        id,
        "rebase",
        params.confirm,
        "agent" as never,
      ),
      {
        code: "approval-forbidden",
      },
    );
    assert.deepEqual(
      await goalPublishAction(store, publisher, "goal.merge", {
        ...params,
        actor: "Reviewer",
      }),
      { error: { code: "invalid-params" } },
    );
    assert.deepEqual(
      await goalPublishAction(store, publisher, "goal.merge", {
        ...params,
        method: "squash",
      }),
      { error: { code: "stale-confirmation" } },
    );
    const saved = remote.controls.pr!;
    remote.controls.overrideReadHead = "a".repeat(40);
    assert.deepEqual(await merge(), {
      error: { code: "publish-remote-head-changed" },
    });
    assert.deepEqual(await close(), {
      error: { code: "publish-remote-head-changed" },
    });
    delete remote.controls.overrideReadHead;
    remote.controls.pr = { ...saved, state: "closed" };
    assert.deepEqual(await merge(), { error: { code: "invalid-transition" } });
    for (const [changed, code] of [
      [{ checks: "failed" }, "publish-checks-failed"],
      [{ checks: "pending" }, "publish-checks-pending"],
      [{ checks: "unknown" }, "publish-checks-unknown"],
      [{ mergeable: "conflict" }, "publish-not-mergeable"],
      [{ mergeable: "blocked" }, "publish-not-mergeable"],
      [{ checks: "none" }, "stale-confirmation"],
    ] as const) {
      remote.controls.pr = { ...saved, ...changed };
      assert.deepEqual(await merge(), { error: { code } });
    }
    const { checks: _checks, ...missingChecks } = saved;
    remote.controls.pr = missingChecks;
    assert.deepEqual(await merge(), {
      error: { code: "publish-checks-unknown" },
    });
    remote.controls.pr = saved;
    assert.deepEqual(remote.mutations, mutations);

    const db = new Database(state.filename);
    try {
      db.exec(`CREATE TRIGGER fail_pr_authorization BEFORE INSERT ON goal_publish_audit
        WHEN NEW.kind = 'publish.authorized' BEGIN SELECT RAISE(ABORT, 'fixture'); END`);
      for (const [operation, confirm] of [
        ["rebase", params.confirm],
        ["close", open.prActions!.close!],
      ] as const) {
        using blocked = openTestStore(state.filename);
        const blockedPublisher = new GoalPublisher(
          blocked.store,
          f.directory,
          f.repoRoot,
          remote.provider,
        );
        await assert.rejects(
          blockedPublisher.actOnPullRequest(
            id,
            operation,
            confirm,
            "operator-ui",
          ),
          {
            code: "publish-audit-failed",
          },
        );
      }
      assert.deepEqual(remote.mutations, mutations);
      db.exec("DROP TRIGGER fail_pr_authorization");
      assert.partialDeepStrictEqual(await close(), {
        result: { state: "closed" },
      });
      assert.deepEqual((await detail()).turn, {
        owner: "stopped",
        reason: { kind: "pr-closed", prNumber: 12 },
      });
      assert.equal(remote.mutations.at(-1), "close-pr");
      assert.deepEqual(await merge(), {
        error: { code: "invalid-transition" },
      });

      await publisher.publish(id, f.integratedHead, {
        number: 12,
        state: "closed",
      });
      assert.deepEqual(await merge(), {
        error: { code: "stale-confirmation" },
      });
      remote.controls.pr = { ...remote.controls.pr!, checks: "passed" };
      await publisher.tick(Date.now() + 400_000);
      const reopened = await detail();
      assert.partialDeepStrictEqual(
        await goalPublishAction(store, publisher, "goal.merge", {
          ...params,
          confirm: reopened.prActions!.merge!.rebase,
        }),
        { result: { state: "merged" } },
      );
      assert.equal(store.getGoal(id)?.status, "done");
      assert.equal(remote.mutations.at(-1), "merge-pr rebase");
      assert.deepEqual(
        publishAudit(db)
          .slice(-2)
          .map(({ kind }) => kind),
        ["publish.authorized", "publish.pr-merged"],
      );
      assert.partialDeepStrictEqual(JSON.parse(publishAudit(db).at(-2)!.data), {
        origin: "operator-ui",
        step: "merge-pr",
        method: "rebase",
        prNumber: 13,
        head: f.integratedHead,
      });
      assert.ok(
        !projectInbox(source).some(({ kind }) => kind.startsWith("pr-")),
      );
    } finally {
      db.close();
    }
  },
);

test(
  "manual PR mutations audit provider failures and let polling settle unreadable results",
  gitTestOptions,
  async () => {
    using state = orchestratorFixture("lo-pr-outcomes-");
    const { store } = state;
    const f = await integratedGoal(state);
    const remote = fakePublishRemote("passed");
    let rejectMutation = true;
    let rejectNextRead = false;
    const provider: PublishProvider = {
      ...remote.provider,
      async readPullRequest(...args) {
        if (rejectNextRead) {
          rejectNextRead = false;
          throw new PublishError("publish-pr-failed");
        }
        return remote.provider.readPullRequest(...args);
      },
      async closePullRequest(destination, number) {
        if (rejectMutation) throw new Error("fixture close failure");
        await remote.provider.closePullRequest(destination, number);
        remote.controls.rejectPoll = true;
      },
      async mergePullRequest(destination, number, method, head) {
        if (rejectMutation) throw new Error("fixture merge failure");
        await remote.provider.mergePullRequest(
          destination,
          number,
          method,
          head,
        );
        remote.controls.rejectPoll = true;
      },
    };
    const publisher = new GoalPublisher(
      store,
      f.directory,
      f.repoRoot,
      provider,
      {
        enabled: true,
      },
    );
    using db = new Database(state.filename);
    await publisher.publish(f.goalId, f.integratedHead);
    const source = { store, target: f.repoRoot };
    for (const operation of ["close", "squash"] as const) {
      const { close, merge } = store.goalPrActions(f.goalId);
      const act = () =>
        publisher.actOnPullRequest(
          f.goalId,
          operation,
          (operation === "close" ? close : merge?.squash)!,
          "cli",
        );
      const code =
        operation === "close" ? "publish-close-failed" : "publish-merge-failed";
      await assert.rejects(act(), { code });
      const [authorization, failure] = publishAudit(db).slice(-2);
      assert.equal(authorization?.kind, "publish.authorized");
      assert.equal(failure?.kind, "publish.failed");
      const warning = store.goalPublishRecord(f.goalId)?.prActionFailure;
      assert.equal(warning?.code, code);
      assert.ok(Number.isFinite(Date.parse(warning.at)));
      assert.partialDeepStrictEqual(JSON.parse(failure!.data), {
        code,
        record: { prActionFailure: warning, pr: { state: "open" } },
      });
      assert.equal(store.goalPublishRecord(f.goalId)?.failure, undefined);
      assert.partialDeepStrictEqual(
        await readOperatorGoal(store, f.directory, f.goalId),
        {
          publish: { state: "pr-open", prActionFailure: warning },
          turn: { owner: "human", reason: { kind: "pr-open" } },
          prActions: { merge, close },
        },
      );
      assert.ok(projectInbox(source).some(({ kind }) => kind === "pr-merge"));
      if (operation === "close") {
        const setMethod = (method: "off" | "rebase") =>
          store.setGoalAutoMerge(
            f.goalId,
            method,
            store.goalAutoMergeConfirmations(f.goalId)[method],
            "cli",
          );
        setMethod("rebase");
        remote.controls.pr = { ...remote.controls.pr!, checks: "unknown" };
        rejectNextRead = true;
        const auditStart = publishAudit(db).length;
        const now = Date.now();
        await publisher.tick(now);
        assert.equal(remote.mutations.at(-1), "auto-merge rebase");
        assert.deepEqual(
          publishAudit(db)
            .slice(auditStart)
            .map(({ kind }) => kind),
          [
            "publish.failed",
            "publish.polled",
            "publish.authorized",
            "publish.auto-merge-set",
          ],
        );
        assert.equal(
          store.goalPublishRecord(f.goalId)?.prActionFailure,
          undefined,
        );
        setMethod("off");
        await publisher.tick(now + 120_000);
        assert.equal(remote.mutations.at(-1), "auto-merge off");
      } else {
        await publisher.tick(Date.now() + 60_000);
        assert.equal(
          store.goalPublishRecord(f.goalId)?.prActionFailure,
          undefined,
        );
        await assert.rejects(act(), { code });
      }
      rejectMutation = false;
      const result = await act();
      assert.equal(result.state, "pr-open");
      assert.equal(result.prActionOutcome, "unknown");
      assert.equal(result.goalCompleted, undefined);
      assert.equal(result.failure, undefined);
      assert.equal(result.prActionFailure, undefined);
      assert.equal(publishAudit(db).at(-1)?.kind, "publish.polled");
      assert.equal(
        JSON.parse(publishAudit(db).at(-1)!.data).outcome,
        "unknown",
      );
      assert.deepEqual(store.goalPrActions(f.goalId), {});
      assert.ok(
        !projectInbox({ store, target: f.repoRoot }).some(({ kind }) =>
          kind.startsWith("pr-"),
        ),
      );
      await publisher.tick(Date.now());
      assert.equal(
        store.goalPublishRecord(f.goalId)?.prActionOutcome,
        "unknown",
      );
      assert.equal(publishAudit(db).at(-1)?.kind, "publish.polled");
      remote.controls.rejectPoll = false;
      await publisher.tick(Date.now() + 10_000);
      assert.equal(
        store.goalPublishRecord(f.goalId)?.prActionOutcome,
        undefined,
      );
      assert.equal(
        store.goalPublishRecord(f.goalId)?.pr?.state,
        operation === "close" ? "closed" : "merged",
      );
      if (operation === "close") {
        assert.equal(store.getGoal(f.goalId)?.status, "active");
        await publisher.publish(f.goalId, f.integratedHead);
        rejectMutation = true;
      }
    }
    assert.equal(store.getGoal(f.goalId)?.status, "done");
  },
);

test(
  "queueing a manual PR merge keeps the Goal active until polling observes the merge",
  gitTestOptions,
  async () => {
    using state = orchestratorFixture("lo-pr-queue-");
    const { store } = state;
    const f = await integratedGoal(state);
    const remote = fakePublishRemote("passed");
    let queued = false;
    const publisher = new GoalPublisher(
      store,
      f.directory,
      f.repoRoot,
      {
        ...remote.provider,
        async mergePullRequest() {
          queued = true;
        },
      },
      { enabled: true },
    );
    await publisher.publish(f.goalId, f.integratedHead);
    const result = await publisher.actOnPullRequest(
      f.goalId,
      "squash",
      store.goalPrActions(f.goalId).merge!.squash,
      "cli",
    );
    assert.equal(queued, true);
    assert.equal(result.state, "pr-open");
    assert.equal(result.goalCompleted, undefined);
    assert.equal(store.getGoal(f.goalId)?.status, "active");
    remote.controls.pr = { ...remote.controls.pr!, state: "merged" };
    await publisher.tick(Date.now() + 10_000);
    assert.equal(store.getGoal(f.goalId)?.status, "done");
  },
);

test(
  "manual PR merge racing the poller completes the Goal once",
  gitTestOptions,
  async () => {
    using state = orchestratorFixture("lo-pr-race-");
    using reopened = openTestStore(state.filename);
    using db = new Database(state.filename);
    const { store } = state;
    const f = await integratedGoal(state);
    const remote = fakePublishRemote("passed");
    const inMerge = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const manual = new GoalPublisher(
      store,
      f.directory,
      f.repoRoot,
      {
        ...remote.provider,
        async mergePullRequest(...args) {
          await remote.provider.mergePullRequest(...args);
          inMerge.resolve();
          await release.promise;
        },
      },
      { enabled: true },
    );
    await manual.publish(f.goalId, f.integratedHead);
    const poller = new GoalPublisher(
      reopened.store,
      f.directory,
      f.repoRoot,
      remote.provider,
      { enabled: false },
    );
    const merge = manual.actOnPullRequest(
      f.goalId,
      "squash",
      store.goalPrActions(f.goalId).merge!.squash,
      "cli",
    );
    try {
      await Promise.race([
        inMerge.promise,
        merge.then(() => assert.fail("merge did not pause")),
      ]);
      await poller.tick(Date.now());
      assert.equal(remote.controls.pr?.state, "merged");
      assert.equal(store.getGoal(f.goalId)?.status, "active");
      release.resolve();
      assert.equal((await merge).goalCompleted, true);
      await poller.tick(Date.now() + 10_000);
      assert.equal(
        publishAudit(db).filter(({ kind }) => kind === "publish.pr-merged")
          .length,
        1,
      );
      assert.equal(
        store
          .listEvents({ subjectId: f.goalId, limit: 50 })
          .filter(
            ({ kind, data }) =>
              kind === "goal.status" &&
              (data as { status?: string }).status === "done",
          ).length,
        1,
      );
    } finally {
      release.resolve();
      await merge;
    }
  },
);

test(
  "Workplace PR operations refuse a cancelled Goal with an open PR",
  gitTestOptions,
  async () => {
    using state = orchestratorFixture("lo-pr-cancel-");
    const f = await integratedGoal(state);
    const remote = fakePublishRemote("passed");
    let cancelDuringRead = false;
    const publisher = new GoalPublisher(
      state.store,
      f.directory,
      f.repoRoot,
      {
        ...remote.provider,
        async readPullRequest(...args) {
          const pr = await remote.provider.readPullRequest(...args);
          if (cancelDuringRead)
            await state.store.discardGoal(
              f.goalId,
              f.integratedHead,
              async () => {},
            );
          return pr;
        },
      },
      { enabled: true },
    );
    await publisher.publish(f.goalId, f.integratedHead);
    const actions = state.store.goalPrActions(f.goalId);
    cancelDuringRead = true;
    using db = new Database(state.filename);
    const before = publishAudit(db);
    await assert.rejects(
      publisher.actOnPullRequest(
        f.goalId,
        "squash",
        actions.merge!.squash,
        "cli",
      ),
      { code: "publish-not-ready" },
    );
    assert.equal(state.store.getGoal(f.goalId)?.status, "cancelled");
    assert.deepEqual(publishAudit(db), before);
    await assert.rejects(
      publisher.actOnPullRequest(
        f.goalId,
        "squash",
        actions.merge!.squash,
        "cli",
      ),
      { code: "invalid-transition" },
    );
    await assert.rejects(
      publisher.actOnPullRequest(f.goalId, "close", actions.close!, "cli"),
      { code: "invalid-transition" },
    );
    assert.equal(remote.controls.pr?.state, "open");
  },
);

test(
  "Goal stays active through pending, push and PR closure, and can be published again or discarded",
  gitTestOptions,
  async () => {
    using state = orchestratorFixture("lo-publish-");
    const { store } = state;
    const f = stage3Fixture(state);
    const remote = fakePublishRemote();
    const publisher = new GoalPublisher(
      store,
      f.directory,
      f.repoRoot,
      remote.provider,
      { enabled: true },
    );
    const now = Date.now();
    await publisher.tick(now);
    const proposal = await f.proposal();
    approve(store, proposal);
    await f.work.drain();
    const expectedHead = proposal.content.candidate;
    async function detail() {
      const detail = (await readOperatorGoal(store, f.directory, f.goalId))!;
      const summary = operatorGoalList(store, "active")[0]!;
      assert.equal(detail.status, "active");
      assert.deepEqual(summary.turn, detail.turn);
      assert.deepEqual(summary.publish, detail.publish);
      return detail;
    }
    assert.partialDeepStrictEqual(await detail(), {
      turn: { owner: "ai", reason: { kind: "publishing" } },
      publish: { state: "pending" },
      publishPreview: { expectedHead },
    });
    remote.controls.beforePush = async () => {
      assert.partialDeepStrictEqual(await detail(), {
        turn: { owner: "ai", reason: { kind: "publishing" } },
        publish: { state: "pushing" },
      });
    };
    await publisher.tick(now + 1);
    assert.deepEqual((await detail()).turn, {
      owner: "human",
      reason: {
        kind: "pr-open",
        prNumber: 12,
        checks: "pending",
        autoMerge: "off",
      },
    });

    remote.controls.pr = { ...remote.controls.pr!, state: "closed" };
    await publisher.tick(now + 100_000);
    const closed = await detail();
    assert.deepEqual(closed.turn, {
      owner: "stopped",
      reason: { kind: "pr-closed", prNumber: 12 },
    });
    assert.deepEqual(closed.publishPreview, { expectedHead });
    assert.deepEqual(
      await goalPublishAction(store, publisher, "goal.setAutoMerge", {
        id: f.goalId,
        method: "squash",
        confirm: closed.autoMergeConfirmations.squash,
      }),
      { error: { code: "invalid-transition" } },
    );

    const confirmed = {
      id: f.goalId,
      expectedHead,
      confirm: goalPublishConfirmation("G1", expectedHead),
      expectedPr: { number: 12, state: "closed" },
    } as const;
    assert.deepEqual(
      await goalPublishAction(store, publisher, "goal.publish", {
        ...confirmed,
        expectedPr: null,
      }),
      { error: { code: "stale-confirmation" } },
    );
    remote.controls.pr = { ...remote.controls.pr!, state: "open" };
    assert.deepEqual(
      await goalPublishAction(store, publisher, "goal.publish", confirmed),
      { error: { code: "stale-confirmation" } },
    );
    assert.equal((await detail()).turn.reason.kind, "pr-open");
    assert.equal(remote.mutations.length, 2);
    remote.controls.pr = { ...remote.controls.pr!, state: "closed" };
    await publisher.tick(now + 200_000);
    const reply = await goalPublishAction(
      store,
      publisher,
      "goal.publish",
      confirmed,
    );
    assert.partialDeepStrictEqual(reply, {
      result: { prNumber: 13, state: "pr-open" },
    });
    assert.deepEqual((await detail()).turn, {
      owner: "human",
      reason: {
        kind: "pr-open",
        prNumber: 13,
        checks: "pending",
        autoMerge: "off",
      },
    });
    assert.equal(
      remote.mutations.filter((value) => value.startsWith("push ")).length,
      1,
    );

    remote.controls.pr = { ...remote.controls.pr!, state: "closed" };
    await publisher.tick(now + 300_000);
    assert.deepEqual(
      await goalPublishAction(store, publisher, "goal.publish", confirmed),
      { error: { code: "stale-confirmation" } },
    );
    assert.deepEqual(
      await operatorAction(store, f.directory, "goal.discard", {
        id: f.goalId,
        expectedHead,
        confirm: "G1",
        expectedClosedPrNumber: 12,
      }),
      { error: { code: "stale-confirmation" } },
    );
    assert.partialDeepStrictEqual(
      await operatorAction(store, f.directory, "goal.discard", {
        id: f.goalId,
        expectedHead,
        confirm: "G1",
        expectedClosedPrNumber: 13,
      }),
      { result: { status: "cancelled" } },
    );
    assert.deepEqual(
      (await readOperatorGoal(store, f.directory, f.goalId))?.turn,
      {
        owner: "stopped",
        reason: { kind: "cancelled" },
      },
    );
  },
);

test(
  "closed PR with a deleted branch can be republished and failed attempts stay retryable",
  gitTestOptions,
  async () => {
    using state = orchestratorFixture("lo-publish-");
    const { store } = state;
    const f = await integratedGoal(state);
    const remote = fakePublishRemote();
    const publisher = (enabled: boolean) =>
      new GoalPublisher(store, f.directory, f.repoRoot, remote.provider, {
        enabled,
      });
    const enabled = publisher(true);
    const head = f.integratedHead;
    await enabled.publish(f.goalId, head);
    await enabled.stop();
    remote.controls.pr = { ...remote.controls.pr!, state: "closed" };
    remote.deleteBranch();
    const disabled = publisher(false);
    const mutations = [...remote.mutations];
    await disabled.tick();
    assert.equal(store.goalPublishRecord(f.goalId)?.pr?.state, "closed");
    assert.deepEqual(remote.mutations, mutations);
    await disabled.stop();

    const resumed = publisher(true);
    const publish = () =>
      goalPublishAction(store, resumed, "goal.publish", {
        id: f.goalId,
        expectedHead: head,
        confirm: goalPublishConfirmation("G1", head),
        expectedPr: { number: 12, state: "closed" },
      });
    remote.controls.rejectPush = true;
    assert.deepEqual(await publish(), {
      error: { code: "publish-non-fast-forward" },
    });
    assert.partialDeepStrictEqual(
      await readOperatorGoal(store, f.directory, f.goalId),
      {
        turn: {
          owner: "stopped",
          reason: { kind: "publish-failed", code: "publish-non-fast-forward" },
        },
        publish: { state: "failed", failure: "publish-non-fast-forward" },
        publishPreview: { expectedHead: head },
        prState: "closed",
      },
    );
    delete remote.controls.rejectPush;
    assert.partialDeepStrictEqual(await publish(), {
      result: { state: "pr-open", prNumber: 13 },
    });
    assert.deepEqual(remote.mutations.slice(-2), [mutations[0], "open-pr"]);
    assert.equal(
      await remote.provider.remoteHead(
        store.goalPublishRecord(f.goalId)!.destination,
      ),
      head,
    );
  },
);

test(
  "open and merged PRs lock Task registration, integration and Goal base updates",
  gitTestOptions,
  async () => {
    using state = orchestratorFixture("lo-publish-");
    const { store } = state;
    const f = await integratedGoal(state);
    const remote = fakePublishRemote();
    const publisher = new GoalPublisher(
      store,
      f.directory,
      f.repoRoot,
      remote.provider,
      { enabled: true },
    );
    await publisher.publish(f.goalId, f.integratedHead);
    const { pending, integration } = await withLegacyOpenPr(
      store,
      f.goalId,
      async () => {
        const pending = store.proposeTask(
          { ...store.getTask(f.taskId)!.content, paths: ["outside-scope/"] },
          planner,
        );
        const id = task(store, f.goalId);
        await f.work.drain();
        const integration = store
          .pendingIntegrations()
          .find(
            (item) => item.kind === "integration" && item.content.taskId === id,
          )!;
        approve(store, integration);
        return { pending, integration };
      },
    );
    const baseUpdate = () =>
      operatorAction(
        store,
        f.directory,
        "goal.updateBase",
        {
          id: f.goalId,
          confirm: "unused",
          from: f.integratedHead,
          to: "a".repeat(40),
        },
        { target: f.repoRoot },
      );
    const assertLocked = async () => {
      assert.throws(() => task(store, f.goalId), { code: "goal-pr-open" });
      assert.throws(() => approve(store, pending), { code: "goal-pr-open" });
      assert.throws(() => store.approvedIntegration(integration.id), {
        code: "goal-pr-open",
      });
      assert.equal(store.nextApprovedIntegration(), undefined);
      assert.deepEqual(await baseUpdate(), { error: { code: "goal-pr-open" } });
    };
    await assertLocked();
    remote.controls.pr = {
      ...remote.controls.pr!,
      state: "merged",
    };
    await publisher.tick();
    assert.equal(store.getGoal(f.goalId)?.status, "active");
    await assertLocked();
    // Queued work for the Goal hides manual completion until it ends.
    const queued = store.createExecution({
      actor: "Planner",
      mode: "planning",
      requestedBy: { kind: "host" },
      goalId: f.goalId,
    });
    assert.equal(store.goalMergeCompletion(f.goalId), null);
    store.startExecution(queued.id);
    store.finishExecution(queued.id, "cancelled");
    const detail = (await readOperatorGoal(store, f.directory, f.goalId))!;
    assert.equal(detail.publish.state, "merged");
    assert.equal(detail.mergeCompletion?.mergedHead, f.integratedHead);
    assert.partialDeepStrictEqual(
      await goalPublishAction(store, undefined, "goal.completeAfterMerge", {
        id: f.goalId,
        confirm: detail.mergeCompletion!.confirm,
      }),
      { result: { status: "done" } },
    );
  },
);

for (const scenario of ["stale", "foreign"] as const) {
  test(
    `opted-out polling observes a ${scenario} merge and only a matching confirmation completes it`,
    gitTestOptions,
    async () => {
      using state = orchestratorFixture("lo-publish-");
      const { store } = state;
      const f = await integratedGoal(state);
      const remote = fakePublishRemote();
      const publisher = (enabled: boolean) =>
        new GoalPublisher(store, f.directory, f.repoRoot, remote.provider, {
          enabled,
        });
      const enabled = publisher(true);
      await enabled.tick();
      await enabled.publish(f.goalId, f.integratedHead);
      const goalHead =
        scenario === "stale" ? await integrateNext(state, f) : f.integratedHead;
      const mergedHead =
        scenario === "stale" ? f.integratedHead : "a".repeat(40);
      await enabled.stop();
      const disabled = publisher(false);
      const mutations = [...remote.mutations];
      remote.controls.pr = {
        ...remote.controls.pr!,
        state: "merged",
        head: mergedHead,
      };
      await disabled.tick();
      assert.deepEqual(remote.mutations, mutations);
      const detail = (await readOperatorGoal(store, f.directory, f.goalId))!;
      assert.equal(detail.status, "active");
      assert.equal(detail.publish.state, "merged-stale");
      const confirm = `complete-goal G1 #12 ${mergedHead}`;
      assert.deepEqual(detail.mergeCompletion, {
        prNumber: 12,
        mergedHead,
        goalHead,
        confirm,
      });
      const complete = (confirm: string, currentStore = store) =>
        goalPublishAction(currentStore, undefined, "goal.completeAfterMerge", {
          id: f.goalId,
          confirm,
        });
      const stale = { error: { code: "stale-confirmation" } };
      assert.deepEqual(await complete(confirm.replace("#12", "#11")), stale);
      assert.deepEqual(await complete(confirm.slice(0, -1)), stale);
      const db = new Database(state.filename);
      try {
        db.exec(`CREATE TRIGGER reject_manual_completion BEFORE INSERT ON goal_publish_audit
          WHEN NEW.kind = 'publish.completed-manually' BEGIN SELECT RAISE(ABORT, 'fixture'); END`);
        assert.deepEqual(await complete(confirm), {
          error: { code: "write-failed" },
        });
        assert.equal(store.getGoal(f.goalId)?.status, "active");
        db.exec("DROP TRIGGER reject_manual_completion");
        using reopened = openTestStore(state.filename);
        assert.deepEqual(await complete(confirm, reopened.store), {
          result: { id: f.goalId, ref: "G1", status: "done" },
        });
        assert.deepEqual(await complete(confirm, reopened.store), stale);
        const audit = publishAudit(db).at(-1)!;
        assert.equal(audit.kind, "publish.completed-manually");
        assert.deepEqual(JSON.parse(audit.data), {
          prNumber: 12,
          head: mergedHead,
          goalHead,
          manual: true,
          origin: "operator-ui",
        });
      } finally {
        db.close();
      }
    },
  );
}

test(
  "merge observation commits Goal status and publish audit together",
  gitTestOptions,
  async () => {
    using state = orchestratorFixture("lo-publish-");
    const { store } = state;
    const f = await integratedGoal(state);
    const remote = fakePublishRemote();
    const publisher = new GoalPublisher(
      store,
      f.directory,
      f.repoRoot,
      remote.provider,
      { enabled: true },
    );
    await publisher.publish(f.goalId, f.integratedHead);
    remote.controls.pr = {
      ...remote.controls.pr!,
      state: "merged",
      checks: "passed",
    };
    const db = new Database(state.filename);
    try {
      const audit = publishAudit(db);
      db.exec(`CREATE TRIGGER reject_goal_completion BEFORE INSERT ON events
      WHEN NEW.kind = 'goal.status' BEGIN SELECT RAISE(ABORT, 'fixture'); END`);
      const now = Date.now();
      await publisher.tick(now);
      assert.equal(store.getGoal(f.goalId)?.status, "active");
      assert.equal(store.goalPublishRecord(f.goalId)?.pr?.state, "open");
      assert.deepEqual(publishAudit(db), audit);
      db.exec("DROP TRIGGER reject_goal_completion");
      using restarted = openTestStore(state.filename);
      const resumed = new GoalPublisher(
        restarted.store,
        f.directory,
        f.repoRoot,
        remote.provider,
        { enabled: true },
      );
      await resumed.tick(now + 100_000);
      assert.equal(restarted.store.getGoal(f.goalId)?.status, "done");
      assert.equal(publishAudit(db).at(-1)?.kind, "publish.polled");
    } finally {
      db.close();
    }
  },
);

test(
  "a stale PR read after a push waits for the latest host-pushed head",
  gitTestOptions,
  async () => {
    using state = orchestratorFixture("lo-publish-");
    const { store } = state;
    store.configureGoalPublishing({ autoMerge: "squash" });
    const f = await integratedGoal(state);
    const remote = fakePublishRemote();
    const publisher = new GoalPublisher(
      store,
      f.directory,
      f.repoRoot,
      remote.provider,
      { enabled: true },
    );
    await publisher.publish(f.goalId, f.integratedHead);
    const now = Date.now();
    await publisher.tick(now);
    const second = await integrateNext(state, f);
    remote.controls.staleReadAfterPush = f.integratedHead;
    await publisher.tick(now + 1);
    assert.partialDeepStrictEqual(store.goalPublishRecord(f.goalId), {
      pushedHead: second,
      phase: "auto-merge",
      pr: { head: f.integratedHead, autoMerge: "off" },
    });
    remote.controls.overrideReadHead = f.integratedHead;
    await publisher.tick(now + 2000);
    assert.equal(store.goalPublishRecord(f.goalId)?.pollFailure, undefined);
    assert.equal(remote.controls.pr?.autoMerge, "off");
    delete remote.controls.overrideReadHead;
    await publisher.tick(now + 8000);
    assert.equal(remote.controls.pr?.autoMerge, "squash");
    assert.equal(store.goalPublishRecord(f.goalId)?.pr?.head, second);

    const third = await integrateNext(state, f);
    remote.controls.staleReadAfterPush = f.integratedHead;
    await publisher.tick(now + 8001);
    assert.partialDeepStrictEqual(store.goalPublishRecord(f.goalId), {
      pushedHead: third,
      phase: "auto-merge",
      pollFailure: "publish-remote-head-changed",
    });
    await publisher.tick(now + 16_000);
    assert.equal(remote.controls.pr?.autoMerge, "off");
  },
);

test(
  "legacy integrations disarm auto-merge before push and restore it once the Goal finishes",
  gitTestOptions,
  async () => {
    using state = orchestratorFixture("lo-publish-");
    const { store } = state;
    store.configureGoalPublishing({ enabled: true, autoMerge: "squash" });
    const f = stage3Fixture(state, undefined, "pass");
    const remote = fakePublishRemote();
    const publisher = new GoalPublisher(
      store,
      f.directory,
      f.repoRoot,
      remote.provider,
      { enabled: true },
    );
    const beforePr = store.goalAutoMergeConfirmations(f.goalId).off;
    const proposal = await f.proposal();
    await publisher.tick(0);
    assert.deepEqual(remote.calls, []);
    approve(store, proposal);
    await f.work.drain();
    const pending = store.proposeTask(
      { ...store.getTask(f.taskId)!.content, paths: ["outside-scope/"] },
      planner,
    );
    assert.equal(pending.status, "pending");
    await publisher.tick();
    assert.deepEqual(remote.mutations, []);
    store.decide(pending.id, {
      decision: "reject",
      answerer: { kind: "human" },
      digest: pending.digest,
    });
    const first = proposal.content.candidate;
    const branch = `ab/g1-${f.goalId.slice(0, 8)}`;
    await publisher.tick(1);
    assert.deepEqual(remote.mutations, [
      `push ${first}:${branch}`,
      "open-pr",
      "auto-merge squash",
    ]);
    assert.equal(store.goalExported(f.goalId)?.head, first);
    assert.equal(remote.files[0]?.title, "Goal");
    assert.match(remote.files[0]!.body, /Valid docs/);
    assert.match(remote.files[0]!.body, /G1-1 ✓ Task/);
    assert.match(remote.files[0]!.body, /G1-1 ✓ \/ ✓/);
    assert.ok(remote.files[0]!.body.includes(first));
    assert.ok(remote.files[0]!.body.includes(f.goalId));
    assert.partialDeepStrictEqual(
      await readOperatorGoal(store, f.directory, f.goalId),
      {
        publish: {
          state: "pr-open",
          branch,
          checks: "pending",
          autoMerge: "squash",
          autoMergeSource: "project",
        },
        turn: {
          owner: "ai",
          reason: {
            kind: "pr-open",
            checks: "pending",
            autoMerge: "squash",
            prNumber: 12,
          },
        },
      },
    );

    assert.throws(
      () => store.setGoalAutoMerge(f.goalId, "off", beforePr, "cli"),
      {
        code: "stale-confirmation",
      },
    );
    const beforeIntegration = store.goalAutoMergeConfirmations(f.goalId).off;
    const second = await integrateNext(state, f);
    assert.equal(store.goalPrActions(f.goalId).merge, undefined);
    assert.throws(
      () => store.setGoalAutoMerge(f.goalId, "off", beforeIntegration, "cli"),
      {
        code: "stale-confirmation",
      },
    );
    const unfinished = await withLegacyOpenPr(store, f.goalId, () =>
      task(store, f.goalId),
    );
    await publisher.tick(2);
    assert.equal(store.getTask(unfinished)?.status, "registered");
    assert.deepEqual(remote.mutations, [
      `push ${first}:${branch}`,
      "open-pr",
      "auto-merge squash",
      "auto-merge off",
      `push ${second}:${branch}`,
    ]);
    assert.equal(store.goalExported(f.goalId)?.head, second);
    assert.equal(store.goalPrActions(f.goalId).merge, undefined);
    remote.controls.pr = { ...remote.controls.pr!, checks: "passed" };
    store.recordGoalPublish(f.goalId, "publish.polled", {
      ...store.goalPublishRecord(f.goalId)!,
      pr: remote.controls.pr,
    });
    await assert.rejects(
      publisher.actOnPullRequest(
        f.goalId,
        "squash",
        `merge-goal G1 #12 ${second} squash checks=passed`,
        "cli",
      ),
      { code: "publish-not-ready" },
    );

    assert.equal(remote.controls.pr?.autoMerge, "off");
    await publisher.tick(3);
    assert.equal(remote.controls.pr?.autoMerge, "off");
    const third = await withLegacyOpenPr(store, f.goalId, async () => {
      await f.work.drain();
      const proposal = store
        .pendingIntegrations()
        .find(
          (item) =>
            item.kind === "integration" && item.content.taskId === unfinished,
        );
      assert.ok(proposal?.kind === "integration");
      approve(store, proposal);
      await f.work.drain();
      return proposal;
    });
    await publisher.tick(4);
    assert.deepEqual(remote.mutations.slice(-2), [
      `push ${third.content.candidate}:${branch}`,
      "auto-merge squash",
    ]);

    const audit = new Database(state.filename);
    try {
      const authorization = audit
        .query<{ step: string }>(
          "SELECT json_extract(data, '$.step') AS step FROM goal_publish_audit WHERE kind = 'publish.authorized'",
        )
        .all();
      for (const step of ["push", "open-pr", "auto-merge"])
        assert.ok(authorization.some((entry) => entry.step === step));
    } finally {
      audit.close();
    }

    remote.controls.pr = { ...remote.controls.pr!, checks: "failed" };
    await publisher.tick(10000);
    assert.partialDeepStrictEqual(
      await readOperatorGoal(store, f.directory, f.goalId),
      {
        publish: { checks: "failed" },
        turn: {
          owner: "ai",
          reason: {
            kind: "pr-open",
            checks: "failed",
            autoMerge: "squash",
            prNumber: 12,
          },
        },
      },
    );
    remote.controls.rejectPoll = true;
    await publisher.tick(20000);
    assert.partialDeepStrictEqual(
      await readOperatorGoal(store, f.directory, f.goalId),
      {
        publish: { failure: "publish-poll-failed" },
        turn: {
          owner: "stopped",
          reason: { kind: "publish-failed", code: "publish-poll-failed" },
        },
      },
    );
    const count = remote.calls.length;
    await publisher.tick(20001);
    assert.equal(remote.calls.length, count);
    remote.controls.rejectPoll = false;
    remote.controls.pr = {
      ...remote.controls.pr!,
      checks: "passed",
      state: "merged",
    };
    await publisher.tick(100000);
    assert.partialDeepStrictEqual(
      (await readOperatorGoal(store, f.directory, f.goalId))!.publish,
      {
        state: "merged",
        checks: "passed",
        lastCheckedAt: store.goalPublishRecord(f.goalId)?.lastCheckedAt,
      },
    );
    assert.equal(store.getGoal(f.goalId)?.status, "done");
    assert.deepEqual(
      (await readOperatorGoal(store, f.directory, f.goalId))?.turn,
      {
        owner: "done",
        reason: { kind: "merged", prNumber: 12 },
      },
    );
    assert.equal(
      store
        .listEvents({ subjectId: f.goalId, limit: 100 })
        .filter(
          ({ kind, data }) =>
            kind === "goal.status" &&
            (data as { status?: string }).status === "done",
        ).length,
      1,
    );
    await assert.rejects(publisher.publish(f.goalId, third.content.candidate), {
      code: "publish-not-ready",
    });
    const finalCalls = remote.calls.length;
    await publisher.tick(999_999);
    assert.equal(remote.calls.length, finalCalls);
    assert.equal(
      (await readOperatorGoal(store, f.directory, f.goalId))?.publish.state,
      "merged",
    );
  },
);

test(
  "publish failures are fixed, sticky and screened before the first mutation",
  gitTestOptions,
  async () => {
    using state = orchestratorFixture("lo-publish-");
    const f = await integratedGoal(state);
    const remote = fakePublishRemote();
    const disabled = new GoalPublisher(
      state.store,
      f.directory,
      f.repoRoot,
      remote.provider,
    );
    await disabled.tick();
    assert.equal(
      (await readOperatorGoal(state.store, f.directory, f.goalId))?.publish
        .state,
      "disabled",
    );
    assert.equal(state.store.goalExported(f.goalId), null);
    assert.deepEqual(remote.calls, []);
    const blocked = new GoalPublisher(
      state.store,
      f.directory,
      f.repoRoot,
      remote.provider,
      { enabled: true },
      createCredentialScanner(
        { leakPatterns: ["Valid docs"] },
        state.root,
        () => {},
      ),
    );
    await assert.rejects(blocked.publish(f.goalId, f.integratedHead), {
      code: "publish-screen-blocked",
    });
    assert.deepEqual(remote.calls, []);
    assert.equal(
      state.store.goalPublishRecord(f.goalId)?.failure,
      "publish-screen-blocked",
    );
    assert.equal(state.store.goalExported(f.goalId)?.head, f.integratedHead);

    const publisher = new GoalPublisher(
      state.store,
      f.directory,
      f.repoRoot,
      remote.provider,
      { enabled: true },
    );
    remote.controls.rejectPush = true;
    assert.deepEqual(
      await goalPublishAction(state.store, publisher, "goal.publish", {
        id: f.goalId,
        expectedHead: "a".repeat(40),
        confirm: goalPublishConfirmation("G1", "a".repeat(40)),
      }),
      { error: { code: "publish-stale-head" } },
    );
    assert.deepEqual(
      await goalPublishAction(state.store, publisher, "goal.publish", {
        id: f.goalId,
        expectedHead: f.integratedHead,
        confirm: goalPublishConfirmation("G1", f.integratedHead),
      }),
      { error: { code: "publish-non-fast-forward" } },
    );
    await publisher.tick();
    assert.deepEqual(remote.calls, ["remote-head", "push"]);
    assert.equal(
      (await readOperatorGoal(state.store, f.directory, f.goalId))?.publish
        .state,
      "failed",
    );
  },
);

for (const failedKind of [
  "publish.authorized",
  "publish.pushed",
  "publish.pr-opened",
] as const) {
  test(
    `publication fails closed or reconciles after a failed ${failedKind} audit`,
    gitTestOptions,
    async () => {
      using state = orchestratorFixture("lo-publish-");
      state.store.goalPublishOptIn();
      const f = await integratedGoal(state);
      const remote = fakePublishRemote();
      const config = { enabled: true };
      const db = new Database(state.filename);
      try {
        db.exec(`CREATE TRIGGER fail_publish BEFORE INSERT ON goal_publish_audit
        WHEN NEW.kind = '${failedKind}' BEGIN SELECT RAISE(ABORT, 'fixture text'); END`);
        const original = new GoalPublisher(
          state.store,
          f.directory,
          f.repoRoot,
          remote.provider,
          config,
        );
        await assert.rejects(original.publish(f.goalId, f.integratedHead), {
          code: "publish-audit-failed",
        });
        const branch = `ab/g1-${f.goalId.slice(0, 8)}`;
        const push = `push ${f.integratedHead}:${branch}`;
        assert.deepEqual(
          remote.mutations,
          failedKind === "publish.authorized"
            ? []
            : failedKind === "publish.pushed"
              ? [push]
              : [push, "open-pr"],
        );
        db.exec("DROP TRIGGER fail_publish");
        using reopened = openTestStore(state.filename);
        const restarted = new GoalPublisher(
          reopened.store,
          f.directory,
          f.repoRoot,
          remote.provider,
          config,
        );
        await restarted.tick();
        assert.deepEqual(remote.mutations, [push, "open-pr"]);
        assert.ok(remote.calls.includes("remote-head"));
        assert.equal(
          reopened.store.goalPublishRecord(f.goalId)?.pr?.state,
          "open",
        );
      } finally {
        db.close();
      }
    },
  );
}

test(
  "auto-merge confirmation is human-only and unavailability leaves the PR open",
  gitTestOptions,
  async () => {
    using state = orchestratorFixture("lo-publish-");
    state.store.configureGoalPublishing({ autoMerge: "rebase" });
    state.store.goalPublishOptIn();
    const f = await integratedGoal(state);
    const { store } = state;
    const remote = fakePublishRemote();
    const publisher = new GoalPublisher(
      store,
      f.directory,
      f.repoRoot,
      remote.provider,
      { enabled: true },
    );
    const confirm = store.goalAutoMergeConfirmations(f.goalId).merge;
    const params = { id: f.goalId, method: "merge", confirm } as const;
    assert.throws(
      () =>
        store.setGoalAutoMerge(f.goalId, "merge", confirm, "agent" as never),
      { code: "approval-forbidden" },
    );
    assert.deepEqual(
      await goalPublishAction(store, publisher, "goal.setAutoMerge", {
        ...params,
        actor: "Reviewer",
      }),
      { error: { code: "invalid-params" } },
    );
    assert.deepEqual(
      await goalPublishAction(store, publisher, "goal.setAutoMerge", params),
      { result: { autoMerge: "merge", autoMergeSource: "goal" } },
    );
    assert.deepEqual(
      await goalPublishAction(store, publisher, "goal.setAutoMerge", params),
      { error: { code: "stale-confirmation" } },
    );
    remote.controls.rejectAutoMerge = true;
    await publisher.tick();
    await publisher.tick();
    assert.equal(
      remote.mutations.filter((item) => item === "auto-merge merge").length,
      1,
    );
    assert.partialDeepStrictEqual(
      await readOperatorGoal(store, f.directory, f.goalId),
      {
        publish: {
          state: "pr-open",
          autoMerge: "merge",
          autoMergeSource: "goal",
          autoMergeUnavailable: true,
        },
        turn: { owner: "human", reason: { kind: "pr-open" } },
      },
    );
    const unavailable = (await readOperatorGoal(store, f.directory, f.goalId))!;
    assert.equal(unavailable.publish.failure, undefined);
    assert.equal(unavailable.publishPreview, undefined);
    const db = new Database(state.filename);
    try {
      assert.equal(
        publishAudit(db).at(-1)?.kind,
        "publish.auto-merge-unavailable",
      );
    } finally {
      db.close();
    }
    remote.controls.pr = { ...remote.controls.pr!, state: "closed" };
    await publisher.tick(Date.now() + 100_000);
    assert.equal(
      (await readOperatorGoal(store, f.directory, f.goalId))?.publish.state,
      "closed",
    );
  },
);

test(
  "publish and auto-merge CLI commands require their typed confirmations",
  gitTestOptions,
  async () => {
    using state = orchestratorFixture("lo-publish-");
    const f = await integratedGoal(state);
    const remote = fakePublishRemote("passed");
    const env = configEnv(state.root);
    writePrivateConfig(
      join(projectConfigDirectory("source", env), "local.json"),
      configRoot(env),
      {
        version: 1,
        publish: { enabled: true, mergeMethod: "rebase" },
      },
    );
    const output: string[] = [];
    const errors: string[] = [];
    const queued: string[] = [];
    const run = (
      args: string[],
      isTTY: boolean,
      prompt: (message: string) => string,
    ) =>
      runCli(
        ["--db", state.filename, "--target", f.repoRoot, ...args],
        {
          stdin: new PassThrough(),
          stdout: { write: (text) => output.push(text) },
          stderr: { write: (text) => errors.push(text) },
          isTTY,
          prompt,
        },
        state.root,
        env,
        () => ({
          ...remote.provider,
          async mergePullRequest(_destination, _number, method) {
            queued.push(method);
          },
        }),
      );
    for (const flags of [
      ["--method"],
      ["--method", "ff-only"],
      ["--method", "merge", "--method", "squash"],
      ["--no-checks", "--no-checks"],
    ]) {
      assert.equal(
        await run(["merge-goal", "G1", ...flags], true, () => {
          throw new Error("unexpected prompt");
        }),
        2,
      );
    }
    for (const args of [
      ["publish-goal", "G1"],
      ["set-auto-merge", "G1", "rebase"],
      ["complete-goal", "G1"],
      ["merge-goal", "G1", "--method", "merge"],
      ["close-goal-pr", "G1"],
    ]) {
      assert.equal(
        await run(args, false, () => {
          throw new Error("unexpected prompt");
        }),
        1,
      );
      assert.equal(await run(args, true, () => "yes"), 1);
    }
    assert.deepEqual(remote.mutations, []);
    assert.equal(state.store.goalAutoMerge(f.goalId).method, "off");
    const answer = (message: string) =>
      /^Type "([^"]+)" to confirm: $/.exec(message)?.[1] ?? "";
    assert.equal(
      await run(["set-auto-merge", "G1", "rebase"], true, answer),
      0,
    );
    assert.equal(await run(["publish-goal", "G1"], true, answer), 0);
    assert.equal(remote.mutations.at(-1), "auto-merge rebase");
    assert.equal(
      await run(["close-goal-pr", "G1"], true, (message) => {
        assert.equal(
          answer(message),
          `close-goal-pr G1 #12 ${f.integratedHead}`,
        );
        return answer(message);
      }),
      0,
    );
    assert.equal(remote.mutations.at(-1), "close-pr");
    assert.equal(await run(["publish-goal", "G1"], true, answer), 0);
    assert.equal(
      await run(["merge-goal", "G1"], true, (message) => {
        assert.equal(
          answer(message),
          `merge-goal G1 #13 ${f.integratedHead} rebase checks=passed`,
        );
        return "yes";
      }),
      1,
    );
    remote.controls.pr = { ...remote.controls.pr!, checks: "none" };
    const record = state.store.goalPublishRecord(f.goalId)!;
    state.store.recordGoalPublish(f.goalId, "publish.polled", {
      ...record,
      pr: remote.controls.pr,
    });
    const answerWithCheckPreview = (message: string) => {
      assert.equal(JSON.parse(output.at(-1)!).checks, "none");
      assert.match(answer(message), / checks=none$/);
      return answer(message);
    };
    assert.equal(
      await run(["merge-goal", "G1"], true, answerWithCheckPreview),
      1,
    );
    assert.match(errors.at(-1)!, /publish-no-checks/);
    const noChecks = remote.controls.pr;
    for (const [checks, code] of [
      ["pending", "publish-checks-pending"],
      ["passed", "stale-confirmation"],
    ] as const) {
      assert.equal(
        await run(["merge-goal", "G1", "--no-checks"], true, (message) => {
          remote.controls.pr = { ...noChecks, checks };
          return answerWithCheckPreview(message);
        }),
        1,
      );
      assert.ok(errors.at(-1)!.includes(code));
    }
    remote.controls.pr = noChecks;
    assert.deepEqual(queued, []);
    assert.equal(
      await run(
        ["merge-goal", "G1", "--no-checks", "--method", "merge"],
        true,
        answerWithCheckPreview,
      ),
      0,
    );
    assert.deepEqual(queued, ["merge"]);
    const mergedHead = "a".repeat(40);
    state.store.recordGoalPublish(f.goalId, "publish.polled", {
      ...record,
      pr: { ...record.pr!, state: "merged", head: mergedHead },
    });
    assert.equal(await run(["complete-goal", "G1"], true, () => "yes"), 1);
    assert.equal(state.store.getGoal(f.goalId)?.status, "active");
    assert.equal(
      await run(["complete-goal", "G1"], true, (message) => {
        assert.equal(answer(message), `complete-goal G1 #13 ${mergedHead}`);
        return answer(message);
      }),
      0,
    );
    assert.equal(state.store.getGoal(f.goalId)?.status, "done");
  },
);

test(
  "a PR for a different head does not count as a published Goal",
  gitTestOptions,
  async () => {
    using state = orchestratorFixture("lo-publish-");
    const f = await integratedGoal(state);
    const remote = fakePublishRemote();
    const publisher = new GoalPublisher(
      state.store,
      f.directory,
      f.repoRoot,
      remote.provider,
      { enabled: true },
    );
    remote.controls.overrideReadHead = "a".repeat(40);
    await assert.rejects(publisher.publish(f.goalId, f.integratedHead), {
      code: "publish-remote-head-changed",
    });
    assert.partialDeepStrictEqual(
      await readOperatorGoal(state.store, f.directory, f.goalId),
      {
        publish: { failure: "publish-remote-head-changed" },
        turn: {
          owner: "stopped",
          reason: {
            kind: "publish-failed",
            code: "publish-remote-head-changed",
          },
        },
        prActions: {},
      },
    );
    delete remote.controls.overrideReadHead;
    assert.equal(
      (await publisher.publish(f.goalId, f.integratedHead)).state,
      "pr-open",
    );
    assert.equal(
      (await readOperatorGoal(state.store, f.directory, f.goalId))?.turn.reason
        .kind,
      "pr-open",
    );
    remote.controls.overrideReadHead = "a".repeat(40);
    await publisher.tick();
    assert.partialDeepStrictEqual(
      await readOperatorGoal(state.store, f.directory, f.goalId),
      {
        publish: { failure: "publish-remote-head-changed" },
        turn: {
          owner: "stopped",
          reason: {
            kind: "publish-failed",
            code: "publish-remote-head-changed",
          },
        },
      },
    );
    assert.equal(remote.mutations.length, 2);
    delete remote.controls.overrideReadHead;
    await publisher.tick(Date.now() + 100_000);
    const confirm = state.store.goalAutoMergeConfirmations(f.goalId).rebase;
    state.store.setGoalAutoMerge(f.goalId, "rebase", confirm, "cli");
    remote.controls.loseAutoMergeReply = true;
    await assert.rejects(publisher.publish(f.goalId, f.integratedHead), {
      code: "publish-auto-merge-failed",
    });
    remote.controls.overrideReadHead = "a".repeat(40);
    remote.controls.loseAutoMergeReply = false;
    using reopened = openTestStore(state.filename);
    const restarted = new GoalPublisher(
      reopened.store,
      f.directory,
      f.repoRoot,
      remote.provider,
      { enabled: true },
    );
    await restarted.tick();
    assert.partialDeepStrictEqual(reopened.store.goalPublishRecord(f.goalId), {
      failure: "publish-auto-merge-failed",
      pendingMutation: { step: "auto-merge", head: f.integratedHead },
    });
    assert.equal(remote.mutations.length, 4);
    assert.equal(remote.mutations.at(-1), "auto-merge off");
  },
);

test(
  "restart reconciles a lost PR creation reply without replaying the command",
  gitTestOptions,
  async () => {
    using state = orchestratorFixture("lo-publish-");
    const f = await integratedGoal(state);
    const remote = fakePublishRemote();
    remote.controls.loseCreateReply = true;
    const config = { enabled: true };
    const publisher = new GoalPublisher(
      state.store,
      f.directory,
      f.repoRoot,
      remote.provider,
      config,
    );
    await assert.rejects(publisher.publish(f.goalId, f.integratedHead), {
      code: "publish-pr-failed",
    });
    assert.equal(
      state.store.goalPublishRecord(f.goalId)?.pendingMutation?.step,
      "open-pr",
    );
    assert.throws(() => task(state.store, f.goalId), { code: "goal-pr-open" });
    const disabled = new GoalPublisher(
      state.store,
      f.directory,
      f.repoRoot,
      remote.provider,
      { enabled: false },
    );
    await disabled.tick();
    await disabled.stop();
    assert.equal(state.store.goalPublishRecord(f.goalId)?.pr?.number, 12);
    assert.equal(state.store.goalPublishRecord(f.goalId)?.failure, undefined);
    assert.equal(remote.mutations.length, 2);
    using reopened = openTestStore(state.filename);
    const restarted = new GoalPublisher(
      reopened.store,
      f.directory,
      f.repoRoot,
      remote.provider,
      config,
    );
    await restarted.tick();
    await restarted.tick();
    assert.equal(reopened.store.goalPublishRecord(f.goalId)?.phase, "complete");
    assert.equal(reopened.store.goalPublishRecord(f.goalId)?.pr?.number, 12);
    assert.equal(remote.mutations.length, 2);
    assert.ok(remote.calls.includes("remote-head"));
  },
);

test(
  "polling never backfills pre-opt-in Goals, even after restart",
  gitTestOptions,
  async () => {
    using state = orchestratorFixture("lo-publish-");
    const f = await integratedGoal(state);
    const remote = fakePublishRemote();
    const config = { enabled: true };
    const first = new GoalPublisher(
      state.store,
      f.directory,
      f.repoRoot,
      remote.provider,
      config,
    );
    await first.tick();
    using reopened = openTestStore(state.filename);
    const { store } = reopened;
    const publisher = new GoalPublisher(
      store,
      f.directory,
      f.repoRoot,
      remote.provider,
      config,
    );
    await publisher.tick();
    assert.deepEqual(remote.calls, []);
    assert.equal(store.goalPublishRecord(f.goalId), null);
    const params = { id: f.goalId, expectedHead: f.integratedHead };
    assert.deepEqual(
      await goalPublishAction(store, publisher, "goal.publish", params),
      {
        error: { code: "invalid-params" },
      },
    );
    assert.deepEqual(
      await goalPublishAction(store, publisher, "goal.publish", {
        ...params,
        confirm: goalPublishConfirmation("G1", "a".repeat(40)),
      }),
      { error: { code: "confirmation-mismatch" } },
    );
    assert.deepEqual(remote.calls, []);
    assert.partialDeepStrictEqual(
      await goalPublishAction(store, publisher, "goal.publish", {
        ...params,
        confirm: goalPublishConfirmation("G1", f.integratedHead),
      }),
      { result: { state: "pr-open" } },
    );
    assert.equal(remote.mutations.length, 2);
  },
);

test(
  "a Goal blocked at opt-in publishes once it finishes",
  gitTestOptions,
  async () => {
    using state = orchestratorFixture("lo-publish-");
    const { store } = state;
    const f = await integratedGoal(state);
    const pending = store.proposeTask(
      { ...store.getTask(f.taskId)!.content, paths: ["outside-scope/"] },
      planner,
    );
    assert.equal(pending.status, "pending");
    const remote = fakePublishRemote();
    const publisher = new GoalPublisher(
      store,
      f.directory,
      f.repoRoot,
      remote.provider,
      { enabled: true },
    );
    await publisher.tick();
    assert.deepEqual(remote.calls, []);
    store.decide(pending.id, {
      decision: "reject",
      answerer: { kind: "human" },
      digest: pending.digest,
    });
    await publisher.tick();
    assert.equal(
      store.goalPublishRecord(f.goalId)?.pushedHead,
      f.integratedHead,
    );
    assert.equal(remote.mutations.length, 2);
  },
);

for (const reason of ["goal-cancelled", "remote-head-changed"] as const) {
  test(
    `an open PR is disarmed with prior audit on ${reason}`,
    gitTestOptions,
    async () => {
      using state = orchestratorFixture("lo-publish-");
      const { store } = state;
      store.configureGoalPublishing({ autoMerge: "squash" });
      const f = await integratedGoal(state);
      const remote = fakePublishRemote();
      const db = new Database(state.filename);
      try {
        const publisher = new GoalPublisher(
          store,
          f.directory,
          f.repoRoot,
          {
            ...remote.provider,
            async setAutoMerge(destination, number, method, head) {
              if (method === "off") {
                const last = publishAudit(db).at(-1)!;
                assert.equal(last.kind, "publish.authorized");
                assert.partialDeepStrictEqual(JSON.parse(last.data), {
                  step: "auto-merge",
                  autoMerge: "off",
                  prNumber: number,
                  head,
                  reason,
                });
              }
              await remote.provider.setAutoMerge(
                destination,
                number,
                method,
                head,
              );
            },
          },
          { enabled: true },
        );
        await publisher.publish(f.goalId, f.integratedHead);
        const now = Date.now() + 3_700_000;
        await publisher.tick(now);
        const foreignHead = "a".repeat(40);
        if (reason === "goal-cancelled") {
          assert.partialDeepStrictEqual(
            await operatorAction(store, f.directory, "goal.discard", {
              id: f.goalId,
              expectedHead: f.integratedHead,
              confirm: "G1",
            }),
            { result: { status: "cancelled" } },
          );
          // Cancellation takes priority over the normal ten-minute wait,
          // including when the first verification requires a retry.
          remote.controls.rejectPoll = true;
          await publisher.tick(now + 1);
          assert.equal(remote.controls.pr?.autoMerge, "squash");
          remote.controls.rejectPoll = false;
          await publisher.tick(now + 4001);
        } else {
          remote.foreignPush(foreignHead);
          await publisher.tick(now + 600_000);
          assert.equal(
            store.goalPublishRecord(f.goalId)?.pollFailure,
            "publish-remote-head-changed",
          );
          assert.equal(
            store.goalPublishRecord(f.goalId)?.pr?.head,
            foreignHead,
          );
          assert.throws(() => task(store, f.goalId), { code: "goal-pr-open" });
          await publisher.tick(now + 600_001);
          await assert.rejects(publisher.publish(f.goalId, f.integratedHead), {
            code: "publish-remote-head-changed",
          });
          assert.equal(
            await remote.provider.remoteHead(
              store.goalPublishRecord(f.goalId)!.destination,
            ),
            foreignHead,
          );
        }
        assert.equal(remote.controls.pr?.state, "open");
        assert.equal(remote.controls.pr?.autoMerge, "off");
        assert.equal(store.goalPublishRecord(f.goalId)?.pr?.autoMerge, "off");
        assert.equal(
          remote.mutations.filter((mutation) => mutation.startsWith("push "))
            .length,
          1,
        );
        assert.equal(remote.mutations.at(-1), "auto-merge off");
        assert.ok(
          publishAudit(db).some(
            ({ kind, data }) =>
              kind === "publish.auto-merge-set" &&
              JSON.parse(data).reason === reason,
          ),
        );
      } finally {
        db.close();
      }
    },
  );
}

test(
  "foreign armed PR with a failed disarm counts as an operator decision",
  gitTestOptions,
  async () => {
    using state = orchestratorFixture("lo-pr-foreign-");
    const { store } = state;
    const f = await integratedGoal(state);
    const remote = fakePublishRemote();
    const publisher = new GoalPublisher(
      store,
      f.directory,
      f.repoRoot,
      remote.provider,
      {
        enabled: true,
        autoMerge: "squash",
      },
    );
    store.setGoalAutoMerge(
      f.goalId,
      "squash",
      store.goalAutoMergeConfirmations(f.goalId).squash,
      "cli",
    );
    await publisher.publish(f.goalId, f.integratedHead);
    const source = { store, target: f.repoRoot };
    const initialCount = operatorActivity(source).yourTurn;
    assert.equal(
      projectInbox(source).find(({ kind }) => kind.startsWith("pr-"))?.kind,
      "pr-auto-merge",
    );
    remote.foreignPush("a".repeat(40));
    remote.controls.rejectDisarm = true;
    await publisher.tick(Date.now() + 10000);
    assert.partialDeepStrictEqual(
      await readOperatorGoal(store, f.directory, f.goalId),
      {
        publish: {
          state: "failed",
          failure: "auto-merge-disarm-failed",
          autoMergeEnabled: "squash",
        },
        turn: {
          owner: "stopped",
          reason: { kind: "publish-failed", code: "auto-merge-disarm-failed" },
        },
      },
    );
    const row = projectInbox(source).find(({ kind }) => kind.startsWith("pr-"));
    assert.equal(row?.kind, "pr-merge");
    assert.match(row.next, / events --subject G1$/);
    assert.equal(operatorActivity(source).yourTurn, initialCount + 1);
    assert.equal(store.goalPrActions(f.goalId).merge, undefined);
  },
);

test(
  "explicit Goal setting still disarms an open PR with publishing opted out",
  gitTestOptions,
  async () => {
    using state = orchestratorFixture("lo-pr-setting-");
    const { store } = state;
    const f = await integratedGoal(state);
    const remote = fakePublishRemote();
    const enabled = new GoalPublisher(
      store,
      f.directory,
      f.repoRoot,
      remote.provider,
      { enabled: true },
    );
    store.setGoalAutoMerge(
      f.goalId,
      "squash",
      store.goalAutoMergeConfirmations(f.goalId).squash,
      "cli",
    );
    await enabled.publish(f.goalId, f.integratedHead);
    await enabled.stop();
    assert.equal(remote.controls.pr?.autoMerge, "squash");
    const disabled = new GoalPublisher(
      store,
      f.directory,
      f.repoRoot,
      remote.provider,
      { enabled: false },
    );
    const now = Date.now();
    await disabled.tick(now);
    assert.equal(store.goalPublishOptIn(false), null);
    assert.equal(remote.controls.pr?.autoMerge, "squash");
    const start = remote.mutations.length;
    store.setGoalAutoMerge(
      f.goalId,
      "off",
      store.goalAutoMergeConfirmations(f.goalId).off,
      "operator-ui",
    );
    await disabled.tick(now + 1);
    assert.deepEqual(remote.mutations.slice(start), ["auto-merge off"]);
    assert.equal(store.goalPublishRecord(f.goalId)?.pr?.autoMerge, "off");
    using db = new Database(state.filename);
    const [authorization, outcome] = publishAudit(db).slice(-2);
    assert.equal(authorization?.kind, "publish.authorized");
    assert.equal(JSON.parse(authorization!.data).reason, "setting-change");
    assert.equal(outcome?.kind, "publish.auto-merge-set");
    assert.equal(JSON.parse(outcome!.data).reason, "setting-change");
  },
);

test(
  "discard disarms after opt-out and exposes retry failures with backoff",
  gitTestOptions,
  async () => {
    using state = orchestratorFixture("lo-publish-");
    const { store } = state;
    store.configureGoalPublishing({ autoMerge: "squash" });
    const f = await integratedGoal(state);
    const remote = fakePublishRemote();
    const enabled = new GoalPublisher(
      store,
      f.directory,
      f.repoRoot,
      remote.provider,
      { enabled: true },
    );
    await enabled.tick();
    await enabled.publish(f.goalId, f.integratedHead);
    await enabled.stop();
    const disabled = new GoalPublisher(
      store,
      f.directory,
      f.repoRoot,
      remote.provider,
      { enabled: false },
    );
    const now = Date.now();
    const callCount = remote.calls.length;
    await disabled.tick(now);
    assert.deepEqual(remote.calls.slice(callCount), ["read-pr"]);
    assert.partialDeepStrictEqual(
      await operatorAction(store, f.directory, "goal.discard", {
        id: f.goalId,
        expectedHead: f.integratedHead,
        confirm: "G1",
      }),
      { result: { status: "cancelled", autoMergeDisarmPending: true } },
    );
    const disarmCount = () =>
      remote.mutations.filter((mutation) => mutation === "auto-merge off")
        .length;
    remote.controls.rejectDisarm = true;
    await disabled.tick(now + 1);
    assert.equal(disarmCount(), 1);
    assert.partialDeepStrictEqual(
      await readOperatorGoal(store, f.directory, f.goalId),
      {
        publish: {
          enabled: false,
          state: "failed",
          failure: "auto-merge-disarm-failed",
          autoMergeEnabled: "squash",
        },
        turn: {
          owner: "stopped",
          reason: { kind: "publish-failed", code: "auto-merge-disarm-failed" },
        },
      },
    );
    await disabled.tick(now + 4000);
    assert.equal(disarmCount(), 1);
    await disabled.tick(now + 4001);
    assert.equal(disarmCount(), 2);
    remote.controls.rejectDisarm = false;
    await disabled.tick(now + 12_000);
    assert.equal(disarmCount(), 2);
    await disabled.tick(now + 12_001);
    assert.equal(disarmCount(), 3);
    assert.equal(remote.controls.pr?.autoMerge, "off");
    assert.equal(
      (await readOperatorGoal(store, f.directory, f.goalId))?.publish?.failure,
      undefined,
    );
    const db = new Database(state.filename);
    try {
      const audit = publishAudit(db);
      assert.equal(
        audit.filter(
          ({ kind, data }) =>
            kind === "publish.failed" &&
            JSON.parse(data).code === "auto-merge-disarm-failed",
        ).length,
        1,
      );
      assert.equal(
        audit.filter(
          ({ kind, data }) =>
            kind === "publish.authorized" &&
            JSON.parse(data).reason === "goal-cancelled",
        ).length,
        3,
      );
    } finally {
      db.close();
    }
  },
);

test(
  "rollback to the previous published head disarms auto-merge until manual publish",
  gitTestOptions,
  async () => {
    using state = orchestratorFixture("lo-publish-");
    const { store } = state;
    store.configureGoalPublishing({ autoMerge: "squash" });
    const f = await integratedGoal(state);
    const remote = fakePublishRemote();
    const config = { enabled: true };
    const publisher = new GoalPublisher(
      store,
      f.directory,
      f.repoRoot,
      remote.provider,
      config,
    );
    await publisher.publish(f.goalId, f.integratedHead);
    const head = await integrateNext(state, f);
    await publisher.publish(f.goalId, head);
    assert.equal(store.goalPublishRecord(f.goalId)?.phase, "complete");
    assert.equal(remote.controls.pr?.autoMerge, "squash");
    remote.foreignPush(f.integratedHead);
    await publisher.tick();
    assert.equal(remote.controls.pr?.autoMerge, "off");
    const db = new Database(state.filename);
    try {
      assert.deepEqual(
        publishAudit(db)
          .filter(
            ({ data }) => JSON.parse(data).reason === "remote-head-changed",
          )
          .map(({ kind }) => kind),
        ["publish.authorized", "publish.auto-merge-set"],
      );
    } finally {
      db.close();
    }
    await publisher.stop();

    remote.foreignPush(head);
    using reopened = openTestStore(state.filename);
    const restarted = new GoalPublisher(
      reopened.store,
      f.directory,
      f.repoRoot,
      remote.provider,
      config,
    );
    await restarted.tick();
    assert.equal(reopened.store.goalPublishRecord(f.goalId)?.pr?.head, head);
    assert.equal(remote.controls.pr?.autoMerge, "off");
    assert.equal(
      (await readOperatorGoal(reopened.store, f.directory, f.goalId))?.publish
        ?.failure,
      "publish-remote-head-changed",
    );
    assert.partialDeepStrictEqual(
      await goalPublishAction(reopened.store, restarted, "goal.publish", {
        id: f.goalId,
        expectedHead: head,
        confirm: goalPublishConfirmation("G1", head),
      }),
      { result: { state: "pr-open", autoMergeEnabled: "squash" } },
    );
    assert.equal(remote.controls.pr?.autoMerge, "squash");
    assert.equal(
      reopened.store.goalPublishRecord(f.goalId)?.pollFailure,
      undefined,
    );
  },
);

test(
  "toggling publish off and back on skips Goals finished during opt-out",
  gitTestOptions,
  async () => {
    using state = orchestratorFixture("lo-publish-");
    const { store } = state;
    const f = stage3Fixture(state);
    const remote = fakePublishRemote();
    const publisher = (enabled: boolean) =>
      new GoalPublisher(store, f.directory, f.repoRoot, remote.provider, {
        enabled,
      });
    const first = publisher(true);
    await first.tick();
    await first.stop();
    const disabled = publisher(false);
    await disabled.tick();
    const proposal = await f.proposal();
    approve(store, proposal);
    await f.work.drain();
    assert.equal(store.goalIsPublishReady(f.goalId), true);
    await disabled.tick();
    await disabled.stop();
    const reenabled = publisher(true);
    await reenabled.tick();
    assert.deepEqual(remote.calls, []);
    assert.equal(store.goalPublishRecord(f.goalId), null);
    const head = proposal.content.candidate;
    assert.equal((await reenabled.publish(f.goalId, head)).state, "pr-open");
  },
);

test(
  "unchanged polls leave audit and activity alone and slow down for old PRs",
  gitTestOptions,
  async () => {
    using state = orchestratorFixture("lo-publish-");
    const f = await integratedGoal(state);
    const remote = fakePublishRemote();
    const publisher = new GoalPublisher(
      state.store,
      f.directory,
      f.repoRoot,
      remote.provider,
      { enabled: true },
    );
    await publisher.publish(f.goalId, f.integratedHead);
    remote.controls.pr = {
      ...remote.controls.pr!,
      checkRuns: [{ name: "build", state: "pending" }],
      checkCounts: { pass: 0, pending: 1, fail: 0 },
      mergeable: "clean",
    };
    const db = new Database(state.filename);
    try {
      const now = Date.now() + 3_700_000;
      await publisher.tick(now - 600_000);
      const revision = state.store.activityRevision();
      const audit = publishAudit(db);
      await publisher.tick(now);
      assert.equal(remote.calls.filter((call) => call === "read-pr").length, 2);
      assert.deepEqual(publishAudit(db), audit);
      assert.equal(state.store.activityRevision(), revision);
      remote.controls.pr = {
        ...remote.controls.pr!,
        checks: "passed",
        checkRuns: [{ name: "build", state: "pass" }],
        checkCounts: { pass: 1, pending: 0, fail: 0 },
      };
      await publisher.tick(now + 599_999);
      assert.equal(remote.calls.filter((call) => call === "read-pr").length, 2);
      await publisher.tick(now + 600_000);
      assert.equal(remote.calls.filter((call) => call === "read-pr").length, 3);
      assert.deepEqual(
        publishAudit(db)
          .slice(audit.length)
          .map(({ kind }) => kind),
        ["publish.polled"],
      );
      assert.ok(state.store.activityRevision() > revision);
      remote.controls.pr = { ...remote.controls.pr!, state: "closed" };
      await publisher.tick(now + 1_200_000);
      await publisher.tick(now + 1_800_000);
      assert.equal(remote.calls.filter((call) => call === "read-pr").length, 4);
    } finally {
      db.close();
    }
  },
);

for (const code of [
  "publish-audit-failed",
  "publish-busy",
  "publish-stale-head",
] as const) {
  test(
    `automatic ${code} retries back off and reuse completed scans`,
    gitTestOptions,
    async () => {
      using state = orchestratorFixture("lo-publish-");
      const f = stage3Fixture(state);
      const remote = fakePublishRemote();
      let attempts = 0;
      let scans = 0;
      const publisher = new GoalPublisher(
        state.store,
        f.directory,
        f.repoRoot,
        {
          ...remote.provider,
          async repository(name) {
            if (++attempts < 3) throw new PublishError(code);
            return remote.provider.repository(name);
          },
        },
        { enabled: true },
        async () => {
          scans++;
        },
      );
      await publisher.tick(0);
      approve(state.store, await f.proposal());
      await f.work.drain();
      const now = Date.now();
      await publisher.tick(now);
      const screened = scans;
      assert.ok(screened >= 2);
      assert.equal(state.store.goalPublishRecord(f.goalId), null);
      await publisher.tick(now + 1000);
      assert.equal(attempts, 1);
      await publisher.tick(now + 2000);
      await publisher.tick(now + 5999);
      assert.equal(attempts, 2);
      await publisher.tick(now + 6000);
      assert.equal(attempts, 3);
      assert.equal(scans, screened);
      assert.equal(state.store.goalPublishRecord(f.goalId)?.pr?.state, "open");
    },
  );
}

test(
  "manual publish racing the timer shares the cross-connection publisher lock",
  gitTestOptions,
  async () => {
    using state = orchestratorFixture("lo-publish-");
    const f = stage3Fixture(state);
    const remote = fakePublishRemote();
    const config = { enabled: true };
    const timer = new GoalPublisher(
      state.store,
      f.directory,
      f.repoRoot,
      remote.provider,
      config,
    );
    await timer.tick();
    const proposal = await f.proposal();
    approve(state.store, proposal);
    await f.work.drain();
    const head = proposal.content.candidate;
    const inPush = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    remote.controls.beforePush = async () => {
      inPush.resolve();
      await release.promise;
    };
    const auto = timer.tick();
    try {
      await Promise.race([
        inPush.promise,
        auto.then(() => assert.fail("timer did not push")),
      ]);
      using reopened = openTestStore(state.filename);
      const manual = new GoalPublisher(
        reopened.store,
        f.directory,
        f.repoRoot,
        remote.provider,
        config,
      );
      const params = {
        id: f.goalId,
        expectedHead: head,
        confirm: goalPublishConfirmation("G1", head),
      };
      assert.deepEqual(
        await goalPublishAction(reopened.store, manual, "goal.publish", params),
        {
          error: { code: "publish-busy" },
        },
      );
      release.resolve();
      await auto;
      assert.partialDeepStrictEqual(
        await goalPublishAction(reopened.store, manual, "goal.publish", params),
        {
          result: { state: "pr-open" },
        },
      );
      assert.deepEqual(remote.mutations, [
        `push ${head}:ab/g1-${f.goalId.slice(0, 8)}`,
        "open-pr",
      ]);
    } finally {
      release.resolve();
      await auto;
    }
  },
);

test(
  "PR titles wrap scoped tokens in code and neutralize other mentions",
  gitTestOptions,
  async () => {
    using state = orchestratorFixture("lo-publish-");
    const raw = `@orga\u200bnization/team\u2028  (#321) @notify @Scope/name @scope/package-name_1.2 file@example.org   ${"x".repeat(90)}`;
    const f = await integratedGoal(state, raw);
    const remote = fakePublishRemote();
    const screened: Array<string | Uint8Array> = [];
    const publisher = new GoalPublisher(
      state.store,
      f.directory,
      f.repoRoot,
      remote.provider,
      { enabled: true },
      async (...values) => {
        screened.push(...values);
      },
    );
    await publisher.publish(f.goalId, f.integratedHead);
    const title = remote.files[0]!.title;
    assert.equal(
      title,
      `\`@organization/team\` (＃321) ＠notify ＠Scope/name \`@scope/package-name_1.2\` file＠example.org ${"x".repeat(90)}`,
    );
    assert.ok(Array.from(title).length <= 200);
    assert.ok(screened.includes(raw));
    assert.ok(screened.includes(title));
  },
);

test(
  "PR text reports the final candidate once and counts earlier revisions",
  gitTestOptions,
  async () => {
    using state = orchestratorFixture("lo-publish-");
    const { store } = state;
    const f = stage3Fixture(state, undefined, "revise-review");
    const proposal = await f.proposal();
    approve(store, proposal);
    await f.work.drain();
    assert.equal(f.verifications(), 3);
    const remote = fakePublishRemote();
    const publisher = new GoalPublisher(
      store,
      f.directory,
      f.repoRoot,
      remote.provider,
      { enabled: true },
    );
    await publisher.publish(f.goalId, proposal.content.candidate);
    assert.deepEqual(store.goalPublishEvidence(f.goalId).get(f.taskId!), {
      verification: true,
      review: true,
      revisions: 1,
    });
    const body = remote.files[0]!.body;
    assert.match(body, /## 検証とレビュー[\s\S]*G1-1 ✓ \/ ✓（やり直し 1 回）/);
    assert.equal(body.match(/✓ \/ ✓/g)?.length, 1);
    assert.doesNotMatch(body, /✕/);
  },
);

test("PR text keeps each bounded task row, abbreviates model text and screens every original field", () => {
  using state = orchestratorFixture("lo-publish-text-");
  const { store } = state;
  const id = goal(store);
  const taskId = task(store, id)!;
  const originalTask = store.getTask(taskId)!;
  const originalGoal = store.getGoal(id)!;
  const omittedTitle = "省略された Task の原文";
  const title = "目標の表題";
  const description = "長い計画の本文";
  const acceptance = "大きい条件".repeat(4000);
  const tasks = Array.from({ length: 183 }, (_, index) => ({
    ...originalTask,
    ref: `G1-${index + 1}`,
    id: String(index),
    status:
      index === 0
        ? ("succeeded" as const)
        : index === 1
          ? ("failed" as const)
          : ("registered" as const),
    content: {
      ...originalTask.content,
      title:
        index === 182
          ? omittedTitle
          : `作業 ${index + 1} ${"長い表題".repeat(45)}`,
    },
  }));
  const head = "a".repeat(40);
  const { body, screened } = buildGoalPullRequest(
    {
      listTasks: () => tasks,
      goalPublishEvidence: () =>
        new Map([["0", { verification: false, review: true, revisions: 2 }]]),
    },
    {
      ...originalGoal,
      content: {
        ...originalGoal.content,
        title,
        description,
        acceptance: [acceptance],
      },
    },
    head,
  );

  assert.ok(Buffer.byteLength(body) <= 24 * 1024);
  assert.ok(body.includes("## 目標"));
  assert.ok(body.includes(title));
  assert.ok(body.includes(`Goal G1 · ${id}`));
  assert.ok(body.includes(head));
  assert.match(body, /### 受け入れ条件\n\n    - 大きい条件/);
  assert.ok(!body.includes(description));
  const taskSection = body
    .split("## Task 一覧")[1]!
    .split("## 検証とレビュー")[0]!;
  assert.equal(taskSection.match(/^    G1-\d+ [✓✕–]/gm)?.length, 180);
  assert.match(taskSection, /G1-1 ✓ 作業 1/);
  assert.match(taskSection, /G1-2 ✕ 作業 2/);
  assert.match(taskSection, /G1-180 – 作業 180/);
  assert.match(taskSection, /ほか 3 件の Task を省略しました/);
  assert.match(body, /G1-1 ✕ \/ ✓（やり直し 2 回）/);
  assert.match(body, /G1-2 – \/ –/);
  for (const original of [
    title,
    description,
    acceptance,
    omittedTitle,
    tasks[0]!.content.title,
  ])
    assert.ok(screened.includes(original));
});
