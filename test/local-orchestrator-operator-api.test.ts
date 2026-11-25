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
import { listenOperatorApi } from "../src/local-orchestrator/operator-api.ts";
import { operatorStatus } from "../src/local-orchestrator/operator-read.ts";
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
    const api = await listenOperatorApi({ ...options, pollMs: 20 });
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
        JSON.parse(JSON.stringify(operatorStatus(store))),
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
        { code: "unknown-method" },
      );
      assert.deepEqual(
        (await request("inbox.list", { includeResolved: "yes" })).error,
        { code: "invalid-params" },
      );
      assert.deepEqual(
        (await request("inbox.markSeen", { ids: Array(201).fill(item) })).error,
        { code: "invalid-params" },
      );
      assert.equal((await request("inbox.list")).result[0].id, item);
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
      store.decide(id, {
        decision: "reject",
        digest,
        answerer: { kind: "human" },
      });
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

async function terminalClient(path: string) {
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
        JSON.stringify({ id, method: `concierge.${method}`, params }) + "\n",
      );
      const response = await next();
      assert.equal(response.id, id);
      return response;
    },
  };
}

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
      const first = await terminalClient(path);
      const second = await terminalClient(path);
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
      const client = await terminalClient(path);
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
