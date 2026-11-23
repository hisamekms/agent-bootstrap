import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { claudeRoleHarness } from "../src/actors.ts";
import {
  claudeLoginCommand,
  conciergeCommand,
} from "../src/local-orchestrator/concierge.ts";
import {
  loadClaudeConfig,
  userConfigPath,
  type ClaudeDirectoryConfig,
} from "../src/local-orchestrator/claude-config.ts";
import {
  classifyClaudeFailure,
  claudeNext,
} from "../src/local-orchestrator/claude-errors.ts";
import { managedClaudeSettings } from "../src/local-orchestrator/claude-policy.ts";
import {
  CredentialsVolume,
  type VolumeCommand,
} from "../src/local-orchestrator/credentials-volume.ts";
import {
  readVerificationConfig,
  writeVerificationConfig,
} from "../src/local-orchestrator/verification.ts";

function fixture(t: TestContext) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "lo-claude-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const config: ClaudeDirectoryConfig = {
    volume: {
      image: join(root, "actors.sparseimage"),
      keychainService: "actors-volume",
      attach: "while-running",
    },
    groups: {
      lead: { actors: ["Concierge"] },
      actors: { actors: ["Planner", "Executor", "Reviewer"] },
    },
    egress: ["models.example.test"],
    loginEgress: ["signin.example.test"],
    errors: [],
  };
  return { root, config };
}

test("Claude configuration merges mode and fields with a private target override", (t) => {
  const { root, config } = fixture(t);
  const env = { XDG_CONFIG_HOME: root };
  const user = userConfigPath(env);
  mkdirSync(join(root, "agent-bootstrap"));
  const target = join(root, "target");
  mkdirSync(target);
  assert.deepEqual(loadClaudeConfig(env, target), {
    auth: "api-key",
    source: "default",
    warnings: [],
  });
  writeFileSync(
    user,
    JSON.stringify({
      claude: {
        auth: "config-dir",
        apiKey: { keychainService: "user-key" },
        configDir: {
          ...config,
          groups: {
            ...config.groups,
            lead: { actors: ["Concierge", "Researcher", "verification"] },
          },
          egress: ["models.example.test:443"],
          loginEgress: ["signin.example.test:443"],
        },
      },
    }),
    { mode: 0o600 },
  );
  const targetPath = join(target, "config.json");
  writeFileSync(
    targetPath,
    JSON.stringify({
      claude: {
        auth: "api-key",
        configDir: { volume: { keychainService: "target-volume" } },
      },
    }),
    { mode: 0o600 },
  );
  assert.equal(loadClaudeConfig(env).source, "user");
  assert.equal(loadClaudeConfig(env, target).source, "target");
  assert.equal(loadClaudeConfig(env, target).keychainService, "user-key");
  const effective = loadClaudeConfig(env, target, "config-dir");
  assert.equal(effective.source, "flag");
  assert.equal(effective.configDir?.volume.keychainService, "target-volume");
  assert.deepEqual(effective.configDir?.groups.lead?.actors, ["Concierge"]);
  assert.match(effective.warnings[0]!, /ignored/);
  writeVerificationConfig(target, { profile: "bun", argv: ["bun", "test"] });
  assert.deepEqual(readVerificationConfig(target), {
    profile: "bun",
    argv: ["bun", "test"],
  });
  writeVerificationConfig(target, null);
  assert.equal(readVerificationConfig(target), null);
  assert.equal(loadClaudeConfig(env, target).source, "target");
});

test("Claude configuration rejects invalid schema, credential values and unsafe files", (t) => {
  const { root, config } = fixture(t);
  const env = { XDG_CONFIG_HOME: root };
  const path = userConfigPath(env);
  mkdirSync(join(root, "agent-bootstrap"));
  for (const claude of [
    { apiKey: { keychainService: "sk-fixture-a1234567890" } },
    { apiKey: { value: "fixture" } },
    { apiKey: { variable: "CUSTOM_KEY" } },
    { configDir: { egress: ["127.0.0.1:443"] } },
    { configDir: { egress: ["example.test:80"] } },
    { configDir: { errors: [{ match: "[", code: "auth-required" }] } },
    {
      configDir: {
        errors: [{ match: "x".repeat(161), code: "auth-required" }],
      },
    },
    { configDir: { groups: { "../escape": { actors: ["Executor"] } } } },
    {
      auth: "config-dir",
      configDir: {
        volume: config.volume,
        groups: {
          one: { actors: ["Concierge", "Planner", "Executor", "Executor"] },
        },
      },
    },
  ]) {
    writeFileSync(path, JSON.stringify({ claude }), { mode: 0o600 });
    assert.throws(() => loadClaudeConfig(env), {
      message: "Invalid Claude configuration.",
    });
  }
  writeFileSync(path, "{}");
  chmodSync(path, 0o640);
  const message =
    "Claude configuration must be a user-owned regular file with mode 0600.";
  assert.throws(() => loadClaudeConfig(env), { message });
  rmSync(path);
  writeFileSync(join(root, "valid"), "{}", { mode: 0o600 });
  symlinkSync(join(root, "valid"), path);
  assert.throws(() => loadClaudeConfig(env), { message });
});

test("volume leases attach once, keep the passphrase on stdin, and detach after the last release", (t) => {
  const { root, config } = fixture(t);
  const events: { file: string; args: string[]; input?: Buffer }[] = [];
  let attached = "";
  const passphrase = "fixture-volume-passphrase";
  const runner: VolumeCommand = (file, args, input) => {
    events.push({
      file,
      args,
      ...(input ? { input: Buffer.from(input) } : {}),
    });
    const [command] = args;
    if (file.endsWith("/plutil"))
      return {
        status: 0,
        stdout: Buffer.from(
          JSON.stringify({
            images: attached
              ? [
                  {
                    "image-path": config.volume.image,
                    "system-entities": [{ "mount-point": attached }],
                  },
                ]
              : [],
          }),
        ),
      };
    if (command === "create")
      writeFileSync(config.volume.image, "", { mode: 0o600 });
    if (command === "isencrypted")
      return { status: 0, stdout: Buffer.from("encrypted: YES\n") };
    if (command === "attach") attached = args[args.indexOf("-mountpoint") + 1]!;
    if (command === "detach") attached = "";
    if (command === "find-generic-password")
      return args.includes("-w")
        ? { status: 0, stdout: Buffer.from(passphrase + "\n") }
        : { status: 44, stdout: Buffer.alloc(0) };
    return { status: 0, stdout: Buffer.alloc(0) };
  };
  const volume = new CredentialsVolume(config, root, runner);
  volume.init();
  const security = events.filter(({ file }) => file.endsWith("/security"));
  assert.ok(!security[0]?.args.includes("-w"));
  assert.deepEqual(security[1]?.args, ["-i"]);
  const generated = security[1]?.input
    ?.toString()
    .match(/-w ([a-f0-9]{64})\n$/)?.[1];
  assert.ok(generated);
  const create = events.find(({ args }) => args[0] === "create")!;
  assert.equal(create.input?.toString(), generated + "\0");
  assert.ok(create.args.includes("AES-256"));
  assert.ok(create.args.includes("APFS"));

  const firstLease = volume.acquire();
  firstLease.prepare();
  assert.throws(() => volume.acquire(), { code: "credentials-detached" });
  firstLease.ready();
  const releaseA = firstLease.release;
  const { release: releaseB } = new CredentialsVolume(
    config,
    root,
    runner,
  ).acquire();
  assert.deepEqual(volume.status(), { mounted: true, active: 2, stale: false });
  const attach = events.filter(({ args }) => args[0] === "attach");
  assert.equal(attach.length, 1);
  assert.ok(attach[0]!.args.includes("-stdinpass"));
  assert.ok(attach[0]!.args.includes("-nobrowse"));
  assert.equal(attach[0]!.input?.toString(), passphrase + "\0");
  assert.ok(
    events.every(
      ({ args }) =>
        !args.join(" ").includes(passphrase) &&
        !args.join(" ").includes(generated),
    ),
  );

  const path = volume.groupPath("actors");
  const notes: string[] = [];
  volume.integrity("actors", "before", (note) => notes.push(note));
  writeFileSync(join(path, "untracked-cli-state"), "state");
  volume.integrity("actors", "after", (note) => notes.push(note), true);
  mkdirSync(join(path, "hooks"));
  writeFileSync(join(path, "hooks", "planted"), "fixture hook");
  writeFileSync(join(path, "settings.json"), '{"changed":true}');
  assert.throws(
    () => volume.integrity("actors", "after", (note) => notes.push(note)),
    { code: "config-tampered" },
  );
  const evidence = JSON.parse(
    readFileSync(notes[0]!.match(/in (.+)\.$/)![1]!, "utf8"),
  );
  assert.deepEqual(
    evidence.entries.map(([name]: [string]) => name),
    ["hooks", "hooks/planted", "settings.json"],
  );
  releaseA();
  assert.equal(volume.status().mounted, true);
  volume.integrity("actors", "accept", () => {});
  volume.integrity("actors", "before", () => {});
  releaseB();
  assert.deepEqual(volume.status(), {
    mounted: false,
    active: 0,
    stale: false,
  });
  assert.equal(events.filter(({ args }) => args[0] === "detach").length, 1);

  attached = volume.mount;
  assert.equal(volume.status().stale, true);
  assert.throws(() => volume.attach(), { code: "credentials-detached" });
  volume.detach();

  const pending = volume.acquire();
  const shared = volume.acquire();
  pending.prepare();
  pending.quarantine();
  shared.release();
  assert.deepEqual(volume.status(), { mounted: true, active: 1, stale: true });
  assert.throws(() => volume.acquire(), { code: "credentials-detached" });
  assert.throws(() => volume.detach(), { code: "credentials-detached" });
});

test("directory commands keep fixed guest controls and login opens without a provider binding", () => {
  const auth = { mode: "config-dir" } as const;
  const harness = claudeRoleHarness({
    auth,
    tools: [],
    model: "fixture-model",
  });
  assert.deepEqual(harness.sandbox, { tools: [], claude: true });
  for (const command of [
    harness.command({ role: "Worker", prompt: "test", timeoutMs: 200 }),
    conciergeCommand({ model: "fixture-model" }, auth),
    claudeLoginCommand(),
  ]) {
    const script = command.argv[2]!;
    execFileSync("/bin/sh", ["-n"], { input: script });
    assert.match(script, /\/claude-config/);
    assert.match(script, /--strict-mcp-config --setting-sources ''/);
    assert.doesNotMatch(script, /ANTHROPIC_API_KEY|\$MSB_|--bare/);
  }
  const policy = managedClaudeSettings("Executor");
  assert.equal(policy.disableAllHooks, true);
  assert.equal(policy.allowManagedPermissionRulesOnly, true);
  assert.deepEqual(policy.allowedMcpServers, []);
  assert.equal(policy.permissions.disableBypassPermissionsMode, "disable");
  assert.deepEqual(managedClaudeSettings("Concierge").allowedMcpServers, [
    { serverCommand: ["/usr/bin/socat", "STDIO", "VSOCK-CONNECT:2:5000"] },
  ]);
});

test("Claude errors classify generic failures and bound operator regex execution", async () => {
  const cliResult = (result: string) =>
    Buffer.from(JSON.stringify({ result, is_error: true }));
  for (const [result, code] of [
    ["HTTP 403", "auth-required"],
    ["Authentication failed", "auth-required"],
    ["HTTP 429", "rate-limited"],
    ["Usage limit reached", "rate-limited"],
    ["Invalid configuration", "config-invalid"],
  ] as const)
    assert.equal(await classifyClaudeFailure(cliResult(result), []), code);
  assert.equal(
    await classifyClaudeFailure(cliResult("fixture error"), [
      { match: "fixture", code: "config-invalid" },
    ]),
    "config-invalid",
  );
  assert.equal(
    await classifyClaudeFailure(cliResult("a".repeat(8191) + "x"), [
      { match: "^(a+)+$", code: "config-invalid" },
    ]),
    undefined,
  );
  assert.equal(
    claudeNext("auth-required", "actors"),
    "agent-bootstrap login --group actors",
  );
  assert.equal(
    claudeNext("credentials-detached"),
    "agent-bootstrap credentials attach",
  );
});
