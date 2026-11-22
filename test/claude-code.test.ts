import assert from "node:assert/strict";
import test from "node:test";
import {
  CLAUDE_CODE,
  CLAUDE_CODE_GUEST_PACKAGES,
  ClaudeCodeUnsupportedError,
  claudeCodeCommand,
  claudeCodeProvider,
  claudeCodeTools,
  parseClaudeCodeResult,
} from "../src/claude-code.ts";

const task = {
  role: "Worker" as const,
  prompt: "Edit hello.txt. $(touch /tmp/pwned) `id` '; exit 0; '",
  model: "claude-opus-5-5",
  maxTurns: 4,
  timeoutMs: 120_000,
};

test("the CLI command takes the prompt only as one argv entry, with fixed flags", () => {
  const command = claudeCodeCommand(task);
  assert.equal(command.argv.length, 5);
  assert.deepEqual(command.argv.slice(0, 2), ["/bin/sh", "-ec"]);
  assert.equal(command.argv[3], "claude-code");
  assert.equal(command.argv[4], task.prompt);
  const script = command.argv[2]!;
  // The prompt never appears in the script, which is built only from constants.
  assert.ok(!script.includes("pwned") && !script.includes("Edit hello.txt"));
  assert.match(script, /-p --bare --strict-mcp-config --setting-sources ''/);
  assert.match(script, /--disable-slash-commands --no-session-persistence/);
  assert.match(script, /--permission-mode acceptEdits/);
  assert.match(
    script,
    /--tools 'Read,Glob,Grep,Edit,Write' --allowedTools 'Read,Glob,Grep,Edit,Write'/,
  );
  assert.doesNotMatch(script, /Bash'/);
  assert.match(script, /-- "\$1" <\/dev\/null/);
  assert.match(
    script,
    /test "\$ANTHROPIC_API_KEY" = '\$MSB_ANTHROPIC_API_KEY'/,
  );
  assert.match(script, /env -i /);
  assert.match(script, /printf '%s' '\{"tool":"collect"\}'/);
  assert.ok(script.includes(CLAUDE_CODE.sha256));
  for (const item of CLAUDE_CODE_GUEST_PACKAGES)
    assert.ok(script.includes(item.sha256));
  const reviewer = claudeCodeCommand({ ...task, role: "Reviewer" }).argv[2]!;
  assert.match(reviewer, /cd \/review/);
  assert.match(
    reviewer,
    /--tools 'Read,Glob,Grep' --allowedTools 'Read,Glob,Grep'/,
  );
  assert.match(reviewer, /head -c 65536 \/tmp\/claude-out\.json/);
  assert.doesNotMatch(reviewer, /Edit|Write|collect/);
  const fixture = claudeCodeCommand({
    ...task,
    baseUrl: "https://host.microsandbox.internal:8443",
  }).argv[2]!;
  assert.match(
    fixture,
    /ANTHROPIC_BASE_URL='https:\/\/host\.microsandbox\.internal:8443'/,
  );
  assert.doesNotMatch(command.argv[2]!, /ANTHROPIC_BASE_URL/);
});

test("invalid roles, models, turn limits, base URLs and prompts are rejected", () => {
  for (const bad of [
    { role: "Coordinator" as never },
    { model: "claude'; rm -rf /" },
    { maxTurns: 0 },
    { maxTurns: 51 },
    { baseUrl: "http://example.com" },
    { baseUrl: "https://example.com/'x" },
    { prompt: "  " },
    { prompt: "a\0b" },
  ])
    assert.throws(() => claudeCodeCommand({ ...task, ...bad }));
});

test("only host-held API keys are supported; native CLI login is refused", () => {
  assert.deepEqual(
    claudeCodeProvider({ mode: "api-key", credential: "host-secret" }),
    {
      host: "api.anthropic.com",
      secretEnv: "ANTHROPIC_API_KEY",
      header: "x-api-key",
    },
  );
  assert.throws(
    () => claudeCodeProvider({ mode: "native-cli" }),
    ClaudeCodeUnsupportedError,
  );
  const tools = claudeCodeTools({
    binary: "/opt/claude",
    packageDir: "/opt/apk",
  });
  assert.equal(tools[0]?.guestPath, "/tmp/claude");
  assert.equal(tools[0]?.sha256, CLAUDE_CODE.sha256);
  assert.equal(tools.length, 1 + CLAUDE_CODE_GUEST_PACKAGES.length);
  assert.ok(
    tools.slice(1).every((tool) => /^\/tmp\/apk-\d\.apk$/.test(tool.guestPath)),
  );
});

test("the JSON result is parsed defensively", () => {
  const ok = parseClaudeCodeResult(
    Buffer.from(
      JSON.stringify({
        result: "FIXTURE-OK",
        is_error: false,
        total_cost_usd: 0.00006,
        usage: { input_tokens: 5, output_tokens: 2 },
      }),
    ),
  );
  assert.deepEqual(ok, {
    text: "FIXTURE-OK",
    isError: false,
    costUsd: 0.00006,
    inputTokens: 5,
    outputTokens: 2,
  });
  assert.equal(parseClaudeCodeResult(Buffer.from("not json")), null);
  assert.equal(parseClaudeCodeResult(Buffer.from("{}")), null);
  assert.equal(parseClaudeCodeResult(Buffer.alloc(70_000, 0x20)), null);
  assert.equal(parseClaudeCodeResult(undefined), null);
  assert.equal(
    parseClaudeCodeResult(
      Buffer.from(JSON.stringify({ result: "x", usage: { input_tokens: -1 } })),
    )?.inputTokens,
    null,
  );
});

test("an operator-chosen credential variable runs without bare mode and keeps isolation flags", () => {
  const auth = {
    mode: "operator-credential" as const,
    variable: "ANTHROPIC_AUTH_TOKEN",
    header: "authorization" as const,
  };
  assert.deepEqual(claudeCodeProvider(auth), {
    host: "api.anthropic.com",
    secretEnv: "ANTHROPIC_AUTH_TOKEN",
    header: "authorization",
  });
  const script = claudeCodeCommand(task, auth).argv[2]!;
  assert.doesNotMatch(script, /--bare/);
  assert.match(script, /--strict-mcp-config --setting-sources ''/);
  assert.match(script, /--disable-slash-commands --no-session-persistence/);
  assert.match(script, /--tools 'Read,Glob,Grep,Edit,Write'/);
  assert.match(
    script,
    /test "\$ANTHROPIC_AUTH_TOKEN" = '\$MSB_ANTHROPIC_AUTH_TOKEN'/,
  );
  assert.match(script, /ANTHROPIC_AUTH_TOKEN="\$ANTHROPIC_AUTH_TOKEN"/);
  assert.doesNotMatch(script, /ANTHROPIC_API_KEY/);
  for (const variable of [
    "RUST_LOG",
    "XDG_CONFIG_HOME",
    "BUN_OPTIONS",
    "CLAUDE_CODE_USE_BEDROCK",
    "OTEL_EXPORTER_OTLP_HEADERS",
    "ENABLE_TOOL_SEARCH",
    "LANG",
    "TERM",
    "PATH",
    "ANTHROPIC_BASE_URL",
    "NODE_EXTRA_CA_CERTS",
    "MSB_TOKEN",
    "HTTPS_PROXY",
    "LD_PRELOAD",
    "lower_case",
    "A$(id)",
    "",
  ])
    assert.throws(() => claudeCodeCommand(task, { ...auth, variable }));
  assert.throws(() =>
    claudeCodeProvider({ ...auth, header: "cookie" as never }),
  );
});

test("credential variables must be credential-shaped and fit their fixed header", async () => {
  const { isSafeCredentialVariable } =
    await import("../src/sandbox-runtime.ts");
  for (const name of [
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "AGENT_BOOTSTRAP_TOKEN",
    "MY_SERVICE_SECRET",
  ])
    assert.ok(isSafeCredentialVariable(name), name);
  for (const name of [
    "RUST_LOG",
    "MSB_TOKEN",
    "BUN_TOKEN",
    "HTTPS_PROXY",
    "XDG_RUNTIME_KEY",
    "TOKEN_FILE",
    "CLAUDE_CODE_CLIENT_KEY",
  ])
    assert.ok(!isSafeCredentialVariable(name), name);
  assert.throws(() =>
    claudeCodeProvider({
      mode: "operator-credential",
      variable: "ANTHROPIC_API_KEY",
      header: "authorization",
    }),
  );
  assert.throws(() =>
    claudeCodeProvider({
      mode: "operator-credential",
      variable: "ANTHROPIC_AUTH_TOKEN",
      header: "x-api-key",
    }),
  );
  const script = claudeCodeCommand(task).argv[2]!;
  // Each guard is a whole line, so sh -e stops on its failure.
  for (const line of [
    "test ! -e /root/.claude",
    "test ! -e /etc/claude-code",
    "claude_home=$(mktemp -d)",
    "claude_config=$(mktemp -d)",
    'test -z "$(ls -A "$claude_home")"',
    'test -z "$(ls -A "$claude_config")"',
  ])
    assert.ok(
      script.split("\n").some((entry) => entry.trim() === line),
      line,
    );
  assert.doesNotMatch(script, /&& test|mktemp -d\) &&/);
  assert.match(script, /claude_config=\$\(mktemp -d\)/);
  assert.match(script, /ENABLE_TOOL_SEARCH=false/);
});
