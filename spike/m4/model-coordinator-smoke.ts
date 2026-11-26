import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath } from "node:fs/promises";
import { createServer } from "node:http";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { exportAudit } from "../../src/audit-export.ts";
import { CodexAppServerCoordinator } from "../../src/codex-app-server.ts";
import { CoordinatorTask } from "../../src/coordinator.ts";
import { HOST_SERVICE_NAME } from "../../src/egress-policy.ts";
import { createObservedHost } from "../../src/observed-host.ts";
import { ProfileCatalog } from "../../src/sandbox-profiles.ts";
import { modelStep } from "../../src/model-coordinator.ts";
import { taskTrace } from "../../src/task-trace.ts";
import { createTelemetry } from "../../src/telemetry.ts";

// Real Codex app-server in a disposable VM, driven by a local mock Responses
// provider. No provider credential exists in the host process or the guest.
const local = fileURLToPath(new URL("../../.local/", import.meta.url));
const msbHome = process.env.MSB_HOME;
const binary = process.argv[2];
const codexDigest =
  "28c24ad7fb3bf29c95cd66a12e72d2219f06170efefae8b02002ceb50e2866b9";
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

const provider = {
  requests: 0,
  followUps: 0,
  calls: [] as string[],
  tools: [] as string[],
  /** "native" makes the model call Codex's own clock.sleep tool. */
  mode: "router" as "router" | "native",
};
const server = createServer(async (request, response) => {
  if (request.method !== "POST" || request.url !== "/v1/responses") {
    response.writeHead(404).end();
    return;
  }
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk);
  const body = Buffer.concat(chunks).toString();
  provider.requests++;
  try {
    type Offered = {
      type?: string;
      name?: string;
      description?: string;
      tools?: Offered[];
    };
    const parsed = JSON.parse(body) as {
      tools?: Offered[];
      input?: { type?: string; tools?: Offered[] }[];
    };
    const visit = (items: Offered[] | undefined, prefix: string) => {
      for (const item of items ?? []) {
        const label = `${prefix}${item.name ?? `<${item.type}>`}`;
        if (item.tools) visit(item.tools, `${label}.`);
        else if (!provider.tools.includes(label)) provider.tools.push(label);
        // Code mode lists its nested tools in the description.
        for (const [, nested] of (item.description ?? "").matchAll(
          /^### `([^`]+)`/gm,
        ))
          if (!provider.tools.includes(`${label}>${nested}`))
            provider.tools.push(`${label}>${nested}`);
      }
    };
    visit(parsed.tools, "");
    for (const entry of parsed.input ?? [])
      if (entry.type === "additional_tools") visit(entry.tools, "");
  } catch {
    provider.tools.push("<unparsed>");
  }
  const id = `mock-${provider.requests}`;
  const followUp = body.includes("function_call_output");
  // Decide like a model would: from the host-provided state in the prompt.
  const call = followUp
    ? undefined
    : provider.mode === "native"
      ? { name: "sleep", arguments: { duration_ms: 10 } }
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
            ...(call.name === "sleep" ? { namespace: "clock" } : {}),
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
const hostService = {
  hostname: HOST_SERVICE_NAME,
  ip: "192.0.2.2",
  port: address.port,
  loopbackPort: address.port,
};

// The guest checks the copied binary again before running it.
const coordinatorCommand = {
  argv: [
    "/bin/sh",
    "-ec",
    `
      printf '%s  /tmp/codex\\n' '${codexDigest}' | sha256sum -c - >/dev/null
      chmod 700 /tmp/codex
      exec /tmp/codex app-server --listen stdio:// \\
        -c 'model_provider="fixture"' \\
        -c 'model_providers.fixture.name="Coordinator fixture"' \\
        -c 'model_providers.fixture.base_url="http://${hostService.hostname}:${hostService.port}/v1"' \\
        -c 'model_providers.fixture.wire_api="responses"' \\
        -c 'model_providers.fixture.request_max_retries=0' \\
        -c 'model_providers.fixture.stream_max_retries=0'
    `,
  ],
  timeoutMs: 50_000,
};

await mkdir(local, { recursive: true, mode: 0o700 });
const root = await realpath(await mkdtemp(join(local, "m4-model-")));
const auditPath = join(root, "audit.sqlite");
const directory = join(root, "observability");
const telemetryConfig = {
  enabled: true,
  resourceSamplingIntervalMs: 1000,
  traceSamplingRatio: 1,
};
const telemetry = createTelemetry(telemetryConfig, directory);
let observed: Awaited<ReturnType<typeof createObservedHost>> | undefined;
try {
  await mkdir(join(root, "tasks"), { mode: 0o700 });
  const profiles = new ProfileCatalog({ base: { image } });
  observed = await createObservedHost({
    config: {
      directory,
      audit: { mode: "required" },
      telemetry: telemetryConfig,
    },
    auditPath,
    msb: {
      binary: msbPath,
      home: msbHome,
      stagingRoot: join(root, "sandboxes"),
    },
    profiles,
    observers: [telemetry],
  });
  const { host, audit } = observed;
  const model = new CodexAppServerCoordinator({
    async open(id, use) {
      const result = await host.runCoordinatorSession(
        {
          sandbox: {
            tools: [
              {
                hostPath: binary,
                guestPath: "/tmp/codex",
                sha256: codexDigest,
              },
            ],
            maxLifetimeMs: 60_000,
          },
          command: coordinatorCommand,
        },
        id,
        use,
        undefined,
        { hostServices: [hostService] },
      );
      if (result.outcome === "ok")
        assert.ok(
          audit
            .readExecution(id)
            .networkEvents.some(
              (event) =>
                event.phase === "decided" &&
                event.channel === "host-service" &&
                event.hostname === hostService.hostname &&
                event.decision === "allow",
            ),
          "Coordinator fixture connection must be audited by the gateway",
        );
      return result.value as never;
    },
    timeoutMs: 90_000,
  });
  const delegated: string[] = [];
  const coordinator = () =>
    new CoordinatorTask(join(root, "tasks"), randomUUID(), {
      step: modelStep(model),
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
  const summary = async (task: CoordinatorTask) => {
    const trace = await taskTrace(task, audit);
    return {
      coordinator: trace.coordinator.map((event) =>
        event.kind === "turn.voided"
          ? `${event.kind} ${event.reason}`
          : event.kind,
      ),
      proposals: trace.proposals.map((proposal) => proposal.text),
      invocations: trace.invocations.map((entry) => ({
        role: entry.events[0]?.role,
        operations: entry.events
          .filter((event) => event.kind === "operation.finished")
          .map((event) => `${event.operation} ${event.outcome}`),
        outcome: entry.events.at(-1)?.outcome,
      })),
    };
  };
  const audited = (role: string) => ({
    role,
    operations: [
      "sandbox.create ok",
      "sandbox.exec ok",
      ...(role === "Worker" ? ["sandbox.collect ok"] : []),
      "sandbox.destroy ok",
    ],
    outcome: "ok",
  });

  const task = coordinator();
  await task.submit("Change the greeting in hello.txt.");
  const outcome = await task.run();
  // A native tool item voids the turn even though no approval is requested.
  provider.mode = "native";
  const native = coordinator();
  await native.submit("Change the greeting in hello.txt.");
  const nativeOutcome = await native.run();
  const first = await summary(task);
  const second = await summary(native);
  console.log(
    JSON.stringify(
      {
        journalRoot: join(root, "tasks"),
        audit: auditPath,
        observability: directory,
        router: { outcome, ...first },
        native: { outcome: nativeOutcome, ...second },
        provider,
      },
      null,
      2,
    ),
  );
  assert.equal(outcome, "denied");
  assert.deepEqual(first.coordinator, [
    "submitted",
    "turn.started",
    "turn.proposed",
    "tool.authorized",
    "delegate.finished",
    "turn.started",
    "turn.proposed",
    "tool.denied",
  ]);
  assert.deepEqual(first.invocations, [
    audited("Coordinator"),
    audited("Worker"),
    audited("Coordinator"),
  ]);
  assert.equal(nativeOutcome, "denied");
  assert.deepEqual(second.coordinator, [
    "submitted",
    "turn.started",
    "turn.voided native-item/sleep",
  ]);
  assert.deepEqual(second.invocations, [audited("Coordinator")]);
  assert.deepEqual(provider.calls, ["delegate", "requestIntegration", "sleep"]);
  assert.equal(delegated.length, 1);
  // Native tools that remain visible are recorded. Shell access must not be.
  const shell = /(^|[.>])(exec_command|write_stdin|shell|unified_exec)$/;
  assert.deepEqual(
    provider.tools.filter((name) => shell.test(name)),
    [],
  );
  console.log(
    "Every Coordinator turn ran as an audited host session. One delegation was authorized, one integration request was denied, and a native clock.sleep call voided its turn.",
  );
} finally {
  server.closeAllConnections();
  server.close();
  try {
    await observed?.close();
  } finally {
    await telemetry.shutdown();
    if (observed) {
      try {
        exportAudit(auditPath, directory);
      } catch {
        console.error("M4 audit JSONL export failed.");
      }
    }
  }
}
