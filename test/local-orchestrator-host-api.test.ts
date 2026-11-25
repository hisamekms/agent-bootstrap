import assert from "node:assert/strict";
import { once } from "node:events";
import {
  chmodSync,
  existsSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createConnection, type Socket } from "node:net";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { test, type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import {
  HostApiServer,
  type ExecutionRequester,
  type HostApiOptions,
} from "../src/local-orchestrator/host-api.ts";
import { orchestratorFixture } from "./local-orchestrator-fixture.ts";

const budgets = { maxExecutionMs: 1000, maxRetries: 1, maxTokens: 500 };
const goalContent = {
  title: "Goal 🛠",
  description: "Goal description\nSecond line",
  acceptance: ["Pass"],
  scope: {
    paths: ["src/x/"],
    profiles: ["base"],
    actors: ["Executor"],
    maxTasks: 3,
    budgets,
  },
};
const taskContent = {
  title: "Task",
  description: "",
  acceptance: ["Pass"],
  actor: "Executor",
  profile: "base",
  paths: ["src/x/a.ts"],
  dependsOn: [],
  budgets,
};

function hostFixture(t: TestContext) {
  // A short prefix leaves room for the socket on platforms with short sun_path.
  const state = orchestratorFixture("lo-api-", "/tmp");
  const { root: folder, store } = state;
  let server: Promise<HostApiServer> | undefined;
  let cleaningUp = false;
  const sockets: Socket[] = [];
  const plannerCalls: Parameters<ExecutionRequester["requestPlanner"]>[0][] =
    [];
  t.after(async () => {
    cleaningUp = true;
    try {
      for (const socket of sockets) socket.destroy();
      await close();
    } finally {
      state[Symbol.dispose]();
    }
  });

  const options: HostApiOptions = {
    store,
    socketPath: join(folder, "mcp.sock"),
    sessionId: store.startSession("Concierge", "test-runtime").id,
    requester: {
      async requestPlanner(input) {
        plannerCalls.push(input);
        return store.createExecution({
          actor: "Planner",
          mode: input.mode,
          ...(input.goalId === undefined ? {} : { goalId: input.goalId }),
          requestedBy: {
            kind: "actor",
            actor: "Concierge",
            sessionId: input.sessionId,
          },
        }).id;
      },
    },
  };

  async function connect() {
    assert.ok(!cleaningUp, "Host fixture is closing");
    const socket = createConnection(options.socketPath);
    sockets.push(socket);
    const closed = new Promise<void>((resolve) =>
      socket.once("close", () => resolve()),
    );
    const lines = createInterface({ input: socket })[Symbol.asyncIterator]();
    await once(socket, "connect");
    let id = 0;
    return {
      socket,
      closed,
      async reply() {
        const next = await lines.next();
        assert.equal(next.done, false, "Expected a JSON-RPC response");
        return JSON.parse(next.value);
      },
      async request(method: string, params?: object) {
        socket.write(wire(method, ++id, params));
        const reply = await this.reply();
        assert.equal(reply.id, id);
        assert.equal(reply.jsonrpc, "2.0");
        return reply;
      },
      async call(name: string, args?: object) {
        const { result } = await this.request("tools/call", {
          name,
          arguments: args,
        });
        assert.equal(result.content.length, 1);
        assert.equal(result.content[0].type, "text");
        return {
          isError: result.isError === true,
          data: JSON.parse(result.content[0].text),
        };
      },
    };
  }

  async function listen(overrides: Partial<HostApiOptions> = {}) {
    server = HostApiServer.listen({ ...options, ...overrides });
    await server;
    return connect();
  }

  async function close() {
    const active = await server?.catch(() => undefined);
    await active?.close();
  }

  function apiCalls() {
    return store
      .listEvents({ subjectId: options.sessionId, limit: 100 })
      .filter(({ kind }) => kind === "host-api.call")
      .reverse();
  }

  return {
    folder,
    store,
    options,
    plannerCalls,
    connect,
    listen,
    apiCalls,
    close,
  };
}

function wire(method: string, id?: number, params?: object) {
  return JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";
}

type HostClient = Awaited<
  ReturnType<ReturnType<typeof hostFixture>["connect"]>
>;

async function queuePlanner(client: HostClient) {
  const { isError, data } = await client.call("request_planner", {
    mode: "goal-design",
    brief: "Plan",
  });
  assert.equal(isError, false);
  return data.executionId as string;
}

function waitRequest(id: string, timeoutSeconds?: number, requestId = 100) {
  return wire("tools/call", requestId, {
    name: "wait_execution",
    arguments: { id, timeoutSeconds },
  });
}

async function beginWait(client: HostClient, id: string) {
  client.socket.write(waitRequest(id) + wire("ping", 101));
  assert.deepEqual(await client.reply(), {
    jsonrpc: "2.0",
    id: 101,
    result: {},
  });
}

async function waitReply(client: HostClient) {
  const { id, result } = await client.reply();
  assert.equal(id, 100);
  assert.equal(result.isError, undefined);
  return JSON.parse(result.content[0].text);
}

test("negotiates MCP versions, lists scoped tools and pipelines notifications", async (t) => {
  const { options, listen } = hostFixture(t);
  const client = await listen();
  assert.equal(statSync(options.socketPath).mode & 0o777, 0o600);
  for (const version of [
    "2024-11-05",
    "2025-03-26",
    "2025-06-18",
    "2025-11-25",
    "future",
  ]) {
    const { result } = await client.request("initialize", {
      protocolVersion: version,
    });
    assert.deepEqual(result, {
      protocolVersion: version === "future" ? "2025-11-25" : version,
      capabilities: { tools: {} },
      serverInfo: { name: "local-orchestrator", version: "0.1.0" },
    });
  }

  client.socket.write(
    wire("notifications/initialized") +
      wire("unknown/notification") +
      wire("ping", 100),
  );
  assert.deepEqual(await client.reply(), {
    jsonrpc: "2.0",
    id: 100,
    result: {},
  });
  const { result } = await client.request("tools/list");
  assert.deepEqual(
    result.tools.map((tool: { name: string }) => tool.name),
    [
      "status",
      "list_proposals",
      "get_proposal",
      "list_goals",
      "get_goal",
      "get_execution",
      "wait_execution",
      "draft_goal",
      "draft_task",
      "request_planner",
    ],
  );
  for (const tool of result.tools) {
    assert.equal(tool.inputSchema.type, "object");
    assert.equal(tool.inputSchema.additionalProperties, false);
    assert.equal(typeof tool.description, "string");
  }
  const wait = result.tools.find(
    ({ name }: { name: string }) => name === "wait_execution",
  );
  assert.match(wait.description, /request_planner/);
  assert.deepEqual(wait.inputSchema.required, ["id"]);
  assert.deepEqual(wait.inputSchema.properties.timeoutSeconds, {
    type: "integer",
    minimum: 1,
    maximum: 60,
    default: 30,
  });
  assert.equal((await client.request("approve")).error.code, -32601);
  assert.deepEqual(await client.call("approve"), {
    isError: true,
    data: { code: "unknown-tool" },
  });
});

test("accepts MCP request metadata without echoing or auditing it", async (t) => {
  const { store, options, listen, apiCalls } = hostFixture(t);
  const client = await listen();
  const _meta = { progressToken: 1 };
  for (const args of [undefined, {}]) {
    const { result } = await client.request("tools/call", {
      name: "status",
      arguments: args,
      _meta,
    });
    assert.deepEqual(result, {
      content: [
        { type: "text", text: JSON.stringify(store.getHostApiStatus()) },
      ],
    });
  }
  assert.deepEqual(
    (await client.request("tools/list", { _meta })).result,
    (await client.request("tools/list")).result,
  );
  const params = { protocolVersion: "2025-11-25" };
  assert.deepEqual(
    (await client.request("initialize", { ...params, _meta })).result,
    (await client.request("initialize", params)).result,
  );
  assert.deepEqual((await client.request("ping", { _meta })).result, {});
  assert.equal(apiCalls().length, 2);
  for (const { data } of apiCalls())
    assert.partialDeepStrictEqual(data, { tool: "status", code: "ok" });
  const events = store.listEvents({ subjectId: options.sessionId, limit: 100 });
  assert.ok(!JSON.stringify(events).includes("progressToken"));
});

test("rejects malformed and oversized MCP request metadata", async (t) => {
  const { listen } = hostFixture(t);
  const client = await listen();
  for (const _meta of [null, [], "invalid", { text: "é".repeat(2048) }]) {
    const { result } = await client.request("tools/call", {
      name: "status",
      _meta,
    });
    assert.deepEqual(result, {
      content: [{ type: "text", text: '{"code":"invalid-arguments"}' }],
      isError: true,
    });
    assert.deepEqual((await client.request("tools/list", { _meta })).error, {
      code: -32602,
      message: "Invalid params",
    });
  }
});

test("refuses existing paths, invalid configuration and non-Concierge sessions", async (t) => {
  const { folder, store, options } = hostFixture(t);
  writeFileSync(options.socketPath, "keep");
  await assert.rejects(HostApiServer.listen(options), /already exists/);
  assert.equal(readFileSync(options.socketPath, "utf8"), "keep");
  rmSync(options.socketPath);
  for (const socketPath of ["relative.sock", join(folder, "🛠".repeat(40))]) {
    await assert.rejects(
      HostApiServer.listen({ ...options, socketPath }),
      /Invalid Host API socket path/,
    );
  }
  await assert.rejects(
    HostApiServer.listen({ ...options, maxLineBytes: 4 * 1024 * 1024 + 1 }),
  );
  await assert.rejects(
    HostApiServer.listen({
      ...options,
      sessionId: store.startSession("Planner", "planner-runtime").id,
    }),
    /inactive/,
  );
  chmodSync(folder, 0o755);
  await assert.rejects(HostApiServer.listen(options), /private parent/);
});

test("rejects a second client and audits each accepted connection", async (t) => {
  const { store, options, connect, listen, close } = hostFixture(t);
  const first = await listen();
  await first.request("ping");
  await assert.rejects(HostApiServer.listen(options), /already exists/);
  const rejected = await connect();
  await rejected.closed;
  await first.request("ping");
  first.socket.end();
  await first.closed;
  const replacement = await connect();
  await replacement.request("ping");
  await close();
  await replacement.closed;
  assert.equal(existsSync(options.socketPath), false);
  assert.deepEqual(
    store
      .listEvents({ subjectId: options.sessionId, limit: 10 })
      .map(({ kind }) => kind),
    [
      "host-api.disconnected",
      "host-api.connected",
      "host-api.disconnected",
      "host-api.connected",
      "session.started",
    ],
  );
});

test("drops oversized lines even before receiving a newline", async (t) => {
  const { listen, apiCalls } = hostFixture(t);
  const client = await listen({ maxLineBytes: 64 });
  client.socket.write("🛠".repeat(16));
  client.socket.write("a");
  await client.closed;
  assert.equal(apiCalls().length, 0);
});

test("returns fixed protocol errors and disconnects after the third", async (t) => {
  const { listen } = hostFixture(t);
  const client = await listen();
  client.socket.write('{"broken"\n42\n[]\n' + wire("ping", 10));
  for (const code of [-32700, -32600, -32600]) {
    assert.partialDeepStrictEqual(await client.reply(), {
      jsonrpc: "2.0",
      id: null,
      error: { code },
    });
  }
  await client.closed;
});

test("handles split UTF-8 and exercises each tool against the real store", async (t) => {
  const { store, options, plannerCalls, listen, apiCalls } = hostFixture(t);
  const client = await listen();
  const draft = Buffer.from(
    wire("tools/call", 100, {
      name: "draft_goal",
      arguments: { content: goalContent },
    }),
  );
  const split = draft.indexOf(Buffer.from("🛠")) + 1;
  client.socket.write(draft.subarray(0, split));
  client.socket.write(draft.subarray(split));
  const receipt = JSON.parse((await client.reply()).result.content[0].text);
  assert.partialDeepStrictEqual(receipt, {
    gate: "goal-registration",
    policy: "human",
    loosening: [],
    message: "The operator approves this proposal with the host CLI.",
  });
  const pending = await client.call("list_proposals", { status: "pending" });
  assert.deepEqual(pending.data, [
    {
      id: receipt.id,
      kind: "goal",
      title: goalContent.title,
      status: "pending",
    },
  ]);
  assert.partialDeepStrictEqual(
    (await client.call("get_proposal", { id: receipt.id })).data,
    {
      content: goalContent,
      digest: receipt.digest,
      gate: receipt.gate,
      policy: receipt.policy,
      status: "pending",
      origin: {
        kind: "actor",
        actor: "Concierge",
        sessionId: options.sessionId,
      },
    },
  );
  const { goalId } = store.decide(receipt.id, {
    digest: receipt.digest,
    decision: "approve",
    answerer: { kind: "human" },
  });
  assert.ok(goalId);
  assert.deepEqual((await client.call("list_goals")).data, [
    { id: goalId, title: goalContent.title, status: "active" },
  ]);

  const task = await client.call("draft_task", {
    content: { ...taskContent, goalId },
  });
  assert.partialDeepStrictEqual(task.data, {
    status: "registered",
    autoRegistered: true,
    reason: "in-scope",
  });
  for (const key of ["gate", "policy", "reasons"])
    assert.equal(Object.hasOwn(task.data as object, key), false);
  const pendingTask = await client.call("draft_task", {
    content: { ...taskContent, goalId, policies: { integration: "agent" } },
  });
  assert.partialDeepStrictEqual(pendingTask.data, {
    status: "pending",
    gate: "task-registration",
    policy: "human",
    loosening: ["integration"],
  });
  const baseCommit = "a".repeat(40);
  store.recordGoalCommit(goalId, baseCommit, "base");
  const taskUsage = {
    tokens: 0,
    maxTokens: 500,
    usage: { input: 0, output: 0, cacheCreation: 0, cacheRead: 0 },
    overBudget: false,
  };
  assert.partialDeepStrictEqual(
    (await client.call("get_goal", { id: goalId })).data,
    {
      id: goalId,
      content: goalContent,
      baseCommit,
      tasks: [
        {
          id: task.data.taskId,
          content: { ...taskContent, goalId },
          ...taskUsage,
          budgetTokens: 0,
          totalTokens: 0,
        },
      ],
    },
  );
  const planned = await client.call("request_planner", {
    mode: "task-decomposition",
    goalId,
    brief: "Break it down",
  });
  assert.deepEqual(plannerCalls, [
    {
      mode: "task-decomposition",
      goalId,
      brief: "Break it down",
      sessionId: options.sessionId,
    },
  ]);
  const id = planned.data.executionId;
  store.startExecution(id);
  store.finishExecution(id, "succeeded", { tasks: 1 });
  assert.deepEqual((await client.call("get_execution", { id })).data, {
    id,
    status: "succeeded",
    result: { tasks: 1 },
  });

  const { data: status } = await client.call("status");
  assert.deepEqual(status, {
    goals: { active: 1 },
    tasks: { registered: 1 },
    proposals: { approved: 1, pending: 1, registered: 1 },
    pendingProposals: [
      {
        id: pendingTask.data.id,
        kind: "task",
        title: "Task",
        gate: "task-registration",
        policy: "human",
      },
    ],
    recentExecutions: [
      {
        id,
        actor: "Planner",
        mode: "task-decomposition",
        status: "succeeded",
        tokens: null,
        maxTokens: 500,
        usage: "unavailable",
      },
    ],
    recentTasks: [
      { id: task.data.taskId, goalId, status: "registered", ...taskUsage },
    ],
  });
  const calls = apiCalls();
  assert.deepEqual(
    calls.map(({ data }) => (data as { tool: string }).tool),
    [
      "draft_goal",
      "list_proposals",
      "get_proposal",
      "list_goals",
      "draft_task",
      "draft_task",
      "get_goal",
      "request_planner",
      "get_execution",
      "status",
    ],
  );
  for (const call of calls) {
    assert.equal(call.sessionId, options.sessionId);
    assert.partialDeepStrictEqual(call.data, { outcome: "ok", code: "ok" });
    assert.equal(
      typeof (call.data as { durationMs: number }).durationMs,
      "number",
    );
  }
  assert.equal(
    calls.find(
      ({ data }) => (data as { tool: string }).tool === "request_planner",
    )?.executionId,
    id,
  );
  const events = store
    .listEvents({ subjectId: options.sessionId, limit: 100 })
    .toReversed();
  for (const call of calls) {
    const { callId } = call.data as { callId: string };
    const authorization = events.findIndex(
      ({ kind, data }) =>
        kind === "host-api.authorized" &&
        (data as { callId: string }).callId === callId,
    );
    assert.ok(
      authorization >= 0 &&
        authorization < events.findIndex(({ id }) => id === call.id),
    );
  }
  assert.ok(!JSON.stringify(calls).includes("Break it down"));
});

test(
  "wait_execution and get_execution omit operator-only diagnostics",
  { timeout: 2000 },
  async (t) => {
    const { store, listen } = hostFixture(t);
    const client = await listen();
    const { id } = store.createExecution({
      actor: "Reviewer",
      mode: "approval",
      requestedBy: { kind: "host" },
    });
    store.startExecution(id);
    store.finishExecution(id, "failed", {
      code: "contract-violation",
      rawAnswer: "untrusted reviewer text",
    });
    const current = await client.call("get_execution", { id });
    assert.deepEqual(current.data, {
      id,
      status: "failed",
      result: { code: "contract-violation" },
    });
    assert.deepEqual(
      await client.call("wait_execution", { id, timeoutSeconds: 60 }),
      current,
    );
  },
);

test(
  "wait_execution returns on completion and audits authorization and outcome",
  { timeout: 3000 },
  async (t) => {
    const { store, options, listen } = hostFixture(t);
    const client = await listen();
    const id = await queuePlanner(client);
    store.startExecution(id);
    await beginWait(client, id);
    const waitEvents = () =>
      store
        .listEvents({ subjectId: options.sessionId, limit: 100 })
        .filter(
          ({ data }) => (data as { tool?: string }).tool === "wait_execution",
        )
        .reverse();
    const [authorized] = waitEvents();
    assert.deepEqual(
      waitEvents().map(({ kind }) => kind),
      ["host-api.authorized"],
    );
    const result = { message: "result omitted from audit" };
    store.finishExecution(id, "failed", result);
    assert.deepEqual(await waitReply(client), { id, status: "failed", result });
    const events = waitEvents();
    assert.deepEqual(
      events.map(({ kind }) => kind),
      ["host-api.authorized", "host-api.call"],
    );
    const call = events[1]!;
    assert.equal(call.executionId, id);
    const authData = authorized!.data as { callId: string; durationMs: number };
    assert.partialDeepStrictEqual(call.data, {
      callId: authData.callId,
      code: "ok",
      outcome: "ok",
    });
    assert.ok(
      (call.data as { durationMs: number }).durationMs > authData.durationMs,
    );
    assert.ok(!JSON.stringify(events).includes(result.message));
  },
);

test(
  "wait_execution times out with the current execution and waiting flag",
  { timeout: 3000 },
  async (t) => {
    const { listen, apiCalls } = hostFixture(t);
    const client = await listen();
    const id = await queuePlanner(client);
    assert.deepEqual(
      await client.call("wait_execution", { id, timeoutSeconds: 1 }),
      {
        isError: false,
        data: { id, status: "queued", result: null, waiting: true },
      },
    );
    assert.ok(
      (apiCalls().at(-1)!.data as { durationMs: number }).durationMs >= 1000,
    );
  },
);

test(
  "wait_execution returns the current state when the session ends",
  { timeout: 3000 },
  async (t) => {
    const { store, options, listen } = hostFixture(t);
    const client = await listen();
    const id = await queuePlanner(client);
    store.startExecution(id);
    await beginWait(client, id);
    store.endSession(options.sessionId);
    assert.deepEqual(await waitReply(client), {
      id,
      status: "running",
      result: null,
    });
  },
);

test(
  "a pipelined call is served during a wait and a second wait is denied",
  { timeout: 3000 },
  async (t) => {
    const { store, listen } = hostFixture(t);
    const client = await listen();
    const id = await queuePlanner(client);
    client.socket.write(waitRequest(id) + waitRequest(id, 60, 102));
    const { id: requestId, result } = await client.reply();
    assert.equal(requestId, 102);
    assert.equal(result.isError, true);
    assert.deepEqual(JSON.parse(result.content[0].text), {
      code: "wait-in-progress",
    });
    assert.equal(
      (await client.call("get_execution", { id })).data.status,
      "queued",
    );
    store.startExecution(id);
    store.finishExecution(id, "timed-out", {});
    assert.deepEqual(await waitReply(client), {
      id,
      status: "timed-out",
      result: {},
    });
  },
);

test(
  "disconnect ends the wait and lets the Host API close promptly",
  { timeout: 3000 },
  async (t) => {
    const { listen, apiCalls, close } = hostFixture(t);
    const client = await listen();
    const id = await queuePlanner(client);
    await beginWait(client, id);
    client.socket.destroy();
    await client.closed;
    // Observe cancellation before closing the server, which also stops an active wait.
    for (let i = 0; i < 100 && apiCalls().length < 2; i++) await delay(10);
    assert.equal(apiCalls().at(-1)?.executionId, id);
    await close();
  },
);

test(
  "closing the Host API ends and audits an active wait",
  { timeout: 3000 },
  async (t) => {
    const { listen, apiCalls, close } = hostFixture(t);
    const client = await listen();
    const id = await queuePlanner(client);
    await beginWait(client, id);
    await close();
    await client.closed;
    assert.equal(apiCalls().at(-1)?.executionId, id);
  },
);

test(
  "wait_execution rejects invalid timeouts and reports unknown IDs",
  { timeout: 2000 },
  async (t) => {
    const { listen } = hostFixture(t);
    const client = await listen();
    for (const timeoutSeconds of [0, 61, 1.5, "1", null]) {
      assert.deepEqual(
        await client.call("wait_execution", { id: "unknown", timeoutSeconds }),
        {
          isError: true,
          data: { code: "invalid-arguments" },
        },
      );
    }
    assert.deepEqual(await client.call("wait_execution", { id: "unknown" }), {
      isError: true,
      data: { code: "not-found" },
    });
  },
);

test("returns fixed tool errors without leaking input into responses or audit", async (t) => {
  const { store, options, listen, apiCalls } = hostFixture(t);
  const marker = "UNIQUE-PRIVATE-MARKER";
  const failingRequester = {
    async requestPlanner() {
      throw new Error(marker);
    },
  };
  const client = await listen({ requester: failingRequester });
  client.socket.write(
    wire("tools/call", undefined, {
      name: "draft_goal",
      arguments: { content: goalContent },
    }) + wire("ping", 100),
  );
  assert.equal((await client.reply()).id, 100);
  assert.deepEqual(store.listProposals(), []);
  const calls = [
    await client.call(marker),
    await client.call("status", { note: marker }),
    await client.call("draft_goal", { content: { title: marker } }),
    await client.call("get_goal", { id: marker }),
    await client.call("draft_task", {
      content: { ...taskContent, goalId: marker },
    }),
    await client.call("request_planner", {
      mode: "replanning",
      brief: marker.repeat(1000),
    }),
    await client.call("request_planner", { mode: "replanning", brief: marker }),
  ];
  assert.deepEqual(
    calls.map(({ isError, data }) => isError && data.code),
    [
      "unknown-tool",
      "invalid-arguments",
      "invalid-arguments",
      "not-found",
      "tool-failed",
      "invalid-arguments",
      "tool-failed",
    ],
  );
  assert.deepEqual(
    apiCalls().map(({ data }) => (data as { outcome: string }).outcome),
    [
      "denied",
      "denied",
      "denied",
      "denied",
      "error",
      "error",
      "denied",
      "error",
    ],
  );
  assert.ok(!JSON.stringify(calls).includes(marker));
  assert.ok(
    !JSON.stringify(
      store.listEvents({ subjectId: options.sessionId, limit: 100 }),
    ).includes(marker),
  );
});

test("an ended session returns an audited denial and closes the connection", async (t) => {
  const { store, options, listen, apiCalls } = hostFixture(t);
  const client = await listen();
  await client.request("ping");
  store.endSession(options.sessionId);
  assert.deepEqual(await client.call("draft_goal", { content: goalContent }), {
    isError: true,
    data: { code: "session-inactive" },
  });
  await client.closed;
  assert.deepEqual(store.listProposals(), []);
  assert.partialDeepStrictEqual(apiCalls()[0]?.data, {
    outcome: "denied",
    code: "session-inactive",
    tool: "draft_goal",
  });
});

test("a failed authorization audit prevents reads, drafts and queueing", async (t) => {
  const { store, plannerCalls, listen } = hostFixture(t);
  const client = await listen();
  await client.request("ping");
  const recordApiCall = store.recordApiCall.bind(store);
  store.recordApiCall = (id, event) => {
    if (event.kind === "authorized") throw new Error("audit write failed");
    recordApiCall(id, event);
  };
  let reads = 0;
  const getHostApiStatus = store.getHostApiStatus.bind(store);
  store.getHostApiStatus = () => {
    reads++;
    return getHostApiStatus();
  };
  const getExecution = store.getExecution.bind(store);
  store.getExecution = (id) => {
    reads++;
    return getExecution(id);
  };
  for (const result of [
    await client.call("status"),
    await client.call("wait_execution", { id: "unknown" }),
    await client.call("draft_goal", { content: goalContent }),
    await client.call("request_planner", {
      mode: "goal-design",
      brief: "Plan",
    }),
  ]) {
    assert.deepEqual(result, {
      isError: true,
      data: { code: "audit-unavailable" },
    });
  }
  assert.deepEqual(store.listProposals(), []);
  assert.deepEqual(plannerCalls, []);
  assert.equal(reads, 0);
  store.close();
  assert.deepEqual(
    await client.call("request_planner", {
      mode: "goal-design",
      brief: "Plan",
    }),
    {
      isError: true,
      data: { code: "audit-unavailable" },
    },
  );
  await client.closed;
});

test("an outcome audit failure reports an error and leaves the committed draft", async (t) => {
  const { store, listen } = hostFixture(t);
  const client = await listen();
  const recordApiCall = store.recordApiCall.bind(store);
  store.recordApiCall = (id, event) => {
    if (event.kind === "call") throw new Error("outcome audit write failed");
    recordApiCall(id, event);
  };
  assert.deepEqual(await client.call("draft_goal", { content: goalContent }), {
    isError: true,
    data: { code: "audit-unavailable" },
  });
  const [draft] = store.listProposals();
  assert.ok(draft);
  assert.equal(draft.status, "pending");
  assert.equal(
    store.listEvents({ subjectId: draft.id, limit: 1 })[0]?.kind,
    "goal.proposed",
  );
});
