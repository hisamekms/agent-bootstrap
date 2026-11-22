import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  claudeRoleHarness,
  guestOf,
  codexRoleHarness,
  parseActorHarnesses,
} from "../src/actors.ts";
import { CLAUDE_CODE_BUILDS } from "../src/claude-code.ts";
import { ClaudeCodeCoordinator } from "../src/claude-coordinator.ts";
import {
  codexCoordinatorCommand,
  codexHostService,
  codexRoleCommand,
  deriveCodexCatalog,
} from "../src/codex-exec.ts";
import { EgressPolicy, HOST_SERVICE_NAME } from "../src/egress-policy.ts";
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
  assert.match(worker.argv[2]!, /\/tmp\/agent-bootstrap\/commit-message/);
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

test("Codex Worker diagnostics preserve the default command and report bounded failure stderr", (t) => {
  const task = {
    role: "Worker" as const,
    prompt: "Change it.",
    timeoutMs: 1000,
  };
  const options = {
    endpoint: { kind: "host-service" as const, port: 18080 },
    model: "gpt-6.2-sol",
  };
  const normal = codexRoleCommand(task, options);
  assert.deepEqual(
    codexRoleCommand(task, { ...options, diagnostics: false }),
    normal,
  );
  // Hash of the generated script before Worker diagnostics were added.
  assert.equal(
    createHash("sha256").update(normal.argv[2]!).digest("hex"),
    "d23c20bd45d4e02aa4d7a7db3ed8ede381c7429ae14ae750f1f7daeec4a62592",
  );

  const directory = mkdtempSync(join(tmpdir(), "bootstrap-codex-worker-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const fake = join(directory, "codex");
  const diagnostic = join(directory, "stderr");
  const script = codexRoleCommand(task, { ...options, diagnostics: true })
    .argv[2]!;
  // Run the real Worker body with a fake CLI and local paths, skipping the
  // guest-only prelude that verifies the pinned binary.
  const bodyStart = script.indexOf("cd /workspace\n");
  assert.ok(bodyStart >= 0);
  const body = script
    .slice(bodyStart)
    .replaceAll("/tmp/agent-bootstrap-codex.err", '"$WORKER_STDERR"')
    .replaceAll("/tmp/codex", '"$FAKE_CODEX"')
    .replace("cd /workspace", 'cd "$WORKER_DIR"');
  writeFileSync(
    fake,
    '#!/bin/sh\nprintf stdout\nprintf "%s" "$FAKE_STDERR" >&2\nexit "$FAKE_STATUS"\n',
    { mode: 0o700 },
  );
  const tail = "x".repeat(4089) + "failure";
  for (const status of [7, 0]) {
    const result = spawnSync("/bin/sh", ["-ec", body, "codex", task.prompt], {
      encoding: "utf8",
      env: {
        PATH: "/usr/bin:/bin",
        FAKE_CODEX: fake,
        WORKER_DIR: directory,
        WORKER_STDERR: diagnostic,
        FAKE_STATUS: String(status),
        FAKE_STDERR: "discarded prefix " + tail,
      },
    });
    assert.equal(result.status, status);
    assert.equal(result.stdout, status ? "" : '{"tool":"collect"}');
    assert.equal(result.stderr, status ? tail : "");
  }
});

test("Codex uses the audited host service for HTTP fixtures", () => {
  const options = {
    endpoint: { kind: "host-service" as const, port: 18080 },
    model: "gpt-6.2-sol",
  };
  const harness = codexRoleHarness(options, []);
  assert.deepEqual(harness.sandbox, { tools: [] });
  const service = codexHostService(options.endpoint);
  assert.ok(service);
  assert.equal(service.hostname, `codex.${HOST_SERVICE_NAME}`);
  for (const command of [
    harness.command({ role: "Worker", prompt: "fixture", timeoutMs: 1000 }),
    codexCoordinatorCommand(options, 1000),
  ]) {
    assert.ok(command.argv[2]?.includes(`http://${service.hostname}:18080/v1`));
    assert.doesNotMatch(command.argv[2]!, /\$gateway|env_key/);
  }
  const policy = new EgressPolicy({ allow: [], hostServices: [service] });
  assert.equal(
    policy.decideConnect({ ...service, sandbox: "fixture" }).channel,
    "host-service",
  );
  assert.throws(
    () =>
      codexCoordinatorCommand(
        {
          ...options,
          endpoint: { ...options.endpoint, port: 65536 },
        },
        1000,
      ),
    /Invalid Codex endpoint/,
  );
});

test("the Codex Reviewer inlines the diff and optional candidate files", () => {
  const reviewer = codexRoleCommand(
    { role: "Reviewer", prompt: "Review this.", timeoutMs: 1000 },
    { endpoint: { kind: "host-port", port: 8080 }, model: "m" },
  );
  const script = reviewer.argv[2]!;
  const start = script.indexOf("cd /review");
  assert.ok(start >= 0);
  // Run just the review body with a local stand-in that captures the prompt.
  const body = script
    .slice(start)
    .replaceAll("/review/", '"$REVIEW_DIR"/')
    .replaceAll(" /review", ' "$REVIEW_DIR"')
    .replaceAll("/tmp/review.json", '"$REVIEW_DIR"/review.json')
    .replace("! command -v bwrap >/dev/null", ":")
    .replace("/tmp/codex exec", "capture_prompt");
  const directory = mkdtempSync(join(tmpdir(), "codex-review-"));
  const run = () =>
    execFileSync(
      "/bin/sh",
      [
        "-ec",
        `capture_prompt() {
          for prompt do :; done
          printf '%s' "$prompt" > "$REVIEW_DIR/review.json"
        }
        ${body}`,
        "codex",
        "Review this.",
      ],
      { encoding: "utf8", env: { ...process.env, REVIEW_DIR: directory } },
    );
  try {
    const diff = join(directory, "candidate.diff");
    const source = join(directory, "candidate.source");
    const message = join(directory, "candidate.message");
    writeFileSync(diff, "+Good day.\n");
    const treePrompt = run();
    assert.match(
      treePrompt,
      /^Review this\.[\s\S]*\n--- BEGIN candidate\.diff ([0-9a-f]{24}) ---\n\+Good day\.\n--- END candidate\.diff \1 ---$/,
    );
    assert.doesNotMatch(treePrompt, /candidate\.source/);

    writeFileSync(message, "Improve greeting\n");
    assert.match(
      run(),
      /--- END candidate\.diff ([0-9a-f]{24}) ---\n--- BEGIN candidate\.message \1 ---\nImprove greeting\n--- END candidate\.message \1 ---$/,
    );
    rmSync(message);
    writeFileSync(source, "Good day.\n");
    assert.match(
      run(),
      /--- END candidate\.diff ([0-9a-f]{24}) ---\n--- BEGIN candidate\.source \1 ---\nGood day\.\n--- END candidate\.source \1 ---$/,
    );
    writeFileSync(source, "x".repeat(2001));
    assert.equal(run(), "oversized");

    rmSync(source);
    writeFileSync(diff, "x".repeat(6001));
    assert.equal(run(), "oversized");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
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

test("harnesses set the profile and pick guest-specific tools and commands", () => {
  assert.equal(guestOf("base"), "alpine");
  assert.equal(guestOf("db"), "alpine");
  assert.equal(guestOf("browser"), "debian");
  const codex = codexRoleHarness(
    { endpoint: { kind: "host-port", port: 8080 }, model: "gpt-6.2-sol" },
    [],
    8080,
    "browser",
  );
  assert.equal(codex.sandbox.profile, "browser");
  assert.equal(
    codexRoleHarness(
      { endpoint: { kind: "host-port", port: 1 }, model: "m" },
      [],
    ).sandbox.profile,
    undefined,
  );
  const worker = codex.command({ role: "Worker", prompt: "x", timeoutMs: 1 });
  const script = worker.argv[2]!;
  assert.match(script, /\/proc\/net\/route/);
  assert.match(script, /command -v ip/);
  assert.doesNotMatch(script, /\$\{/);
  assert.ok(!script.includes("\nx"));
  const auth = { mode: "api-key" as const, credential: "host-secret" as const };
  const tools = [
    { hostPath: "/h/c", guestPath: "/tmp/claude", sha256: "0".repeat(64) },
  ];
  const debian = claudeRoleHarness({
    auth,
    model: "claude-opus-5-5",
    tools,
    profile: "browser",
  });
  assert.equal(debian.sandbox.profile, "browser");
  const dScript = debian.command({ role: "Worker", prompt: "x", timeoutMs: 1 })
    .argv[2]!;
  assert.doesNotMatch(dScript, /apk/);
  assert.ok(dScript.includes(CLAUDE_CODE_BUILDS.debian.sha256));
  const base = claudeRoleHarness({
    auth,
    model: "claude-opus-5-5",
    tools,
    profile: "db",
  });
  assert.match(
    base.command({ role: "Worker", prompt: "x", timeoutMs: 1 }).argv[2]!,
    /apk add/,
  );
  const explicit = claudeRoleHarness({
    auth,
    model: "claude-opus-5-5",
    tools,
    guest: "debian",
  });
  assert.equal(explicit.sandbox.profile, undefined);
  assert.doesNotMatch(
    explicit.command({ role: "Reviewer", prompt: "x", timeoutMs: 1 }).argv[2]!,
    /apk/,
  );
});
