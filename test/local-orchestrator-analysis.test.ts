import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SqliteAudit } from "../src/audit.ts";
import { JsonlWriter } from "../src/jsonl-files.ts";
import { runDuckDb } from "../src/local-orchestrator/analysis.ts";
import { runCli } from "../src/local-orchestrator/cli.ts";
import { exportOrchestrator } from "../src/local-orchestrator/export.ts";
import { goalBranch } from "../src/local-orchestrator/model.ts";
import { OrchestratorStore } from "../src/local-orchestrator/store.ts";
import {
  discoverAnalysisTargets,
  prepareTargetDirectory,
  resolveTarget,
} from "../src/local-orchestrator/target.ts";

const host = { kind: "host" } as const;
const operator = { kind: "operator" } as const;
const human = { kind: "human" } as const;
const authorization = "DO NOT EXPORT operator delegation text";
const budgets = { maxExecutionMs: 1000, maxRetries: 1, maxTokens: 500 };
const usage = { input: 8, output: 2, cacheCreation: 0, cacheRead: 10 };

function fixture(store: OrchestratorStore) {
  const runtimeId = randomUUID();
  const sessionId = store.startSession("Concierge", runtimeId).id;
  const planner = store.createExecution({
    actor: "Planner",
    mode: "goal-design",
    requestedBy: { kind: "actor", actor: "Concierge", sessionId },
  }).id;
  store.startExecution(planner);
  const goal = store.proposeGoal(
    {
      title: "PRIVATE PROMPT",
      description: "",
      acceptance: ["Pass"],
      scope: {
        paths: ["src/"],
        profiles: ["base"],
        actors: ["Executor"],
        maxTasks: 3,
        budgets,
      },
    },
    { kind: "actor", actor: "Planner", sessionId, executionId: planner },
  );
  store.finishExecution(planner, "succeeded", {
    costUsd: 0.5,
    numTurns: 2,
    durationMs: 200,
    tokens: 11,
    usage: [usage],
  });
  const { goalId } = store.decide(goal.id, {
    digest: goal.digest,
    decision: "approve",
    answerer: {
      kind: "human",
      delegate: {
        agent: "claude-code",
        session: "delegate-session",
        authorization,
      },
    },
  });
  assert.ok(goalId);
  const task = store.proposeTask(
    {
      title: "PRIVATE TASK",
      description: "",
      acceptance: ["Pass"],
      goalId,
      actor: "Executor",
      profile: "base",
      paths: ["src/example.ts"],
      dependsOn: [],
      budgets,
    },
    operator,
  );
  assert.equal(task.status, "registered");
  if (task.status !== "registered")
    throw new Error("fixture task must register");
  const { taskId } = task;
  assert.ok(store.claimTask(taskId));
  function run(
    actor: "Executor" | "Reviewer",
    mode: string,
    status: "succeeded" | "failed",
    result: object,
  ) {
    const { id } = store.createExecution({
      actor,
      mode,
      taskId,
      requestedBy: host,
    });
    store.startExecution(id);
    store.finishExecution(id, status, result);
    return id;
  }
  run("Executor", "task", "failed", {
    code: "path-violation",
    revision: false,
    tokens: 11,
    usage,
    costUsd: 0.25,
    rawAnswer: "PRIVATE RESULT",
  });
  const worker = run("Executor", "task", "succeeded", {
    // Previously recorded revisions are reconstructed from Task claim events.
    tokens: 11,
    usage,
    costUsd: 0.25,
  });
  run("Reviewer", "verification", "succeeded", {
    tokens: 0,
    usage: { input: 0, output: 0, cacheCreation: 0, cacheRead: 0 },
  });
  const pin = {
    base: "a".repeat(40),
    candidate: "b".repeat(40),
    digest: "c".repeat(64),
  };
  const review = run("Reviewer", "review", "succeeded", {
    review: "pass",
    pin,
    tokens: 11,
    usage,
    costUsd: 0.5,
  });
  const integration = store.proposeIntegration(
    {
      ...pin,
      goalId,
      taskId,
      branch: goalBranch(goalId),
      changedPaths: ["src/example.ts"],
      review: { result: "pass" },
      verified: true,
    },
    review,
  );
  store.decide(integration.id, {
    digest: integration.digest,
    decision: "approve",
    answerer: human,
  });
  store.beginIntegration(
    integration.id,
    integration.digest,
    store.approvedIntegration(integration.id).approvalId,
  );
  store.finishIntegration(integration.id, "completed", "ok");
  store.setProjectDefaults({ "goal-registration": "agent" }, operator);
  const rejected = store.proposeGoal(store.getGoal(goalId)!.content, operator);
  const approver = store.createExecution({
    actor: "Reviewer",
    mode: "approval",
    requestedBy: host,
  }).id;
  store.startExecution(approver);
  store.decide(rejected.id, {
    digest: rejected.digest,
    decision: "reject",
    answerer: { kind: "agent", executionId: approver, model: "fixture" },
  });
  store.finishExecution(approver, "succeeded", {
    costUsd: 0.125,
    tokens: 11,
    usage,
    proposalId: rejected.id,
  });
  store.endSession(sessionId, {
    mode: "plan",
    status: "succeeded",
    exitCode: 0,
  });
  store.recordSessionAuditExport(sessionId, true);
  return { planner, worker, goalId, taskId };
}

function jsonlFiles(root: string): string[] {
  return readdirSync(root, { recursive: true, encoding: "utf8" })
    .filter((name) => name.endsWith(".jsonl"))
    .sort();
}

test("exports a private consistent store snapshot and skips unchanged re-exports", () => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "lo-analysis-"));
  try {
    const db = join(root, "state.db");
    const obs = join(root, "export");
    const store = OrchestratorStore.open(db);
    try {
      fixture(store);
      const before = readFileSync(db);
      exportOrchestrator(db, obs);
      const files = jsonlFiles(obs);
      assert.equal(files.length, 7);
      const output = files
        .map((name) => {
          const path = join(obs, name);
          assert.equal(statSync(path).mode & 0o777, 0o600);
          return readFileSync(path, "utf8");
        })
        .join("");
      assert.doesNotMatch(
        output,
        /authorization|DO NOT EXPORT|PRIVATE PROMPT|PRIVATE RESULT|PRIVATE TASK/,
      );
      assert.match(
        output,
        /"delegated":true,"agent":"claude-code","session":"delegate-session"/,
      );
      assert.match(
        output,
        /"kind":"session.audit-export"[^\n]*"exported":true/,
      );
      const checkpoint = readFileSync(
        join(obs, "orchestrator/export-state.json"),
        "utf8",
      );
      exportOrchestrator(db, obs);
      assert.deepEqual(jsonlFiles(obs), files);
      assert.equal(
        readFileSync(join(obs, "orchestrator/export-state.json"), "utf8"),
        checkpoint,
      );
      assert.deepEqual(readFileSync(db), before);
      const execution = store.createExecution({
        actor: "Researcher",
        mode: "research",
        requestedBy: host,
      });
      exportOrchestrator(db, obs);
      store.startExecution(execution.id);
      store.finishExecution(execution.id, "failed", {
        code: "PRIVATE-ERROR",
        costUsd: -1,
      });
      exportOrchestrator(db, obs);
      assert.equal(jsonlFiles(obs).length, 11);
      assert.doesNotMatch(
        jsonlFiles(obs)
          .map((name) => readFileSync(join(obs, name), "utf8"))
          .join(""),
        /PRIVATE-ERROR/,
      );
    } finally {
      store.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("discovers the default target and previous target slugs without their worktrees", async () => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "lo-analysis-"));
  try {
    const target = await resolveTarget(undefined, root);
    assert.deepEqual(
      (await discoverAnalysisTargets(target)).map(({ slug }) => slug),
      [target.slug],
    );
    const parent = join(target.directory, "targets");
    await prepareTargetDirectory(root, join(parent, "dagq-lite-123456789abc"));
    mkdirSync(join(parent, "ignored"));
    symlinkSync(join(parent, "ignored"), join(parent, "symlink-123456789abc"));
    writeFileSync(join(parent, "file-123456789abc"), "");
    assert.deepEqual(
      (await discoverAnalysisTargets(target)).map(({ slug }) => slug),
      [target.slug, "dagq-lite-123456789abc"],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the non-interactive analyzer joins target-local audit and telemetry in DuckDB", async (t) => {
  if (runDuckDb(["-version"]).status !== 0) {
    t.skip("Pinned DuckDB 1.5.6 unavailable in the local mise cache");
    return;
  }
  const root = mkdtempSync(join(realpathSync(tmpdir()), "lo-analysis-"));
  try {
    const target = await resolveTarget(undefined, root);
    const other = "dagq-lite-0123456789ab";
    const otherDirectory = join(target.directory, "targets", other);
    await prepareTargetDirectory(root, otherDirectory);
    const state = join(target.directory, "state.db");
    const store = OrchestratorStore.open(state);
    const { planner, worker, goalId, taskId } = fixture(store);
    store.close();
    // Duplicate IDs make an accidentally target-blind join visible.
    copyFileSync(state, join(otherDirectory, "state.db"));
    const otherStore = OrchestratorStore.open(join(otherDirectory, "state.db"));
    otherStore.setProjectDefaults({ integration: "human" }, operator);
    otherStore.close();
    const audit = new SqliteAudit(join(target.directory, "audit.sqlite"));
    const plannerRetry = randomUUID();
    audit.appendExecutionContext({
      executionId: plannerRetry,
      retryOfExecutionId: planner,
    });
    audit.append({
      invocationId: worker,
      kind: "invocation.started",
      role: "Worker",
    });
    for (const kind of [
      "operation.requested",
      "operation.allowed",
      "operation.finished",
    ] as const)
      audit.append({
        invocationId: worker,
        kind,
        operation: "sandbox.create",
        ...(kind === "operation.finished" ? { outcome: "ok" } : {}),
      });
    const traces = new JsonlWriter(
      join(target.directory, "observability/telemetry/traces"),
    );
    traces.write({
      resourceSpans: [
        {
          scopeSpans: [
            {
              spans: [
                {
                  traceId: "trace",
                  spanId: "span",
                  name: "agent.run",
                  startTimeUnixNano: "1000000",
                  endTimeUnixNano: "35000000",
                  attributes: [
                    {
                      key: "agent_bootstrap.execution_id",
                      value: { stringValue: plannerRetry },
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    });
    traces.close();
    const extra = join(root, "assert.sql");
    writeFileSync(
      extra,
      `
SELECT CASE WHEN (SELECT count(*) FROM actor_runs) = 12
 AND (SELECT goal_id FROM actor_runs WHERE target = '${target.slug}' AND execution_id = '${planner}') = '${goalId}'
 AND (SELECT process_exec_ms FROM actor_runs WHERE target = '${target.slug}' AND execution_id = '${planner}') = 34
 AND (SELECT process_exec_ms IS NULL FROM actor_runs WHERE target = '${other}' AND execution_id = '${planner}')
 AND (SELECT sandbox_create_ms IS NOT NULL FROM actor_runs WHERE target = '${target.slug}' AND execution_id = '${worker}')
 AND (SELECT count(*) = 2 AND bool_and(attempts = 2 AND revisions = 1 AND path_violations = 1 AND status = 'succeeded'
      AND registration_to_integration_ms >= 0 AND review_verdicts = ['pass'] AND verification_results = ['succeeded']
      AND total_cost_usd = 1 AND total_budget_tokens = 33) FROM task_outcomes WHERE task_id = '${taskId}')
 AND (SELECT count(*) = 2 AND bool_and(tasks = 1 AND total_cost_usd = 1.5 AND total_raw_tokens = 80
      AND approval_to_last_integration_ms >= 0) FROM goal_summary)
 AND (SELECT count(*) = 2 AND bool_and(agent = 'claude-code' AND session = 'delegate-session' AND duration_ms >= 0)
      FROM gate_latency WHERE answerer_kind = 'delegated')
 AND (SELECT count(*) = 2 AND bool_and(policy = 'agent' AND decision = 'reject'
      AND answerer_cost_usd = 0.125 AND answerer_status = 'succeeded')
      FROM gate_latency WHERE answerer_kind = 'agent')
 AND (SELECT count(*) = 2 AND bool_and(planner_requests = 1 AND mode = 'plan' AND session_outcome = 'succeeded')
      FROM concierge_sessions)
 AND (SELECT count(*) = 2 AND bool_and(failures_by_code ->> 'path-violation' = '1' AND success_rate = 0.5)
      FROM actor_summary WHERE actor = 'Executor')
 THEN 'fixture-ok' ELSE error('unexpected local orchestrator analysis') END;`,
    );
    let stdout = "";
    let stderr = "";
    const out = join(root, "analysis with spaces");
    let code: number;
    try {
      code = await runCli(
        ["--all-targets", "analyze", "--out", out, "--sql", extra],
        {
          stdin: process.stdin,
          isTTY: false,
          stdout: { write: (text) => (stdout += text) },
          stderr: { write: (text) => (stderr += text) },
          prompt: () => {
            throw new Error("unexpected analysis prompt");
          },
        },
        root,
      );
    } finally {
      audit.close();
    }
    assert.equal(code, 0, stderr);
    assert.match(stdout, /fixture-ok/);
    assert.match(stdout, /-init \/dev\/null/);
    assert.equal(statSync(out).mode & 0o777, 0o700);
    assert.deepEqual(
      readdirSync(out).sort(),
      [target.slug, other, "load.sql"].sort(),
    );
    const resumed = OrchestratorStore.open(state);
    try {
      const execution = resumed.createExecution({
        actor: "Researcher",
        mode: "research",
        requestedBy: host,
      });
      exportOrchestrator(state, join(out, target.slug));
      resumed.startExecution(execution.id);
      resumed.finishExecution(execution.id, "succeeded");
      exportOrchestrator(state, join(out, target.slug));
      const updated = runDuckDb(
        ["-bail", "-csv", "-noheader", ":memory:"],
        readFileSync(join(out, "load.sql"), "utf8") +
          "SELECT status FROM actor_runs WHERE actor = 'Researcher';\n",
      );
      assert.equal(updated.status, 0, updated.stderr);
      assert.equal(updated.stdout.trim(), "succeeded");
    } finally {
      resumed.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
