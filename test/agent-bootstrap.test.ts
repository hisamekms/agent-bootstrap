import { EnvironmentStore } from "../src/environments/store.ts";
import { CODEX, codexBinaryPath } from "../src/codex-exec.ts";
import { mkdtempDisposableSync, realpathSync } from "node:fs";
import { addProject } from "../src/config/projects.ts";
import { configEnv, fixtureGit, initConfigRepo } from "./config-fixture.ts";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, test } from "node:test";
import { createHash } from "node:crypto";
import {
  copyFile,
  mkdir,
  readFile,
  readdir,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  artifactStatus,
  artifacts,
  defaultProfiles,
  fetchArtifact,
} from "../src/onboarding/artifacts.ts";
import { runBootstrap, type BootstrapIo } from "../src/onboarding/cli.ts";
import { type Check, type Host } from "../src/onboarding/prerequisites.ts";
import { applySetup, setupPlan } from "../src/onboarding/setup.ts";
import { ALPINE_3_23 } from "../src/image-recipes.ts";
import { MISE_MSB } from "../src/mise-tools.ts";
import {
  userStateDirectory,
  writePrivateConfig,
  configRoot,
  userConfigPath,
} from "../src/config/layers.ts";
import { recordSecretTestPass } from "../src/local-orchestrator/secret-test-record.ts";

const checkout = fileURLToPath(new URL("..", import.meta.url));
const lockFile = "images/profiles.lock.json";
async function prepareFixture(temp: string) {
  await mkdir(join(temp, "images"));
  await copyFile(join(checkout, lockFile), join(temp, lockFile));
  await writeFile(join(temp, "package.json"), "{}");
  return temp;
}

function fakeHost(root: string, settingsRoot = root) {
  const calls: Array<{
    file: string;
    args: readonly string[];
    env: NodeJS.ProcessEnv | undefined;
  }> = [];
  const images = new Map<string, string>([
    [ALPINE_3_23.reference, ALPINE_3_23.reference.split("@")[1]!],
  ]);
  const host: Host = {
    platform: "darwin",
    arch: "arm64",
    bun: "1.4.5",
    env: {
      ...configEnv(settingsRoot),
      MSB_HOME: root,
      USER: "operator",
      LO_CLAUDE_KEYCHAIN: "claude-test",
      LO_CLAUDE_AUTH: "operator:ANTHROPIC_API_KEY:x-api-key",
    },
    command(file, args, env) {
      calls.push({ file, args, env });
      if (file === "/usr/bin/security")
        return Promise.resolve({ code: 0, stdout: "never display this" });
      if (file !== "mise") return Promise.resolve({ code: 0, stdout: "" });
      if (args.includes("where"))
        return Promise.resolve({ code: 0, stdout: "/fixture/msb-install\n" });
      if (args.includes("inspect")) {
        const digest = images.get(args.at(-1)!);
        return Promise.resolve({
          code: digest ? 0 : 1,
          stdout: digest ? JSON.stringify({ digest }) : "",
          stderr: digest ? "" : `error: image not found: ${args.at(-1)}\n`,
        });
      }
      return Promise.resolve({
        code: 0,
        stdout: args.includes("msb") ? "msb 0.7.16\n" : "v1.5.6\n",
      });
    },
    fetch: (() => {
      throw new Error("Unexpected fetch");
    }) as typeof fetch,
  };
  return { host, calls, images };
}

function cliIo(overrides: Partial<BootstrapIo> = {}) {
  let stdout = "";
  let stderr = "";
  const io: BootstrapIo = {
    stdin: process.stdin,
    stdout: {
      write: (chunk) => {
        stdout += chunk;
      },
    },
    stderr: {
      write: (chunk) => {
        stderr += chunk;
      },
    },
    isTTY: false,
    conciergeTTY: false,
    prompt: () => {
      throw new Error("Unexpected prompt");
    },
    ...overrides,
  };
  return { io, stdout: () => stdout, stderr: () => stderr };
}

async function invoke(
  args: string[],
  root: string,
  host: Host,
  overrides?: Partial<BootstrapIo>,
) {
  const result = cliIo(overrides);
  const code = await runBootstrap(args, root, result.io, host);
  return { code, stdout: result.stdout(), stderr: result.stderr() };
}

const topics = [
  "start",
  "setup",
  "environment",
  "concierge",
  "workplace",
  "goals",
  "inbox",
  "watch",
  "approve",
  "audit",
  "performance",
  "targets",
  "configuration",
  "troubleshoot",
  "safety",
  "volume",
  "secrets",
];

describe("agent-bootstrap", () => {
  test("environment CLI handles arguments and doctor follows the committed key", async () => {
    using temp = mkdtempDisposableSync(join(realpathSync(tmpdir()), "ab-env-"));
    const root = await prepareFixture(temp.path);
    const { host, calls } = fakeHost(root);
    const target = initConfigRepo(join(root, "target"));
    const project = addProject(target, undefined, host.env);
    host.env.MSB_HOME = "/tmp";
    for (const invalid of [
      ["build", "--target", target],
      ["build", "--target", target, "--allow-network", "--allow-network"],
      ["status", "--target", target, "--allow-network"],
      ["status"],
      ["prune", "--target", target, "--keep", "-1"],
      ["prune", "--target", target, "--max-age-days", "9999999999"],
      ["outdated", "--target", target],
    ])
      assert.equal(
        (await invoke(["environment", ...invalid, "--json"], root, host)).code,
        2,
      );
    assert.equal(calls.length, 0);

    const check = async () => {
      const result = await invoke(
        ["doctor", "--target", target, "--json"],
        root,
        host,
      );
      return (JSON.parse(result.stdout) as Check[]).find(
        ({ id }) => id === "environment",
      )!;
    };
    const manifestPath = join(target, "package.json");
    await writeFile(manifestPath, "{}");
    const skipped = await check();
    assert.equal(skipped.status, "skipped");
    assert.equal(skipped.environment, undefined);
    await writeFile(
      join(target, "bun.lock"),
      '{"lockfileVersion":1,"packages":{}}',
    );
    fixtureGit(target, "add", ".");
    fixtureGit(target, "commit", "-m", "Declare Bun inputs");
    const status = async () => {
      const result = await invoke(
        ["environment", "status", "--target", target, "--json"],
        root,
        host,
      );
      assert.equal(result.code, 0, result.stderr + result.stdout);
      return JSON.parse(result.stdout) as {
        key: string;
        hasLock: boolean;
        state: string;
        size: number;
      };
    };
    const initial = await status();
    assert.equal(initial.state, "missing");
    assert.equal(initial.hasLock, true);
    assert.equal(initial.size, 0);
    assert.equal((await check()).status, "missing");
    assert.deepEqual((await check()).environment, initial);

    const store = new EnvironmentStore(project.id, host.env);
    const lock = JSON.parse(await readFile(join(root, lockFile), "utf8"));
    const archive = Buffer.from("fixture");
    await store.publish(
      {
        key: initial.key,
        adapter: "bun",
        profileDigest: lock.profiles.bun.image.slice(-64),
        createdAt: new Date().toISOString(),
        size: archive.length,
        hasLock: true,
        packages: [],
      },
      archive,
    );
    assert.equal((await status()).state, "current");
    assert.equal((await check()).status, "ok");
    const build = [
      "environment",
      "build",
      "--target",
      target,
      "--allow-network",
      "--json",
    ];
    const unlock = store.tryLockBuild();
    assert.ok(unlock);
    try {
      const busy = await invoke(build.slice(0, -1), root, host);
      assert.equal(busy.code, 1);
      assert.match(busy.stderr, /Another environment build is running/);
    } finally {
      unlock();
    }
    const one = await invoke(build, root, host);
    assert.equal(one.code, 0);
    assert.equal(JSON.parse(one.stdout).cacheHit, true);
    assert.match(one.stderr, /You are responsible/);
    const two = await invoke(build, root, host);
    assert.equal(two.code, 0);
    assert.equal(two.stderr, "");
    await writeFile(manifestPath, '{"name":"changed"}');
    assert.equal((await status()).state, "current");
    fixtureGit(target, "add", ".");
    fixtureGit(target, "commit", "-m", "Change Bun inputs");
    const next = await status();
    assert.equal(next.state, "stale");
    assert.equal(next.size, archive.length);
    assert.notEqual(next.key, initial.key);
    assert.deepEqual((await check()).environment, next);
    assert.equal(
      (
        await invoke(
          ["environment", "prune", "--target", target, "--keep", "0"],
          root,
          host,
        )
      ).code,
      0,
    );
    assert.equal((await status()).state, "missing");
    assert.ok(!calls.some(({ args }) => args.includes("create")));
  });

  test("codex authorize refuses a non-TTY before host operations", async () => {
    const { host, calls } = fakeHost(checkout, "/nonexistent");
    const result = await invoke(
      ["codex", "authorize", "--json"],
      checkout,
      host,
    );
    assert.equal(result.code, 2);
    assert.match(JSON.parse(result.stdout).next, /codex authorize.*TTY/);
    assert.deepEqual(calls, []);
  });

  test("doctor reports selected harnesses and probes SIWC presence without a password", async () => {
    using temp = mkdtempDisposableSync(join(realpathSync(tmpdir()), "ab-cli-"));
    const root = await prepareFixture(temp.path);
    const { host, calls } = fakeHost(root);
    const state = userStateDirectory(host.env);
    const fakeHostId = "urn:uuid:10000000-0000-4000-a000-000000000000";
    const fakeClientId = "fixture_cli_registration";
    const fakeSubject = "fixture_cli_subject";
    const fakeModel = "fixture-cli-model";
    const user = userConfigPath(host.env);
    writePrivateConfig(user, configRoot(host.env), {
      version: 1,
      actors: { Executor: "codex" },
      codex: { model: fakeModel, auth: "siwc" },
    });
    const stateFile = join(state, "siwc", "registration.json");
    writePrivateConfig(stateFile, state, {
      hostId: fakeHostId,
      clientId: fakeClientId,
      subjectHash: fakeSubject,
    });
    const temporary = join(state, "siwc", ".config-fixture");
    await writeFile(temporary, "", { mode: 0o600 });
    const result = await invoke(["doctor", "--json"], root, host);
    const checks = JSON.parse(result.stdout) as Check[];
    assert.deepEqual(
      checks.find(({ id }) => id === "actor-harnesses")?.actorHarnesses,
      {
        Concierge: "claude",
        Planner: "claude",
        Executor: "codex",
        Reviewer: "claude",
      },
    );
    assert.deepEqual(
      checks.find(({ id }) => id === "siwc-grant"),
      {
        id: "siwc-grant",
        status: "ok",
        detail: "A Sign in with ChatGPT grant is present.",
        fix: [],
        needsNetwork: false,
        needsHuman: false,
      },
    );
    const prefix = "agent-bootstrap.siwc.refresh.";
    const suffix = createHash("sha256")
      .update(fakeHostId)
      .digest("hex")
      .slice(0, 16);
    assert.deepEqual(
      calls.find(({ args }) => args.some((arg) => arg.startsWith(prefix)))
        ?.args,
      ["find-generic-password", "-s", prefix + suffix, "-a", "operator"],
    );
    for (const privateValue of [
      fakeHostId,
      fakeClientId,
      fakeSubject,
      fakeModel,
      prefix + suffix,
      "never display this",
    ])
      assert.ok(!(result.stdout + result.stderr).includes(privateValue));
    assert.ok((await stat(temporary)).isFile());

    writePrivateConfig(user, configRoot(host.env), {
      version: 1,
      actors: { Executor: "invalid" },
    });
    const invalid = await invoke(["doctor", "--json"], root, host);
    const error = (JSON.parse(invalid.stdout) as Check[]).find(
      ({ id }) => id === "configuration",
    );
    assert.ok(error);
    assert.equal(error.code, "config-invalid");
    assert.equal(error.key, "actors.Executor");
    assert.match(error.fix[0] ?? "", /config edit/);
  });

  test("help has stable topics, commands and exit codes", async () => {
    const { host, calls } = fakeHost(checkout, "/nonexistent");
    const result = await invoke(["help", "--json"], checkout, host);
    assert.equal(result.code, 0);
    const schema = JSON.parse(result.stdout);
    assert.deepEqual(Object.keys(schema), ["topics", "commands", "exitCodes"]);
    assert.deepEqual(Object.keys(schema.topics), topics);
    assert.deepEqual(Object.keys(schema.exitCodes), ["0", "1", "2", "3"]);
    assert.deepEqual(Object.keys(schema.commands), [
      "help",
      "doctor",
      "codex",
      "setup",
      "environment",
      "concierge",
      "workplace",
      "sandbox",
      "project",
      "config",
      "migrate",
      "volume",
      "secrets",
      "status",
      "inbox",
      "watch",
      "proposals",
      "show",
      "approve",
      "reject",
      "policy",
      "events",
      "show-execution",
      "retry-task",
      "reconcile",
      "update-goal-base",
      "discard-goal",
      "verification",
      "export-goal-branch",
      "publish-goal",
      "complete-goal",
      "set-auto-merge",
      "analyze",
      "denials",
    ]);
    for (const topic of topics) {
      assert.deepEqual(Object.keys(schema.topics[topic]), [
        "purpose",
        "prerequisites",
        "commands",
        "output",
        "next",
        "human",
      ]);
      const selected = await invoke(["help", topic, "--json"], checkout, host);
      assert.deepEqual(JSON.parse(selected.stdout).topics, {
        [topic]: schema.topics[topic],
      });
    }
    assert.deepEqual(calls, []);
  });

  test("linked entry finds its checkout and the full help matches the checked-in guide", async () => {
    using temp = mkdtempDisposableSync(join(realpathSync(tmpdir()), "ab-cli-"));
    const root = await prepareFixture(temp.path);
    const entry = join(root, "agent-bootstrap");
    await symlink(join(checkout, "bin/agent-bootstrap.ts"), entry);
    const env = { PATH: `${dirname(process.execPath)}:/usr/bin:/bin` };
    const run = spawnSync(entry, ["help", "--agent"], { cwd: root, env });
    assert.equal(run.status, 0);
    assert.equal(
      run.stdout.toString(),
      await readFile(join(checkout, "docs/agent-guide.md"), "utf8"),
    );
  });

  test("secrets test rejects invalid arguments and absent grants before host commands", async () => {
    using temp = mkdtempDisposableSync(join(realpathSync(tmpdir()), "ab-cli-"));
    const root = await prepareFixture(temp.path);
    const { host, calls } = fakeHost(root);
    for (const args of [
      ["secrets"],
      ["secrets", "test", "../TOOL_TOKEN"],
      ["secrets", "test", "TOOL_TOKEN", "--claude-auth", "external"],
      ["secrets", "test", "TOOL_TOKEN", "unexpected"],
    ]) {
      assert.equal((await invoke(args, root, host)).code, 2);
    }
    const result = await invoke(
      ["secrets", "test", "TOOL_TOKEN", "--json"],
      root,
      host,
    );
    assert.equal(result.code, 1);
    assert.match(
      JSON.parse(result.stdout).error,
      /requires an effective secret grant/,
    );
    assert.deepEqual(calls, []);
  });

  test("the linked command ignores settings from the target working directory's .env", async () => {
    using temp = mkdtempDisposableSync(join(realpathSync(tmpdir()), "ab-cli-"));
    const root = await prepareFixture(temp.path);
    const entry = join(root, "agent-bootstrap");
    await symlink(join(checkout, "bin/agent-bootstrap.ts"), entry);
    await writeFile(
      join(root, ".env"),
      "MSB_HOME=/tmp\nLO_CLAUDE_AUTH=operator:ANTHROPIC_API_KEY:x-api-key\n",
    );
    const run = spawnSync(entry, ["doctor", "--json"], {
      cwd: root,
      env: {
        PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
        ...configEnv(root),
        LO_CLAUDE_BINARY: join(root, "absent-claude"),
      },
    });
    assert.equal(run.status, 3);
    const checks = JSON.parse(run.stdout.toString()) as Array<{
      id: string;
      status: string;
    }>;
    assert.equal(checks.find(({ id }) => id === "msb-home")?.status, "missing");
    assert.equal(checks.find(({ id }) => id === "keychain")?.status, "missing");
  });

  test("invalid commands and refused commands use distinct exits and one JSON object", async () => {
    using temp = mkdtempDisposableSync(join(realpathSync(tmpdir()), "ab-cli-"));
    const root = await prepareFixture(temp.path);
    const { host } = fakeHost(root, "/nonexistent");
    for (const [args, exit] of [
      [["nonesuch"], 2],
      [["help", "nonesuch"], 2],
      [["doctor", "--target"], 2],
      [["concierge", "--mode", "nonesuch"], 2],
      [["concierge", "--run"], 2],
      [["--all-targets", "status"], 2],
      [["concierge"], 1],
      [["approve", "bad-id"], 1],
      [["setup", "--allow-network"], 1],
    ] as const) {
      const result = await invoke([...args, "--json"], root, host);
      assert.equal(result.code, exit);
      assert.deepEqual(Object.keys(JSON.parse(result.stdout)), [
        "error",
        "next",
      ]);
    }
  });

  test("operator dispatch preserves existing JSON and gives a next hint", async () => {
    using temp = mkdtempDisposableSync(join(realpathSync(tmpdir()), "ab-cli-"));
    const root = await prepareFixture(temp.path);
    const { host } = fakeHost(root);
    const args = ["--db", join(root, "state.db"), "status"];
    const result = await invoke([...args, "--json"], root, host);
    assert.equal(result.code, 0);
    assert.deepEqual(JSON.parse(result.stdout), {
      counts: { goals: 0, tasks: 0, proposals: 0, pending: 0 },
      pending: [],
      publish: {
        enabled: false,
        remote: "origin",
        base: "main",
        autoMerge: "off",
      },
      recentExecutions: [],
      recentTasks: [],
    });
    assert.equal((await invoke(args, root, host)).stdout, result.stdout);
    assert.ok(result.stderr.startsWith("next:"));
  });

  test(
    "doctor exposes every check status and probes Keychain metadata only",
    { timeout: 30_000 },
    async () => {
      using temp = mkdtempDisposableSync(
        join(realpathSync(tmpdir()), "ab-cli-"),
      );
      const root = await prepareFixture(temp.path);
      const { host, calls, images } = fakeHost(root);
      const target = initConfigRepo(join(root, "target"));
      addProject(target, undefined, host.env);
      host.bun = "1.2.0";
      host.env.MSB_HOME = "/tmp";
      // /tmp resolves within the limit on macOS and Linux, unlike mkdtemp under macOS TMPDIR.
      const lock = JSON.parse(await readFile(join(root, lockFile), "utf8"));
      images.set(lock.profiles.bun.image, "sha256:" + "f".repeat(64));
      const result = await invoke(
        ["doctor", "--target", target, "--json"],
        root,
        host,
      );
      assert.equal(result.code, 3);
      const checks = JSON.parse(result.stdout) as Array<{
        id: string;
        status: string;
      }>;
      const byId = Object.fromEntries(
        checks.map(({ id, status }) => [id, status]),
      );
      assert.partialDeepStrictEqual(byId, {
        platform: "ok",
        bun: "wrong",
        mise: "ok",
        microsandbox: "ok",
        "msb-home": "ok",
        dependencies: "ok",
        target: "ok",
        "effective-configuration": "ok",
        verification: "skipped",
        "artifact:.local/claude-code/2.1.332/linux-arm64-musl/claude":
          "missing",
        "image:base": "ok",
        "image:bun": "wrong",
        "image:concierge": "missing",
        "image:db": "missing",
        "image:browser": "missing",
        keychain: "ok",
        "claude-auth": "ok",
        "claude-config-warning-1": "skipped",
        duckdb: "ok",
      });
      for (const check of checks)
        assert.deepEqual(
          Object.keys(check).filter(
            (key) =>
              key !== "effective" &&
              key !== "actorHarnesses" &&
              key !== "environment",
          ),
          ["id", "status", "detail", "fix", "needsNetwork", "needsHuman"],
        );
      assert.equal(result.stderr, "next: mise install bun@1.4.5\n");
      const security = calls.filter(({ file }) => file === "/usr/bin/security");
      assert.deepEqual(
        security.map(({ args }) => args),
        [["find-generic-password", "-s", "claude-test", "-a", "operator"]],
      );
      assert.ok(
        !(result.stdout + result.stderr).includes("never display this"),
      );
      const inspected = calls.filter(({ args }) => args.includes("inspect"));
      assert.equal(inspected.length, 5);
      for (const { args, env } of inspected) {
        assert.deepEqual(args.slice(0, MISE_MSB.length), MISE_MSB);
        assert.equal(env?.MISE_OFFLINE, "1");
        assert.equal(env?.MISE_NOT_FOUND_AUTO_INSTALL, "false");
        assert.equal(env?.MISE_EXEC_AUTO_INSTALL, "false");
      }
    },
  );

  test("doctor reports the selected Microsandbox home source and fixes", async () => {
    using temp = mkdtempDisposableSync(join(realpathSync(tmpdir()), "ab-cli-"));
    const root = await prepareFixture(temp.path);
    const { host, calls } = fakeHost(root);
    using homeDirectory = mkdtempDisposableSync("/tmp/ab-home-");
    const homeRoot = realpathSync(homeDirectory.path);
    const destination = join(homeRoot, "user");
    const fallback = join(homeRoot, ".msb");
    await mkdir(destination);
    delete host.env.MSB_HOME;
    host.env.HOME = homeRoot;

    async function inspect(source: string, status: string) {
      calls.length = 0;
      const result = await invoke(["doctor", "--json"], root, host);
      const checks = JSON.parse(result.stdout) as Array<{
        id: string;
        status: string;
        detail: string;
        fix: string[];
        effective?: { sources: Record<string, string> };
      }>;
      const home = checks.find(({ id }) => id === "msb-home");
      assert.ok(home);
      assert.equal(home.status, status);
      assert.ok(home.detail.includes(`source: ${source}`));
      assert.equal(
        checks.find(({ id }) => id === "effective-configuration")?.effective
          ?.sources["microsandbox.home"],
        source,
      );
      return { ...home, stderr: result.stderr };
    }

    const missing = await inspect("default", "missing");
    assert.deepEqual(missing.fix, [`mkdir -p ${fallback}`]);
    assert.equal(missing.stderr, `next: mkdir -p ${fallback}\n`);
    await assert.rejects(stat(fallback), { code: "ENOENT" });
    const longPath = join(homeRoot, "x".repeat(40));
    await mkdir(longPath);
    await symlink(longPath, fallback);
    const wrong = await inspect("default", "wrong");
    assert.match(wrong.detail, /40 bytes after realpath/);
    assert.match(wrong.stderr, /next: .*config edit.*microsandbox\.home/);

    writePrivateConfig(userConfigPath(host.env), configRoot(host.env), {
      version: 1,
      microsandbox: { home: destination },
    });
    assert.deepEqual((await inspect("user", "ok")).fix, []);
    const image = calls.find(({ args }) => args.includes("inspect"));
    assert.equal(image?.env?.MSB_HOME, destination);
    host.env.MSB_HOME = "relative";
    const env = await inspect("env", "wrong");
    assert.ok(env.fix.includes('export MSB_HOME="$HOME/.msb"'));
  });

  test(
    "doctor reports secret grants and pinned passes without showing the source",
    { timeout: 30_000 },
    async () => {
      using temp = mkdtempDisposableSync(
        join(realpathSync(tmpdir()), "ab-cli-"),
      );
      const root = await prepareFixture(temp.path);
      const { host, calls } = fakeHost(root);
      const target = initConfigRepo(join(root, "target"));
      addProject(target, undefined, host.env);
      const config = {
        version: 1,
        claude: { auth: "external" },
        secrets: { tool: { keychainService: "fixture-private-service" } },
        secretEnv: {
          TOOL_TOKEN: { secret: "tool", actors: ["Planner", "Reviewer"] },
        },
      };
      const path = userConfigPath(host.env);
      const configDir = configRoot(host.env);
      writePrivateConfig(path, configDir, config);
      const run = () =>
        invoke(["doctor", "--target", target, "--json"], root, host);
      const grant = (out: string) =>
        JSON.parse(out).find(
          ({ id }: { id: string }) => id === "secretEnv.TOOL_TOKEN",
        );
      const before = await run();
      const missing = grant(before.stdout);
      assert.equal(missing.status, "missing");
      assert.match(missing.detail, /Planner, Reviewer.*Self-test/);
      assert.match(missing.fix[0], /secrets test TOOL_TOKEN/);
      recordSecretTestPass(userStateDirectory(host.env), "TOOL_TOKEN");
      const after = await run();
      assert.equal(grant(after.stdout).status, "ok");
      assert.doesNotMatch(
        before.stdout + after.stdout,
        /fixture-private-service/,
      );
      assert.ok(!calls.some(({ file }) => file === "/usr/bin/security"));

      writePrivateConfig(path, configDir, {
        ...config,
        egress: { Planner: ["extra.example:443"] },
      });
      const rejected = await run();
      assert.match(rejected.stdout, /cannot receive added egress/);
      assert.doesNotMatch(
        rejected.stdout,
        /extra\.example|fixture-private-service/,
      );
    },
  );

  test("concierge returns prerequisite exit and does not launch", async () => {
    using temp = mkdtempDisposableSync(join(realpathSync(tmpdir()), "ab-cli-"));
    const root = await prepareFixture(temp.path);
    const { host } = fakeHost(root);
    const result = await invoke(["concierge", "--json"], root, host, {
      conciergeTTY: true,
      launch: () => {
        throw new Error("Unexpected launch");
      },
    });
    assert.equal(result.code, 3);
    assert.equal(
      JSON.parse(result.stdout).error,
      "Concierge prerequisites are missing.",
    );
  });

  test("workplace accepts the target in both positions without a TTY", async () => {
    using temp = mkdtempDisposableSync(join(realpathSync(tmpdir()), "ab-cli-"));
    const root = await prepareFixture(temp.path);
    const { host } = fakeHost(root);
    for (const args of [
      ["workplace", "--target", root, "--dev-bridge", "--mode", "plan"],
      ["--target", root, "workplace", "--dev-bridge", "--mode", "plan"],
    ]) {
      const result = await invoke(args, root, host, {
        launchWorkplace: () => {
          throw new Error("Unexpected launch");
        },
      });
      assert.equal(result.code, 3);
      assert.match(result.stderr, /Workplace prerequisites are missing/);
    }
    for (const args of [
      ["workplace"],
      ["workplace", "--target", "--dev-bridge", root],
      ["workplace", "--target", root, "--dev-bridge", "--dev-bridge"],
      ["workplace", "--target", root, "--volume-shell", "state"],
      ["workplace", "--target", root, "--run"],
      ["workplace", "--target", root, "--json"],
    ])
      assert.equal((await invoke(args, root, host)).code, 2);
  });

  test("setup plan stays offline and apply itself refuses without authorization", async () => {
    using temp = mkdtempDisposableSync(join(realpathSync(tmpdir()), "ab-cli-"));
    const root = await prepareFixture(temp.path);
    const { host, calls } = fakeHost(root);
    const result = await invoke(["setup", "--json"], root, host);
    assert.equal(result.code, 0);
    const plan = JSON.parse(result.stdout);
    assert.equal(plan.mode, "plan");
    assert.equal(plan.artifacts.length, artifacts(defaultProfiles).length);
    assert.ok(
      plan.artifacts[0].url.endsWith("/2.1.332/linux-arm64-musl/claude"),
    );
    assert.equal(
      plan.artifacts.every(
        ({ sha256, url }: { sha256: string; url: string }) =>
          /^[a-f0-9]{64}$/.test(sha256) && url.startsWith("https:"),
      ),
      true,
    );
    writePrivateConfig(userConfigPath(host.env), configRoot(host.env), {
      version: 1,
      claude: { auth: "external" },
      secrets: { fixture: { keychainService: "fixture-private-service" } },
      secretEnv: { TOOL_TOKEN: { secret: "fixture", actors: ["Executor"] } },
    });
    const withGrant = await invoke(["setup", "--json"], root, host);
    assert.equal(withGrant.code, 0);
    assert.deepEqual(
      JSON.parse(withGrant.stdout).artifacts.map(
        ({ path }: { path: string }) => path,
      ),
      artifacts(defaultProfiles, undefined, true).map(({ path }) => path),
    );
    assert.deepEqual(
      plan.images.profiles.map(({ name }: { name: string }) => name),
      ["concierge", "bun"],
    );
    const extended = await invoke(
      ["setup", "--profiles", "--json"],
      root,
      host,
    );
    assert.deepEqual(
      JSON.parse(extended.stdout).images.profiles.map(
        ({ name }: { name: string }) => name,
      ),
      ["concierge", "bun", "db", "browser"],
    );
    const refused = await invoke(
      ["setup", "--allow-network", "--json"],
      root,
      host,
      { isTTY: true, prompt: () => "no" },
    );
    assert.equal(refused.code, 1);
    assert.deepEqual(Object.keys(JSON.parse(refused.stdout)), [
      "error",
      "next",
    ]);
    await assert.rejects(
      applySetup(root, host, await setupPlan(root, false, host.env), false),
      new RegExp("require --allow-network"),
    );
    assert.deepEqual(calls, []);
  });

  test("setup refuses a mismatching build and preserves the lock", async () => {
    using temp = mkdtempDisposableSync(join(realpathSync(tmpdir()), "ab-cli-"));
    const root = await prepareFixture(temp.path);
    const { host, calls, images } = fakeHost(root);
    host.env.MSB_HOME = "/tmp";
    const plan = await setupPlan(root, false, host.env);
    const original = await readFile(join(root, lockFile), "utf8");
    const command = host.command;
    host.command = async (file, args, env, timeout) => {
      if (!args.includes("--locked")) return command(file, args, env, timeout);
      images.set(plan.images.profiles[0]!.image, "sha256:" + "f".repeat(64));
      await command(file, args, env, timeout);
      return {
        code: 1,
        stdout: "",
        stderr: `${"noise\n".repeat(30)}Image build stopped at profile lock.\nBuild differs \u001b]52;c;aGk=\u0007from the lock\n`,
      };
    };
    await assert.rejects(
      applySetup(root, host, { ...plan, artifacts: [] }, true),
      (error: Error) => {
        assert.match(error.message, /differs from the checked-in digest/);
        assert.match(error.message, /Image build stopped at profile lock\./);
        assert.match(error.message, /\\u001b\]52/);
        assert.doesNotMatch(error.message, /\u001b/);
        assert.equal(error.message.match(/noise/g)?.length, 18);
        return true;
      },
    );
    assert.deepEqual(
      calls
        .filter(({ args }) => args.includes("--locked"))
        .map(({ args }) => args.at(-1)),
      ["concierge"],
    );
    assert.equal(await readFile(join(root, lockFile), "utf8"), original);
  });

  test("setup pulls the pinned base, builds profiles in order, and skips completed work", async () => {
    using temp = mkdtempDisposableSync(join(realpathSync(tmpdir()), "ab-cli-"));
    const root = await prepareFixture(temp.path);
    const { host, images, calls } = fakeHost(root);
    delete host.env.MSB_HOME;
    using homeDirectory = mkdtempDisposableSync("/tmp/ab-home-");
    const home = realpathSync(homeDirectory.path);
    writePrivateConfig(userConfigPath(host.env), configRoot(host.env), {
      version: 1,
      microsandbox: { home },
    });
    images.clear();
    const plan = {
      ...(await setupPlan(root, false, host.env)),
      artifacts: [],
    };
    const command = host.command;
    host.command = (file, args, env, timeout) => {
      if (
        args.includes("inspect") ||
        args.includes("pull") ||
        args.includes("--locked")
      )
        assert.equal(env?.MSB_HOME, home);
      if (args.includes("pull")) {
        assert.equal(args.at(-1), plan.images.base);
        images.set(plan.images.base, plan.images.base.split("@")[1]!);
      }
      if (args.includes("--locked")) {
        assert.ok(images.has(plan.images.base));
        const profile = plan.images.profiles.find(
          ({ name }) => name === args.at(-1),
        )!;
        images.set(profile.image, profile.image.split("@")[1]!);
      }
      return command(file, args, env, timeout);
    };

    assert.deepEqual(await applySetup(root, host, plan, true), {
      downloaded: [],
      pulled: [plan.images.base],
      built: ["concierge", "bun"],
    });
    calls.length = 0;
    assert.deepEqual(await applySetup(root, host, plan, true), {
      downloaded: [],
      pulled: [],
      built: [],
    });
    assert.ok(
      calls.every(
        ({ args }) => !args.includes("pull") && !args.includes("--locked"),
      ),
    );
  });

  test("setup includes the pinned Codex release only when the effective harness selects it", async () => {
    using temp = mkdtempDisposableSync(join(realpathSync(tmpdir()), "ab-cli-"));
    const root = await prepareFixture(temp.path);
    const { host, calls } = fakeHost(root);
    const userFile = userConfigPath(host.env);
    const codex = { auth: "siwc", model: "fixture-model" };
    const plan = () => setupPlan(root, false, host.env);
    writePrivateConfig(userFile, configRoot(host.env), { version: 1, codex });
    assert.ok(
      !(await plan()).artifacts.some(({ path }) => path === codexBinaryPath),
    );
    writePrivateConfig(userFile, configRoot(host.env), {
      version: 1,
      codex,
      actors: { Executor: "codex" },
    });
    const item = (await plan()).artifacts.find(
      ({ path }) => path === codexBinaryPath,
    );
    assert.equal(item?.sha256, CODEX.sha256);
    assert.equal(item?.archive?.sha256, CODEX.archive.sha256);
    assert.equal(
      item?.url,
      `https://github.com/openai/codex/releases/download/rust-v${CODEX.version}/${CODEX.archive.name}`,
    );
    assert.deepEqual(calls, []);
  });

  test("verified Codex archives stage only the pinned executable with private execute mode", async () => {
    using temp = mkdtempDisposableSync(join(realpathSync(tmpdir()), "ab-cli-"));
    const root = await prepareFixture(temp.path);
    const member = CODEX.archive.member;
    const fixture = "fixture binary";
    await writeFile(join(root, member), fixture);
    const archive = join(root, "fixture.tar.gz");
    assert.equal(
      spawnSync("/usr/bin/tar", ["-czf", archive, "-C", root, member]).status,
      0,
    );
    const bytes = await readFile(archive);
    const hash = (bytes: string | Buffer) =>
      createHash("sha256").update(bytes).digest("hex");
    const item = {
      ...artifacts(defaultProfiles, undefined, false, true).find(
        ({ path }) => path === codexBinaryPath,
      )!,
      sha256: hash(fixture),
      archive: { member, sha256: hash(bytes) },
    };
    const fetchFixture = ((url: URL) =>
      url.hostname === "github.com"
        ? Promise.resolve(
            new Response(null, {
              status: 302,
              headers: {
                location:
                  "https://release-assets.githubusercontent.com/fixture",
              },
            }),
          )
        : Promise.resolve(new Response(bytes))) as typeof fetch;
    await assert.rejects(
      fetchArtifact(
        root,
        { ...item, archive: { ...item.archive, sha256: "0".repeat(64) } },
        fetchFixture,
      ),
      /Download checksum/,
    );
    await assert.rejects(
      fetchArtifact(root, { ...item, sha256: "0".repeat(64) }, fetchFixture),
      /binary checksum/,
    );
    assert.equal(
      await artifactStatus(join(root, item.path), item.sha256),
      "missing",
    );
    await fetchArtifact(root, item, fetchFixture);
    assert.equal(
      await artifactStatus(join(root, item.path), item.sha256, 0o700),
      "ok",
    );
  });

  test("a file arriving during download is preserved if it differs from the pin", async () => {
    using temp = mkdtempDisposableSync(join(realpathSync(tmpdir()), "ab-cli-"));
    const root = await prepareFixture(temp.path);
    const item = {
      path: ".local/claude",
      url: "https://downloads.claude.ai/claude-code-releases/test/claude",
      sha256: createHash("sha256").update("verified").digest("hex"),
    };
    const response = (async () => {
      await writeFile(join(root, item.path), "operator file");
      return new Response("verified");
    }) as typeof fetch;
    await assert.rejects(
      fetchArtifact(root, item, response),
      /destination changed/,
    );
    assert.equal(
      await readFile(join(root, item.path), "utf8"),
      "operator file",
    );
    assert.deepEqual(await readdir(join(root, ".local")), ["claude"]);
  });

  test("downloads verify the exact bytes before rename and do not grant execute permission", async () => {
    using temp = mkdtempDisposableSync(join(realpathSync(tmpdir()), "ab-cli-"));
    const root = await prepareFixture(temp.path);
    const script = `#!/bin/sh\ntouch "${join(root, "executed")}"\n`;
    const item = {
      path: ".local/claude",
      url: "https://downloads.claude.ai/claude-code-releases/test/claude",
      sha256: createHash("sha256").update(script).digest("hex"),
    };
    const response = ((input: URL) => {
      assert.equal(input.href, item.url);
      return Promise.resolve(new Response(script));
    }) as typeof fetch;
    await assert.rejects(
      fetchArtifact(root, { ...item, sha256: "0".repeat(64) }, response),
      new RegExp("checksum"),
    );
    assert.deepEqual(await readdir(join(root, ".local")), []);
    assert.equal(
      await artifactStatus(join(root, item.path), item.sha256),
      "missing",
    );
    await fetchArtifact(root, item, response);
    assert.equal(
      await artifactStatus(join(root, item.path), item.sha256),
      "ok",
    );
    assert.equal(
      await artifactStatus(join(root, item.path), "0".repeat(64)),
      "wrong",
    );
    assert.equal((await stat(join(root, item.path))).mode & 0o777, 0o600);
    assert.ok(!(await readdir(root)).includes("executed"));
  });
});

test("sandbox shell resolves the user home before checking protected mounts", async () => {
  using temp = mkdtempDisposableSync(join(realpathSync(tmpdir()), "ab-cli-"));
  const root = await prepareFixture(temp.path);
  const { host, calls } = fakeHost(root);
  using homeDirectory = mkdtempDisposableSync("/tmp/ab-home-");
  const home = realpathSync(homeDirectory.path);
  const missingHome = join(home, "missing");
  const tool = join(root, "tool");
  await mkdir(tool);
  await writeFile(join(tool, "msb"), "");
  delete host.env.MSB_HOME;
  const command = host.command;
  host.command = async (file, args, env) => {
    await command(file, args, env);
    assert.ok(args.includes("where"));
    return { code: 0, stdout: tool };
  };
  const args = [
    "sandbox",
    "shell",
    "--run",
    "--mount-dir",
    `${home}:/external`,
  ];
  function configure(path: string) {
    writePrivateConfig(userConfigPath(host.env), configRoot(host.env), {
      version: 1,
      microsandbox: { home: path },
    });
  }
  configure(missingHome);
  const missing = await invoke(args, root, host, { conciergeTTY: true });
  assert.equal(missing.code, 1);
  assert.match(missing.stderr, /source: user/);
  assert.ok(missing.stderr.includes(`next: mkdir -p ${missingHome}\n`));
  assert.deepEqual(calls, []);

  configure(home);
  const protectedMount = await invoke(args, root, host, { conciergeTTY: true });
  assert.equal(protectedMount.code, 1);
  assert.match(
    protectedMount.stderr,
    /Check the profile, Microsandbox home, mount directories/,
  );
  assert.equal(calls.length, 1);
});

test("sandbox shell renders a credential-free gateway plan and validates options without host commands", async () => {
  using temp = mkdtempDisposableSync(join(realpathSync(tmpdir()), "ab-cli-"));
  const root = await prepareFixture(temp.path);
  const { host, calls } = fakeHost(root);
  host.env.XDG_STATE_HOME = root;
  const { code, stdout } = await invoke(
    [
      "sandbox",
      "shell",
      "--json",
      "--profile",
      "bun",
      "--allow",
      "Example.NET:443",
      "--mount-dir",
      "/test:/inspect:ro",
    ],
    root,
    host,
  );
  assert.equal(code, 0);
  const plan = JSON.parse(stdout);
  assert.equal(plan.profile, "bun");
  assert.equal(plan.egress, "gateway");
  assert.equal(plan.maxLifetimeMs, 300_000);
  assert.deepEqual(plan.allow, [{ hostname: "example.net", port: 443 }]);
  assert.deepEqual(plan.mounts, [
    { host: "/test", guest: "/inspect", readOnly: true },
  ]);
  assert.equal(
    plan.auditPath,
    join(root, "agent-bootstrap", "sandbox-shell", "audit.sqlite"),
  );
  for (const flags of [
    ["--allow", "1.2.3.4:443"],
    ["--allow", "bad-.net:443"],
    ["--allow", "example.net:22"],
    ["--allow", "example.net:443\n"],
    ["--allow", "*.example.net:443"],
    ["--profile", "unknown"],
    ["--mount-dir", "relative:/inspect"],
    ["--mount-dir", "/test:/proc"],
    ["--mount-dir", "/test:/x/../y"],
    ["--mount-dir", "/test:/x:rw"],
    ["--mount-dir", "/one:/x", "--mount-dir", "/two:/x/y"],
    ["--run"],
  ]) {
    const result = await invoke(
      ["sandbox", "shell", "--json", ...flags],
      root,
      host,
    );
    assert.equal(result.code, 2, flags.join(" "));
  }
  assert.equal(
    (await invoke(["sandbox", "shell", "--run"], root, host)).code,
    1,
  );
  assert.deepEqual(calls, []);
});
