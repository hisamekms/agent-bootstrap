import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { symlink } from "node:fs/promises";
import test, { type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import {
  MICROSANDBOX_LIMITS,
  MicrosandboxRuntime,
} from "../src/microsandbox.ts";
import { ProfileCatalog } from "../src/sandbox-profiles.ts";
import { SandboxRuntimeError } from "../src/sandbox-runtime.ts";

const image = `fixture.invalid/alpine@sha256:${"a".repeat(64)}`;
const profiles = new ProfileCatalog({ base: { image } });
const diagnostic = "synthetic-backend-diagnostic-do-not-propagate";

type Event = {
  args: string[];
  envKeys: string[];
  env: { PATH: string; MSB_HOME: string; MSB_BACKEND: string };
  workspace?: string;
  stagedPaths?: string[];
  stagedBytes?: number;
  copyFiles?: string[];
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
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { truncateSync } from 'node:fs';
const require_truncate = (p) => truncateSync(p, 1024 * 1024 * 1024 + 1);
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
} else if (args[0] === 'create') {
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
  for (const c of event.copyFiles) if (c.endsWith(':/tmp/agent-bootstrap-tree.tar')) cpSync(c.split(':')[0], join(guests, name + '.tree'));
  cpSync(source, join(guests, name), { recursive: true });
  if (mode === 'partial-create-failure' || mode === 'create-and-cleanup-failure') fail();
} else if (args[0] === 'exec') {
  log();
  const separator = args.indexOf('--');
  const name = args[separator - 1];
  const command = args.slice(separator + 1);
  const workspace = join(guests, name);
  if (!existsSync(workspace)) fail();
  if (command[0] === 'fixture-write') writeFileSync(join(workspace, command[1]), command[2]);
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
  else if (command[0] === '/bin/sh' && command[3] === 'collect') {
    const bytes = readFileSync(join(workspace, command[4]));
    console.log(String(mode === 'oversized-collection' ? 999999999 : bytes.length));
    console.log(bytes.toString('base64'));
  } else fail();
} else if (args[0] === 'copy') {
  log();
  const [name, guestPath] = args[1].split(':');
  if (!existsSync(join(guests, name)) || guestPath !== '/tmp/agent-bootstrap-collect.tar') fail();
  if (mode === 'big-tree') { writeFileSync(args[2], ''); require_truncate(args[2]); }
  else writeFileSync(args[2], 'TREE-BYTES');
} else if (args[0] === 'stop') {
  log(); if (mode === 'create-and-cleanup-failure') fail();
} else if (args[0] === 'rm') {
  log(); if (args[1] !== '--force' || mode === 'create-and-cleanup-failure') fail();
  rmSync(join(guests, args[2]), { recursive: true, force: true });
  rmSync(join(guests, args[2] + '.tree'), { force: true });
} else { log(); fail(); }
`,
    { mode: 0o700 },
  );
  const runtime = new MicrosandboxRuntime({
    binary,
    home,
    stagingRoot,
    profiles,
  });
  return {
    runtime,
    withCredentials: (token: string) =>
      new MicrosandboxRuntime({
        binary,
        home,
        stagingRoot,
        profiles,
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

test("tools and the host port reach the backend only after a host digest check", async (t) => {
  const f = await fixture(t);
  const tool = join(f.home, "..", "tool.bin");
  await writeFile(tool, "fixture tool");
  const { createHash } = await import("node:crypto");
  const sha256 = createHash("sha256").update("fixture tool").digest("hex");
  const handle = await f.runtime.create({
    tools: [{ hostPath: tool, guestPath: "/tmp/tool", sha256 }],
    hostTcpPort: 4242,
  });
  const create = (await f.events()).find(({ args }) => args[0] === "create");
  assert.ok(create);
  const args = create.args.join(" ");
  assert.match(args, /--no-net --net-rule allow@host:tcp:4242 /);
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
    f.runtime.create({ hostTcpPort: 70_000 }),
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
  const runtime = f.withCredentials(token);
  const env = "AGENT_BOOTSTRAP_TOKEN";
  const provider = { host: "api.openai.com", secretEnv: env };
  const handle = await runtime.create({ provider });
  await runtime
    .exec(handle, { argv: ["fixture-cat", "missing"], timeoutMs: 1000 })
    .catch(() => {});
  const events = await f.events();
  const create = events.find(({ args }) => args[0] === "create");
  assert.ok(create);
  assert.match(
    create.args.join(" "),
    /--no-net --net-rule allow@dns --net-rule allow@api\.openai\.com:tcp:443 --tls-intercept --secret AGENT_BOOTSTRAP_TOKEN:headers=authorization@api\.openai\.com --secret-violation-action block /,
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
    f.withCredentials("throw").create({ provider }),
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
      runtime.create({ provider: bad }),
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
      runtime.create({ provider: rebind }),
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
  const handle = await runtime.create({
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
    /--net-rule allow@dns --net-rule allow@host:tcp:8443 --tls-intercept --tls-intercept-port 8443 --tls-upstream-ca-cert-for host\.microsandbox\.internal=\/tmp\/fixture-ca\.pem --secret ANTHROPIC_API_KEY:headers=x-api-key@host\.microsandbox\.internal --secret-violation-action block /,
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
      runtime.create({
        provider: {
          host: "host.microsandbox.internal",
          secretEnv: "ANTHROPIC_API_KEY",
          ...provider,
        } as never,
      }),
      (error: SandboxRuntimeError) => error.code === "invalid-input",
    );
});

test("one runtime binds its single credential to at most one provider", () => {
  const provider = {
    host: "api.anthropic.com",
    secretEnv: "ANTHROPIC_API_KEY",
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
  const events = await f.events();
  const exec = events.filter(({ args }) => args[0] === "exec").at(-1)!;
  const script = exec.args.at(-1)!;
  assert.ok(script.includes("tar -cf /tmp/agent-bootstrap-collect.tar"));
  assert.ok(script.includes("--exclude ./.git"));
  const copy = events.at(-1)!;
  assert.equal(copy.args[0], "copy");
  assert.match(
    copy.args[1]!,
    /^bootstrap-[^:]+:\/tmp\/agent-bootstrap-collect\.tar$/,
  );
  await f.runtime.destroy(handle);
  await assertCleanup(f);
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
