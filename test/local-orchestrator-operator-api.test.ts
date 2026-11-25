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
