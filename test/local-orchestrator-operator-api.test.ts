import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import { once } from "node:events";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  realpathSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createConnection } from "node:net";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { test } from "node:test";
import { createConciergeTerminalHub } from "../src/local-orchestrator/concierge-terminal.ts";
import type { TerminalExit } from "../src/sandbox-runtime.ts";
import {
  dispatchPolicy,
  listenOperatorApi,
} from "../src/local-orchestrator/operator-api.ts";
import { projectInbox } from "../src/local-orchestrator/inbox.ts";
import { goalBranch } from "../src/local-orchestrator/model.ts";
import {
  operatorGoal,
  operatorGoalList,
  operatorInbox,
  operatorProblems,
  operatorStatus,
  operatorTask,
  operatorTaskList,
} from "../src/local-orchestrator/operator-read.ts";
import {
  answerFromPanel,
  answerManyFromPanel,
  parsePanelAnswer,
} from "../src/local-orchestrator/proposal-answer.ts";
import { orchestratorFixture } from "./local-orchestrator-fixture.ts";

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

test("operator delegation methods validate, audit and expose the effective settings", async () => {
  using fixture = orchestratorFixture("lo-op-policy-");
  const { store } = fixture;
  const operator = { kind: "operator" } as const;
  const planner = { kind: "actor", actor: "Planner" } as const;
  const call = (method: string, params: object) =>
    dispatchPolicy(store, method, params);
  const ok = { result: { ok: true } };
  const invalid = { error: { code: "invalid-params" } };
  const original = store.policySettings();
  assert.deepEqual(await call("policy.get", {}), { result: original });
  assert.deepEqual(original.defaults, {
    "goal-registration": "human",
    "task-registration": "human",
    integration: "human",
  });
  assert.deepEqual(original.rules, []);
  assert.ok(original.invariants.includes("policy-loosening"));

  const proposal = store.proposeGoal(goal, operator);
  const { goalId } = store.decide(proposal.id, {
    digest: proposal.digest,
    decision: "approve",
    answerer: { kind: "human" },
  });
  const task = store.proposeTask(
    {
      goalId,
      title: "Document",
      description: "",
      acceptance: ["Pass"],
      category: "docs",
      actor: "Executor",
      profile: "base",
      paths: ["src/a.md"],
      dependsOn: [],
      budgets: goal.scope.budgets,
    },
    planner,
  );
  if (task.status !== "registered")
    throw new Error("Expected automatic registration");
  const { taskId } = task;
  assert.deepEqual(
    await call("policy.setDefault", { gate: "integration", policy: "agent" }),
    ok,
  );
  assert.deepEqual(
    await call("goal.setPolicy", {
      goalId,
      gate: "integration",
      value: "human",
    }),
    ok,
  );
  assert.deepEqual(
    await call("task.setIntegrationPolicy", { taskId, value: "agent" }),
    ok,
  );
  assert.partialDeepStrictEqual(operatorGoal(store, goalId!), {
    policyOverrides: { "task-registration": "inherit", integration: "human" },
  });
  assert.partialDeepStrictEqual(operatorTask(store, taskId), {
    category: "docs",
    integrationPolicy: "agent",
    effectiveIntegrationPolicy: { policy: "agent", source: "operator-task" },
  });
  assert.deepEqual(
    await call("task.setIntegrationPolicy", {
      taskId,
      value: "rule",
      expected: "human",
    }),
    { error: { code: "stale-policy" } },
  );

  const rule = {
    id: "small",
    name: "Small integration",
    gate: "integration",
    action: "agent",
    enabled: true,
    order: 0,
    conditions: { maxChangedFiles: 2 },
  };
  assert.deepEqual(
    await call("policy.setRules", {
      rules: [rule],
      expectedRevision: original.rulesRevision,
    }),
    ok,
  );
  assert.deepEqual(
    await call("policy.setRules", {
      rules: [],
      expectedRevision: original.rulesRevision,
    }),
    { error: { code: "stale-policy" } },
  );
  assert.deepEqual(
    await dispatchPolicy(store, "policy.setRules", { rules: [] }, async () => {
      throw new Error("screened");
    }),
    { error: { code: "write-failed" } },
  );
  assert.deepEqual(store.policySettings().rules, [
    { ...rule, hitsLast7Days: 0 },
  ]);

  for (const [method, params] of [
    ["policy.get", { extra: true }],
    ["policy.setDefault", { gate: "other", policy: "agent" }],
    ["policy.setDefault", { gate: "integration", policy: "inherit" }],
    [
      "policy.setRules",
      { rules: [{ ...rule, conditions: { categories: ["docs"] } }] },
    ],
    ["policy.setRules", { rules: [], expectedRevision: "invalid" }],
    ["goal.setPolicy", { goalId, gate: "goal-registration", value: "agent" }],
    ["goal.setPolicy", { goalId, gate: "integration", value: "rule" }],
    ["task.setIntegrationPolicy", { taskId, value: "inherit" }],
    ["decision.history", { limit: 0 }],
    ["decision.history", { limit: 1.1 }],
  ] as const)
    assert.deepEqual(await call(method, params), invalid, method);
  assert.deepEqual(
    await call("task.setIntegrationPolicy", {
      taskId: "missing",
      value: "human",
    }),
    { error: { code: "not-found" } },
  );
  assert.deepEqual(await call("decision.history", {}), { result: [] });

  assert.deepEqual(
    await call("policy.setDefault", {
      gate: "goal-registration",
      policy: "agent",
    }),
    ok,
  );
  const agentProposal = store.proposeGoal(goal, planner);
  const execution = store.createExecution({
    actor: "Reviewer",
    mode: "approval",
    requestedBy: { kind: "host" },
    approvalProposalId: agentProposal.id,
  });
  store.startExecution(execution.id);
  const decision = store.decide(agentProposal.id, {
    digest: agentProposal.digest,
    decision: "approve",
    reasons: ["Reviewer model text"],
    answerer: {
      kind: "agent",
      executionId: execution.id,
      model: "claude-test",
    },
  });
  assert.partialDeepStrictEqual(await call("decision.history", { limit: 1 }), {
    result: [
      {
        goalId: decision.goalId,
        taskId: null,
        result: "approve",
        setting: { policy: "agent", source: "default" },
        reasons: ["Reviewer model text"],
      },
    ],
  });
  assert.partialDeepStrictEqual(
    store.listEvents({ subjectId: taskId, limit: 1 })[0],
    {
      kind: "task.policy-set",
      data: { origin: "operator-ui", before: "rule", after: "agent" },
    },
  );
  assert.ok(
    store
      .listEvents({ subjectId: "project", limit: 10 })
      .some(
        ({ kind, data }) =>
          kind === "project.defaults-set" &&
          (data as { origin: string }).origin === "operator-ui",
      ),
  );
});

test("operator API answers return per-item errors in order and audit the panel origin", async () => {
  using fixture = orchestratorFixture("lo-op-answer-");
  const { root, store } = fixture;
  const origin = { kind: "operator" } as const;
  const propose = () => {
    const { id, digest } = store.proposeGoal(goal, origin);
    return { id, digest };
  };
  const first = propose();
  const second = propose();
  const stale = { ...first, digest: "0".repeat(64), decision: "approve" };
  assert.deepEqual(
    await answerFromPanel(store, root, parsePanelAnswer(stale)),
    { id: first.id, error: { code: "stale-digest" } },
  );
  const approve = { ...first, decision: "approve" };
  const missing = { ...approve, id: "missing" };
  const screened: unknown[] = [];
  assert.deepEqual(
    await answerManyFromPanel(
      store,
      root,
      {
        answers: [
          stale,
          approve,
          missing,
          approve,
          { ...second, decision: "reject" },
        ],
      },
      async (source) => {
        screened.push(JSON.parse(String(source)));
      },
    ),
    [
      { id: first.id, error: { code: "stale-digest" } },
      { id: first.id, ok: true },
      { id: "missing", error: { code: "not-found" } },
      { id: first.id, error: { code: "invalid-transition" } },
      { id: second.id, ok: true },
    ],
  );
  assert.partialDeepStrictEqual(screened, [
    [first.id, first.id, "missing", first.id, second.id],
    { content: { title: goal.title } },
    { id: second.id, digest: second.digest, status: "pending" },
  ]);
  assert.equal(store.getProposal(first.id)?.status, "approved");
  assert.equal(store.getProposal(second.id)?.status, "rejected");
  for (const [proposal, decision] of [
    [first, "approve"],
    [second, "reject"],
  ] as const) {
    assert.partialDeepStrictEqual(
      store.listEvents({ subjectId: proposal.id, limit: 1 })[0],
      {
        kind: "proposal.decided",
        data: {
          digest: proposal.digest,
          decision,
          answererKind: "human",
          origin: { kind: "operator", channel: "operator-ui" },
        },
      },
    );
  }
  const third = propose();
  const pending = { ...third, decision: "approve" };
  for (const invalid of [
    { ...pending, delegate: {} },
    { ...pending, choice: "option" },
    { ...pending, decision: "abstain" },
    { ...pending, digest: "a".repeat(12) },
    { ...pending, id: "invalid id" },
  ]) {
    assert.throws(
      () => parsePanelAnswer(invalid),
      /Invalid local orchestrator input/,
    );
    await assert.rejects(
      answerManyFromPanel(store, root, { answers: [pending, invalid] }),
      /Invalid local orchestrator input/,
    );
  }
  for (const answers of [[], Array(21).fill(pending)])
    await assert.rejects(
      answerManyFromPanel(store, root, { answers }),
      /Invalid local orchestrator input/,
    );
  await assert.rejects(
    answerManyFromPanel(
      store,
      root,
      { answers: [pending, missing] },
      async () => {
        throw new Error("screening failed");
      },
    ),
    /screening failed/,
  );
  assert.equal(store.getProposal(third.id)?.status, "pending");
});

test("operator API enforces decision-specific human requirements under an agent policy", async () => {
  using fixture = orchestratorFixture("lo-op-answer-policy-");
  const { root, store } = fixture;
  const host = { kind: "host" } as const;
  const operator = { kind: "operator" } as const;
  store.setProjectDefaults({ "goal-registration": "agent" }, operator);
  const normal = store.proposeGoal(goal, host);
  // An approval widening policy requires a human. A rejection may still be delegated.
  const loosening = store.proposeGoal(
    { ...goal, policies: { integration: "agent" } },
    host,
  );
  const answer = (
    proposal: { id: string; digest: string },
    decision: "approve" | "reject",
  ) =>
    answerFromPanel(store, root, {
      id: proposal.id,
      digest: proposal.digest,
      decision,
    });
  for (const decision of ["approve", "reject"] as const)
    assert.deepEqual(await answer(normal, decision), {
      id: normal.id,
      error: { code: "approval-forbidden" },
    });
  const inbox = operatorInbox(
    store,
    projectInbox({ store, target: "/fixture" }),
  );
  assert.equal(
    "answer" in inbox.find(({ subject }) => subject.proposalId === normal.id)!,
    false,
  );
  assert.partialDeepStrictEqual(
    inbox.find(({ subject }) => subject.proposalId === loosening.id),
    {
      answer: {
        approve: true,
        reject: false,
        digest: loosening.digest,
        title: goal.title,
        agentGates: ["integration"],
      },
    },
  );
  assert.deepEqual(await answer(loosening, "reject"), {
    id: loosening.id,
    error: { code: "approval-forbidden" },
  });
  assert.deepEqual(await answer(loosening, "approve"), {
    id: loosening.id,
    ok: true,
  });
  assert.equal(store.getProposal(normal.id)?.status, "pending");

  store.setProjectDefaults({ "goal-registration": "human" }, operator);
  assert.deepEqual(
    await answerFromPanel(
      store,
      root,
      {
        id: normal.id,
        digest: normal.digest,
        decision: "approve",
      },
      async () => {
        store.setProjectDefaults({ "goal-registration": "agent" }, operator);
      },
    ),
    { id: normal.id, error: { code: "approval-forbidden" } },
  );
  assert.equal(store.getProposal(normal.id)?.status, "pending");
});

function socketFixture() {
  const state = orchestratorFixture("lo-op-", realpathSync("/tmp"));
  const { store, root } = state;
  return {
    state,
    options: { stateDirectory: root, store, target: "/fixture" },
    directory: join(root, "operator"),
    path: join(root, "operator", "api.sock"),
  };
}

test("operator API refuses public and linked socket directories and preserves occupants", async () => {
  const { state, options, directory, path } = socketFixture();
  using fixture = state;
  assert.equal(fixture.root, options.stateDirectory);
  mkdirSync(directory, { mode: 0o755 });
  await assert.rejects(listenOperatorApi(options), /safe directories/);
  assert.equal(statSync(directory).mode & 0o777, 0o755);
  chmodSync(directory, 0o700);
  symlinkSync(directory, join(directory, "operator"));
  await assert.rejects(
    listenOperatorApi({ ...options, stateDirectory: directory }),
    /safe directories/,
  );
  writeFileSync(path, "existing", { mode: 0o600 });
  await assert.rejects(listenOperatorApi(options), /already exists/);
  assert.ok(statSync(path).isFile());
  unlinkSync(path);
});

test(
  "operator API replaces a stale socket and refuses a live one",
  { timeout: 5000 },
  async () => {
    const { state, options, path } = socketFixture();
    using fixture = state;
    assert.equal(fixture.root, options.stateDirectory);
    const first = await listenOperatorApi(options);
    try {
      await assert.rejects(listenOperatorApi(options), /already running/);
    } finally {
      await first.close();
    }
    // A launcher that died left its socket file without a listener.
    const died = spawnSync(process.execPath, [
      "-e",
      `require("node:net").createServer().listen(${JSON.stringify(path)}, () => process.exit(0))`,
    ]);
    assert.equal(died.status, 0);
    assert.ok(statSync(path).isSocket());
    const second = await listenOperatorApi(options);
    await second.close();
  },
);

test(
  "operator API lists, marks, subscribes and reads safe proposal metadata",
  { timeout: 5000 },
  async () => {
    const { state, options, directory, path } = socketFixture();
    using fixture = state;
    const { store } = fixture;
    const { id, digest } = store.proposeGoal(goal, { kind: "operator" });
    const repository = { project: "demo", repositoryPath: "team/demo" };
    const api = await listenOperatorApi({ ...options, repository, pollMs: 20 });
    try {
      assert.equal(statSync(directory).mode & 0o777, 0o700);
      assert.equal(statSync(path).mode & 0o777, 0o600);
      assert.ok(statSync(path).isSocket());
      const socket = createConnection(path);
      const lines = createInterface({ input: socket })[Symbol.asyncIterator]();
      await once(socket, "connect");
      const reply = async () => JSON.parse((await lines.next()).value!);
      let seq = 0;
      const request = async (method: string, params: object = {}) => {
        const id = ++seq;
        // A client can split a line across writes and may see a notification before the response.
        const wire = JSON.stringify({ id, method, params });
        socket.write(wire.slice(0, 5));
        socket.write(wire.slice(5) + "\n");
        const response = await reply();
        assert.equal(response.id, id);
        return response;
      };
      for (const method of [
        "concierge.attach",
        "concierge.input",
        "concierge.resize",
      ]) {
        assert.deepEqual((await request(method)).error, {
          code: "terminal-unavailable",
        });
      }
      const item = `goal-registration:${id}`;
      assert.deepEqual(
        (await request("status")).result,
        JSON.parse(JSON.stringify({ ...operatorStatus(store), ...repository })),
      );
      assert.partialDeepStrictEqual(
        (await request("proposal.get", { id })).result,
        {
          id,
          digest,
          effectivePolicy: "human",
          diffStat: null,
        },
      );
      assert.deepEqual(
        (await request("proposal.get", { id: "unknown" })).error,
        { code: "not-found" },
      );
      assert.deepEqual(
        (await request("proposal.answer", { secret: "never returned" })).error,
        { code: "invalid-params" },
      );
      assert.deepEqual(
        (
          await request("proposal.answer", {
            id,
            digest: "0".repeat(64),
            decision: "approve",
          })
        ).error,
        { code: "stale-digest" },
      );
      assert.deepEqual(
        (await request("inbox.list", { includeResolved: "yes" })).error,
        { code: "invalid-params" },
      );
      assert.deepEqual(
        (await request("inbox.markSeen", { ids: Array(201).fill(item) })).error,
        { code: "invalid-params" },
      );
      assert.partialDeepStrictEqual((await request("inbox.list")).result[0], {
        id: item,
        answer: { id, digest, approve: true, reject: true },
      });
      assert.deepEqual((await request("inbox.subscribe")).result, {
        subscribed: true,
      });
      assert.deepEqual(
        (await request("inbox.markSeen", { ids: [item, item, "unknown"] }))
          .result,
        { marked: 1 },
      );
      assert.deepEqual(await reply(), {
        method: "inbox.changed",
        params: { ids: [item] },
      });
      assert.equal((await request("inbox.list")).result[0].state, "seen");
      assert.deepEqual(
        (await request("proposal.answer", { id, digest, decision: "reject" }))
          .result,
        { id, ok: true },
      );
      assert.deepEqual(await reply(), {
        method: "inbox.changed",
        params: { ids: [item] },
      });
      assert.deepEqual((await request("inbox.list")).result, []);
      assert.equal(
        (await request("inbox.list", { includeResolved: true })).result[0]
          .state,
        "resolved",
      );
      const batchClient = await operatorClient(path, "");
      const next = store.proposeGoal(goal, { kind: "operator" });
      assert.deepEqual(
        (
          await batchClient.request("proposal.answerMany", {
            answers: [
              { id, digest, decision: "approve" },
              { id: next.id, digest: next.digest, decision: "approve" },
            ],
          })
        ).result,
        [
          { id, error: { code: "invalid-transition" } },
          { id: next.id, ok: true },
        ],
      );
    } finally {
      await api.close();
    }
    assert.equal(existsSync(path), false);
  },
);

test(
  "operator API bounds connections and lines, and rejects malformed input without echoing it",
  { timeout: 5000 },
  async () => {
    const { state, options, path } = socketFixture();
    using fixture = state;
    assert.equal(fixture.store, options.store);
    const api = await listenOperatorApi({ ...options, maxLineBytes: 128 });
    try {
      const clients = [];
      for (let i = 0; i < 8; i++) {
        const socket = createConnection(path);
        await once(socket, "connect");
        clients.push(socket);
      }
      const extra = createConnection(path);
      extra.on("error", () => {});
      await once(extra, "close");
      const malformed = clients[0]!;
      const lines = createInterface({ input: malformed })[
        Symbol.asyncIterator
      ]();
      malformed.write("{never returned}\n");
      assert.deepEqual(JSON.parse((await lines.next()).value!), {
        id: null,
        error: { code: "invalid-request" },
      });
      const oversized = clients[1]!;
      const closed = once(oversized, "close");
      oversized.write("x".repeat(129));
      await closed;
    } finally {
      await api.close();
    }
    assert.equal(existsSync(path), false);
  },
);

async function operatorClient(path: string, prefix = "concierge.") {
  const socket = createConnection(path);
  const reader = createInterface({ input: socket });
  const lines = reader[Symbol.asyncIterator]();
  await once(socket, "connect");
  const next = async () => JSON.parse((await lines.next()).value!);
  let seq = 0;
  return {
    socket,
    reader,
    next,
    async request(method: string, params: object = {}) {
      const id = ++seq;
      socket.write(
        JSON.stringify({ id, method: prefix + method, params }) + "\n",
      );
      const response = await next();
      assert.equal(response.id, id);
      return response;
    },
  };
}

test(
  "operator activity subscribes to execution changes and serves refs and actions",
  { timeout: 5000 },
  async () => {
    const { state, options, path } = socketFixture();
    using fixture = state;
    const { store } = fixture;
    const proposed = store.proposeGoal(goal, { kind: "operator" });
    const { goalId } = store.decide(proposed.id, {
      digest: proposed.digest,
      decision: "approve",
      answerer: { kind: "human" },
    });
    const api = await listenOperatorApi({ ...options, pollMs: 10 });
    try {
      const client = await operatorClient(path, "");
      try {
        assert.partialDeepStrictEqual(
          await client.request("goal.get", { id: "g1" }),
          {
            result: { id: goalId, ref: "G1", head: null },
          },
        );
        assert.deepEqual(
          (await client.request("task.get", { id: "g1-8" })).error,
          { code: "not-found" },
        );
        assert.deepEqual((await client.request("activity.subscribe")).result, {
          subscribed: true,
        });
        const session = store.startSession("Concierge", "watch-run");
        assert.equal(
          (await client.request("activity.get")).result.conciergeWatching,
          false,
        );
        store.recordConciergeWatch(session.id, "connected");
        assert.equal((await client.next()).method, "activity.changed");
        assert.equal(
          (await client.request("activity.get")).result.conciergeWatching,
          true,
        );
        store.recordConciergeWatch(session.id, "disconnected");
        assert.equal((await client.next()).method, "activity.changed");
        assert.equal(
          (await client.request("activity.get")).result.conciergeWatching,
          false,
        );
        store.endSession(session.id);
        assert.ok(goalId);
        const execution = store.createExecution({
          actor: "Planner",
          mode: "task-decomposition",
          goalId,
          requestedBy: { kind: "host" },
        });
        assert.deepEqual(await client.next(), {
          method: "activity.changed",
          params: {},
        });
        assert.partialDeepStrictEqual(
          (await client.request("activity.get")).result,
          {
            queued: [{ id: execution.id, goalRef: "G1" }],
            queuedCount: 1,
          },
        );
        store.startExecution(execution.id);
        assert.deepEqual(await client.next(), {
          method: "activity.changed",
          params: {},
        });
        assert.partialDeepStrictEqual(
          (await client.request("activity.get")).result,
          {
            running: [{ id: execution.id, goalRef: "G1" }],
            queuedCount: 0,
          },
        );
        assert.deepEqual(
          (
            await client.request("goal.discard", {
              id: "g1",
              confirm: "G1",
              expectedHead: null,
            })
          ).error,
          { code: "goal-busy" },
        );
        assert.deepEqual(
          (await client.request("concierge.draft", { text: "draft" })).error,
          { code: "terminal-unavailable" },
        );
      } finally {
        client.reader.close();
        client.socket.destroy();
      }
    } finally {
      await api.close();
    }
  },
);

test(
  "operator API replays filtered terminal output and transfers input ownership",
  { timeout: 5000 },
  async () => {
    const { state, options, path } = socketFixture();
    using fixture = state;
    const terminal = createConciergeTerminalHub();
    const { promise: finished, resolve } =
      Promise.withResolvers<TerminalExit>();
    const inputs: Buffer[] = [];
    const sizes: number[][] = [];
    terminal.data(Buffer.from("y" + "x".repeat(512 * 1024)));
    terminal.data(Buffer.from("\x1b]52;hidden\x07hello"));
    terminal.start({
      finished,
      terminal: {
        write: (data) => inputs.push(Buffer.from(data)),
        resize: (cols, rows) => sizes.push([cols, rows]),
      },
    });
    const api = await listenOperatorApi({
      ...options,
      store: fixture.store,
      terminal,
    });
    try {
      const first = await operatorClient(path);
      const second = await operatorClient(path);
      assert.deepEqual((await first.request("attach")).result, {
        replay: Buffer.from("x".repeat(512 * 1024 - 5) + "hello").toString(
          "base64",
        ),
      });
      terminal.data(Buffer.from("\x1b]0;title\x1b\\first"));
      assert.deepEqual(await first.next(), {
        method: "concierge.output",
        params: { data: Buffer.from("first").toString("base64") },
      });
      const input = Buffer.alloc(16 * 1024, 0xff);
      assert.deepEqual(
        (await first.request("input", { data: input.toString("base64") }))
          .result,
        {},
      );
      assert.deepEqual(inputs, [input]);
      for (const data of [
        Buffer.alloc(16 * 1024 + 1).toString("base64"),
        "QQ=!",
      ]) {
        assert.deepEqual((await first.request("input", { data })).error, {
          code: "invalid-params",
        });
      }
      for (const [cols, rows] of [
        [19, 24],
        [501, 24],
        [80, 4],
        [80, 201],
        [80.5, 24],
      ]) {
        assert.deepEqual(
          (await first.request("resize", { cols, rows })).error,
          { code: "invalid-params" },
        );
      }
      assert.deepEqual((await second.request("attach")).result, {
        replay: Buffer.from(
          "x".repeat(512 * 1024 - 10) + "hellofirst",
        ).toString("base64"),
      });
      assert.deepEqual(await first.next(), {
        method: "concierge.notice",
        params: { code: "input-transferred" },
      });
      assert.deepEqual((await first.request("input", { data: "YQ==" })).error, {
        code: "terminal-read-only",
      });
      assert.deepEqual(
        (await first.request("resize", { cols: 20, rows: 5 })).error,
        { code: "terminal-read-only" },
      );
      assert.deepEqual(
        (await second.request("resize", { cols: 20, rows: 5 })).result,
        {},
      );
      assert.deepEqual(sizes, [[20, 5]]);
      assert.deepEqual(
        (await second.request("input", { data: "YQ==" })).result,
        {},
      );
      assert.deepEqual(inputs, [input, Buffer.from("a")]);
      terminal.data(Buffer.from("both"));
      const output = {
        method: "concierge.output",
        params: { data: "Ym90aA==" },
      };
      assert.deepEqual(await first.next(), output);
      assert.deepEqual(await second.next(), output);
      resolve({ exitCode: 7 });
      for (const client of [first, second]) {
        assert.deepEqual(await client.next(), {
          method: "concierge.exit",
          params: { exitCode: 7 },
        });
        for (const method of ["attach", "input", "resize"]) {
          assert.deepEqual((await client.request(method)).error, {
            code: "terminal-exited",
          });
        }
      }
    } finally {
      await api.close();
    }
  },
);

test(
  "operator API disconnects a terminal client over the pending-output limit",
  { timeout: 5000 },
  async () => {
    const { state, options, path } = socketFixture();
    using fixture = state;
    const terminal = createConciergeTerminalHub();
    terminal.start({
      finished: new Promise(() => {}),
      terminal: { write() {}, resize() {} },
    });
    const api = await listenOperatorApi({
      ...options,
      store: fixture.store,
      terminal,
    });
    try {
      const client = await operatorClient(path);
      assert.deepEqual((await client.request("attach")).result, { replay: "" });
      client.reader.close();
      client.socket.pause();
      const closed = once(client.socket, "close");
      const chunk = Buffer.alloc(400 * 1024, 0x78);
      for (let i = 0; i < 8; i++) terminal.data(chunk);
      client.socket.resume();
      await closed;
    } finally {
      await api.close();
    }
  },
);

test("terminal hub maintains bounded filtered replay and ends the stream independently of sockets", async () => {
  const hub = createConciergeTerminalHub();
  const { promise: finished, resolve } = Promise.withResolvers<TerminalExit>();
  const received: object[] = [];
  const send = (event: object) => received.push(event);
  const second = () => {};
  assert.equal(hub.status, "terminal-unavailable");
  hub.data(Buffer.alloc(512 * 1024, 0x78));
  hub.data(Buffer.from("\x1b]8;;hidden"));
  hub.start({ finished, terminal: { write() {}, resize() {} } });
  assert.equal(hub.status, "ready");
  assert.equal(
    hub.attach(send),
    Buffer.alloc(512 * 1024, 0x78).toString("base64"),
  );
  hub.data(Buffer.from("\x1b\\hi"));
  assert.equal(
    hub.attach(second),
    Buffer.from("x".repeat(512 * 1024 - 2) + "hi").toString("base64"),
  );
  assert.equal(hub.ownsInput(send), false);
  assert.equal(hub.ownsInput(second), true);
  hub.detach(second);
  assert.equal(hub.ownsInput(second), false);
  resolve({ exitCode: 7 });
  await finished;
  hub.data(Buffer.from("late"));
  assert.equal(hub.status, "terminal-exited");
  assert.deepEqual(received, [
    { method: "concierge.output", params: { data: "aGk=" } },
    { method: "concierge.notice", params: { code: "input-transferred" } },
    { method: "concierge.exit", params: { exitCode: 7 } },
  ]);
});

function readFixture(store: ReturnType<typeof orchestratorFixture>["store"]) {
  const host = { kind: "host" } as const;
  const approve = ({ id, digest }: { id: string; digest: string }) =>
    store.decide(id, {
      digest,
      decision: "approve",
      answerer: { kind: "human" },
    });
  const { goalId } = approve(store.proposeGoal(goal, { kind: "operator" }));
  assert.ok(goalId);
  const base = "a".repeat(40);
  store.recordGoalCommit(goalId, base, "base");
  const task = (title: string) => {
    const result = store.proposeTask(
      {
        title,
        goalId,
        description: "<script>task description</script>",
        acceptance: ["Pass"],
        actor: "Executor",
        profile: "base",
        paths: ["src/a.ts"],
        budgets: goal.scope.budgets,
        dependsOn: [],
      },
      host,
    );
    assert.equal(result.status, "registered");
    return result.taskId;
  };
  const failed = task("Failed Task");
  const reviewed = task("Reviewed Task");
  const registered = task("Registered Task");
  assert.ok(store.claimTask(failed));
  const execution = store.createExecution({
    taskId: failed,
    actor: "Executor",
    mode: "task",
    requestedBy: host,
  }).id;
  store.startExecution(execution);
  store.finishExecution(execution, "failed", {
    tokens: 501,
    rawAnswer: "must stay private",
  });
  const rejectedPaths = [{ path: "private/rejected", symlink: false }];
  store.failTask(failed, "path-violation", rejectedPaths);
  assert.ok(store.claimTask(reviewed));
  function startReview(taskId: string) {
    const review = store.createExecution({
      taskId,
      actor: "Reviewer",
      mode: "review",
      requestedBy: host,
    }).id;
    store.startExecution(review);
    return review;
  }
  const review = startReview(reviewed);

  function proposeReviewed(taskId = reviewed, reviewId = review) {
    const pin = { base, candidate: "b".repeat(40), digest: "c".repeat(64) };
    store.finishExecution(reviewId, "succeeded", { review: "pass", pin });
    return store.proposeIntegration(
      {
        taskId,
        goalId: goalId!,
        branch: goalBranch(goalId!),
        ...pin,
        changedPaths: ["src/a.ts"],
        review: { result: "pass" },
      },
      reviewId,
    );
  }
  function finishReviewed(taskId = reviewed, reviewId = review) {
    const integration = proposeReviewed(taskId, reviewId);
    approve(integration);
    const { approvalId } = store.approvedIntegration(integration.id);
    store.beginIntegration(integration.id, integration.digest, approvalId);
    store.finishIntegration(integration.id, "completed", "ok");
  }
  return {
    goalId,
    failed,
    reviewed,
    registered,
    execution,
    rejectedPaths,
    startReview,
    proposeReviewed,
    finishReviewed,
  };
}

test("operator integration answers honor the human invariant and the CLI diff precondition", async () => {
  using fixture = orchestratorFixture("lo-op-integration-answer-");
  const { root, store } = fixture;
  store.setProjectDefaults({ integration: "agent" }, { kind: "operator" });
  const { reviewed, proposeReviewed } = readFixture(store);
  const { id, digest, humanAnswerRequired } = proposeReviewed();
  assert.equal(humanAnswerRequired, true);
  const items = operatorInbox(
    store,
    projectInbox({ store, target: "/fixture" }),
  );
  assert.partialDeepStrictEqual(
    items.find(({ subject }) => subject.proposalId === id),
    {
      answer: {
        kind: "integration",
        approve: true,
        reject: true,
        title: "Reviewed Task",
      },
    },
  );
  const scan = async () => {};
  assert.deepEqual(
    await answerFromPanel(
      store,
      root,
      { id, digest, decision: "approve" },
      scan,
    ),
    { id, error: { code: "write-failed" } },
  );
  assert.equal(store.getProposal(id)?.status, "pending");
  assert.equal(store.nextApprovedIntegration(), undefined);
  assert.deepEqual(
    await answerFromPanel(
      store,
      root,
      { id, digest, decision: "reject" },
      scan,
    ),
    { id, ok: true },
  );
  assert.equal(store.getTask(reviewed)?.status, "failed");
});

test("operator read projections use scoped durable Task state and safe metadata", () => {
  using state = orchestratorFixture("lo-op-read-");
  const { store } = state;
  const {
    goalId,
    failed,
    reviewed,
    registered,
    execution,
    rejectedPaths,
    finishReviewed,
  } = readFixture(store);
  const summary = operatorGoalList(store, "active")[0]!;
  assert.partialDeepStrictEqual(summary, {
    id: goalId,
    status: "active",
    progress: {
      done: 0,
      total: 3,
      failed: 1,
      running: 1,
      awaitingIntegration: 0,
    },
    estimate: { basis: "current-plan", remainingMs: null },
  });
  assert.deepEqual(operatorGoalList(store, "done"), []);
  assert.deepEqual(
    operatorGoal(store, goalId)?.tasks.map(({ id, stage }) => [id, stage]),
    [
      [failed, "failed"],
      [reviewed, "review"],
      [registered, "registered"],
    ],
  );
  assert.equal(operatorTaskList(store, "missing"), null);
  assert.equal(operatorTask(store, "missing"), null);
  assert.partialDeepStrictEqual(operatorTask(store, failed)!, {
    tokensUsed: 501,
    failure: { code: "path-violation", stage: "running", rejectedPaths },
    executions: [{ id: execution, actor: "Executor", tokens: 501 }],
  });
  assert.doesNotMatch(
    JSON.stringify(operatorTask(store, failed)),
    /must stay private|category/,
  );
  assert.deepEqual(
    Object.keys(operatorTask(store, failed)!.events[0]!).sort(),
    ["at", "kind"],
  );
  const problems = operatorProblems(store);
  assert.equal(problems.length, 2);
  assert.partialDeepStrictEqual(
    problems.find(({ kind }) => kind === "path-violation"),
    {
      goalId,
      taskId: failed,
      canRetry: true,
      rejectedPaths,
    },
  );
  assert.partialDeepStrictEqual(
    problems.find(({ kind }) => kind === "execution-over-budget"),
    {
      goalId,
      taskId: failed,
      executionId: execution,
      title: "Failed Task",
    },
  );
  const planning = store.createExecution({
    goalId,
    actor: "Planner",
    mode: "plan",
    requestedBy: { kind: "host" },
  });
  store.startExecution(planning.id);
  store.finishExecution(planning.id, "succeeded", { tokens: 501 });
  assert.partialDeepStrictEqual(
    operatorProblems(store).find(
      ({ executionId }) => executionId === planning.id,
    ),
    {
      goalId,
      taskId: null,
      title: goal.title,
    },
  );
  finishReviewed();
  assert.equal(operatorGoalList(store)[0]?.progress.done, 1);
  assert.equal(
    typeof operatorGoalList(store)[0]?.estimate.remainingMs,
    "number",
  );
  assert.equal(
    typeof operatorTask(store, registered)?.estimate.remainingMs,
    "number",
  );
  assert.equal(operatorTask(store, reviewed)?.stage, "done");
  store.retryTask(failed, 0);
  assert.equal(operatorTask(store, failed)?.stage, "registered");
  assert.equal(operatorTask(store, failed)?.elapsedMs, 0);
  assert.ok(
    !operatorProblems(store).some(({ kind }) => kind === "path-violation"),
  );

  assert.ok(store.claimTask(registered));
  const blocked = store.createExecution({
    taskId: registered,
    actor: "Executor",
    mode: "task",
    requestedBy: { kind: "host" },
  });
  store.startExecution(blocked.id);
  store.finishExecution(blocked.id, "failed", {
    code: "path-violation",
    rejectedPaths,
    rawAnswer: "exclude execution output",
  });
  const violation = () =>
    operatorProblems(store).filter(({ kind }) => kind === "path-violation");
  assert.partialDeepStrictEqual(violation(), [
    { taskId: registered, executionId: blocked.id, rejectedPaths },
  ]);
  assert.doesNotMatch(JSON.stringify(violation()), /exclude execution output/);
  const legacy = store.createExecution({
    taskId: registered,
    actor: "Executor",
    mode: "task",
    requestedBy: { kind: "host" },
  });
  store.startExecution(legacy.id);
  store.finishExecution(legacy.id, "failed", { code: "path-violation" });
  assert.partialDeepStrictEqual(
    violation().find(({ executionId }) => executionId === legacy.id),
    { taskId: registered, kind: "path-violation" },
  );
  store.failTask(registered, "path-violation", rejectedPaths);
  assert.partialDeepStrictEqual(violation(), [
    { taskId: registered, canRetry: true, rejectedPaths },
  ]);

  const other = readFixture(store);
  assert.equal(
    typeof operatorGoal(store, other.goalId)?.estimate.remainingMs,
    "number",
  );
  assert.equal(
    typeof operatorTask(store, other.registered)?.estimate.remainingMs,
    "number",
  );
});

test("problems drop early path violations after success and disappear when the Goal is discarded", async () => {
  using state = orchestratorFixture("lo-op-problems-");
  const { store } = state;
  const { goalId, failed, registered, startReview, finishReviewed } =
    readFixture(store);
  assert.ok(store.claimTask(registered));
  const startAttempt = () => {
    const { id } = store.createExecution({
      taskId: registered,
      actor: "Executor",
      mode: "task",
      requestedBy: { kind: "host" },
    });
    store.startExecution(id);
    return id;
  };
  const taskProblems = (includeResolved = false) =>
    operatorProblems(store, includeResolved).filter(
      ({ taskId }) => taskId === registered,
    );
  const paths = (attempt: number) => [
    { path: `private/rejected-${attempt}`, symlink: false },
  ];
  for (let attempt = 1; attempt <= 4; attempt++) {
    const executionId = startAttempt();
    const rejectedPaths = paths(attempt);
    store.finishExecution(executionId, "failed", {
      code: "path-violation",
      rejectedPaths,
    });
    assert.partialDeepStrictEqual(taskProblems(), [
      { kind: "path-violation", executionId, rejectedPaths },
    ]);
    if (attempt % 2 === 0) {
      store.failTask(registered, "path-violation", rejectedPaths);
      store.retryTask(registered, attempt / 2 - 1);
      assert.deepEqual(taskProblems(), []);
      assert.ok(store.claimTask(registered));
    }
  }

  const successful = startAttempt();
  assert.deepEqual(taskProblems(), []);
  store.finishExecution(successful, "succeeded", {});
  finishReviewed(registered, startReview(registered));
  assert.equal(store.getTask(registered)?.status, "succeeded");
  assert.deepEqual(taskProblems(), []);
  const latestPaths = paths(4);
  assert.partialDeepStrictEqual(taskProblems(true), [
    { kind: "path-violation", rejectedPaths: latestPaths, canRetry: false },
  ]);

  finishReviewed();
  assert.equal(
    operatorProblems(store).filter(({ taskId }) => taskId === failed).length,
    2,
  );
  await store.discardGoal(goalId, null, async () => {});
  assert.equal(store.getGoal(goalId)?.status, "cancelled");
  assert.deepEqual(operatorProblems(store), []);
  assert.partialDeepStrictEqual(taskProblems(true), [
    { kind: "path-violation", rejectedPaths: latestPaths, canRetry: false },
  ]);
});

test(
  "operator API validates, screens and serves Goal, Task and problem reads",
  { timeout: 5000 },
  async () => {
    const { state, options, path } = socketFixture();
    using fixture = state;
    const { store } = fixture;
    const { goalId, failed, reviewed, rejectedPaths, finishReviewed } =
      readFixture(store);
    const screened: unknown[] = [];
    let reject = false;
    const api = await listenOperatorApi({
      ...options,
      async scan(...sources) {
        screened.push(JSON.parse(String(sources[0])));
        if (reject) throw new Error("secret must not escape");
      },
    });
    try {
      const client = await operatorClient(path, "");
      for (const { method, params, invalid, check } of [
        {
          method: "goal.list",
          params: { status: "active" },
          invalid: { status: "running" },
          check: (result: unknown) =>
            assert.partialDeepStrictEqual(result, [
              { id: goalId, status: "active" },
            ]),
        },
        {
          method: "goal.get",
          params: { id: goalId },
          invalid: {},
          check: (result: unknown) =>
            assert.partialDeepStrictEqual(result, {
              id: goalId,
              branch: goalBranch(goalId),
              baseCommit: "a".repeat(40),
              scope: goal.scope,
            }),
        },
        {
          method: "task.list",
          params: { goalId },
          invalid: { goalId: 99 },
          check: (result: unknown) =>
            assert.partialDeepStrictEqual(result, [
              { id: failed, stage: "failed" },
              { id: reviewed, stage: "review" },
            ]),
        },
        {
          method: "task.get",
          params: { id: failed },
          invalid: { id: "invalid id" },
          check: (result: unknown) =>
            assert.partialDeepStrictEqual(result, {
              id: failed,
              failure: { rejectedPaths },
            }),
        },
        {
          method: "problem.list",
          params: { includeResolved: true },
          invalid: { includeResolved: "yes" },
          check: (result: unknown) =>
            assert.partialDeepStrictEqual(result, [
              { taskId: failed, kind: "path-violation" },
            ]),
        },
      ]) {
        const { result } = await client.request(method, params);
        check(result);
        assert.deepEqual(screened.pop(), result);
        assert.deepEqual((await client.request(method, invalid)).error, {
          code: "invalid-params",
        });
        reject = true;
        assert.deepEqual((await client.request(method, params)).error, {
          code: "read-failed",
        });
        assert.ok(screened.pop());
        reject = false;
      }
      for (const [method, params] of [
        ["goal.get", { id: "missing" }],
        ["task.get", { id: "missing" }],
        ["task.list", { goalId: "missing" }],
      ] as const) {
        assert.deepEqual((await client.request(method, params)).error, {
          code: "not-found",
        });
      }
      assert.deepEqual(
        (await client.request("goal.list", { status: "cancelled" })).result,
        [],
      );
      assert.deepEqual(screened, [[]]);
      finishReviewed();
      await store.discardGoal(goalId, null, async () => {});
      for (const params of [{}, { includeResolved: false }]) {
        assert.deepEqual(
          (await client.request("problem.list", params)).result,
          [],
        );
      }
      assert.partialDeepStrictEqual(
        (await client.request("problem.list", { includeResolved: true }))
          .result,
        [
          { taskId: failed, kind: "path-violation" },
          { taskId: failed, kind: "execution-over-budget" },
        ],
      );
    } finally {
      await api.close();
    }
  },
);
