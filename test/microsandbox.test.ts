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
import test, { type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import {
  MICROSANDBOX_LIMITS,
  MicrosandboxRuntime,
} from "../src/microsandbox.ts";
import { SandboxRuntimeError } from "../src/sandbox-runtime.ts";

const image = `fixture.invalid/alpine@sha256:${"a".repeat(64)}`;
const diagnostic = "synthetic-backend-diagnostic-do-not-propagate";

type Event = {
  args: string[];
  envKeys: string[];
  env: { PATH: string; MSB_HOME: string; MSB_BACKEND: string };
  workspace?: string;
  stagedPaths?: string[];
  stagedBytes?: number;
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
const guests = ${JSON.stringify(guests)};
const mode = readFileSync(${JSON.stringify(mode)}, 'utf8');
const args = process.argv.slice(2);
const event = { args, envKeys: Object.keys(process.env).sort(), env: Object.fromEntries(['PATH', 'HOME', 'MSB_HOME', 'MSB_BACKEND'].map(k => [k, process.env[k]])) };
const log = () => appendFileSync(${JSON.stringify(log)}, JSON.stringify(event) + '\\n');
const fail = () => { process.stderr.write(${JSON.stringify(diagnostic)}); process.exit(2); };
if (args[0] === '--version') {
  log(); console.log(mode === 'wrong-version' ? 'msb 0.0.0' : 'msb 0.7.16');
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
  log();
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
  else if (command[0] === '/bin/sh' && command[3] === 'collect') {
    const bytes = readFileSync(join(workspace, command[4]));
    console.log(String(mode === 'oversized-collection' ? 999999999 : bytes.length));
    console.log(bytes.toString('base64'));
  } else fail();
} else if (args[0] === 'stop') {
  log(); if (mode === 'create-and-cleanup-failure') fail();
} else if (args[0] === 'rm') {
  log(); if (args[1] !== '--force' || mode === 'create-and-cleanup-failure') fail();
  rmSync(join(guests, args[2]), { recursive: true, force: true });
} else { log(); fail(); }
`,
    { mode: 0o700 },
  );
  const runtime = new MicrosandboxRuntime({ binary, home, stagingRoot, image });
  return {
    runtime,
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
    image,
  };
  assert.throws(
    () => new MicrosandboxRuntime({ ...config, image: "alpine:latest" }),
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
  assert.ok(create.args.includes(`${tool}:/tmp/tool`));
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
