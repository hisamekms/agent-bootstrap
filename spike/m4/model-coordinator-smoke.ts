import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath } from "node:fs/promises";
import { createServer } from "node:http";
import { isAbsolute, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { SqliteAudit } from "../../src/audit.ts";
import {
  CodexAppServerCoordinator,
  type JsonlChannel,
} from "../../src/codex-app-server.ts";
import { CoordinatorTask } from "../../src/coordinator.ts";
import { MicrosandboxRuntime } from "../../src/microsandbox.ts";
import { modelStep } from "../../src/model-coordinator.ts";
import { TrustedHost } from "../../src/trusted-host.ts";

// Real Codex app-server in a disposable VM, driven by a local mock Responses
// provider. No provider credential exists in the host process or the guest.
const local = fileURLToPath(new URL("../../.local/", import.meta.url));
const msbHome = process.env.MSB_HOME;
const binary = process.argv[2];
const codexDigest =
  "6a95492ca9d85ee76bd9fc5a4d8f72dd98a6130d1bb409bcfc50e61573106616";
const image =
  "docker.io/library/alpine@sha256:5dda816445facf5f7282dc7689a333278834c74265ba25db2e2eb90509e3a9dd";
assert.ok(msbHome && isAbsolute(msbHome), "Set an absolute MSB_HOME");
assert.ok(binary && isAbsolute(binary), "Pass the absolute Codex path");
assert.equal(
  createHash("sha256")
    .update(await readFile(binary))
    .digest("hex"),
  codexDigest,
);
const msbPath = await new Promise<string>((resolve, reject) =>
  execFile("/usr/bin/which", ["msb"], (error, stdout) =>
    error ? reject(error) : resolve(stdout.trim()),
  ),
);

const provider = { requests: 0, followUps: 0, calls: [] as string[] };
const server = createServer(async (request, response) => {
  if (request.method !== "POST" || request.url !== "/v1/responses") {
    response.writeHead(404).end();
    return;
  }
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk);
  const body = Buffer.concat(chunks).toString();
  provider.requests++;
  const id = `mock-${provider.requests}`;
  const followUp = body.includes("function_call_output");
  // Decide like a model would: from the host-provided state in the prompt.
  const call = followUp
    ? undefined
    : /\\"role\\": \\"Worker\\",\\n\s*\\"id\\"/.test(body)
      ? { name: "requestIntegration", arguments: { key: "ship" } }
      : { name: "delegate", arguments: { key: "change", role: "Worker" } };
  if (followUp) provider.followUps++;
  if (call) provider.calls.push(call.name);
  const events = [
    { type: "response.created", response: { id } },
    {
      type: "response.output_item.done",
      item: call
        ? {
            type: "function_call",
            call_id: `call-${provider.requests}`,
            name: call.name,
            arguments: JSON.stringify(call.arguments),
          }
        : {
            type: "message",
            role: "assistant",
            id: `${id}-message`,
            content: [{ type: "output_text", text: "Submitted." }],
          },
    },
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
        .map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`)
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
const msb = promisify(execFile);
const cleanups: Promise<unknown>[] = [];

/** Spike-only streamed transport. The product port has no streaming exec yet,
 * so these Coordinator VMs are not in the SQLite sandbox audit. */
async function connect(id: string): Promise<JsonlChannel> {
  const name = `coord-${id.slice(0, 8)}`;
  await msb(
    msbPath,
    [
      "create",
      "--name",
      name,
      "--pull",
      "never",
      "--no-net",
      "--net-rule",
      `allow@host:tcp:${port}`,
      "--max-duration",
      "60s",
      "--copy-file",
      `${binary}:/tmp/codex`,
      image,
    ],
    { env, timeout: 20_000, killSignal: "SIGKILL" },
  );
  const child = spawn(
    msbPath,
    [
      "exec",
      "--stream",
      "--timeout",
      "50s",
      name,
      "--",
      "/bin/sh",
      "-ec",
      `
        gateway=$(ip -4 route show default | awk '$1 == "default" && $2 == "via" { print $3; exit }')
        test -n "$gateway"
        printf '%s  /tmp/codex\\n' '${codexDigest}' | sha256sum -c - >/dev/null
        chmod 700 /tmp/codex
        exec /tmp/codex app-server --listen stdio:// \
          -c 'model_provider="fixture"' \
          -c 'model_providers.fixture.name="Coordinator fixture"' \
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
  child.stdin.on("error", () => {});
  child.stderr.resume();
  let closed = false;
  return {
    send(line) {
      if (!closed) child.stdin.write(`${line}\n`);
    },
    lines: createInterface({ input: child.stdout, crlfDelay: Infinity }),
    close() {
      if (closed) return;
      closed = true;
      child.stdin.end();
      child.kill("SIGKILL");
      cleanups.push(
        msb(msbPath, ["rm", "--force", name], {
          env,
          timeout: 15_000,
          killSignal: "SIGKILL",
        }).catch(() => {}),
      );
    },
  };
}

await mkdir(local, { recursive: true, mode: 0o700 });
const root = await realpath(await mkdtemp(join(local, "m4-model-")));
const audit = new SqliteAudit(join(root, "audit.sqlite"));
try {
  await mkdir(join(root, "tasks"), { mode: 0o700 });
  const host = new TrustedHost(
    audit,
    new MicrosandboxRuntime({
      binary: msbPath,
      home: msbHome,
      image,
      stagingRoot: join(root, "sandboxes"),
    }),
  );
  const delegated: string[] = [];
  const task = new CoordinatorTask(join(root, "tasks"), randomUUID(), {
    step: modelStep(
      new CodexAppServerCoordinator({ connect, timeoutMs: 90_000 }),
    ),
    async delegate(role, _control, id) {
      assert.equal(role, "Worker");
      const run = await host.runWorker(
        {
          sandbox: {
            files: [{ path: "hello.txt", bytes: Buffer.from("hello\n") }],
            maxLifetimeMs: 30_000,
          },
          command: {
            argv: [
              "/bin/sh",
              "-ec",
              `printf 'hello from Worker\\n' > /workspace/hello.txt; printf '{"tool":"collect"}'`,
            ],
            timeoutMs: 8000,
          },
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
  });
  await task.submit("Change the greeting in hello.txt.");
  const outcome = await task.run();
  const kinds = (await task.trace()).map((event) => event.kind);
  const worker = delegated[0] ? audit.read(delegated[0]) : [];
  console.log(
    JSON.stringify(
      {
        outcome,
        coordinator: kinds,
        provider,
        worker: worker.map((e) =>
          [e.kind, e.operation, e.outcome].filter(Boolean).join(" "),
        ),
      },
      null,
      2,
    ),
  );
  assert.equal(outcome, "denied");
  assert.deepEqual(kinds, [
    "submitted",
    "turn.started",
    "tool.authorized",
    "delegate.finished",
    "turn.started",
    "tool.denied",
  ]);
  assert.deepEqual(provider.calls, ["delegate", "requestIntegration"]);
  assert.equal(worker.at(-1)?.outcome, "ok");
  console.log(
    "Real app-server turns proposed one authorized delegation and one out-of-policy integration request; the router denied the second.",
  );
} finally {
  audit.close();
  await Promise.allSettled(cleanups);
  server.closeAllConnections();
  server.close();
}
