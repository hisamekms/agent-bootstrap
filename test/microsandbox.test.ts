import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { symlink } from "node:fs/promises";
import test, { type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import {
  MICROSANDBOX_LIMITS,
  type MicrosandboxConfig,
  MicrosandboxRuntime,
} from "../src/microsandbox.ts";
import { RoutingSandboxRuntime } from "../src/routing-runtime.ts";
import { ProfileCatalog } from "../src/sandbox-profiles.ts";
import {
  SandboxRuntimeError,
  type SandboxSpec,
  type TerminalCommand,
} from "../src/sandbox-runtime.ts";

const image = `fixture.invalid/alpine@sha256:${"a".repeat(64)}`;
const profiles = new ProfileCatalog({ base: { image } });
const diagnostic = "synthetic-backend-diagnostic-do-not-propagate";
const gatewayPassword = "synthetic-gateway-password";
const gateway = {
  socksPort: 18190,
  dnsPort: 18153,
  username: "fixture-sandbox",
  passwordEnv: "GATEWAY_FIXTURE_SECRET",
};

async function createBound(runtime: MicrosandboxRuntime, spec: SandboxSpec) {
  return runtime.createBound(
    { ...spec, expectedNetRuleDigest: runtime.netRuleDigest(spec) },
    `bootstrap-${randomUUID()}`,
  );
}

type Event = {
  args: string[];
  envKeys: string[];
  env: { PATH: string; MSB_HOME: string; MSB_BACKEND: string };
  workspace?: string;
  stagedPaths?: string[];
  stagedBytes?: number;
  copyFiles?: string[];
  gatewayPasswordMatches?: boolean;
};

// This executable simulates only CLI responses and copied fixture directories.
// It never starts a VM or executes caller-provided commands on the host. These
// tests establish adapter behavior, not real guest isolation or network denial.
async function fixture(t: TestContext) {
  const fixtures = new URL("../.local/", import.meta.url);
  await mkdir(fixtures, { recursive: true });
  const root = await mkdtemp(join(fixtures.pathname, "runtime-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, "home");
  const stagingRoot = join(root, "staging");
  const guests = join(root, "fake-guests");
  const log = join(root, "events.jsonl");
  const mode = join(root, "mode");
  const binary = join(root, "fake-msb.mjs");
  await Promise.all([mkdir(home), mkdir(guests), writeFile(mode, "normal")]);
  await writeFile(
    binary,
    `#!${process.execPath}
import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from "node:net";
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { truncateSync } from 'node:fs';
const require_truncate = (p) => truncateSync(p, 512 * 1024 * 1024 + 1);
const guests = ${JSON.stringify(guests)};
const mode = readFileSync(${JSON.stringify(mode)}, 'utf8');
const args = process.argv.slice(2);
const event = { args, envKeys: Object.keys(process.env).sort(), env: Object.fromEntries(['PATH', 'HOME', 'MSB_HOME', 'MSB_BACKEND'].map(k => [k, process.env[k]])) };
const log = () => appendFileSync(${JSON.stringify(log)}, JSON.stringify(event) + '\\n');
const fail = () => { process.stderr.write(${JSON.stringify(diagnostic)}); process.exit(2); };
if (args[0] === '--version') {
  log(); console.log(mode === 'wrong-version' ? 'msb 0.0.0' : 'msb 0.7.16');
} else if (args[0] === 'image') {
  log();
  const ref = args[args.length - 1];
  const digest = 'sha256:' + ref.slice(-64);
  if (mode === 'inspect-fail') fail();
  else if (mode === 'inspect-mismatch') console.log(JSON.stringify({ digest: 'sha256:' + 'b'.repeat(64) }));
  else if (mode === 'inspect-malformed') console.log('{not json');
  else if (mode === 'inspect-missing') console.log(JSON.stringify({ architecture: 'arm64' }));
  else if (mode === 'inspect-array') console.log(JSON.stringify([{ digest }]));
  else if (mode === 'inspect-null') console.log('null');
  else console.log(JSON.stringify({ digest, architecture: 'arm64', layers: [] }));
} else if (args[0] === 'list') {
  log();
  if (args[1] !== '--format' || args[2] !== 'json') fail();
  if (mode === 'list-malformed') console.log('{"name":"unknown"}');
  else console.log(JSON.stringify(readdirSync(guests, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(({ name }) => ({ name }))));
} else if (args[0] === 'create') {
  const passwordIndex = args.indexOf('--socks5-password-env');
  if (passwordIndex !== -1) {
    const password = process.env[args[passwordIndex + 1]];
    event.gatewayPasswordMatches = password === ${JSON.stringify(gatewayPassword)};
  }
  const name = args[args.indexOf('--name') + 1];
  const copy = args[args.indexOf('--copy-dir') + 1];
  const [source, destination] = copy.split(':');
  if (destination !== '/workspace') fail();
  event.workspace = source;
  const walk = (dir, prefix = '') => readdirSync(dir).flatMap(name => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path, prefix + name + '/') : [{ path: prefix + name, bytes: statSync(path).size }];
  });
  const files = walk(source);
  event.stagedPaths = files.map(f => f.path).sort();
  event.stagedBytes = files.reduce((n, f) => n + f.bytes, 0);
  event.copyFiles = args.flatMap((a, i) => args[i - 1] === '--copy-file' ? [a] : []);
  log();
  if (mode === 'late-name-collision') mkdirSync(join(guests, name));
  if (existsSync(join(guests, name))) fail();
  for (const c of event.copyFiles) if (c.endsWith(':/tmp/agent-bootstrap-tree.tar')) cpSync(c.split(':')[0], join(guests, name + '.tree'));
  cpSync(source, join(guests, name), { recursive: true });
  const cleanupLabel = args.find((a, i) => args[i - 1] === '--label' && a.startsWith('agent-bootstrap-create='));
  if (cleanupLabel) writeFileSync(join(guests, name, '.fixture-cleanup-label'), cleanupLabel);
  if (mode === 'gateway-create-failure') {
    process.stderr.write(process.env[args[passwordIndex + 1]] ?? '');
    process.exit(2);
  }
  if (mode === 'partial-create-failure' || mode === 'create-and-cleanup-failure') fail();
} else if (args[0] === 'exec') {
  log();
  const separator = args.indexOf('--');
  const name = args[separator - 1];
  const command = args.slice(separator + 1);
  const workspace = join(guests, name);
  if (!existsSync(workspace)) fail();
  if (args[1] === '-t') {
    if (mode === 'terminal-sleep') await new Promise(resolve => setTimeout(resolve, 30000));
    else process.exitCode = mode === 'terminal-fail' ? 7 : 0;
  }
  else if (command[0] === 'fixture-write') writeFileSync(join(workspace, command[1]), command[2]);
  else if (command[0] === 'fixture-cat') process.stdout.write(readFileSync(join(workspace, command[1])));
  else if (command[0] === 'fixture-fail') { process.stderr.write('synthetic guest failure'); process.exitCode = 7; }
  else if (command[0] === 'fixture-sleep') await new Promise(resolve => setTimeout(resolve, 30000));
  else if (command[0] === 'fixture-echo') { for await (const line of createInterface({ input: process.stdin })) process.stdout.write('echo:' + line + '\\n'); }
  else if (command[0] === 'fixture-long-line') process.stdout.write(Buffer.alloc(2 * 1024 * 1024, 120));
  else if (command[0] === 'fixture-output-limit') process.stdout.write(Buffer.alloc(2 * 1024 * 1024, 120));
  else if (command[0] === '/bin/sh' && String(command[2]).includes('tar -xf')) {
    if (mode === 'extract-fail') { process.exitCode = 1; }
    else cpSync(join(guests, name + '.tree'), join(workspace, 'extracted.tar'));
  }
  else if (command[0] === '/bin/sh' && String(command[2]).includes('tar -cf')) { if (mode === 'pack-fail') process.exitCode = 1; }
  else if (command[0] === '/bin/sh' && String(command[2]).includes('p=/tmp/agent-bootstrap/commit-message;')) {
    const limit = Number(command[2].match(/head -c ([0-9]+)/)?.[1]);
    if (!limit) fail();
    // The swap yields zeros after the checks, like a link to a character device.
    const contents = {
      'message': Buffer.from('Improve greeting\\n'),
      'max-message': Buffer.alloc(4096, 'a'),
      'big-message': Buffer.alloc(4097, 'a'),
      'message-swapped': Buffer.alloc(limit),
    }[mode];
    if (contents) console.log(contents.subarray(0, limit).toString('base64').match(/.{1,76}/g).join('\\n'));
    else process.exitCode = 3; // Missing path, directory or symlink at check time.
  }
  else if (command[0] === '/bin/sh' && command[3] === 'collect') {
    const bytes = readFileSync(join(workspace, command[4]));
    console.log(String(mode === 'oversized-collection' ? 999999999 : bytes.length));
    console.log(bytes.toString('base64'));
  } else fail();
} else if (args[0] === 'volume') {
  log();
  if (mode === 'volume-fail') fail();
  if (mode === 'volume-exists') {
    process.stderr.write('volume already exists');
    process.exitCode = 1;
  }
} else if (args[0] === 'copy') {
  log();
  const [name, guestPath] = args[1].split(':');
  if (!existsSync(join(guests, name))) fail();
  if (guestPath !== '/tmp/agent-bootstrap-collect.tar') fail();
  else if (mode === 'big-tree') { writeFileSync(args[2], ''); require_truncate(args[2]); }
  else writeFileSync(args[2], 'TREE-BYTES');
} else if (args[0] === 'stop') {
  log(); if (mode === 'create-and-cleanup-failure') fail();
} else if (args[0] === 'metrics') {
  log();
  if (!existsSync(join(guests, args[1])) || mode === 'metrics-failure') fail();
  if (mode === 'metrics-malformed') console.log('{bad json');
  else if (mode === 'metrics-oversized') process.stdout.write(' '.repeat(20 * 1024));
  else console.log(JSON.stringify({ vcpu_time_ns: 123, memory_bytes: 456, net_rx_bytes: null }));
} else if (args[0] === 'rm') {
  log(); if (args[1] !== '--force' || mode === 'create-and-cleanup-failure') fail();
  const names = args[2] === '--label'
    ? readdirSync(guests, { withFileTypes: true }).filter(entry => {
        if (!entry.isDirectory()) return false;
        const marker = join(guests, entry.name, '.fixture-cleanup-label');
        return existsSync(marker) && readFileSync(marker, 'utf8') === args[3];
      }).map(entry => entry.name)
    : [args[2]];
  for (const name of names) {
    rmSync(join(guests, name), { recursive: true, force: true });
    rmSync(join(guests, name + '.tree'), { force: true });
  }
} else { log(); fail(); }
`,
    { mode: 0o700 },
  );
  const config = {
    binary,
    home,
    stagingRoot,
    profiles,
  };
  const runtime = new MicrosandboxRuntime(config);
  return {
    config,
    runtime,
    withCredentials: (
      token: string,
      resolvePassword?: MicrosandboxConfig["gatewayPassword"],
    ) =>
      new MicrosandboxRuntime({
        ...config,
        gatewayHosts: ["api.openai.com"],
        ...(resolvePassword ? { gatewayPassword: resolvePassword } : {}),
        providers: [
          { host: "api.openai.com", secretEnv: "AGENT_BOOTSTRAP_TOKEN" },
        ],
        credentials: {
          async withAccessToken(consume) {
            if (token === "throw")
              throw new Error("fixture-credential-failure");
            return consume(token);
          },
        },
      }),
    home,
    stagingRoot,
    guests,
    setMode: (value: string) => writeFile(mode, value),
    async events(): Promise<Event[]> {
      const text = await readFile(log, "utf8").catch(() => "");
      return text.trim()
        ? text
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line) as Event)
        : [];
    },
  };
}

async function assertCleanup(
  f: Awaited<ReturnType<typeof fixture>>,
  count = 1,
) {
  const events = await f.events();
  assert.equal(events.filter(({ args }) => args[0] === "stop").length, 0);
  assert.equal(events.filter(({ args }) => args[0] === "rm").length, count);
  for (const { args } of events.filter(({ args }) => args[0] === "rm"))
    assert.equal(args[1], "--force");
  assert.deepEqual(await readdir(f.stagingRoot), []);
  assert.deepEqual(await readdir(f.guests), []);
}

const bytes = (text: string) => new TextEncoder().encode(text);
const text = (value: Uint8Array) => new TextDecoder().decode(value);

test("fake lifecycle uses a clean local backend, pinned cached image, copied workspace and bounded collection", async (t) => {
  const f = await fixture(t);
  const source = Buffer.from("original");
  const creating = f.runtime.create({
    files: [{ path: "input.txt", bytes: source }],
  });
  source.fill(0);
  const handle = await creating;
  const read = await f.runtime.exec(handle, {
    argv: ["fixture-cat", "input.txt"],
    timeoutMs: 1000,
  });
  assert.equal(read.status, "exited");
  assert.equal(read.exitCode, 0);
  assert.equal(text(read.stdout), "original");
  await f.runtime.exec(handle, {
    argv: ["fixture-write", "result.txt", "result"],
    timeoutMs: 1000,
  });
  const artifacts = await f.runtime.collect(handle, { paths: ["result.txt"] });
  assert.deepEqual(
    artifacts.files.map((file) => ({
      path: file.path,
      text: text(file.bytes),
    })),
    [{ path: "result.txt", text: "result" }],
  );
  const events = await f.events();
  for (const event of events) {
    assert.deepEqual(event.envKeys, ["MSB_BACKEND", "MSB_HOME", "PATH"]);
    assert.deepEqual(event.env, {
      PATH: "/usr/bin:/bin",
      MSB_HOME: f.home,
      MSB_BACKEND: "local",
    });
    assert.equal(
      event.args.some(
        (arg) =>
          arg.startsWith("--mount") ||
          arg.startsWith("--secret") ||
          arg === "--net-rule",
      ),
      false,
    );
  }
  const create = events.find(({ args }) => args[0] === "create");
  assert.ok(create);
  assert.equal(create.args[create.args.indexOf("--pull") + 1], "never");
  assert.ok(create.args.includes("--no-net"));
  assert.equal(create.args.at(-1), image);
  assert.ok(create.args.includes("--max-duration"));
  assert.deepEqual(create.stagedPaths, ["input.txt"]);
  assert.equal(create.stagedBytes, 8);
  assert.ok(create.workspace?.startsWith(f.stagingRoot + "/"));
  for (const { args } of events.filter(({ args }) => args[0] === "exec")) {
    assert.equal(args[args.indexOf("--workdir") + 1], "/workspace");
    assert.ok(args.includes("--no-stdin"));
    assert.ok(args.includes("--no-tty"));
  }
  await Promise.all([f.runtime.destroy(handle), f.runtime.destroy(handle)]);
  await f.runtime.destroy(handle);
  await assertCleanup(f);
});

test("invalid paths and workspace bounds reject before backend invocation", async (t) => {
  const f = await fixture(t);
  for (const path of [
    "../escape",
    "/absolute",
    "nested/../escape",
    "nested\\escape",
    "file:alias",
    ".",
    "a//b",
  ]) {
    await assert.rejects(
      f.runtime.create({ files: [{ path, bytes: bytes("data") }] }),
      /invalid-input/,
    );
  }
  await assert.rejects(
    f.runtime.create({
      files: [
        {
          path: "big",
          bytes: new Uint8Array(MICROSANDBOX_LIMITS.fileBytes + 1),
        },
      ],
    }),
    /invalid-input/,
  );
  await assert.rejects(
    f.runtime.create({
      files: Array.from({ length: 5 }, (_, index) => ({
        path: `part-${index}`,
        bytes: new Uint8Array(MICROSANDBOX_LIMITS.fileBytes),
      })),
    }),
    /invalid-input/,
  );
  await assert.rejects(
    f.runtime.create({
      files: Array.from(
        { length: MICROSANDBOX_LIMITS.files + 1 },
        (_, index) => ({ path: `file-${index}`, bytes: bytes("") }),
      ),
    }),
    /invalid-input/,
  );
  assert.deepEqual(await f.events(), []);
});

test("adapter rejects mutable images and incompatible backend versions", async (t) => {
  const f = await fixture(t);
  const config = {
    binary: "/fixture/msb",
    home: f.home,
    stagingRoot: f.stagingRoot,
    profiles,
  };
  assert.throws(
    () =>
      new MicrosandboxRuntime({
        ...config,
        profiles: { base: { image } } as unknown as ProfileCatalog,
      }),
    /invalid-input/,
  );
  assert.throws(
    () => new MicrosandboxRuntime({ ...config, binary: "msb" }),
    /invalid-input/,
  );
  await f.setMode("wrong-version");
  await assert.rejects(f.runtime.create({}), /unsupported-version/);
  assert.deepEqual(
    (await f.events()).map(({ args }) => args),
    [["--version"]],
  );
});

test("partial create failure cleans backend and staging without exposing diagnostics", async (t) => {
  const f = await fixture(t);
  await f.setMode("partial-create-failure");
  await assert.rejects(f.runtime.create({}), (error) => {
    assert.ok(error instanceof SandboxRuntimeError);
    assert.equal(error.cleanupFailed, false);
    assert.equal(error.message.includes(diagnostic), false);
    assert.equal(String(error.stack).includes(f.home), false);
    return true;
  });
  await assertCleanup(f);
});

test("cleanup failures remain explicit while backend diagnostics remain sanitized", async (t) => {
  const f = await fixture(t);
  await f.setMode("create-and-cleanup-failure");
  await assert.rejects(f.runtime.create({}), (error) => {
    assert.ok(error instanceof SandboxRuntimeError);
    assert.equal(error.cleanupFailed, true);
    assert.match(error.sandboxId ?? "", /^bootstrap-[0-9a-f-]+$/);
    assert.equal(JSON.stringify(error).includes(diagnostic), false);
    assert.equal(error.message.includes(diagnostic), false);
    return true;
  });
  assert.deepEqual(await readdir(f.stagingRoot), []);
});

test("destroy can retry forced removal after failure and rejects further exec", async (t) => {
  const f = await fixture(t);
  const handle = await f.runtime.create({});
  await f.setMode("create-and-cleanup-failure");
  await assert.rejects(f.runtime.destroy(handle), /cleanup-failed/);
  await assert.rejects(
    f.runtime.exec(handle, { argv: ["fixture-sleep"], timeoutMs: 1_000 }),
    /unknown-handle/,
  );
  await f.setMode("normal");
  await f.runtime.destroy(handle);
  await assertCleanup(f, 2);
});

test("nonzero guest command triggers cleanup and preserves guest exit status", async (t) => {
  const f = await fixture(t);
  const handle = await f.runtime.create({});
  const result = await f.runtime.exec(handle, {
    argv: ["fixture-fail"],
    timeoutMs: 1000,
  });
  assert.equal(result.status, "exited");
  assert.equal(result.exitCode, 7);
  assert.equal(text(result.stderr), "synthetic guest failure");
  await assertCleanup(f);
  await assert.rejects(
    f.runtime.exec(handle, {
      argv: ["fixture-cat", "missing"],
      timeoutMs: 1000,
    }),
    /unknown-handle/,
  );
});

test("command timeout terminates its subprocess and cleans the sandbox", async (t) => {
  const f = await fixture(t);
  const handle = await f.runtime.create({});
  const result = await f.runtime.exec(handle, {
    argv: ["fixture-sleep"],
    timeoutMs: 100,
  });
  assert.equal(result.status, "timed-out");
  assert.equal(result.exitCode, null);
  await assertCleanup(f);
});

test("active cancellation cleans the sandbox and concurrent operations fail closed while busy", async (t) => {
  const f = await fixture(t);
  const handle = await f.runtime.create({});
  const controller = new AbortController();
  const pending = f.runtime.exec(handle, {
    argv: ["fixture-sleep"],
    timeoutMs: 5000,
    signal: controller.signal,
  });
  await assert.rejects(f.runtime.collect(handle, { paths: [] }), /busy/);
  await assert.rejects(f.runtime.destroy(handle), /busy/);
  const deadline = Date.now() + 2000;
  while (!(await f.events()).some(({ args }) => args[0] === "exec")) {
    assert.ok(Date.now() < deadline, "Fixture command did not start");
    await delay(5);
  }
  controller.abort();
  const result = await pending;
  assert.equal(result.status, "cancelled");
  await assertCleanup(f);
});

test("output overflow fails safely and destroys the sandbox", async (t) => {
  const f = await fixture(t);
  const handle = await f.runtime.create({});
  await assert.rejects(
    f.runtime.exec(handle, { argv: ["fixture-output-limit"], timeoutMs: 1000 }),
    /output-limit/,
  );
  await assertCleanup(f);
});

test("collection rejects traversal before invocation and rejects oversized response with cleanup", async (t) => {
  const f = await fixture(t);
  const handle = await f.runtime.create({
    files: [{ path: "input.txt", bytes: bytes("data") }],
  });
  await assert.rejects(
    f.runtime.collect(handle, { paths: ["../outside"] }),
    /invalid-input/,
  );
  assert.equal(
    (await f.events()).filter(({ args }) => args[0] === "exec").length,
    0,
  );
  await f.setMode("oversized-collection");
  await assert.rejects(
    f.runtime.collect(handle, { paths: ["input.txt"] }),
    /collection/,
  );
  await assertCleanup(f);
});

test("two concurrent fake sandboxes have distinct copies with no cross-worker writes", async (t) => {
  const f = await fixture(t);
  const [first, second] = await Promise.all([
    f.runtime.create({ files: [{ path: "input.txt", bytes: bytes("one") }] }),
    f.runtime.create({ files: [{ path: "input.txt", bytes: bytes("two") }] }),
  ]);
  assert.notEqual(first.id, second.id);
  await f.runtime.exec(first, {
    argv: ["fixture-write", "input.txt", "changed"],
    timeoutMs: 1000,
  });
  const results = await Promise.all(
    [first, second].map((handle) =>
      f.runtime.exec(handle, {
        argv: ["fixture-cat", "input.txt"],
        timeoutMs: 1000,
      }),
    ),
  );
  assert.deepEqual(
    results.map((result) => text(result.stdout)),
    ["changed", "two"],
  );
  const copies = (await f.events())
    .filter(({ args }) => args[0] === "create")
    .map((event) => event.workspace);
  assert.equal(new Set(copies).size, 2);
  await Promise.all([f.runtime.destroy(first), f.runtime.destroy(second)]);
  await assertCleanup(f, 2);
});

test("tools reach the offline backend after a host digest check, and direct ports are refused", async (t) => {
  const f = await fixture(t);
  const tool = join(f.home, "..", "tool.bin");
  await writeFile(tool, "fixture tool");
  const { createHash } = await import("node:crypto");
  const sha256 = createHash("sha256").update("fixture tool").digest("hex");
  const handle = await f.runtime.create({
    tools: [{ hostPath: tool, guestPath: "/tmp/tool", sha256 }],
  });
  const create = (await f.events()).find(({ args }) => args[0] === "create");
  assert.ok(create);
  const args = create.args.join(" ");
  assert.match(args, /--no-net /);
  assert.ok(!create.args.includes("--net-rule"));
  // The backend copies the verified staging copy, not the caller's path.
  const copy = create.args[create.args.indexOf("--copy-file") + 1] ?? "";
  assert.ok(copy.startsWith(f.stagingRoot) && copy.endsWith(":/tmp/tool"));
  assert.ok(!create.args.includes(`${tool}:/tmp/tool`));
  await f.runtime.destroy(handle);
  const before = (await f.events()).length;
  await assert.rejects(
    f.runtime.create({
      tools: [
        { hostPath: tool, guestPath: "/tmp/tool", sha256: "0".repeat(64) },
      ],
    }),
    (error: SandboxRuntimeError) => error.code === "tool-digest",
  );
  const { symlink } = await import("node:fs/promises");
  const link = join(f.home, "..", "tool.link");
  await symlink(tool, link);
  await assert.rejects(
    f.runtime.create({
      tools: [{ hostPath: link, guestPath: "/tmp/tool", sha256 }],
    }),
    (error: SandboxRuntimeError) => error.code === "tool-digest",
  );
  for (const tools of [
    [{ hostPath: tool, guestPath: "/etc/tool", sha256 }],
    [{ hostPath: "relative", guestPath: "/tmp/tool", sha256 }],
    [{ hostPath: `${tool}:x`, guestPath: "/tmp/tool", sha256 }],
    [
      { hostPath: tool, guestPath: "/tmp/tool", sha256 },
      { hostPath: tool, guestPath: "/tmp/tool", sha256 },
    ],
  ])
    await assert.rejects(
      f.runtime.create({ tools }),
      (error: SandboxRuntimeError) => error.code === "invalid-input",
    );
  await assert.rejects(
    f.runtime.create({ hostTcpPort: 4242 }),
    (error: SandboxRuntimeError) => error.code === "invalid-input",
  );
  // Only the version probe for the digest mismatch reached the backend.
  assert.equal(
    (await f.events()).slice(before).filter(({ args }) => args[0] === "create")
      .length,
    0,
  );
});

test("a session streams bounded lines, holds the handle busy and stops on close", async (t) => {
  const f = await fixture(t);
  const handle = await f.runtime.create({});
  const session = await f.runtime.openSession(handle, {
    argv: ["fixture-echo"],
    timeoutMs: 5000,
  });
  await assert.rejects(
    f.runtime.exec(handle, { argv: ["fixture-cat", "x"], timeoutMs: 1000 }),
    (error: SandboxRuntimeError) => error.code === "busy",
  );
  session.send("one");
  session.send("two");
  const seen: string[] = [];
  for await (const line of session.lines) {
    seen.push(line);
    if (seen.length === 2) session.close();
  }
  assert.deepEqual(seen, ["echo:one", "echo:two"]);
  assert.equal(await session.finished, "cancelled");
  const streamed = (await f.events()).find(
    ({ args }) => args[0] === "exec" && args.includes("--stream"),
  );
  assert.ok(streamed);
  await f.runtime.destroy(handle);
  await assertCleanup(f);

  const long = await f.runtime.create({});
  const flood = await f.runtime.openSession(long, {
    argv: ["fixture-long-line"],
    timeoutMs: 5000,
  });
  await assert.rejects(
    (async () => {
      for await (const _line of flood.lines);
    })(),
    /limit/,
  );
  flood.close();
  await flood.finished;
  await f.runtime.destroy(long);
});

test("provider egress passes the credential only to the create process", async (t) => {
  const f = await fixture(t);
  const token = "fixture-provider-token-value";
  const runtime = f.withCredentials(token, () => gatewayPassword);
  const env = "AGENT_BOOTSTRAP_TOKEN";
  const provider = { host: "api.openai.com", secretEnv: env };
  for (const spec of [{ provider }, { provider, egressGateway: gateway }])
    await assert.rejects(runtime.create(spec), /invalid-input/);
  assert.deepEqual(await f.events(), []);
  const handle = await createBound(runtime, {
    provider,
    egressGateway: gateway,
  });
  await runtime
    .exec(handle, { argv: ["fixture-cat", "missing"], timeoutMs: 1000 })
    .catch(() => {});
  const events = await f.events();
  const create = events.find(({ args }) => args[0] === "create");
  assert.ok(create);
  assert.match(
    create.args.join(" "),
    /--proxy socks5:\/\/127\.0\.0\.1:18190 .* --tls-intercept --secret AGENT_BOOTSTRAP_TOKEN:headers=authorization@api\.openai\.com --secret-violation-action block /,
  );
  assert.ok(create.envKeys.includes(env));
  for (const event of events.filter(({ args }) => args[0] !== "create"))
    assert.ok(!event.envKeys.includes(env));
  assert.doesNotMatch(JSON.stringify(events), /fixture-provider-token-value/);
  await runtime.destroy(handle).catch(() => {});
  // Without credentials and a host allowlist, provider egress is refused.
  await assert.rejects(
    f.runtime.create({ provider }),
    (error: SandboxRuntimeError) => error.code === "invalid-input",
  );
  // A failing credential provider stops create with a fixed diagnostic.
  await assert.rejects(
    createBound(
      f.withCredentials("throw", () => gatewayPassword),
      { provider, egressGateway: gateway },
    ),
    (error: Error) =>
      error instanceof SandboxRuntimeError &&
      !error.message.includes("fixture-credential-failure"),
  );
  for (const bad of [
    { host: "api.openai.com:443", secretEnv: env },
    { host: "localhost", secretEnv: env },
    { host: "metadata.internal", secretEnv: env },
    { host: "chatgpt.com", secretEnv: env },
    { host: "api.openai.com", secretEnv: "PATH" },
    { host: "api.openai.com", secretEnv: "HTTPS_PROXY" },
    { host: "api.openai.com", secretEnv: "AGENT_BOOTSTRAP_" },
    { host: "api.openai.com", secretEnv: "agent_bootstrap_token" },
  ])
    await assert.rejects(
      createBound(runtime, { provider: bad, egressGateway: gateway }),
      (error: SandboxRuntimeError) => error.code === "invalid-input",
    );
  await assert.rejects(
    runtime.create({ provider, hostTcpPort: 4242 }),
    (error: SandboxRuntimeError) => error.code === "invalid-input",
  );
  // A spec cannot rebind the configured credential to another header, port
  // or upstream CA for the same host.
  for (const rebind of [
    { ...provider, header: "x-api-key" as const },
    { ...provider, port: 8443 },
    { ...provider, upstreamCaCertPath: "/tmp/other-ca.pem" },
  ])
    await assert.rejects(
      createBound(runtime, { provider: rebind, egressGateway: gateway }),
      (error: SandboxRuntimeError) => error.code === "invalid-input",
    );
});

test("Anthropic-style provider egress uses x-api-key, a custom port and an upstream CA", async (t) => {
  const f = await fixture(t);
  const runtime = new MicrosandboxRuntime({
    binary: join(f.home, "..", "fake-msb.mjs"),
    home: f.home,
    stagingRoot: f.stagingRoot,
    profiles,
    gatewayPassword: () => gatewayPassword,
    providers: [
      {
        host: "host.microsandbox.internal",
        secretEnv: "ANTHROPIC_API_KEY",
        header: "x-api-key",
        port: 8443,
        upstreamCaCertPath: "/tmp/fixture-ca.pem",
      },
    ],
    credentials: {
      async withAccessToken(consume) {
        return consume("fixture-anthropic-key");
      },
    },
  });
  const handle = await createBound(runtime, {
    egressGateway: gateway,
    provider: {
      host: "host.microsandbox.internal",
      secretEnv: "ANTHROPIC_API_KEY",
      header: "x-api-key",
      port: 8443,
      upstreamCaCertPath: "/tmp/fixture-ca.pem",
    },
  });
  const create = (await f.events()).find(({ args }) => args[0] === "create");
  assert.ok(create);
  assert.match(
    create.args.join(" "),
    /--proxy socks5:\/\/127\.0\.0\.1:18190 .* --tls-intercept --tls-intercept-port 8443 --tls-upstream-ca-cert-for host\.microsandbox\.internal=\/tmp\/fixture-ca\.pem --secret ANTHROPIC_API_KEY:headers=x-api-key@host\.microsandbox\.internal --secret-violation-action block /,
  );
  assert.ok(create.envKeys.includes("ANTHROPIC_API_KEY"));
  assert.doesNotMatch(
    JSON.stringify(await f.events()),
    /fixture-anthropic-key/,
  );
  await runtime.destroy(handle);
  for (const provider of [
    { header: "cookie" },
    { port: 0 },
    { upstreamCaCertPath: "relative.pem" },
    { upstreamCaCertPath: "/tmp/a=b.pem" },
  ])
    await assert.rejects(
      createBound(runtime, {
        egressGateway: gateway,
        provider: {
          host: "host.microsandbox.internal",
          secretEnv: "ANTHROPIC_API_KEY",
          ...provider,
        } as never,
      }),
      (error: SandboxRuntimeError) => error.code === "invalid-input",
    );
});

test("gateway mode binds exact argv and passes passwords only to create, with and without a provider", async (t) => {
  const f = await fixture(t);
  const provider = {
    host: "api.openai.com",
    secretEnv: "AGENT_BOOTSTRAP_TOKEN",
  };
  const resolvePassword: NonNullable<MicrosandboxConfig["gatewayPassword"]> = (
    binding,
  ) => {
    assert.deepEqual(binding, gateway);
    return gatewayPassword;
  };
  const runtime = new RoutingSandboxRuntime([
    {
      runtime: new MicrosandboxRuntime({
        ...f.config,
        gatewayPassword: resolvePassword,
      }),
    },
    {
      provider,
      runtime: f.withCredentials("fixture-token", resolvePassword),
    },
  ]);
  for (const binding of [undefined, provider]) {
    const spec = {
      egressGateway: gateway,
      ...(binding ? { provider: binding } : {}),
    };
    const expectedNetworkArgs = [
      "--no-net",
      "--net-rule",
      "allow@dns,deny@host,deny@0.0.0.0/0:tcp:53,deny@[::/0]:tcp:53,deny@0.0.0.0/0:tcp:853,deny@[::/0]:tcp:853,allow@0.0.0.0/0:tcp,allow@[::/0]:tcp",
      "--dns-nameserver",
      "127.0.0.1:18153",
      "--proxy",
      "socks5://127.0.0.1:18190",
      "--socks5-username",
      "fixture-sandbox",
      "--socks5-password-env",
      "GATEWAY_FIXTURE_SECRET",
      ...(binding
        ? [
            "--tls-intercept",
            "--secret",
            "AGENT_BOOTSTRAP_TOKEN:headers=authorization@api.openai.com",
            "--secret-violation-action",
            "block",
          ]
        : []),
    ];
    const expectedDigest = createHash("sha256")
      .update(JSON.stringify(expectedNetworkArgs))
      .digest("hex");
    assert.equal(runtime.netRuleDigest(spec), expectedDigest);
    const sandboxId = `bootstrap-${randomUUID()}`;
    const handle = await runtime.createBound(
      { ...spec, expectedNetRuleDigest: expectedDigest },
      sandboxId,
    );
    assert.deepEqual(handle, { id: sandboxId, netRuleDigest: expectedDigest });
    const creates = (await f.events()).filter(
      ({ args }) => args[0] === "create",
    );
    const create = creates.at(-1)!;
    const cleanupLabel = create.args[create.args.indexOf("--label") + 1]!;
    assert.match(cleanupLabel, /^agent-bootstrap-create=[0-9a-f-]{36}$/);
    assert.deepEqual(create.args, [
      "create",
      "--name",
      sandboxId,
      "--label",
      cleanupLabel,
      "--pull",
      "never",
      ...expectedNetworkArgs,
      "--max-duration",
      "120s",
      "--copy-dir",
      `${create.workspace}:/workspace`,
      image,
    ]);
    assert.equal(create.gatewayPasswordMatches, true);
    assert.equal(create.envKeys.includes(provider.secretEnv), !!binding);
    assert.equal(create.envKeys.includes(gateway.passwordEnv), true);
    const sample = { vcpuTimeNs: 123, memoryBytes: 456 };
    assert.deepEqual(await runtime.sampleResources(handle), sample);
    await runtime.destroy(handle);
    assert.deepEqual((await f.events()).at(-1)?.args, [
      "rm",
      "--force",
      "--label",
      cleanupLabel,
    ]);
    assert.deepEqual(runtime.finalResourceSample(handle), sample);
    assert.equal(runtime.finalResourceSample(handle), null);
  }
  const events = await f.events();
  for (const { envKeys } of events.filter(({ args }) => args[0] !== "create")) {
    assert.equal(envKeys.includes(gateway.passwordEnv), false);
    assert.equal(envKeys.includes(provider.secretEnv), false);
  }
  assert.equal(JSON.stringify(events).includes(gatewayPassword), false);
});

test("bound create refuses invalid IDs and missing or mismatched digests before invoking the backend", async (t) => {
  const f = await fixture(t);
  const sandboxId = `bootstrap-${randomUUID()}`;
  const spec = { expectedNetRuleDigest: f.runtime.netRuleDigest({}) };
  for (const bad of ["", "--name", "../guest", randomUUID(), sandboxId + "\n"])
    await assert.rejects(f.runtime.createBound(spec, bad), /invalid-input/);
  await assert.rejects(f.runtime.createBound({}, sandboxId), /invalid-input/);
  await assert.rejects(
    f.runtime.createBound({ expectedNetRuleDigest: "0".repeat(64) }, sandboxId),
    /invalid-input/,
  );
  assert.deepEqual(await f.events(), []);
});

test("bound create refuses concurrent and existing names without removing the owner", async (t) => {
  const f = await fixture(t);
  const sandboxId = `bootstrap-${randomUUID()}`;
  const other = new MicrosandboxRuntime(f.config);
  const spec = { expectedNetRuleDigest: f.runtime.netRuleDigest({}) };
  const results = await Promise.allSettled([
    f.runtime.createBound(spec, sandboxId),
    other.createBound(spec, sandboxId),
  ]);
  const [winner] = results.flatMap((result, index) =>
    result.status === "fulfilled" ? [{ handle: result.value, index }] : [],
  );
  assert.ok(winner);
  const loser = results[1 - winner.index];
  assert.ok(loser?.status === "rejected");
  assert.match(String(loser.reason), /name-collision/);
  const [owner, contender] =
    winner.index === 0 ? [f.runtime, other] : [other, f.runtime];
  await assert.rejects(
    contender.createBound(spec, sandboxId),
    /name-collision/,
  );
  assert.deepEqual(await readdir(f.guests), [sandboxId]);
  const ops = (await f.events()).map(({ args }) => args[0]);
  assert.equal(ops.filter((op) => op === "create").length, 1);
  assert.equal(ops.includes("rm"), false);
  await owner.destroy(winner.handle);
  await assertCleanup(f);
  assert.deepEqual(await readdir(f.home), []);
});

test("failed bound create removes only its own partial sandbox", async (t) => {
  const f = await fixture(t);
  const sandboxId = `bootstrap-${randomUUID()}`;
  const spec = { expectedNetRuleDigest: f.runtime.netRuleDigest({}) };
  await f.setMode("partial-create-failure");
  await assert.rejects(
    f.runtime.createBound(spec, sandboxId),
    /backend-failure/,
  );
  await assertCleanup(f);

  await f.setMode("late-name-collision");
  await assert.rejects(
    f.runtime.createBound(spec, sandboxId),
    /backend-failure/,
  );
  assert.deepEqual(await readdir(f.guests), [sandboxId]);
  assert.deepEqual(await readdir(f.stagingRoot), []);
  assert.deepEqual(await readdir(f.home), []);
  const removals = (await f.events()).filter(({ args }) => args[0] === "rm");
  for (const { args } of removals)
    assert.deepEqual(args.slice(0, 3), ["rm", "--force", "--label"]);
  assert.notEqual(removals[0]?.args[3], removals[1]?.args[3]);
});

test("bound create fails closed if the backend cannot list sandbox names", async (t) => {
  const f = await fixture(t);
  await f.setMode("list-malformed");
  const spec = { expectedNetRuleDigest: f.runtime.netRuleDigest({}) };
  await assert.rejects(
    f.runtime.createBound(spec, `bootstrap-${randomUUID()}`),
    /backend-failure/,
  );
  assert.deepEqual(
    (await f.events()).map(({ args }) => args[0]),
    ["--version", "image", "list"],
  );
});

test("unsafe gateway bindings are refused before the backend", async (t) => {
  const f = await fixture(t);
  const provider = {
    host: "api.openai.com",
    secretEnv: "AGENT_BOOTSTRAP_TOKEN",
  };
  const runtime = f.withCredentials("fixture-token", () => gatewayPassword);
  for (const spec of [
    { egressGateway: gateway, hostTcpPort: 8080 },
    {
      egressGateway: { ...gateway, passwordEnv: provider.secretEnv },
      provider,
    },
    { egressGateway: { ...gateway, passwordEnv: "MSB_CONFIG_SECRET" } },
    { egressGateway: { ...gateway, passwordEnv: "PATH" } },
    { egressGateway: { ...gateway, socksPort: 0 } },
    { egressGateway: { ...gateway, dnsPort: 65536 } },
    { egressGateway: { ...gateway, dnsPort: gateway.socksPort } },
    { egressGateway: { ...gateway, username: "--no-net" } },
  ]) {
    assert.throws(() => runtime.netRuleDigest(spec), /invalid-input/);
    await assert.rejects(runtime.create(spec), /invalid-input/);
  }
  await assert.rejects(
    f.runtime.create({ egressGateway: gateway }),
    /invalid-input/,
  );
  await assert.rejects(
    runtime.create({
      egressGateway: { ...gateway, dnsPort: gateway.dnsPort + 1 },
      expectedNetRuleDigest: runtime.netRuleDigest({ egressGateway: gateway }),
    }),
    /invalid-input/,
  );
  assert.deepEqual(await f.events(), []);
});

test("gateway password and backend diagnostics stay out of errors", async (t) => {
  const f = await fixture(t);
  const spec = { egressGateway: gateway };
  const failure = (error: unknown) => {
    assert.ok(error instanceof SandboxRuntimeError);
    assert.equal(error.code, "backend-failure");
    assert.equal(error.stack?.includes(gatewayPassword), false);
    assert.equal(JSON.stringify(error).includes(gatewayPassword), false);
    return true;
  };
  const unavailable = new MicrosandboxRuntime({
    ...f.config,
    gatewayPassword() {
      throw new SandboxRuntimeError(gatewayPassword);
    },
  });
  await assert.rejects(createBound(unavailable, spec), failure);
  const invalidPassword = new MicrosandboxRuntime({
    ...f.config,
    gatewayPassword: () => "",
  });
  await assert.rejects(createBound(invalidPassword, spec), /invalid-input/);
  assert.equal(
    (await f.events()).some(({ args }) => args[0] === "create"),
    false,
  );

  const runtime = new MicrosandboxRuntime({
    ...f.config,
    gatewayPassword: () => gatewayPassword,
  });
  await f.setMode("gateway-create-failure");
  await assert.rejects(createBound(runtime, spec), failure);
  await assertCleanup(f);
});

test("destroy samples before removal and continues after CLI or parser failure", async (t) => {
  const f = await fixture(t);
  for (const mode of [
    "normal",
    "metrics-failure",
    "metrics-malformed",
    "metrics-oversized",
  ]) {
    const handle = await f.runtime.create({});
    await f.setMode(mode);
    assert.equal(f.runtime.finalResourceSample(handle), null);
    await Promise.all([f.runtime.destroy(handle), f.runtime.destroy(handle)]);
    assert.deepEqual(
      (await f.events()).slice(-2).map(({ args }) => args),
      [
        ["metrics", handle.id, "--format", "json"],
        ["rm", "--force", handle.id],
      ],
    );
    assert.deepEqual(
      f.runtime.finalResourceSample(handle),
      mode === "normal" ? { vcpuTimeNs: 123, memoryBytes: 456 } : null,
    );
    assert.equal(f.runtime.finalResourceSample(handle), null);
    assert.equal(await f.runtime.sampleResources(handle), null);
    await f.setMode("normal");
  }
  await assertCleanup(f, 4);
});

test("one runtime binds its single credential to at most one provider", () => {
  const provider = {
    host: "api.anthropic.com",
    secretEnv: "ANTHROPIC_API_KEY",
    header: "x-api-key" as const,
  };
  assert.throws(
    () =>
      new MicrosandboxRuntime({
        binary: "/fixture/msb",
        home: "/fixture/home",
        stagingRoot: "/fixture/staging",
        profiles,
        providers: [
          provider,
          { host: "api.openai.com", secretEnv: "AGENT_BOOTSTRAP_TOKEN" },
        ],
      }),
    (error: SandboxRuntimeError) => error.code === "invalid-input",
  );
});

test("profiles select the image and resources; unconfigured or malformed profiles fail before any backend call", async (t) => {
  const f = await fixture(t);
  const dbImage = `fixture.invalid/db@sha256:${"b".repeat(64)}`;
  const runtime = new MicrosandboxRuntime({
    binary: join(f.home, "..", "fake-msb.mjs"),
    home: f.home,
    stagingRoot: f.stagingRoot,
    profiles: new ProfileCatalog({
      base: { image },
      db: { image: dbImage, memoryMiB: 2048, cpus: 2 },
    }),
  });
  const base = await runtime.create({});
  await runtime.destroy(base);
  let create = (await f.events()).find(({ args }) => args[0] === "create")!;
  assert.equal(create.args.at(-1), image);
  assert.ok(!create.args.includes("--memory"));
  assert.ok(!create.args.includes("--cpus"));
  const db = await runtime.create({ profile: "db" });
  await runtime.destroy(db);
  create = (await f.events()).filter(({ args }) => args[0] === "create")[1]!;
  assert.equal(create.args.at(-1), dbImage);
  assert.equal(create.args[create.args.indexOf("--memory") + 1], "2048M");
  assert.equal(create.args[create.args.indexOf("--cpus") + 1], "2");
  assert.ok(create.args.indexOf("--cpus") < create.args.length - 1);
  const before = (await f.events()).length;
  for (const profile of ["browser", "nope", 1, null, {}]) {
    await assert.rejects(
      runtime.create({ profile } as never),
      (error: SandboxRuntimeError) => error.code === "invalid-input",
    );
  }
  // The digest the host audited must be the image this adapter boots.
  for (const imageDigest of ["c".repeat(64), "a".repeat(64), 1])
    await assert.rejects(
      runtime.create({ profile: "db", imageDigest } as never),
      (error: SandboxRuntimeError) => error.code === "invalid-input",
    );
  assert.equal((await f.events()).length, before);
  const matched = await runtime.create({
    profile: "db",
    imageDigest: "b".repeat(64),
  });
  await runtime.destroy(matched);
});

test("create inspects the image digest before create and rejects any mismatch", async (t) => {
  const f = await fixture(t);
  const handle = await f.runtime.create({});
  const events = await f.events();
  assert.deepEqual(
    events.map(({ args }) => args[0]),
    ["--version", "image", "create"],
  );
  assert.deepEqual(events[1]?.args, [
    "image",
    "inspect",
    "--format",
    "json",
    image,
  ]);
  await f.runtime.destroy(handle);
  // No caching: a second create inspects again.
  const again = await f.runtime.create({});
  await f.runtime.destroy(again);
  assert.equal(
    (await f.events()).filter(({ args }) => args[0] === "image").length,
    2,
  );
});

for (const mode of [
  "inspect-mismatch",
  "inspect-malformed",
  "inspect-missing",
  "inspect-array",
  "inspect-null",
  "inspect-fail",
]) {
  test(`create refuses before staging when ${mode}`, async (t) => {
    const f = await fixture(t);
    await f.setMode(mode);
    await assert.rejects(
      f.runtime.create({}),
      (error: unknown) =>
        error instanceof SandboxRuntimeError &&
        error.code ===
          (mode === "inspect-fail" ? "backend-failure" : "invalid-input") &&
        !String(error.message).includes(diagnostic),
    );
    const events = await f.events();
    assert.equal(events.filter(({ args }) => args[0] === "create").length, 0);
    assert.deepEqual(await readdir(f.stagingRoot).catch(() => []), []);
  });
}

async function repoFixture(f: Awaited<ReturnType<typeof fixture>>) {
  const base = join(f.stagingRoot, "..", "repo-input");
  await mkdir(join(base, "git", "objects"), { recursive: true });
  await writeFile(join(base, "git", "HEAD"), "ref: refs/heads/main\n");
  await writeFile(join(base, "git", "objects", "x"), "obj");
  await writeFile(join(base, "tree.tar"), "TARDATA");
  return { gitDir: join(base, "git"), tree: join(base, "tree.tar") };
}

test("repository staging copies .git and maps the tree tar, then extracts before returning", async (t) => {
  const f = await fixture(t);
  const repository = await repoFixture(f);
  const handle = await f.runtime.create({ repository });
  const events = await f.events();
  const create = events.find(({ args }) => args[0] === "create");
  assert.ok(create);
  assert.deepEqual(create.stagedPaths, [".git/HEAD", ".git/objects/x"]);
  assert.equal(create.copyFiles?.length, 1);
  assert.match(
    create.copyFiles![0]!,
    /\/tree\.tar:\/tmp\/agent-bootstrap-tree\.tar$/,
  );
  const last = events.at(-1)!;
  assert.equal(last.args[0], "exec");
  assert.ok(
    last.args
      .join(" ")
      .includes("tar -xf /tmp/agent-bootstrap-tree.tar -C /workspace"),
  );
  assert.ok(last.args.includes("--no-stdin"));
  assert.equal(last.args[last.args.indexOf("--workdir") + 1], "/workspace");
  await f.runtime.destroy(handle);
  await assertCleanup(f);
});

test("failed extraction destroys the sandbox and reports backend-failure", async (t) => {
  const f = await fixture(t);
  const repository = await repoFixture(f);
  await f.setMode("extract-fail");
  await assert.rejects(f.runtime.create({ repository }), /backend-failure/);
  await assertCleanup(f);
});

test("repository with files, symlinks, relative paths or missing parts is refused before the backend", async (t) => {
  const f = await fixture(t);
  const repository = await repoFixture(f);
  await assert.rejects(
    f.runtime.create({
      repository,
      files: [{ path: "a.txt", bytes: bytes("x") }],
    }),
    /invalid-input/,
  );
  await assert.rejects(
    f.runtime.create({ repository: { ...repository, tree: "tree.tar" } }),
    /invalid-input/,
  );
  await assert.rejects(
    f.runtime.create({
      repository: { ...repository, tree: repository.tree + ".missing" },
    }),
    /invalid-input/,
  );
  await symlink("/etc/passwd", join(repository.gitDir, "link"));
  await assert.rejects(f.runtime.create({ repository }), /invalid-input/);
  await rm(join(repository.gitDir, "link"));
  await symlink(repository.tree, repository.tree + ".lnk");
  await assert.rejects(
    f.runtime.create({
      repository: { ...repository, tree: repository.tree + ".lnk" },
    }),
    /invalid-input/,
  );
  assert.deepEqual(await f.events(), []);
});

test("tree collection tars in the guest, copies the tar out and returns its bytes", async (t) => {
  const f = await fixture(t);
  const handle = await f.runtime.create({
    files: [{ path: "a.txt", bytes: bytes("x") }],
  });
  const result = await f.runtime.collect(handle, { tree: true });
  assert.deepEqual(result.files, []);
  assert.equal(text(result.tree!), "TREE-BYTES");
  assert.equal(result.message, undefined);
  const events = await f.events();
  const exec = events.find(({ args }) => args.at(-1)?.includes("tar -cf"))!;
  const script = exec.args.at(-1)!;
  assert.ok(script.includes("tar -cf /tmp/agent-bootstrap-collect.tar"));
  assert.ok(script.includes("--exclude ./.git"));
  const copy = events.find(({ args }) => args[0] === "copy")!;
  assert.equal(copy.args[0], "copy");
  assert.match(
    copy.args[1]!,
    /^bootstrap-[^:]+:\/tmp\/agent-bootstrap-collect\.tar$/,
  );
  await f.runtime.destroy(handle);
  await assertCleanup(f);
});

test("tree collection bounds message reads and ignores oversized, swapped and non-regular messages", async (t) => {
  for (const [mode, expected] of [
    ["message", "Improve greeting\n"],
    ["max-message", "a".repeat(4096)],
    ["big-message", undefined],
    ["message-swapped", undefined],
    ["message-directory", undefined],
    ["message-symlink", undefined],
  ] as const) {
    const f = await fixture(t);
    const handle = await f.runtime.create({});
    await f.setMode(mode);
    const result = await f.runtime.collect(handle, { tree: true });
    assert.equal(result.message && text(result.message), expected);
    assert.equal(text(result.tree!), "TREE-BYTES");
    const events = await f.events();
    const reads = events.filter(({ args }) =>
      args.some((arg) => arg.includes("/tmp/agent-bootstrap/commit-message")),
    );
    assert.equal(reads.length, 1, mode);
    assert.equal(reads[0]?.args[0], "exec", mode);
    const script = reads[0]?.args.at(-1) ?? "";
    assert.match(script, /\[ ! -L "\$p" \] && \[ -f "\$p" \] \|\| exit 3/);
    assert.match(script, /head -c 4097 -- "\$p" \| base64/);
    await f.runtime.destroy(handle);
    await assertCleanup(f);
  }
});

test("tree collection failures and oversized tars clean up", async (t) => {
  for (const [mode, pattern] of [
    ["pack-fail", /collection-failed/],
    ["big-tree", /output-limit/],
  ] as const) {
    const f = await fixture(t);
    const handle = await f.runtime.create({});
    await f.setMode(mode);
    await assert.rejects(f.runtime.collect(handle, { tree: true }), pattern);
    await assertCleanup(f);
  }
});

async function interactiveFixture(t: TestContext) {
  const f = await fixture(t);
  // A Unix-domain socket needs a much shorter pathname than the worktree.
  const root = await mkdtemp(join(await realpath("/tmp"), "lo-msb-"));
  const socketDir = join(root, "socket");
  const hostPath = join(socketDir, "api.sock");
  const snapshotDir = join(root, "snapshot");
  const server = createServer();
  t.after(async () => {
    if (server.listening)
      await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  });
  await mkdir(snapshotDir, { mode: 0o700 });
  await mkdir(socketDir, { mode: 0o700 });
  const socketAvailable = await new Promise<boolean>((resolve, reject) => {
    server.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "EPERM") resolve(false);
      else reject(error);
    });
    server.listen(hostPath, () => resolve(true));
  });
  if (socketAvailable) await chmod(hostPath, 0o600);
  const provider = {
    host: "api.anthropic.com",
    secretEnv: "ANTHROPIC_API_KEY",
    header: "x-api-key" as const,
  };
  const runtime = new MicrosandboxRuntime({
    ...f.config,
    profiles: new ProfileCatalog({ base: { image }, concierge: { image } }),
    providers: [provider],
    credentials: { withAccessToken: (consume) => consume("fixture-token") },
    gatewayPassword: () => gatewayPassword,
  });
  const interactive = {
    vsock: { hostPath, port: 5000 },
    stateVolume: "lo-session-1",
    snapshotDir,
  };
  const spec = {
    profile: "concierge",
    interactive,
    provider,
    egressGateway: gateway,
  } as const;
  return { ...f, runtime, root, spec, interactive, socketAvailable };
}

test("non-interactive digest still hashes the original network argv", async (t) => {
  const { runtime } = await fixture(t);
  assert.equal(
    runtime.netRuleDigest({}),
    createHash("sha256").update('["--no-net"]').digest("hex"),
  );
});

test("interactive create hashes exact host channels without changing non-interactive digests", async (t) => {
  const { runtime, spec, interactive, events, setMode, socketAvailable } =
    await interactiveFixture(t);
  if (!socketAvailable)
    return t.skip("Unix socket bind is blocked by the execution sandbox");
  const plain = { provider: spec.provider, egressGateway: gateway };
  const channels = [
    "--vsock",
    `${interactive.vsock.hostPath}:5000`,
    "--mount-named",
    "lo-session-1:/state",
    "--mount-dir",
    `${interactive.snapshotDir}:/repo:ro`,
  ];
  const handle = await createBound(runtime, {
    ...spec,
    maxLifetimeMs: MICROSANDBOX_LIMITS.interactiveMaxLifetimeMs,
  });
  try {
    const create = (await events()).find(
      (event) => event.args[0] === "create",
    )!;
    const network = create.args.slice(
      create.args.indexOf("--no-net"),
      create.args.indexOf("--vsock"),
    );
    const digest = (args: string[]) =>
      createHash("sha256").update(JSON.stringify(args)).digest("hex");
    assert.equal(runtime.netRuleDigest(plain), digest(network));
    assert.equal(handle.netRuleDigest, digest([...network, ...channels]));
    assert.deepEqual(
      create.args.slice(
        create.args.indexOf("--vsock"),
        create.args.indexOf("--copy-dir"),
      ),
      [...channels, "--max-duration", "43200s"],
    );
    assert.notEqual(
      runtime.netRuleDigest({
        ...spec,
        interactive: { ...interactive, stateVolume: "lo-other" },
      }),
      handle.netRuleDigest,
    );

    await setMode("terminal-fail");
    assert.deepEqual(
      await runtime.attachTerminal(handle, {
        argv: ["claude", "--continue"],
        env: { TERM: "xterm-256color", LO_SESSION: "session-1" },
        workdir: "/state",
      }),
      { exitCode: 7 },
    );
    const attach = (await events()).at(-1)!;
    assert.deepEqual(attach.args, [
      "exec",
      "-t",
      "--workdir",
      "/state",
      handle.id,
      "--",
      "/usr/bin/env",
      "--",
      "TERM=xterm-256color",
      "LO_SESSION=session-1",
      "claude",
      "--continue",
    ]);
    assert.deepEqual(attach.envKeys, ["MSB_BACKEND", "MSB_HOME", "PATH"]);
  } finally {
    await runtime.destroy(handle);
  }
});

test("interactive specs reject conflicting channels, invalid names and unsafe host paths before launch", async (t) => {
  const { runtime, root, spec, interactive, events, socketAvailable } =
    await interactiveFixture(t);
  const { vsock, snapshotDir } = interactive;
  const linkedSnapshot = join(root, "snapshot-link");
  const linkedSocket = join(root, "socket-link");
  const linkedRoot = `${root}-link`;
  t.after(() => rm(linkedRoot, { force: true }));
  await symlink(snapshotDir, linkedSnapshot);
  await symlink(vsock.hostPath, linkedSocket);
  await symlink(root, linkedRoot);
  const invalidSpecs: SandboxSpec[] = [
    { profile: "concierge" },
    { ...spec, profile: "base" },
    { ...spec, interactive, provider: undefined } as unknown as SandboxSpec,
    {
      ...spec,
      interactive,
      egressGateway: undefined,
    } as unknown as SandboxSpec,
    { ...spec, files: [] },
    { ...spec, readOnlyFiles: [] },
    { ...spec, repository: { gitDir: "/fixture", tree: "/fixture" } },
    { ...spec, hostTcpPort: 8000 },
    {
      ...spec,
      maxLifetimeMs: MICROSANDBOX_LIMITS.interactiveMaxLifetimeMs + 1,
    },
    { maxLifetimeMs: MICROSANDBOX_LIMITS.maxLifetimeMs + 1 },
    ...[0, 1023, 1024.5, 65536].map((port) => ({
      ...spec,
      interactive: { ...interactive, vsock: { ...vsock, port } },
    })),
    ...[
      "relative",
      linkedSocket,
      join(linkedRoot, "socket", "api.sock"),
      snapshotDir,
      ...[":", ",", "=", "\0", "\n"].map((c) => vsock.hostPath + c),
      "/" + "é".repeat(50),
    ].map((hostPath) => ({
      ...spec,
      interactive: { ...interactive, vsock: { ...vsock, hostPath } },
    })),
    ...[
      "no-prefix",
      "lo-",
      "lo--a",
      "lo-A",
      "lo-a/b",
      "lo-" + "a".repeat(64),
    ].map((stateVolume) => ({
      ...spec,
      interactive: { ...interactive, stateVolume },
    })),
    ...[
      "relative",
      vsock.hostPath,
      linkedSnapshot,
      join(linkedRoot, "snapshot"),
      linkedSnapshot + "/",
      ...[":", ",", "="].map((c) => snapshotDir + c),
    ].map((snapshotDir) => ({
      ...spec,
      interactive: { ...interactive, snapshotDir },
    })),
  ];
  for (const invalidSpec of invalidSpecs)
    await assert.rejects(createBound(runtime, invalidSpec), /invalid-input/);
  const unsafe = join(root, "unsafe");
  const nested = join(unsafe, "nested");
  await mkdir(nested, { recursive: true, mode: 0o700 });
  await chmod(unsafe, 0o777);
  await assert.rejects(
    createBound(runtime, {
      ...spec,
      interactive: { ...interactive, snapshotDir: nested },
    }),
    /invalid-input/,
  );
  for (const mode of [0o500, 0o710, 0o740, 0o701, 0o1700]) {
    await chmod(snapshotDir, mode);
    await assert.rejects(createBound(runtime, spec), /invalid-input/);
  }
  await chmod(snapshotDir, 0o700);
  if (socketAvailable) {
    await chmod(vsock.hostPath, 0o660);
    await assert.rejects(createBound(runtime, spec), /invalid-input/);
    await chmod(vsock.hostPath, 0o600);
    await chmod(root, 0o720);
    await assert.rejects(createBound(runtime, spec), /invalid-input/);
  } else {
    await assert.rejects(createBound(runtime, spec), /invalid-input/);
  }
  assert.deepEqual(await events(), []);
});

test("interactive create rechecks host paths after asynchronous credential and gateway setup", async (t) => {
  const { config, spec, interactive, events, socketAvailable } =
    await interactiveFixture(t);
  if (!socketAvailable)
    return t.skip("Unix socket bind is blocked by the execution sandbox");
  let passwordRequested = false;
  const runtime = new MicrosandboxRuntime({
    ...config,
    profiles: new ProfileCatalog({ base: { image }, concierge: { image } }),
    providers: [spec.provider],
    credentials: { withAccessToken: (consume) => consume("fixture-token") },
    gatewayPassword: async () => {
      passwordRequested = true;
      await chmod(interactive.snapshotDir, 0o755);
      return gatewayPassword;
    },
  });
  await assert.rejects(createBound(runtime, spec), /invalid-input/);
  assert.equal(passwordRequested, true);
  assert.equal(
    (await events()).some(({ args }) => args[0] === "create"),
    false,
  );
});

test("terminal validation, exclusive attach and deadline use the existing handle", async (t) => {
  const { runtime, spec, setMode, events, socketAvailable } =
    await interactiveFixture(t);
  if (!socketAvailable)
    return t.skip("Unix socket bind is blocked by the execution sandbox");
  const plain = await runtime.create({});
  await assert.rejects(
    runtime.attachTerminal(plain, { argv: ["claude"] }),
    /unsupported/,
  );
  await runtime.destroy(plain);
  const handle = await createBound(runtime, { ...spec, maxLifetimeMs: 1500 });
  const invalid: TerminalCommand[] = [
    { argv: [] },
    { argv: Array<string>(65).fill("x") },
    { argv: ["claude", "x\0y"] },
    { argv: ["claude"], workdir: "/workspace" } as unknown as TerminalCommand,
    { argv: ["claude"], env: { lowercase: "x" } },
    { argv: ["claude"], env: { ANTHROPIC_API_KEY: "fixture" } },
    { argv: ["claude"], env: { DATABASE_PASSWORD: "fixture" } },
    { argv: ["claude"], env: { HOME: "/state" } },
    { argv: ["claude"], env: { PATH: "/bin" } },
    { argv: ["claude"], env: { LO_: "fixture" } },
    { argv: ["claude"], env: { LO_lowercase: "fixture" } },
    { argv: ["claude"], env: { ["LO_" + "X".repeat(41)]: "fixture" } },
    { argv: ["claude"], env: { TERM: "x\0y" } },
    { argv: ["claude"], env: { TERM: "x\ny" } },
    { argv: ["claude"], env: { TERM: "x\ry" } },
    { argv: ["claude"], env: { TERM: "é".repeat(513) } },
    { argv: ["ANTHROPIC_API_KEY=fixture", "claude"], env: { TERM: "x" } },
  ];
  for (const command of invalid)
    await assert.rejects(
      runtime.attachTerminal(handle, command),
      /invalid-input/,
    );
  await setMode("terminal-sleep");
  const hanging = runtime.attachTerminal(handle, { argv: ["claude"] });
  await assert.rejects(
    runtime.attachTerminal(handle, { argv: ["claude"] }),
    /busy/,
  );
  await assert.rejects(hanging, /lifetime-expired/);
  assert.deepEqual((await events()).at(-1)?.args, [
    "exec",
    "-t",
    "--workdir",
    "/repo",
    handle.id,
    "--",
    "claude",
  ]);
  await assert.rejects(
    runtime.attachTerminal(handle, { argv: ["claude"] }),
    /lifetime-expired/,
  );
  await runtime.destroy(handle);
});

test("volume create tolerates existing volumes and rejects other failures and invalid names", async (t) => {
  const { runtime, events, setMode } = await fixture(t);
  await assert.rejects(runtime.createVolume("-o"), /invalid-input/);
  await assert.rejects(runtime.removeVolume("lo-../../"), /invalid-input/);
  assert.deepEqual(await runtime.createVolume("lo-session"), { reused: false });
  await setMode("volume-exists");
  assert.deepEqual(await runtime.createVolume("lo-session"), { reused: true });
  await setMode("volume-fail");
  await assert.rejects(runtime.createVolume("lo-session"), /backend-failure/);
  await assert.rejects(runtime.removeVolume("lo-session"), /backend-failure/);
  await setMode("normal");
  await runtime.removeVolume("lo-session");
  assert.deepEqual(
    (await events()).map(({ args }) => args),
    [
      ["volume", "create", "lo-session"],
      ["volume", "create", "lo-session"],
      ["volume", "create", "lo-session"],
      ["volume", "remove", "lo-session"],
      ["volume", "remove", "lo-session"],
    ],
  );
});

test("create checks gateway availability after asynchronous provider credential acquisition", async (t) => {
  const { config, events } = await fixture(t);
  const provider = {
    host: "api.anthropic.com",
    secretEnv: "ANTHROPIC_API_KEY",
    header: "x-api-key" as const,
  };
  let grant = true;
  const runtime = new MicrosandboxRuntime({
    ...config,
    providers: [provider],
    gatewayPassword() {
      if (!grant) throw new Error("gateway unavailable");
      return gatewayPassword;
    },
    credentials: {
      async withAccessToken(consume) {
        await Promise.resolve();
        grant = false;
        return consume("fixture-token");
      },
    },
  });
  await assert.rejects(
    createBound(runtime, { provider, egressGateway: gateway }),
    /backend-failure/,
  );
  assert.equal(
    (await events()).some(({ args }) => args[0] === "create"),
    false,
  );
});

test("Claude configuration and managed settings create mounts without a provider substitution", async (t) => {
  const { config, events } = await fixture(t);
  const root = dirname(config.home);
  const managed = join(root, "managed.json");
  const group = join(root, "actors");
  await writeFile(managed, "{}", { mode: 0o600 });
  await mkdir(group, { mode: 0o700 });
  const runtime = new MicrosandboxRuntime({
    ...config,
    profiles: new ProfileCatalog({ base: { image }, concierge: { image } }),
    gatewayPassword: () => gatewayPassword,
  });

  for (const extra of [
    {},
    { profile: "concierge", interactive: { login: true } },
  ] as const) {
    const spec = {
      ...extra,
      claude: true,
      claudeMounts: { managed, group },
      egressGateway: gateway,
    } as const;
    const handle = await createBound(runtime, spec);
    try {
      const create = (await events())
        .filter(({ args }) => args[0] === "create")
        .at(-1)!;
      assert.equal(
        create.args[create.args.indexOf("--mount-file") + 1],
        `${managed}:/etc/claude-code/managed-settings.json:ro`,
      );
      assert.equal(
        create.args[create.args.indexOf("--mount-dir") + 1],
        `${group}:/claude-config`,
      );
      assert.ok(!create.args.includes("--secret"));
      assert.ok(!create.args.includes("--tls-intercept"));
      assert.ok(!create.args.includes("--vsock"));
      assert.ok(!create.args.includes("--mount-named"));
      assert.deepEqual(
        create.envKeys.filter((key) => key.startsWith("ANTHROPIC")),
        [],
      );
      if ("interactive" in extra) {
        assert.deepEqual(
          await runtime.attachTerminal(handle, {
            argv: ["claude"],
            workdir: "/",
          }),
          { exitCode: 0 },
        );
      }
    } finally {
      await runtime.destroy(handle);
    }
  }
});
