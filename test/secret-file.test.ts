import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createConnection } from "node:net";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SqliteAudit } from "../src/audit.ts";
import {
  claudeCodeCommand,
  claudeCodeProvider,
  claudeCodeTools,
} from "../src/claude-code.ts";
import { managedClaudeSettings } from "../src/local-orchestrator/claude-policy.ts";
import { withActorSecret } from "../src/local-orchestrator/secret-launch.ts";
import {
  createSecretFileSender,
  createSecretScreen,
  openSecretFileDelivery,
  SECRET_TOOL_DIRS,
} from "../src/secret-file.ts";
import { checkSecretWorkspace } from "../src/workspace-tree.ts";

const auth = { mode: "secret-file", variable: "TOOL_TOKEN" } as const;

test("actor launch refuses an untested variable before reading Keychain or opening a channel", async () => {
  const config = {
    secrets: { tool: { keychainService: "fixture-private-service" } },
    secretEnv: { TOOL_TOKEN: { secret: "tool", actors: ["Executor"] } },
  } as const;
  await assert.rejects(
    withActorSecret(
      config,
      "/missing-fixture-state",
      auth.variable,
      async () => assert.fail("actor launched before passing the self-test"),
      async () => assert.fail("Keychain read before passing the self-test"),
    ),
    {
      next: "Run agent-bootstrap secrets test TOOL_TOKEN with the same target, then retry.",
    },
  );
});

test("secret-file Claude command stages a restricted launcher and drops privileges", () => {
  const task = {
    role: "Worker",
    model: "fixture",
    prompt: "Treat this as data: $1",
    shell: true,
    maxTurns: 1,
    timeoutMs: 1000,
  } as const;
  const command = claudeCodeCommand(task, auth);
  const script = command.argv[2]!;
  assert.equal(command.claudeSecretVariable, auth.variable);
  assert.equal(command.argv[4], task.prompt);
  for (const part of [
    "--bare",
    "--allowedTools",
    "MSB_",
    "LO_MOUNT_CONFIG_DIR",
  ])
    assert.ok(!script.includes(part), part);
  for (const part of [
    "env -i",
    "CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1",
    "CLAUDE_CODE_DISABLE_AUTO_MEMORY=1",
    "CLAUDE_CODE_SKIP_PROMPT_HISTORY=1",
    "claude_config=/home/agent/run/config",
    'TMPDIR="$claude_tmp"',
    "ulimit -Sc 0",
    "ulimit -Hc 0",
    "GIT_CONFIG_NOSYSTEM=1",
    "GIT_CONFIG_GLOBAL=/dev/null",
    "GIT_CONFIG_KEY_0=core.fsmonitor",
    "GIT_CONFIG_VALUE_0=false",
    "GIT_CONFIG_KEY_1=core.hooksPath",
    "GIT_CONFIG_VALUE_1=/dev/null",
    "GIT_CONFIG_KEY_2=core.pager",
    "GIT_CONFIG_VALUE_2=cat",
    "GIT_CONFIG_KEY_3=core.sshCommand",
    "GIT_CONFIG_VALUE_3=false",
    "chown -hR agent:agent /workspace",
    "mount -t tmpfs",
    "file=/run/secrets/TOOL_TOKEN",
    'chmod 400 "$file"',
    "socat -t 5",
    "agent-bootstrap-bwrap-failed",
    "bwrap --ro-bind / / --unshare-all --proc /proc --dev /dev",
    "--tools 'Read,Glob,Grep,Edit,Write,Bash'",
  ])
    assert.ok(script.includes(part), part);
  const remove = script.indexOf('rm "$file"');
  const unset = script.indexOf("unset secret");
  const drop = script.indexOf('/bin/busybox su -p -s /bin/sh -c "IFS=');
  assert.ok(
    remove >= 0 &&
      script.indexOf("ulimit -Sc 0") < script.indexOf("socat -t 5") &&
      script.indexOf("ulimit -Hc 0") < script.indexOf("socat -t 5") &&
      remove < drop &&
      drop < unset &&
      unset < script.indexOf("/tmp/claude -p"),
  );
  assert.equal(spawnSync("/bin/sh", ["-n", "-c", script]).status, 0);

  const probe = claudeCodeCommand({ ...task, secretFileProbe: true }, auth)
    .argv[2]!;
  for (const part of [
    "agent-bootstrap-bwrap-ok",
    "agent-observer",
    "agent-crash-status",
  ]) {
    assert.ok(!script.includes(part), part);
    assert.ok(probe.includes(part), part);
  }
  assert.ok(
    claudeCodeCommand(
      { ...task, model: "m".repeat(81), secretFileProbe: true },
      { ...auth, variable: "V".repeat(58) + "_TOKEN" },
    ).argv[2]!.length <= 8192,
  );
  assert.ok(probe.length <= 8192);
  assert.equal(spawnSync("/bin/sh", ["-n", "-c", probe]).status, 0);
  const launch = /\/bin\/sh -ec '([\s\S]+)' tool-secret/.exec(probe)?.[1];
  assert.ok(launch);
  assert.equal(spawnSync("/bin/sh", ["-n", "-c", launch]).status, 0);

  const install = { binary: "/fixture/claude", packageDir: "/fixture/apks" };
  const names = claudeCodeTools(install, "alpine", auth).map(
    ({ hostPath }) => hostPath,
  );
  for (const name of [
    "bubblewrap-0.12.0-r0.apk",
    "libcap2-2.78-r0.apk",
    "socat-1.8.1.3-r0.apk",
  ])
    assert.ok(names.includes("/fixture/apks/" + name), name);
  assert.equal(claudeCodeTools(install).length, 5);
  assert.throws(() => claudeCodeCommand(task, auth, "debian"));
  assert.throws(() =>
    claudeCodeCommand(task, { ...auth, variable: "LD_UNSAFE_SECRET" }),
  );
  assert.throws(() => claudeCodeProvider(auth));
});

test("secret-file managed settings require the Bash sandbox and constrain file tools", () => {
  const settings = managedClaudeSettings("Executor", true, [], auth.mode);
  assert.deepEqual(settings.sandbox, {
    enabled: true,
    failIfUnavailable: true,
    allowUnsandboxedCommands: false,
    network: { allowManagedDomainsOnly: true, allowedDomains: [] },
    filesystem: {
      denyRead: [
        "/run/secrets",
        "/etc/claude-code",
        SECRET_TOOL_DIRS.home,
        SECRET_TOOL_DIRS.config,
      ],
      allowWrite: [SECRET_TOOL_DIRS.tmp],
      denyWrite: ["/workspace/.git/config", "/workspace/.git/hooks"],
    },
  });
  assert.equal(settings.disableAllHooks, true);
  assert.equal(settings.allowManagedPermissionRulesOnly, true);
  assert.ok(settings.permissions.allow.includes("Bash"));
  for (const deny of [
    "WebFetch",
    "WebSearch",
    "Agent",
    "Skill",
    "Read(//proc/**)",
    "Glob(//home/agent/run/config/**)",
    "Write(//workspace/.git/config)",
    "Edit(//workspace/.git/hooks/**)",
  ])
    assert.ok(settings.permissions.deny.includes(deny), deny);
  assert.ok(
    !managedClaudeSettings(
      "Reviewer",
      false,
      [],
      auth.mode,
    ).permissions.allow.includes("Bash"),
  );
  assert.ok(!Object.hasOwn(managedClaudeSettings("Executor", true), "sandbox"));
});

test("secret-file sender awaits delivery audit and reserves the armed channel", async () => {
  const value = Buffer.from("fixture-value-once");
  const sender = createSecretFileSender(value);
  const order: string[] = [];
  const gate = Promise.withResolvers<void>();
  const sent: Buffer[] = [];
  const write = async (bytes: Buffer) => {
    order.push("write");
    sent.push(Buffer.from(bytes));
    return "acknowledged" as const;
  };
  try {
    assert.equal(await sender.send(write), false);
    sender.authorize({
      async beforeSend() {
        order.push("audit-start");
        await gate.promise;
        order.push("audit-committed");
      },
      async afterSend(result) {
        order.push(result);
      },
    });
    const first = sender.send(write);
    assert.equal(await sender.send(write), false);
    assert.deepEqual(order, ["audit-start"]);
    gate.resolve();
    assert.equal(await first, true);
    assert.equal(await sender.send(write), false);
    assert.deepEqual(order, [
      "audit-start",
      "audit-committed",
      "write",
      "acknowledged",
    ]);
    assert.deepEqual(sent, [value]);
    assert.ok(!JSON.stringify(sender).includes(value.toString()));
  } finally {
    sender.close();
  }
});

test("secret-file sender refuses after audit failure and records unknown on write failure", async () => {
  const failed = createSecretFileSender(Buffer.from("fixture"));
  const incomplete = createSecretFileSender(Buffer.from("fixture"));
  try {
    failed.authorize({
      async beforeSend() {
        throw new Error("Audit unavailable");
      },
      async afterSend() {
        assert.fail("Unexpected delivery outcome");
      },
    });
    await assert.rejects(
      failed.send(async () => {
        assert.fail("Unexpected write");
      }),
      /Audit unavailable/,
    );
    assert.equal(
      await failed.send(async () => {
        assert.fail("Unexpected retry");
      }),
      false,
    );
    const reports: string[] = [];
    incomplete.authorize({
      async beforeSend() {},
      async afterSend(outcome) {
        reports.push(outcome);
      },
    });
    await assert.rejects(
      incomplete.send(async () => {
        throw new Error("Interrupted");
      }),
      /Interrupted/,
    );
    assert.deepEqual(reports, ["unknown"]);
  } finally {
    failed.close();
    incomplete.close();
  }
});

test("secret-file Unix channel refuses pre-arm connections and requires peer acknowledgment", async () => {
  const dir = await mkdtemp("/tmp/secret-socket-");
  try {
    for (const acknowledge of [true, false]) {
      const value = Buffer.from("socket-fixture");
      const channel = await openSecretFileDelivery(dir, auth.variable, value);
      const outcome = Promise.withResolvers<string>();
      const read = (ack: boolean) =>
        new Promise<Buffer>((resolve, reject) => {
          const chunks: Buffer[] = [];
          const socket = createConnection({
            path: channel.hostPath,
            allowHalfOpen: true,
          });
          // Length-prefixed frame: 8 ASCII digits, then the value. The
          // client acknowledges with "A" only after the whole frame.
          let answered = false;
          socket.on("data", (chunk: Buffer) => {
            chunks.push(chunk);
            const data = Buffer.concat(chunks);
            if (answered || data.length < 8) return;
            const length = Number(data.subarray(0, 8).toString());
            if (data.length < 8 + length) return;
            answered = true;
            if (ack) socket.end("A");
            else socket.end();
          });
          socket.on("end", () => {
            if (!answered) socket.end();
          });
          socket.on("close", () => {
            const data = Buffer.concat(chunks);
            resolve(data.length >= 8 ? data.subarray(8) : data);
          });
          socket.on("error", reject);
        });
      try {
        assert.equal((await read(false)).length, 0);
        let committed = false;
        channel.authorize({
          async beforeSend() {
            committed = true;
          },
          async afterSend(result) {
            assert.ok(committed);
            outcome.resolve(result);
          },
        });
        assert.deepEqual(await read(acknowledge), value);
        assert.equal(
          await outcome.promise,
          acknowledge ? "acknowledged" : "unknown",
        );
        await channel.close();
        assert.equal(channel.acknowledged, acknowledge);
      } finally {
        channel.clearScreen();
        await channel.close();
      }
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("secret scanner catches every overlapping window at every alignment", () => {
  const value = Buffer.from(
    "あいうえお-0123456789-middle-fixture-abcdefghijklmnopqrst",
  );
  const screen = createSecretScreen(value);
  try {
    for (let offset = 0; offset <= value.length - 16; offset++)
      for (let padding = 0; padding < 15; padding++)
        assert.ok(
          screen.matches(
            Buffer.concat([
              Buffer.alloc(padding, 42),
              value.subarray(offset, offset + 16),
              Buffer.from("!"),
            ]),
          ),
          `offset=${offset}, padding=${padding}`,
        );
    assert.ok(!screen.matches(value.subarray(0, 15)));
    assert.ok(!screen.matches("unrelated output"));
  } finally {
    screen.close();
  }
  assert.ok(!screen.matches(value));
  const short = createSecretScreen(Buffer.from("fixture"));
  assert.ok(short.matches("a fixture response"));
  assert.ok(!short.matches("fixtur"));
  short.close();
});

test("secret workspace rejects absolute and escaping repository symlinks", async () => {
  const dir = await mkdtemp(join(tmpdir(), "secret-tree-"));
  try {
    const workspace = join(dir, "work");
    const archive = join(dir, "tree.tar");
    await mkdir(join(workspace, "sub"), { recursive: true });
    await writeFile(join(workspace, "file"), "fixture");
    await symlink("../file", join(workspace, "sub", "safe"));
    const tar = async (path = ".") => {
      const process = spawnSync(
        "/usr/bin/tar",
        ["-cf", archive, "-C", workspace, path],
        {
          env: { PATH: "/usr/bin:/bin", COPYFILE_DISABLE: "1" },
        },
      );
      assert.equal(process.status, 0);
      return readFile(archive);
    };
    checkSecretWorkspace(await tar(), 64 * 1024);
    checkSecretWorkspace(await tar("sub/safe"), 64 * 1024);
    for (const target of ["/outside-fixture", "../../outside-fixture"]) {
      const unsafe = join(workspace, "sub", "unsafe");
      await symlink(target, unsafe);
      const data = await tar();
      assert.throws(
        () => checkSecretWorkspace(data, 64 * 1024),
        /Unsafe secret-run workspace entry|absolute workspace entry name/,
      );
      await rm(unsafe);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("secret-file audit evidence accepts the variable name as delivery metadata", async () => {
  const dir = await mkdtemp(join(tmpdir(), "secret-audit-"));
  const audit = new SqliteAudit(join(dir, "audit.sqlite"));
  try {
    const invocationId = randomUUID();
    const event = {
      invocationId,
      role: "Worker",
      kind: "operation.requested",
      operation: "sandbox.exec",
    } as const;
    assert.throws(() =>
      audit.append({
        ...event,
        detail: { event: "secret.served", variable: "fixture-value-once" },
      }),
    );
    audit.append({
      ...event,
      detail: { event: "secret.served", variable: auth.variable },
    });
    assert.deepEqual(audit.readExecution(invocationId).auditEvents[0]?.detail, {
      event: "secret.served",
      variable: auth.variable,
    });
  } finally {
    audit.close();
    await rm(dir, { recursive: true, force: true });
  }
});
