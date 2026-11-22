import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import {
  claudeRoleHarness,
  codexRoleHarness,
  parseActorHarnesses,
} from "../src/actors.ts";
import { ClaudeCodeCoordinator } from "../src/claude-coordinator.ts";
import {
  codexCoordinatorCommand,
  codexRoleCommand,
  deriveCodexCatalog,
} from "../src/codex-exec.ts";
import {
  COORDINATOR_TOOLS,
  coordinatorPrompt,
} from "../src/model-coordinator.ts";

test("actor harnesses are parsed per actor with a fallback", () => {
  assert.deepEqual(parseActorHarnesses(undefined), {
    Coordinator: "codex",
    Planner: "codex",
    Worker: "codex",
    Reviewer: "codex",
  });
  assert.deepEqual(parseActorHarnesses("all=claude,Coordinator=codex"), {
    Coordinator: "codex",
    Planner: "claude",
    Worker: "claude",
    Reviewer: "claude",
  });
  for (const bad of [
    "Worker=gemini",
    "Admin=codex",
    "Worker",
    "Worker=codex=x",
  ])
    assert.throws(() => parseActorHarnesses(bad), /Invalid actor harness/);
});

test("Codex role commands take the prompt as one argv entry and follow the role contract", () => {
  const fixture = {
    endpoint: { kind: "host-port" as const, port: 8080 },
    model: "gpt-6.2-sol",
    catalog: true,
  };
  const live = {
    endpoint: {
      kind: "provider" as const,
      host: "api.openai.com",
      secretEnv: "AGENT_BOOTSTRAP_TOKEN",
      name: "plan",
    },
    model: "gpt-6.2-sol",
  };
  const prompt = "Change it. $(id) `id`";
  const worker = codexRoleCommand(
    { role: "Worker", prompt, timeoutMs: 1000 },
    fixture,
  );
  assert.equal(worker.argv[4], prompt);
  assert.ok(!worker.argv[2]!.includes("Change it"));
  assert.match(worker.argv[2]!, /printf '%s' '\{"tool":"collect"\}'/);
  assert.match(worker.argv[2]!, /model_catalog_json/);
  assert.match(worker.argv[2]!, /\$gateway:8080/);
  const reviewer = codexRoleCommand(
    { role: "Reviewer", prompt, timeoutMs: 1000 },
    live,
  );
  assert.match(reviewer.argv[2]!, /--output-schema \/tmp\/review-schema\.json/);
  assert.match(
    reviewer.argv[2]!,
    /test "\$AGENT_BOOTSTRAP_TOKEN" = '\$MSB_AGENT_BOOTSTRAP_TOKEN'/,
  );
  assert.match(reviewer.argv[2]!, /https:\/\/api\.openai\.com\/v1/);
  assert.doesNotMatch(reviewer.argv[2]!, /model_catalog_json/);
  assert.match(
    codexCoordinatorCommand(live, 1000).argv[2]!,
    /app-server --listen stdio:\/\//,
  );
  assert.throws(() =>
    codexRoleCommand(
      { role: "Worker", prompt, timeoutMs: 1 },
      { ...live, model: "x'; id" },
    ),
  );
  assert.throws(() =>
    codexRoleCommand(
      { role: "Worker", prompt, timeoutMs: 1 },
      { ...live, endpoint: { ...live.endpoint, secretEnv: "PATH" } },
    ),
  );
  const harness = codexRoleHarness(live, []);
  assert.deepEqual(harness.sandbox.provider, {
    host: "api.openai.com",
    secretEnv: "AGENT_BOOTSTRAP_TOKEN",
  });
  assert.equal(codexRoleHarness(fixture, [], 8080).sandbox.hostTcpPort, 8080);
});

test("the derived catalog switches one model to ordinary tools and is pinned", () => {
  const catalog = {
    models: [
      {
        slug: "m",
        tool_mode: "code_mode_only",
        experimental_supported_tools: ["clock"],
        multi_agent_version: "v2",
        text: 'a "}{" b \\ c',
      },
    ],
  };
  const embedded = Buffer.concat([
    Buffer.from("\0junk"),
    Buffer.from(JSON.stringify(catalog, null, 2)),
    Buffer.from("\0tail}"),
  ]);
  const expected = JSON.stringify({
    models: [
      {
        ...catalog.models[0],
        tool_mode: null,
        experimental_supported_tools: [],
        multi_agent_version: null,
      },
    ],
  });
  const digest = createHash("sha256").update(expected).digest("hex");
  assert.equal(deriveCodexCatalog(embedded, "m", digest), expected);
  assert.throws(
    () => deriveCodexCatalog(embedded, "m", "0".repeat(64)),
    /changed/,
  );
  assert.throws(
    () => deriveCodexCatalog(embedded, "other", digest),
    /not in catalog/,
  );
});

test("the Claude Coordinator turns the CLI answer into one proposal for the router", async () => {
  const answers = [
    '{"tool":"delegate","key":"change","role":"Worker"}',
    '```json\n{"tool":"finish"}\n```',
    "I think we should delegate.",
  ];
  const seen: { control: string; argv: string }[] = [];
  const model = new ClaudeCodeCoordinator({
    async run(plan, id) {
      seen.push({
        control: Buffer.from(
          plan.sandbox.readOnlyFiles?.[0]?.bytes ?? new Uint8Array(),
        ).toString(),
        argv: plan.command.argv.join(" "),
      });
      return {
        id,
        outcome: "ok",
        response: Buffer.from(
          JSON.stringify({
            result: answers.shift(),
            is_error: false,
            usage: { input_tokens: 3, output_tokens: 2 },
          }),
        ),
      };
    },
    sandbox: { tools: [] },
    auth: { mode: "api-key", credential: "host-secret" },
    model: "claude-opus-5-5",
    timeoutMs: 1000,
  });
  const input = {
    prompt: coordinatorPrompt({ task: "Change hello.txt", invocations: [] }),
    tools: COORDINATOR_TOOLS,
  };
  assert.deepEqual(await model.turn(input, randomUUID()), {
    call: { name: "delegate", arguments: { key: "change", role: "Worker" } },
  });
  assert.deepEqual(await model.turn(input, randomUUID()), {
    call: { name: "finish", arguments: {} },
  });
  assert.deepEqual(await model.turn(input, randomUUID()), {
    call: null,
    reason: "no-call",
  });
  assert.match(seen[0]!.control, /"name": "requestIntegration"/);
  assert.match(seen[0]!.argv, /--tools ''/);
  const reviewer = claudeRoleHarness({
    auth: { mode: "api-key", credential: "host-secret" },
    model: "claude-opus-5-5",
    tools: [],
  });
  assert.equal(
    Buffer.from(
      reviewer.reviewerOutput!(
        Buffer.from(
          JSON.stringify({ result: ' {"review":"pass","notes":""} ' }),
        ),
      )!,
    ).toString(),
    '{"review":"pass","notes":""}',
  );
  assert.equal(
    reviewer.reviewerOutput!(
      Buffer.from(JSON.stringify({ result: "x", is_error: true })),
    ),
    undefined,
  );
});

test("the Claude harness passes shell to the Worker command only", () => {
  const input = { prompt: "do it", timeoutMs: 1000 };
  const make = (shell?: boolean) =>
    claudeRoleHarness({
      auth: { mode: "api-key", credential: "host-secret" },
      model: "claude-opus-5-5",
      tools: [],
      ...(shell === undefined ? {} : { shell }),
    });
  const shelled = make(true);
  assert.match(
    shelled.command({ ...input, role: "Worker" }).argv[2]!,
    /--allowedTools 'Read,Glob,Grep,Edit,Write,Bash'/,
  );
  for (const role of ["Planner", "Reviewer"] as const)
    assert.doesNotMatch(shelled.command({ ...input, role }).argv[2]!, /Bash/);
  assert.doesNotMatch(
    make().command({ ...input, role: "Worker" }).argv[2]!,
    /Bash/,
  );
});
