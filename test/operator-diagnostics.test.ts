import assert from "node:assert/strict";
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { AuditStoreError } from "../src/audit.ts";
import {
  configRoot,
  userConfigPath,
  writePrivateConfig,
} from "../src/config/layers.ts";
import { addProject } from "../src/config/projects.ts";
import { ConfigError } from "../src/config/messages.ts";
import { MsbHomeError } from "../src/config/msb-home.ts";
import { GitIntegrationError } from "../src/git-integration.ts";
import { runCli } from "../src/local-orchestrator/cli.ts";
import { exportOrchestrator } from "../src/local-orchestrator/export.ts";
import {
  secretTestWarnings,
  withActorSecret,
} from "../src/local-orchestrator/secret-launch.ts";
import { recordSecretTestPass } from "../src/local-orchestrator/secret-test-record.ts";
import {
  OrchestratorStore,
  OrchestratorStoreError,
} from "../src/local-orchestrator/store.ts";
import { runTask, type TaskFlow } from "../src/local-orchestrator/tasks.ts";
import { doctor, systemHost } from "../src/onboarding/prerequisites.ts";
import { ObservedHostStartupError } from "../src/observed-host.ts";
import { MountBusy, VolumeError } from "../src/volumes/volume.ts";
import { conciergeFailure } from "../spike/local-orchestrator/concierge.ts";
import { configEnv, initConfigRepo } from "./config-fixture.ts";

const budgets = { maxExecutionMs: 1000, maxRetries: 1, maxTokens: 50 };
const pin = {
  base: "a".repeat(40),
  candidate: "b".repeat(40),
  digest: "c".repeat(64),
};

function fixture(t: TestContext) {
  const root = mkdtempSync(
    join(realpathSync(tmpdir()), "operator-diagnostics-"),
  );
  const db = join(root, "state.db");
  const store = OrchestratorStore.open(db);
  t.after(() => {
    store.close();
    rmSync(root, { force: true, recursive: true });
  });
  const approve = ({ id, digest }: { id: string; digest: string }) =>
    store.decide(id, {
      decision: "approve",
      answerer: { kind: "human" },
      digest,
    });
  const { goalId } = approve(
    store.proposeGoal(
      {
        title: "Goal",
        description: "",
        acceptance: ["Changes stay in scope"],
        scope: {
          paths: ["docs/"],
          profiles: ["base"],
          actors: ["Executor"],
          maxTasks: 3,
          budgets,
        },
      },
      { kind: "operator" },
    ),
  );
  const task = () => {
    const draft = store.proposeTask(
      {
        goalId: goalId!,
        title: "Task",
        description: "",
        acceptance: ["Update docs"],
        actor: "Executor",
        profile: "base",
        paths: ["docs/"],
        dependsOn: [],
        budgets,
      },
      { kind: "actor", actor: "Planner" },
    );
    return (draft.status === "registered" ? draft : approve(draft)).taskId!;
  };

  async function show(
    kind: "show" | "show-execution",
    id: string,
    asJson = true,
  ) {
    let output = "";
    let error = "";
    const code = await runCli(
      ["--db", db, kind, id],
      {
        stdin: process.stdin,
        stdout: {
          write(text) {
            output += text;
          },
        },
        stderr: {
          write(text) {
            error += text;
          },
        },
        ...(asJson
          ? {
              json(text: string) {
                output += text;
              },
            }
          : {}),
        isTTY: !asJson,
        prompt: () => undefined,
      },
      root,
      configEnv(root),
    );
    assert.equal(code, 0, error);
    return output;
  }

  const execute = (taskId: string, flow: TaskFlow) =>
    runTask(
      store,
      {
        open: async () => flow,
        diff: async () => assert.fail("candidate diff was requested"),
      },
      taskId,
    );
  const exported = (stream: "events" | "executions") => {
    const directory = join(root, "analysis", "orchestrator", stream);
    exportOrchestrator(db, join(root, "analysis"));
    return readdirSync(directory)
      .filter((name) => name.endsWith(".jsonl"))
      .map((name) => readFileSync(join(directory, name), "utf8"))
      .join("");
  };
  return { root, store, task, show, execute, exported };
}

test("rejected paths are bounded and escaped per attempt and on final Task failure", async (t) => {
  const { store, task, show, execute, exported } = fixture(t);
  const taskId = task();
  const ids: string[] = [];
  let rejections = 0;
  await execute(taskId, {
    async worker(id) {
      ids.push(id);
      return pin;
    },
    async review() {
      return assert.fail("rejected candidate reached review");
    },
    async reject() {
      rejections++;
    },
    async changes() {
      if (ids.length === 1)
        return [{ path: "first/reject", newMode: "100644" }];
      return [
        {
          path: "docs/link\x1b\n\u202e",
          newMode: "120000",
          target: "../outside",
        },
        { path: "docs/ok", newMode: "100644" },
        { path: "docs/ok-link", newMode: "120000", target: "./ok" },
        { path: "private-" + "\t".repeat(300), newMode: "100644" },
        ...Array.from({ length: 30 }, (_, index) => ({
          path: `outside-${index}`,
          newMode: "100644",
        })),
      ];
    },
  });
  assert.equal(rejections, 2);
  const first = JSON.parse(await show("show-execution", ids[0]!));
  assert.deepEqual(first.result.rejectedPaths, [
    { path: "first/reject", symlink: false },
  ]);
  const last = JSON.parse(await show("show-execution", ids[1]!));
  assert.equal(last.result.code, "path-violation");
  const paths = last.result.rejectedPaths;
  assert.equal(paths.length, 20);
  assert.deepEqual(paths[0], {
    path: "docs/link\\u001b\\u000a\\u202e",
    symlink: true,
  });
  assert.match(paths[1].path, /^private-(?:\\u0009)+…$/);
  assert.ok(paths.every(({ path }: { path: string }) => path.length <= 256));
  assert.equal(paths.at(-1).path, "outside-17");
  assert.deepEqual(store.listEvents({ subjectId: taskId, limit: 1 })[0]?.data, {
    status: "failed",
    code: "path-violation",
    rejectedPaths: paths,
  });
  assert.deepEqual(JSON.parse(await show("show", taskId)).rejectedPaths, paths);
  for (const [command, id] of [
    ["show", taskId],
    ["show-execution", ids[1]!],
  ] as const) {
    const human = await show(command, id, false);
    assert.match(
      human,
      /Rejected path docs\/link\\u001b\\u000a\\u202e \(symlink\) and 19 more listed/,
    );
    assert.ok(!human.includes("\x1b") && !human.includes("\u202e"));
  }
  for (const output of [exported("events"), exported("executions")]) {
    assert.match(output, /"path-violation"/);
    assert.doesNotMatch(output, /rejectedPaths|outside-|docs\/link/);
  }
});

test("operator and analysis readers accept older path violations without a path list", async (t) => {
  const { store, task, show, exported } = fixture(t);
  const taskId = task();
  store.claimTask(taskId);
  const { id } = store.createExecution({
    actor: "Executor",
    mode: "task",
    taskId,
    requestedBy: { kind: "host" },
  });
  store.startExecution(id);
  store.finishExecution(id, "failed", { code: "path-violation" });
  store.failTask(taskId, "path-violation");
  assert.equal(
    JSON.parse(await show("show", taskId, false)).rejectedPaths,
    undefined,
  );
  assert.deepEqual(JSON.parse(await show("show-execution", id, false)).result, {
    code: "path-violation",
  });
  assert.match(exported("events"), /"code":"path-violation"/);
  assert.match(exported("executions"), /"failure_code":"path-violation"/);
});

test("Concierge formats known failures using the stage, code and recovery action", () => {
  const cases = [
    [
      new ConfigError("fixture", "private path", "Review configuration."),
      "config-invalid",
      "Review configuration.",
    ],
    [
      new VolumeError(
        "volume-detached",
        "private volume",
        "private reason",
        "Attach the volume.",
      ),
      "volume/volume-detached",
      "Attach the volume.",
    ],
    [
      new MountBusy("private volume"),
      "volume/mount-busy",
      "Wait for the volume operation to finish",
    ],
    [
      new MsbHomeError({
        source: "user",
        status: "wrong",
        detail: "private path",
        fix: ["Check the runtime home."],
      }),
      "runtime-home-invalid",
      "Check the runtime home.",
    ],
    [
      new AuditStoreError("open-failed"),
      "audit-store/open-failed",
      "Keep the audit database",
    ],
    [
      new GitIntegrationError("unsafe-input-symlink"),
      "git-integration/unsafe-input-symlink",
      "Replace absolute or escaping symlinks",
    ],
    [
      new OrchestratorStoreError("session-busy"),
      "orchestrator-store/session-busy",
      "Wait for the active launcher",
    ],
    [
      new ObservedHostStartupError("microsandbox-version-check-failed"),
      "microsandbox-version-check-failed",
      "Check the pinned runtime",
    ],
    [
      new ObservedHostStartupError("microsandbox-version-mismatch"),
      "microsandbox-version-mismatch",
      "Check the pinned runtime",
    ],
    [
      new ObservedHostStartupError("gateway-startup-failed"),
      "gateway-startup-failed",
      "Check local socket permissions",
    ],
  ] as const;
  for (const [error, code, action] of cases) {
    const [message, next] = conciergeFailure("open audited host", error).split(
      "\n",
    );
    assert.equal(message, `Concierge failed to open audited host (${code})`);
    assert.ok(next?.startsWith(`next: ${action}`));
  }
  assert.equal(
    conciergeFailure(
      "open state",
      Object.assign(new Error("raw SQLite text"), { code: "open-failed" }),
    ),
    "Concierge failed to open state",
  );
});

test("expired actor self-tests warn and refuse with the same target command", async (t) => {
  const { root, store, task, show, execute, exported } = fixture(t);
  const variable = "FIXTURE_TOOL_TOKEN";
  const config = {
    secrets: { tool: { keychainService: "fixture-service" } },
    secretEnv: { [variable]: { secret: "tool", actors: ["Executor"] } },
  } as const;
  const target = "/fixture checkout";
  const next =
    "agent-bootstrap secrets test FIXTURE_TOOL_TOKEN --target '/fixture checkout'";
  recordSecretTestPass(root, variable, undefined, "previous-image");
  assert.deepEqual(
    secretTestWarnings(config, root, "previous-image", target),
    [],
  );
  assert.deepEqual(secretTestWarnings(config, root, "changed-image", target), [
    `Warning: ${variable} has no current self-test pass.\nnext: ${next}`,
  ]);

  const taskId = task();
  let executionId = "";
  await execute(taskId, {
    async worker(id) {
      executionId = id;
      return withActorSecret(
        config,
        root,
        variable,
        "changed-image",
        target,
        async () => assert.fail("actor was launched"),
        async () => assert.fail("secret was read"),
      );
    },
    async review() {
      return assert.fail("review was started");
    },
    async reject() {
      assert.fail("candidate was created");
    },
    async changes() {
      return assert.fail("candidate was created");
    },
  });
  assert.equal(store.getExecution(executionId)?.status, "failed");
  const execution = JSON.parse(await show("show-execution", executionId));
  assert.equal(execution.result.code, "secret-test-required");
  assert.equal(execution.result.next, next);
  assert.ok(
    (await show("show-execution", executionId, false)).endsWith(
      `next: ${next}\n`,
    ),
  );
  const output = exported("executions");
  assert.match(output, /"failure_code":"secret-test-required"/);
  assert.doesNotMatch(output, /fixture checkout/);
});

test("doctor gives a target-specific command and does not require an actor self-test for Concierge startup", async (t) => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "operator-doctor-"));
  t.after(() => rmSync(root, { force: true, recursive: true }));
  const repo = initConfigRepo(join(root, "project checkout"));
  const env = configEnv(root);
  addProject(repo, undefined, env);
  const variable = "FIXTURE_TOOL_TOKEN";
  writePrivateConfig(userConfigPath(env), configRoot(env), {
    version: 1,
    claude: { auth: "external" },
    secrets: { tool: { keychainService: "fixture-service" } },
    secretEnv: { [variable]: { secret: "tool", actors: ["Executor"] } },
  });
  const { checks, first } = await doctor(
    fileURLToPath(new URL("..", import.meta.url)),
    {
      ...systemHost,
      env,
      async command() {
        return { code: 1, stdout: "" };
      },
      fetch: async () => assert.fail("doctor tried to access the network"),
    },
    repo,
    true,
  );
  const check = checks.find(({ id }) => id === `secretEnv.${variable}`);
  assert.equal(check?.status, "missing");
  assert.deepEqual(check.fix, [
    `agent-bootstrap secrets test ${variable} --target '${repo}'`,
  ]);
  assert.notEqual(first?.id, check.id);
});
