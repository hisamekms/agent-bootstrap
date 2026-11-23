import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, describe, test } from "node:test";
import { createHash } from "node:crypto";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
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
import { type Host } from "../src/onboarding/prerequisites.ts";
import { applySetup, setupPlan } from "../src/onboarding/setup.ts";
import { ALPINE_3_23 } from "../src/image-recipes.ts";
import { MISE_MSB } from "../src/mise-tools.ts";

const checkout = fileURLToPath(new URL("..", import.meta.url));
const lockFile = "images/profiles.lock.json";
const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporary
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function fixture() {
  const temp = await realpath(await mkdtemp(join(tmpdir(), "ab-cli-")));
  temporary.push(temp);
  await mkdir(join(temp, "images"));
  await copyFile(join(checkout, lockFile), join(temp, lockFile));
  await writeFile(join(temp, "package.json"), "{}");
  return temp;
}

function fakeHost(root: string) {
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
    bun: "1.4.4",
    env: {
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
  "concierge",
  "goals",
  "approve",
  "audit",
  "performance",
  "targets",
  "troubleshoot",
  "safety",
];

describe("agent-bootstrap", () => {
  test("help has stable topics, commands and exit codes", async () => {
    const { host, calls } = fakeHost(checkout);
    const result = await invoke(["help", "--json"], checkout, host);
    assert.equal(result.code, 0);
    const schema = JSON.parse(result.stdout);
    assert.deepEqual(Object.keys(schema), ["topics", "commands", "exitCodes"]);
    assert.deepEqual(Object.keys(schema.topics), topics);
    assert.deepEqual(Object.keys(schema.exitCodes), ["0", "1", "2", "3"]);
    assert.deepEqual(Object.keys(schema.commands), [
      "help",
      "doctor",
      "setup",
      "concierge",
      "status",
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
      "verification",
      "export-goal-branch",
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
    const root = await fixture();
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

  test("the linked command ignores settings from the target working directory's .env", async () => {
    const root = await fixture();
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
        LO_CLAUDE_BINARY: join(root, "absent-claude"),
      },
    });
    assert.equal(run.status, 3);
    const checks = JSON.parse(run.stdout.toString()) as Array<{
      id: string;
      status: string;
    }>;
    assert.equal(checks.find(({ id }) => id === "msb-home")?.status, "missing");
    assert.equal(
      checks.find(({ id }) => id === "claude-auth")?.status,
      "missing",
    );
  });

  test("invalid commands and refused commands use distinct exits and one JSON object", async () => {
    const { host } = fakeHost(checkout);
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
      const result = await invoke([...args, "--json"], checkout, host);
      assert.equal(result.code, exit);
      assert.deepEqual(Object.keys(JSON.parse(result.stdout)), [
        "error",
        "next",
      ]);
    }
  });

  test("operator dispatch preserves existing JSON and gives a next hint", async () => {
    const root = await fixture();
    const { host } = fakeHost(root);
    const args = ["--db", join(root, "state.db"), "status"];
    const result = await invoke([...args, "--json"], root, host);
    assert.equal(result.code, 0);
    assert.deepEqual(JSON.parse(result.stdout), {
      counts: { goals: 0, tasks: 0, proposals: 0, pending: 0 },
      pending: [],
      recentExecutions: [],
      recentTasks: [],
    });
    assert.equal((await invoke(args, root, host)).stdout, result.stdout);
    assert.ok(result.stderr.startsWith("next:"));
  });

  test("doctor exposes every check status and probes Keychain metadata only", async () => {
    const root = await fixture();
    const { host, calls, images } = fakeHost(root);
    host.bun = "1.2.0";
    host.env.LO_CLAUDE_AUTH = "operator:ANTHROPIC_API_KEY:authorization";
    host.env.MSB_HOME = "/tmp";
    // /tmp resolves within the limit on macOS and Linux, unlike mkdtemp under macOS TMPDIR.
    const lock = JSON.parse(await readFile(join(root, lockFile), "utf8"));
    images.set(lock.profiles.bun.image, "sha256:" + "f".repeat(64));
    const result = await invoke(
      ["doctor", "--target", root, "--json"],
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
      target: "wrong",
      verification: "skipped",
      "artifact:.local/claude-code/2.1.330/linux-arm64-musl/claude": "missing",
      "image:base": "ok",
      "image:bun": "wrong",
      "image:concierge": "missing",
      "image:db": "missing",
      "image:browser": "missing",
      keychain: "ok",
      "claude-auth": "wrong",
      duckdb: "ok",
    });
    for (const check of checks)
      assert.deepEqual(Object.keys(check), [
        "id",
        "status",
        "detail",
        "fix",
        "needsNetwork",
        "needsHuman",
      ]);
    assert.equal(result.stderr, "next: mise install bun@1.4.4\n");
    const security = calls.filter(({ file }) => file === "/usr/bin/security");
    assert.deepEqual(
      security.map(({ args }) => args),
      [["find-generic-password", "-s", "claude-test", "-a", "operator"]],
    );
    assert.ok(!(result.stdout + result.stderr).includes("never display this"));
    const inspected = calls.filter(({ args }) => args.includes("inspect"));
    assert.equal(inspected.length, 5);
    for (const { args, env } of inspected) {
      assert.deepEqual(args.slice(0, MISE_MSB.length), MISE_MSB);
      assert.equal(env?.MISE_OFFLINE, "1");
      assert.equal(env?.MISE_NOT_FOUND_AUTO_INSTALL, "false");
      assert.equal(env?.MISE_EXEC_AUTO_INSTALL, "false");
    }
  });

  test("concierge returns prerequisite exit and does not launch", async () => {
    const root = await fixture();
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

  test("setup plan stays offline and apply itself refuses without authorization", async () => {
    const root = await fixture();
    const { host, calls } = fakeHost(root);
    const result = await invoke(["setup", "--json"], root, host);
    assert.equal(result.code, 0);
    const plan = JSON.parse(result.stdout);
    assert.equal(plan.mode, "plan");
    assert.equal(plan.artifacts.length, artifacts(defaultProfiles).length);
    assert.ok(
      plan.artifacts[0].url.endsWith("/2.1.330/linux-arm64-musl/claude"),
    );
    assert.equal(
      plan.artifacts.every(
        ({ sha256, url }: { sha256: string; url: string }) =>
          /^[a-f0-9]{64}$/.test(sha256) && url.startsWith("https:"),
      ),
      true,
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
      applySetup(root, host, await setupPlan(root, false), false),
      new RegExp("require --allow-network"),
    );
    assert.deepEqual(calls, []);
  });

  test("setup refuses a mismatching build and preserves the lock", async () => {
    const root = await fixture();
    const { host, calls, images } = fakeHost(root);
    host.env.MSB_HOME = "/tmp";
    const plan = await setupPlan(root, false);
    const original = await readFile(join(root, lockFile), "utf8");
    const command = host.command;
    host.command = (file, args, env, timeout) => {
      if (args.includes("--locked"))
        images.set(plan.images.profiles[0]!.image, "sha256:" + "f".repeat(64));
      return command(file, args, env, timeout);
    };
    await assert.rejects(
      applySetup(root, host, { ...plan, artifacts: [] }, true),
      new RegExp("differs from the checked-in digest"),
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
    const root = await fixture();
    const { host, images, calls } = fakeHost(root);
    host.env.MSB_HOME = "/tmp";
    images.clear();
    const plan = { ...(await setupPlan(root, false)), artifacts: [] };
    const command = host.command;
    host.command = (file, args, env, timeout) => {
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

  test("a file arriving during download is preserved if it differs from the pin", async () => {
    const root = await fixture();
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
    const root = await fixture();
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
