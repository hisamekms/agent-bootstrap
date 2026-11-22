import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { ServerResponse } from "node:http";
import { createInterface } from "node:readline";
import { promisify } from "node:util";

const msbHome = process.env.MSB_HOME;
const binary = process.argv[2];
const digest =
  "6a95492ca9d85ee76bd9fc5a4d8f72dd98a6130d1bb409bcfc50e61573106616";
assert.ok(msbHome?.startsWith("/"), "Set an absolute, dedicated MSB_HOME");
assert.ok(
  binary && binary.startsWith("/"),
  "Pass the absolute Linux arm64 Codex path",
);
assert.equal(
  createHash("sha256").update(readFileSync(binary)).digest("hex"),
  digest,
);
const image =
  "docker.io/library/alpine@sha256:5dda816445facf5f7282dc7689a333278834c74265ba25db2e2eb90509e3a9dd";
const tool = "fixture_action";
const allowed = "fixture action performed";
const denied = "fixture action denied";
let modelRequests = 0;
let returnedOutputs = false;
let heldResponse: ServerResponse | undefined;
let continuedContext = false;
let notifyHeld = () => {};

function call(operation: string) {
  return {
    type: "response.output_item.done",
    item: {
      type: "function_call",
      call_id: operation,
      name: tool,
      arguments: JSON.stringify({ operation }),
    },
  };
}

const server = createServer(async (request, response) => {
  if (request.method !== "POST" || request.url !== "/v1/responses") {
    response.writeHead(404).end();
    return;
  }
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > 1_000_000) {
      response.writeHead(413).end();
      return;
    }
    chunks.push(chunk);
  }
  modelRequests += 1;
  const id = `fixture-response-${modelRequests}`;
  if (modelRequests === 3) {
    heldResponse = response;
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.write(
      `event: response.created\ndata: ${JSON.stringify({
        type: "response.created",
        response: { id },
      })}\n\n`,
    );
    notifyHeld();
    return;
  }
  if (modelRequests === 4) {
    continuedContext = Buffer.concat(chunks).includes("Fixture turn complete");
  }
  if (modelRequests === 2) {
    try {
      const body = JSON.parse(Buffer.concat(chunks).toString()) as {
        input?: { type: string; call_id: string; output?: unknown }[];
      };
      const outputs =
        body.input?.filter((item) => item.type === "function_call_output") ??
        [];
      const matched = (id: string, marker: string) => {
        const entry = outputs.find((item) => item.call_id === id);
        return (
          entry?.output !== undefined &&
          JSON.stringify(entry.output).includes(marker)
        );
      };
      returnedOutputs =
        outputs.length === 2 &&
        matched("read", allowed) &&
        matched("write", denied);
    } catch {
      returnedOutputs = false;
    }
  }
  if (modelRequests > 4 || (modelRequests === 2 && !returnedOutputs)) {
    response.writeHead(400).end("Expected fixture tool outcomes");
    return;
  }
  const events = [
    { type: "response.created", response: { id } },
    ...(modelRequests === 1
      ? [call("read"), call("write")]
      : [
          {
            type: "response.output_item.done",
            item: {
              type: "message",
              role: "assistant",
              id: "fixture-final-message",
              content: [{ type: "output_text", text: "Fixture turn complete" }],
            },
          },
        ]),
    {
      type: "response.completed",
      response: {
        id,
        usage: { input_tokens: 7, output_tokens: 3, total_tokens: 10 },
      },
    },
  ];
  response
    .writeHead(200, {
      "Content-Type": "text/event-stream",
      Connection: "close",
    })
    .end(
      events
        .map(
          (event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
        )
        .join(""),
    );
});
await new Promise<void>((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolve);
});

const address = server.address();
assert.ok(address && typeof address !== "string");
const port = String(address.port);
const env = { PATH: process.env.PATH, MSB_HOME: msbHome, MSB_BACKEND: "local" };
const sandbox = `codex-tool-${randomUUID().slice(0, 8)}`;
const msb = promisify(execFile);
try {
  await msb(
    "msb",
    [
      "create",
      "--name",
      sandbox,
      "--pull",
      "never",
      "--no-net",
      "--net-rule",
      `allow@host:tcp:${port}`,
      "--max-duration",
      "45s",
      "--copy-file",
      `${binary}:/tmp/codex`,
      image,
    ],
    { env, timeout: 15_000, killSignal: "SIGKILL" },
  );
} catch (error) {
  server.closeAllConnections();
  server.close();
  throw error;
}
const child = spawn(
  "msb",
  [
    "exec",
    "--stream",
    "--timeout",
    "30s",
    sandbox,
    "--",
    "/bin/sh",
    "-ec",
    `
      gateway=$(ip -4 route show default | awk '$1 == "default" && $2 == "via" { print $3; exit }')
      test -n "$gateway"
      printf '%s  /tmp/codex\\n' '${digest}' | sha256sum -c - >/dev/null
      chmod 700 /tmp/codex
      exec /tmp/codex app-server --listen stdio:// \
        -c 'model_provider="fixture"' \
        -c 'model_providers.fixture.name="M1 fixture"' \
        -c 'model_providers.fixture.base_url="http://'"$gateway:$1"'/v1"' \
        -c 'model_providers.fixture.wire_api="responses"' \
        -c 'model_providers.fixture.request_max_retries=0' \
        -c 'model_providers.fixture.stream_max_retries=0'
    `,
    "sh",
    port,
  ],
  { env },
);
const exited = new Promise<number | null>((resolve, reject) => {
  child.once("error", reject);
  child.once("close", resolve);
});
void exited.catch(() => {});
child.stderr.pipe(process.stderr);
child.stdin.on("error", () => {});
const timeout = setTimeout(() => child.kill("SIGKILL"), 40_000);
const send = (message: object) =>
  child.stdin.write(`${JSON.stringify(message)}\n`);
type RpcMessage = {
  id?: number | string;
  method?: string;
  error?: unknown;
  result?: { thread?: { id: string }; turn?: { id: string } };
  params?: {
    tool?: string;
    threadId?: string;
    turnId?: string;
    callId?: string;
    arguments?: { operation?: string };
    turn?: { id: string; status: string };
  };
};
const observations = new Map<string, string>();
let executions = 0;
let completed = false;
let interrupted = false;
let usageObserved = false;
let threadId: string | undefined;
let turnId: string | undefined;
let phase: "tools" | "interrupt" | "continuation" = "tools";
let interruptSent = false;
notifyHeld = () => {
  if (phase === "interrupt" && heldResponse && turnId && !interruptSent) {
    interruptSent = true;
    send({ id: 4, method: "turn/interrupt", params: { threadId, turnId } });
  }
};
const startTurn = (id: number, prompt: string) => {
  turnId = undefined;
  send({
    id,
    method: "turn/start",
    params: {
      threadId,
      input: [{ type: "text", text: prompt, text_elements: [] }],
    },
  });
};

try {
  send({
    id: 0,
    method: "initialize",
    params: {
      clientInfo: { name: "agent-bootstrap-m1", version: "0.0.0" },
      capabilities: { experimentalApi: true },
    },
  });
  for await (const line of createInterface({
    input: child.stdout,
    crlfDelay: Infinity,
  })) {
    const message = JSON.parse(line) as RpcMessage;
    assert.equal(message.error, undefined);
    if (message.method === undefined && message.id === 0) {
      send({ method: "initialized" });
      send({
        id: 1,
        method: "thread/start",
        params: {
          cwd: "/tmp",
          ephemeral: false,
          sandbox: "read-only",
          approvalPolicy: "never",
          dynamicTools: [
            {
              type: "function",
              name: tool,
              description: "In-memory fixture action",
              inputSchema: {
                type: "object",
                properties: { operation: { type: "string" } },
                required: ["operation"],
                additionalProperties: false,
              },
            },
          ],
        },
      });
    } else if (message.method === undefined && message.id === 1) {
      threadId = message.result?.thread?.id;
      assert.ok(threadId);
      startTurn(2, "Run the mock tool fixture.");
    } else if (
      message.method === undefined &&
      [2, 3, 6].some((id) => id === message.id)
    ) {
      turnId = message.result?.turn?.id;
      assert.ok(turnId);
      notifyHeld();
    } else if (message.method === undefined && message.id === 5) {
      assert.ok(threadId);
      assert.equal(message.result?.thread?.id, threadId);
      startTurn(6, "Continue this fixture conversation.");
    } else if (message.method === "item/tool/call") {
      const call = message.params;
      assert.equal(call?.tool, tool);
      assert.equal(call?.threadId, threadId);
      assert.ok(call?.turnId && call.callId && message.id !== undefined);
      assert.equal(call.turnId, turnId);
      assert.ok(call.callId === "read" || call.callId === "write");
      assert.equal(call.arguments?.operation, call.callId);
      assert.equal(observations.has(call.callId), false);
      const permit = call.arguments?.operation === "read";
      if (permit) executions += 1;
      observations.set(call.callId, permit ? "allowed" : "denied");
      send({
        id: message.id,
        result: {
          success: permit,
          contentItems: [
            { type: "inputText", text: permit ? allowed : denied },
          ],
        },
      });
    } else if (message.method === "thread/tokenUsage/updated") {
      usageObserved = true;
    } else if (message.method === "turn/completed") {
      assert.ok(turnId);
      assert.equal(message.params?.turn?.id, turnId);
      if (phase === "tools") {
        assert.equal(message.params?.turn?.status, "completed");
        phase = "interrupt";
        startTurn(3, "Wait for the host interrupt.");
      } else if (phase === "interrupt") {
        assert.equal(message.params?.turn?.status, "interrupted");
        assert.ok(interruptSent);
        interrupted = true;
        heldResponse?.destroy();
        phase = "continuation";
        send({ id: 5, method: "thread/resume", params: { threadId } });
      } else {
        assert.equal(message.params?.turn?.status, "completed");
        completed = true;
        child.stdin.end();
      }
    } else if (message.method && message.id !== undefined) {
      throw new Error(`Unexpected server request: ${message.method}`);
    }
  }
  assert.ok(
    completed && returnedOutputs,
    "Expected a complete turn and matched outputs",
  );
  assert.deepEqual([...observations].sort(), [
    ["read", "allowed"],
    ["write", "denied"],
  ]);
  assert.equal(executions, 1);
  assert.ok(interrupted && continuedContext);
  assert.equal(await exited, 0);
  console.log(
    "Mock tool turn completed. The host accepted one dynamic tool call and denied one.",
  );
  console.log(
    "A live mock request was interrupted, and the same thread resumed with context.",
  );
  console.log(`Synthetic usage notification observed: ${usageObserved}`);
} finally {
  clearTimeout(timeout);
  child.stdin.end();
  if (child.exitCode === null && child.signalCode === null)
    child.kill("SIGKILL");
  server.closeAllConnections();
  server.close();
  await msb("msb", ["rm", "--force", sandbox], {
    env,
    timeout: 10_000,
    killSignal: "SIGKILL",
  });
}
