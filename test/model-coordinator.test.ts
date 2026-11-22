import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { type AuditInput, SqliteAudit } from "../src/audit.ts";
import {
  CODEX_COORDINATOR_CONFIG,
  CodexAppServerCoordinator,
  type JsonlChannel,
} from "../src/codex-app-server.ts";
import { CoordinatorTask, type CoordinatorDriver } from "../src/coordinator.ts";
import { boundedLines } from "../src/lines.ts";
import {
  COORDINATOR_TOOLS,
  encodeToolCall,
  modelStep,
} from "../src/model-coordinator.ts";
import type { SandboxRuntime, SandboxSession } from "../src/sandbox-runtime.ts";
import { taskTrace } from "../src/task-trace.ts";
import { TrustedHost } from "../src/trusted-host.ts";

/** What the mock provider makes the model emit in one turn. */
type Emission =
  | { call: string; arguments: unknown }
  | { request: string }
  | { message: string }
  | { item: string }
  | { raw: string }
  | { close: true }
  | { hang: true };

type Observed = {
  tools: string[];
  prompts: string[];
  toolResults: { success: boolean }[];
  declined: number;
  interrupts: number;
};

/** In-memory stand-in for `codex app-server` with a scripted mock provider.
 * Like Codex, it forwards only calls to registered dynamic tools. */
function fakeAppServer(turns: Emission[][], observed: Observed) {
  return async (): Promise<JsonlChannel> => {
    const script = turns.shift() ?? [{ call: "finish", arguments: {} }];
    const queue: string[] = [];
    let wake: (() => void) | undefined;
    let closed = false;
    let next = 100;
    let threadId = "";
    let turnId = "";
    let pending = 0;
    let finished = false;
    const emit = (message: object | string) => {
      queue.push(
        typeof message === "string" ? message : JSON.stringify(message),
      );
      wake?.();
    };
    const started = (type: string) =>
      emit({
        method: "item/started",
        params: { threadId, turnId, item: { type, id: `item-${next++}` } },
      });
    const complete = (status: string) => {
      if (finished) return;
      finished = true;
      emit({
        method: "turn/completed",
        params: { threadId, turn: { id: turnId, status } },
      });
    };
    const play = () => {
      for (const step of script) {
        if ("hang" in step) return;
        if ("close" in step) {
          closed = true;
          wake?.();
          return;
        }
        if ("raw" in step) {
          emit(step.raw);
          continue;
        }
        if ("message" in step) {
          started("agentMessage");
          continue;
        }
        // A native item that Codex runs without any approval request.
        if ("item" in step) {
          started(step.item);
          continue;
        }
        if ("call" in step) started("dynamicToolCall");
        pending++;
        if ("request" in step)
          emit({
            id: next++,
            method: step.request,
            params: { threadId, turnId, itemId: "fixture" },
          });
        else if (observed.tools.includes(step.call))
          emit({
            id: next++,
            method: "item/tool/call",
            params: {
              threadId,
              turnId,
              callId: `call-${next}`,
              tool: step.call,
              arguments: step.arguments,
            },
          });
        else pending--;
      }
      if (pending === 0) complete("completed");
    };
    return {
      send(line) {
        const message = JSON.parse(line);
        if (message.method === "initialize")
          emit({ id: message.id, result: {} });
        else if (message.method === "thread/start") {
          observed.tools = message.params.dynamicTools.map(
            (tool: { name: string }) => tool.name,
          );
          assert.equal(message.params.sandbox, "read-only");
          assert.equal(message.params.approvalPolicy, "never");
          assert.deepEqual(message.params.config, CODEX_COORDINATOR_CONFIG);
          threadId = randomUUID();
          emit({ id: message.id, result: { thread: { id: threadId } } });
        } else if (message.method === "turn/start") {
          assert.equal(message.params.threadId, threadId);
          observed.prompts.push(message.params.input[0].text);
          turnId = randomUUID();
          emit({ id: message.id, result: { turn: { id: turnId } } });
          play();
        } else if (message.method === "turn/interrupt") {
          observed.interrupts++;
          emit({ id: message.id, result: {} });
          complete("interrupted");
        } else if (message.result) {
          observed.toolResults.push(message.result);
          if (--pending === 0) complete("completed");
        } else if (message.error) {
          observed.declined++;
          if (--pending === 0) complete("completed");
        }
      },
      lines: {
        async *[Symbol.asyncIterator]() {
          while (!closed) {
            const line = queue.shift();
            if (line !== undefined) yield line;
            else await new Promise<void>((resolve) => (wake = resolve));
          }
        },
      },
      close() {
        closed = true;
        wake?.();
      },
    };
  };
}

/** Adapter options that open a channel directly, without a host session. */
const direct = (connect: () => Promise<JsonlChannel>) => ({
  async open<T>(_id: string, use: (channel: JsonlChannel) => Promise<T>) {
    return use(await connect());
  },
});

/** A fake streaming sandbox whose session is the fake app-server channel. */
const runtime = (connect: () => Promise<JsonlChannel>): SandboxRuntime => ({
  async create() {
    return { id: "fixture" };
  },
  async openSession(): Promise<SandboxSession> {
    const channel = await connect();
    let stopped: () => void = () => {};
    const finished = new Promise<"cancelled">((resolve) => {
      stopped = () => resolve("cancelled");
    });
    return {
      send: (line) => channel.send(line),
      lines: channel.lines,
      close() {
        channel.close();
        stopped();
      },
      finished,
    };
  },
  async exec() {
    return {
      status: "exited",
      exitCode: 0,
      stdout: Buffer.from('{"tool":"collect"}'),
      stderr: Buffer.alloc(0),
    };
  },
  async collect() {
    return { files: [{ path: "hello.txt", bytes: Buffer.from("hi\n") }] };
  },
  async destroy() {},
});

async function fixture(
  t: { after(cleanup: () => Promise<void> | void): void },
  turns: Emission[][],
  timeoutMs = 2000,
) {
  const root = await mkdtemp(
    join(await realpath(tmpdir()), "bootstrap-model-"),
  );
  t.after(() => rm(root, { recursive: true, force: true }));
  const audit = new SqliteAudit(join(root, "audit.sqlite"));
  t.after(() => audit.close());
  const observed: Observed = {
    tools: [],
    prompts: [],
    toolResults: [],
    declined: 0,
    interrupts: 0,
  };
  const appended: AuditInput[] = [];
  const host = new TrustedHost(
    {
      append(event) {
        appended.push(event);
        return audit.append(event);
      },
    },
    runtime(fakeAppServer(turns, observed)),
  );
  const delegated: string[] = [];
  const model = new CodexAppServerCoordinator({
    async open(id, use) {
      const result = await host.runCoordinatorSession(
        {
          sandbox: { maxLifetimeMs: 10_000 },
          command: { argv: ["/fixture/codex"], timeoutMs: 5000 },
        },
        id,
        use,
      );
      return result.value as never;
    },
    timeoutMs,
  });
  const driver: CoordinatorDriver = {
    step: modelStep(model),
    async delegate(role, _control, id) {
      assert.equal(role, "Worker");
      const run = await host.runWorker(
        {
          sandbox: { maxLifetimeMs: 10_000 },
          command: { argv: ["/fixture"], timeoutMs: 500 },
          collectPaths: ["hello.txt"],
        },
        id,
      );
      delegated.push(run.id);
      return { id: run.id, outcome: run.outcome === "ok" ? "ok" : "failed" };
    },
    async reviewedCandidate() {
      return null;
    },
    async decide() {
      return "denied";
    },
  };
  const taskId = randomUUID();
  const reopen = () => new CoordinatorTask(join(root, "tasks"), taskId, driver);
  await mkdir(join(root, "tasks"), { mode: 0o700 });
  const task = reopen();
  await task.submit("Change the greeting in hello.txt. fixture-task-secret");
  return { task, reopen, audit, appended, observed, delegated };
}

const kinds = async (task: CoordinatorTask) =>
  (await task.trace()).map((event) => event.kind);

test("a model-proposed delegation passes the router and the host audit", async (t) => {
  const { task, audit, observed, delegated } = await fixture(t, [
    [{ call: "delegate", arguments: { key: "change", role: "Worker" } }],
    [{ message: "done" }, { call: "finish", arguments: {} }],
  ]);
  assert.equal(await task.run(), "done");
  assert.deepEqual(
    observed.tools,
    COORDINATOR_TOOLS.map((tool) => tool.name),
  );
  assert.deepEqual(await kinds(task), [
    "submitted",
    "turn.started",
    "turn.proposed",
    "tool.authorized",
    "delegate.finished",
    "turn.started",
    "turn.proposed",
    "turn.done",
  ]);
  assert.equal(delegated.length, 1);
  const trace = audit.read(delegated[0]!);
  assert.equal(trace[0]?.role, "Worker");
  assert.equal(trace.at(-1)?.kind, "invocation.finished");
  assert.equal(trace.at(-1)?.outcome, "ok");
  // The second turn sees the first outcome. The task text is prompt data.
  assert.match(observed.prompts[1] ?? "", /"role": "Worker"[\s\S]*"ok"/);
  assert.match(observed.prompts[0] ?? "", /fixture-task-secret/);
  assert.deepEqual(
    observed.toolResults.map((result) => result.success),
    [true, true],
  );
  assert.equal(observed.interrupts, 2);
  assert.doesNotMatch(
    JSON.stringify(await task.trace()),
    /fixture-task-secret|change/,
  );
  // One task ID reaches every Coordinator turn, its proposal and the Worker.
  const joined = await taskTrace(task, audit);
  assert.deepEqual(
    joined.proposals.map((proposal) => JSON.parse(proposal.text ?? "")),
    [{ key: "change", role: "Worker", tool: "delegate" }, { done: true }],
  );
  const roles = joined.invocations.map((entry) => entry.events[0]?.role);
  assert.deepEqual(roles, ["Coordinator", "Worker", "Coordinator"]);
  for (const entry of joined.invocations.filter(
    (item) => item.events[0]?.role === "Coordinator",
  ))
    assert.deepEqual(
      entry.events
        .filter((event) => event.kind === "operation.finished")
        .map((event) => `${event.operation} ${event.outcome}`),
      ["sandbox.create ok", "sandbox.exec ok", "sandbox.destroy ok"],
    );
});

test("a registered tool requested out of policy is denied before any effect", async (t) => {
  const { task, appended, delegated } = await fixture(t, [
    [{ call: "requestIntegration", arguments: { key: "ship" } }],
  ]);
  assert.equal(await task.run(), "denied");
  assert.deepEqual(await kinds(task), [
    "submitted",
    "turn.started",
    "turn.proposed",
    "tool.denied",
  ]);
  assert.equal(delegated.length, 0);
  // Only the Coordinator session was audited; no role was started.
  assert.deepEqual(
    [...new Set(appended.map((event) => event.role))],
    ["Coordinator"],
  );
});

test("forged roles, injected fields and extra calls cannot widen a turn", async (t) => {
  for (const turn of [
    [{ call: "delegate", arguments: { key: "x", role: "Coordinator" } }],
    [{ call: "delegate", arguments: { key: "x", role: "Worker", push: true } }],
    [{ call: "finish", arguments: { tool: "requestIntegration" } }],
    [{ call: "getStatus", arguments: "key=x" }],
  ] satisfies Emission[][]) {
    const { task, delegated } = await fixture(t, [turn]);
    assert.equal(await task.run(), "denied");
    assert.equal((await kinds(task)).at(-1), "turn.denied");
    assert.equal(delegated.length, 0);
  }
  const { task, observed, delegated } = await fixture(t, [
    [
      { call: "getStatus", arguments: { key: "status" } },
      { call: "delegate", arguments: { key: "change", role: "Worker" } },
    ],
    [{ call: "finish", arguments: {} }],
  ]);
  assert.equal(await task.run(), "done");
  assert.equal(delegated.length, 0);
  assert.deepEqual(
    observed.toolResults.map((result) => result.success),
    [true, false, true],
  );
  assert.ok((await kinds(task)).includes("query.finished"));
});

test("a native approval request or a turn without a tool call is denied", async (t) => {
  for (const turn of [
    [
      { request: "item/commandExecution/requestApproval" },
      { call: "finish", arguments: {} },
    ],
    [{ message: "I am done." }],
  ] satisfies Emission[][]) {
    const { task, observed } = await fixture(t, [turn]);
    assert.equal(await task.run(), "denied");
    const tail = (await task.trace()).at(-1);
    assert.equal(tail?.kind, "turn.voided");
    assert.equal(
      tail?.kind === "turn.voided" && tail.reason,
      "request" in turn[0]!
        ? "server-request/item/commandExecution/requestApproval"
        : "no-call",
    );
    assert.equal(observed.declined, "request" in turn[0]! ? 1 : 0);
  }
});

test("a stalled model turn times out and is never retried automatically", async (t) => {
  const { task, reopen } = await fixture(t, [[{ hang: true }]], 50);
  await assert.rejects(task.run(), /Codex app-server: timed-out/);
  assert.equal(await reopen().run(), "uncertain");
  const tail = (await task.trace()).at(-1);
  assert.equal(tail?.kind === "turn.failed" && tail.code, "timed-out");
});

test("encoding keeps the router as the only authority", () => {
  const decode = (bytes?: Uint8Array) =>
    bytes ? JSON.parse(Buffer.from(bytes).toString()) : undefined;
  assert.equal(encodeToolCall(null), undefined);
  assert.deepEqual(decode(encodeToolCall({ name: "finish", arguments: {} })), {
    done: true,
  });
  assert.deepEqual(
    decode(
      encodeToolCall({
        name: "delegate",
        arguments: { tool: "approve", key: "k", role: "Worker" },
      }),
    ),
    { tool: "delegate", key: "k", role: "Worker" },
  );
  assert.deepEqual(decode(encodeToolCall({ name: "push", arguments: [1] })), {
    arguments: [1],
    tool: "push",
  });
});

test("a native tool item voids the turn even without an approval request", async (t) => {
  for (const item of [
    "commandExecution",
    "fileChange",
    "mcpToolCall",
    "collabAgentToolCall",
    "webSearch",
    "imageView",
    "sleep",
    "futureToolFromGuest",
  ]) {
    const { task, delegated } = await fixture(t, [
      [
        { item },
        { call: "delegate", arguments: { key: "change", role: "Worker" } },
      ],
    ]);
    assert.equal(await task.run(), "denied", item);
    const tail = (await task.trace()).at(-1);
    assert.equal(
      tail?.kind === "turn.voided" && tail.reason,
      `native-item/${item === "futureToolFromGuest" ? "other" : item}`,
    );
    assert.equal(delegated.length, 0);
  }
});

test("malformed, oversized or truncated app-server output stops the turn", async (t) => {
  for (const [turn, code] of [
    [[{ raw: "not json" }], /protocol/],
    [[{ raw: "[1]" }], /protocol/],
    [[{ raw: '{"id":2,"result":{"turn":{"id":"again"}}}' }], /protocol/],
    [[{ close: true }], /closed/],
  ] satisfies [Emission[], RegExp][]) {
    const { task, reopen, delegated } = await fixture(t, [turn]);
    await assert.rejects(task.run(), code);
    assert.equal(await reopen().run(), "uncertain");
    assert.equal((await kinds(task)).at(-1), "turn.failed");
    assert.equal(delegated.length, 0);
  }
  const lines = async (chunks: string[], max: number) => {
    const out: string[] = [];
    for await (const line of boundedLines(
      (async function* () {
        yield* chunks;
      })(),
      max,
    ))
      out.push(line);
    return out;
  };
  assert.deepEqual(await lines(["ab\r\nc", "d\n", "e"], 4), ["ab", "cd", "e"]);
  await assert.rejects(lines(["abc", "de"], 4), /limit/);
  await assert.rejects(lines(["abcde\n"], 4), /limit/);
});

test("a failed or slow connection reports a fixed error and closes late channels", async () => {
  const input = { prompt: "fixture", tools: COORDINATOR_TOOLS };
  await assert.rejects(
    new CodexAppServerCoordinator({
      ...direct(async () => {
        throw new Error("fixture-private-detail");
      }),
      timeoutMs: 1000,
    }).turn(input, randomUUID()),
    (error: Error) =>
      /Codex app-server: connect/.test(error.message) &&
      !error.message.includes("fixture-private-detail"),
  );
  let closedLate = false;
  await assert.rejects(
    new CodexAppServerCoordinator({
      ...direct(async () => {
        await new Promise((resolve) => setTimeout(resolve, 60));
        return {
          send() {},
          lines: (async function* () {})(),
          close() {
            closedLate = true;
          },
        };
      }),
      timeoutMs: 20,
    }).turn(input, randomUUID()),
    /timed-out/,
  );
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.ok(closedLate);
});

test("violations after a captured call still void the turn, and request floods stop it", async (t) => {
  const delegate = {
    call: "delegate",
    arguments: { key: "change", role: "Worker" },
  };
  for (const after of [
    { item: "commandExecution" },
    // A call that does not belong to this thread and turn.
    {
      raw: JSON.stringify({
        id: 999,
        method: "item/tool/call",
        params: {
          threadId: "other",
          turnId: "other",
          callId: "stray",
          tool: "delegate",
          arguments: { key: "change", role: "Worker" },
        },
      }),
    },
  ] satisfies Emission[]) {
    const { task, delegated } = await fixture(t, [[delegate, after]]);
    assert.equal(await task.run(), "denied");
    assert.equal((await kinds(task)).at(-1), "turn.voided");
    assert.equal(delegated.length, 0);
  }
  const flood = Array.from({ length: 65 }, () => ({
    request: "item/tool/requestUserInput",
  }));
  const { task, reopen } = await fixture(t, [flood]);
  await assert.rejects(task.run(), /Codex app-server: limit/);
  assert.equal(await reopen().run(), "uncertain");
});

test("a transport error is reported with a fixed code", async () => {
  await assert.rejects(
    new CodexAppServerCoordinator({
      ...direct(async () => ({
        send() {},
        lines: (async function* () {
          yield* [];
          throw new Error("fixture-premature-close");
        })(),
        close() {},
      })),
      timeoutMs: 1000,
    }).turn({ prompt: "fixture", tools: COORDINATOR_TOOLS }, randomUUID()),
    (error: Error) => error.message === "Codex app-server: closed",
  );
});

test("a host audit failure outranks the adapter timeout", async () => {
  const { HostAuditError } = await import("../src/trusted-host.ts");
  await assert.rejects(
    new CodexAppServerCoordinator({
      async open() {
        await new Promise((resolve) => setTimeout(resolve, 40));
        throw new HostAuditError(randomUUID());
      },
      timeoutMs: 10,
    }).turn({ prompt: "fixture", tools: COORDINATOR_TOOLS }, randomUUID()),
    HostAuditError,
  );
});

test("stored proposals escape bidirectional controls in the trace", async (t) => {
  const { task, audit } = await fixture(t, [
    [{ call: "delegate", arguments: { key: "x", role: "\u202eWorker" } }],
  ]);
  assert.equal(await task.run(), "denied");
  const joined = await taskTrace(task, audit);
  assert.equal(joined.proposals.length, 1);
  assert.ok(joined.proposals[0]?.text?.includes("\\u202eWorker"));
  assert.ok(!joined.proposals[0]?.text?.includes("\u202e"));
});
