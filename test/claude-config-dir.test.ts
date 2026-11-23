import {
  configRoot,
  privatePath,
  projectConfigDirectory,
} from "../src/config/layers.ts";
import { createRequire } from "node:module";
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
import { dirname, join } from "node:path";
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
import {
  configuredCredentialScanner,
  createCredentialScanner,
  requireCredentialScan,
} from "../src/local-orchestrator/credential-scan.ts";
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
  mkdirSync(join(root, "agent-bootstrap"), { mode: 0o700 });
  const target = projectConfigDirectory("target", env);
  privatePath(target, configRoot(env), true);
  assert.deepEqual(loadClaudeConfig(env, target), {
    auth: "api-key",
    source: "default",
    warnings: [],
  });
  writeFileSync(
    user,
    JSON.stringify({
      version: 1,
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
  const targetPath = join(target, "local.json");
  writeFileSync(
    targetPath,
    JSON.stringify({
      version: 1,
      claude: {
        auth: "api-key",
        model: "local-model",
      },
    }),
    { mode: 0o600 },
  );
  assert.equal(loadClaudeConfig(env, target).model, "local-model");
  assert.equal(
    loadClaudeConfig({ ...env, LO_CLAUDE_MODEL: "override-model" }, target)
      .model,
    "override-model",
  );
  assert.equal(loadClaudeConfig(env).source, "user");
  assert.equal(loadClaudeConfig(env, target).source, "target");
  assert.equal(loadClaudeConfig(env, target).keychainService, "user-key");
  const effective = loadClaudeConfig(env, target, "config-dir");
  assert.equal(effective.source, "flag");
  assert.equal(
    effective.configDir?.volume.keychainService,
    config.volume.keychainService,
  );
  assert.deepEqual(effective.configDir?.groups.lead?.actors, ["Concierge"]);
  assert.match(effective.warnings[0]!, /ignored/);
  const local = readFileSync(targetPath, "utf8");
  for (const [claude, key] of [
    [{ configDir: { volume: {} } }, "claude.configDir.volume"],
    [{ gateway: [] }, "claude.gateway"],
  ] as const) {
    writeFileSync(targetPath, JSON.stringify({ version: 1, claude }));
    assert.throws(
      () => loadClaudeConfig(env, target),
      (error: Error) =>
        error.message.includes(
          `Invalid local configuration (${targetPath}): ${key}`,
        ),
    );
  }
  writeFileSync(targetPath, local);
  chmodSync(targetPath, 0o640);
  assert.throws(() => loadClaudeConfig(env, target));
  chmodSync(targetPath, 0o600);
  writeVerificationConfig(
    target,
    { profile: "bun", argv: ["bun", "test"] },
    env,
  );
  assert.deepEqual(readVerificationConfig(target, env), {
    profile: "bun",
    argv: ["bun", "test"],
  });
  writeVerificationConfig(target, null, env);
  assert.equal(readVerificationConfig(target, env), null);
  assert.equal(loadClaudeConfig(env, target).source, "target");
});

test("Claude configuration rejects invalid schema, credential values and unsafe files", (t) => {
  const { root, config } = fixture(t);
  const env = { XDG_CONFIG_HOME: root };
  const path = userConfigPath(env);
  mkdirSync(join(root, "agent-bootstrap"), { mode: 0o700 });
  for (const claude of [
    { apiKey: { keychainService: "sk-fixture-a1234567890" } },
    { apiKey: { value: "fixture" } },
    { apiKey: { variable: "CUSTOM_KEY" } },
    { configDir: { egress: ["127.0.0.1:443"] } },
    { configDir: { egress: ["example.test:80"] } },
    { configDir: { errors: [{ match: "[", code: "auth-required" }] } },
    { configDir: { leakPatterns: ["["] } },
    { configDir: { leakPatterns: ["x".repeat(161)] } },
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
    writeFileSync(path, JSON.stringify({ version: 1, claude }), {
      mode: 0o600,
    });
    assert.throws(
      () => loadClaudeConfig(env),
      /Invalid user configuration .*: claude(?:[. ]|$)/,
    );
  }
  writeFileSync(path, "{}");
  chmodSync(path, 0o640);
  assert.throws(() => loadClaudeConfig(env), /mode 0600/);
  rmSync(path);
  writeFileSync(join(root, "valid"), "{}", { mode: 0o600 });
  symlinkSync(join(root, "valid"), path);
  assert.throws(() => loadClaudeConfig(env), /without links/);
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

  const firstLease = volume.acquire("actors");
  firstLease.prepare();
  assert.throws(() => volume.acquire(), { code: "credentials-detached" });
  firstLease.ready();
  const releaseA = firstLease.release;
  assert.throws(
    () => new CredentialsVolume(config, root, runner).acquire("actors"),
    { code: "credentials-detached" },
  );
  assert.throws(() => volume.detach(true), { code: "credentials-detached" });
  const { release: releaseB } = new CredentialsVolume(
    config,
    root,
    runner,
  ).acquire("lead");
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
  writeFileSync(join(path, ".credentials.json"), "mutable state");
  writeFileSync(join(path, ".claude.json.backup"), "mutable state");
  writeFileSync(join(path, "state.lock.owner"), "mutable state");
  mkdirSync(join(path, "sessions"));
  writeFileSync(join(path, "sessions", "large"), Buffer.alloc(1024 * 1024 + 1));
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
  assert.match(evidence.digest, /^[a-f0-9]{64}$/);
  assert.doesNotMatch(JSON.stringify(evidence), /mutable state|fixture hook/);
  releaseA();
  assert.equal(volume.status().mounted, true);
  volume.integrity("actors", "accept", () => {});
  volume.integrity("actors", "before", () => {});
  writeFileSync(join(path, "unexpected"), "new state");
  assert.throws(() => volume.integrity("actors", "after", () => {}), {
    code: "config-tampered",
  });
  volume.integrity("actors", "accept", () => {});
  symlinkSync("large", join(path, "sessions", "link"));
  assert.throws(() => volume.integrity("actors", "accept", () => {}), {
    code: "config-tampered",
  });
  const { Database } = createRequire(import.meta.url)("bun:sqlite");
  const lock = new Database(join(dirname(volume.mount), "lock.sqlite"), {
    readonly: true,
  });
  try {
    assert.deepEqual(
      lock.query("SELECT event FROM integrity_audit ORDER BY rowid").all(),
      [
        { event: "integrity-hold" },
        { event: "integrity-accepted" },
        { event: "integrity-hold" },
        { event: "integrity-accepted" },
        { event: "integrity-hold" },
      ],
    );
  } finally {
    lock.close();
  }
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

  const pending = volume.acquire("actors");
  const shared = volume.acquire("lead");
  pending.prepare();
  pending.quarantine();
  shared.release();
  assert.deepEqual(volume.status(), { mounted: true, active: 1, stale: true });
  assert.throws(() => volume.acquire(), { code: "credentials-detached" });
  assert.throws(() => volume.detach(), { code: "credentials-detached" });
  volume.detach(true);
  assert.deepEqual(volume.status(), {
    mounted: false,
    active: 0,
    stale: false,
  });
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
  assert.deepEqual(policy.permissions.allow, [
    "Read(//workspace/**)",
    "Glob(//workspace/**)",
    "Grep(//workspace/**)",
    "Edit(//workspace/**)",
    "Write(//workspace/**)",
  ]);
  for (const actor of ["Planner", "Reviewer"] as const)
    assert.deepEqual(managedClaudeSettings(actor).permissions.allow, [
      "Read(//review/**)",
      "Glob(//review/**)",
      "Grep(//review/**)",
    ]);
  for (const actor of [
    "Planner",
    "Reviewer",
    "Executor",
    "Concierge",
    "login",
  ] as const)
    for (const tool of ["Read", "Glob", "Grep", "Edit", "Write"])
      for (const path of ["/claude-config", "/etc/claude-code"])
        assert.ok(
          managedClaudeSettings(actor).permissions.deny.includes(
            `${tool}(/${path}/**)`,
          ),
        );
  assert.ok(
    managedClaudeSettings("Executor", true).permissions.allow.includes("Bash"),
  );
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

test("credential scans block credential shapes and operator patterns with fixed evidence", async (t) => {
  const { root, config } = fixture(t);
  const notes: string[] = [];
  const scan = createCredentialScanner(
    { ...config, leakPatterns: ["fixture-private-[0-9]+"] },
    root,
    (note) => notes.push(note),
  );
  await scan('+{"expiresAt":123}', "Public output");
  for (const text of [
    '+  "accessToken": "fixture-a",\n+  "refreshToken": "fixture-b",\n+  "expiresAt": 123',
    "sk-ant-YMStp5zxuHQ_WMoM6iRSLxLzrjTS",
    "fixture-private-123",
    "prefixsk-ant-YMStp5zxuHQ_WMoM6iRSLxLzrjTS",
  ]) {
    await assert.rejects(scan(text), { code: "credential-leak" });
    const path = notes.at(-1)!.replace("credential-leak evidence: ", "");
    assert.equal(readFileSync(path, "utf8"), '{"code":"credential-leak"}\n');
    assert.ok(!notes.join("\n").includes(text));
  }
});

test("target screening persists after a directory launch overrides API-key mode", async (t) => {
  const { root } = fixture(t);
  const env = { XDG_CONFIG_HOME: root, XDG_STATE_HOME: root };
  const note = () => {};
  assert.equal(configuredCredentialScanner(root, note, env), undefined);
  requireCredentialScan(root);
  requireCredentialScan(root);
  const scan = configuredCredentialScanner(root, note, env);
  assert.ok(scan);
  await assert.rejects(scan("sk-ant-Zew8qZHgxj2uI9yksWwEWP8AnaT"), {
    code: "credential-leak",
  });
});

test("failed evidence writes preserve the fixed refusal code", async (t) => {
  const { root } = fixture(t);
  const blocked = join(root, "not-a-directory");
  writeFileSync(blocked, "");
  const notes: string[] = [];
  const scan = createCredentialScanner({}, blocked, (note) => notes.push(note));
  await assert.rejects(scan("sk-ant-Fek8A13O5I6CyJCHuZmFL5k5vRu"), {
    code: "credential-leak",
  });
  assert.deepEqual(notes, ["credential-leak evidence could not be written."]);
});
