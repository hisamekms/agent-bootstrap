import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  lstat,
  lutimes,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  readdir,
  rm,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { SqliteAudit } from "../src/audit.ts";
import { mergeConfig, parseConfig } from "../src/config/layers.ts";
import {
  EnvironmentError,
  identifyEnvironment,
  type EnvironmentTree,
} from "../src/environments/adapter.ts";
import {
  checkEnvironmentTree,
  validateEnvironmentArchive,
} from "../src/environments/archive.ts";
import { bunAdapter } from "../src/environments/bun.ts";
import { diffBunLocks, parseBunLock } from "../src/environments/lock.ts";
import { parseEnvironmentEvidence } from "../src/environments/events.ts";
import {
  provisionEnvironment,
  provisionerGatewayLimits,
} from "../src/environments/provisioner.ts";
import {
  EnvironmentStore,
  type EnvironmentManifest,
} from "../src/environments/store.ts";

const digest = "a".repeat(64);
const project = "0123456789ab";
const lock = (packages: Record<string, string[]> = {}) =>
  JSON.stringify({ lockfileVersion: 1, workspaces: {}, packages });
const tree = (files: Record<string, string>): EnvironmentTree => ({
  paths: Object.keys(files),
  async read(path) {
    return Object.hasOwn(files, path) ? Buffer.from(files[path]!) : undefined;
  },
});

test("environment key covers profile, recipe, lock and matching manifests only", async () => {
  const contents = {
    "package.json": '{"workspaces":{"packages":["packages/*","apps/client"]}}',
    "packages/a/package.json": '{"name":"a"}',
    "packages/b/package.json": '{"name":"b"}',
    "apps/client/package.json": "{}",
    "packages/a/extra/package.json": "{}",
    "unrelated/package.json": "{}",
    "bun.lock": lock(),
    "README.md": "text",
  };
  const get = (
    files: Record<string, string>,
    image = digest,
    adapter = bunAdapter,
  ) => identifyEnvironment(tree(files), image, adapter);
  const initial = await get(contents);
  assert.match(initial.key, /^[a-f0-9]{64}$/);
  assert.deepEqual(initial.layout.outputs, [
    "node_modules",
    "apps/client/node_modules",
    "packages/a/node_modules",
    "packages/b/node_modules",
  ]);
  assert.ok(
    initial.layout.pathEntries.includes("packages/a/node_modules/.bin"),
  );
  assert.equal(
    (
      await get({
        ...contents,
        "README.md": "changed",
        "packages/a/extra/package.json": '{"new":true}',
      })
    ).key,
    initial.key,
  );
  assert.equal(
    (await get(Object.fromEntries(Object.entries(contents).reverse()))).key,
    initial.key,
  );
  for (const name of initial.layout.keyFiles)
    assert.notEqual(
      (
        await get({
          ...contents,
          [name]: contents[name as keyof typeof contents] + " ",
        })
      ).key,
      initial.key,
    );
  const { "bun.lock": _lock, ...unlocked } = contents;
  assert.notEqual((await get(unlocked)).key, initial.key);
  assert.notEqual((await get(contents, "b".repeat(64))).key, initial.key);
  assert.notEqual(
    (
      await get(contents, digest, {
        ...bunAdapter,
        recipeVersion: bunAdapter.recipeVersion + 1,
      })
    ).key,
    initial.key,
  );
});

test("workspace globs reject absolute paths and parent traversal", async () => {
  for (const pattern of [
    "/packages/*",
    "packages/../*",
    "../packages",
    "C:\\pkg",
    "packages\\*",
  ])
    await assert.rejects(
      bunAdapter.layout(
        tree({ "package.json": JSON.stringify({ workspaces: [pattern] }) }),
      ),
      { code: "env-build-failed" },
    );
  const layout = await bunAdapter.layout(
    tree({
      "package.json": '{"workspaces":["packages/**","packages/*"]}',
      "packages/a/nested/package.json": "{}",
      "packages/a/package.json": "{}",
      "packages/a/node_modules/b/package.json": "{}",
    }),
  );
  assert.deepEqual(layout.keyFiles, [
    "bun.lock",
    "package.json",
    "packages/a/nested/package.json",
    "packages/a/package.json",
  ]);
  assert.deepEqual(bunAdapter.command("build", true)?.argv, [
    "bun",
    "install",
    "--frozen-lockfile",
    "--network-concurrency=16",
  ]);
  assert.equal(bunAdapter.command("build", false)?.warning, "env-lock-missing");
  assert.deepEqual(bunAdapter.command("resolve", false)?.argv, [
    "bun",
    "install",
    "--network-concurrency=16",
  ]);
  assert.deepEqual(bunAdapter.command("update", true, ["@scope/a"])?.argv, [
    "bun",
    "update",
    "--network-concurrency=16",
    "@scope/a",
  ]);
  assert.deepEqual(bunAdapter.command("outdated", true)?.argv, [
    "bun",
    "outdated",
  ]);
});

test("Bun JSONC locks parse comments, trailing commas, scopes, duplicates and workspace sources", () => {
  const before = `{
    // bun lock
    "lockfileVersion": 1,
    "packages": {
      "@scope/a": ["@scope/a@1.0.0", "", {}, "hash",],
      "nested/@scope/a": ["@scope/a@1.0.0", "", {}, "hash",],
      "b": ["b@1.0.0", "https://fixture.invalid/#/*not a comment*/"],
    },
  }`;
  assert.deepEqual(parseBunLock(before), ["@scope/a@1.0.0", "b@1.0.0"]);
  const after = lock({
    "@scope/a": ["@scope/a@2.0.0", ""],
    c: ["c@1.2.3-beta.4", ""],
  });
  assert.deepEqual(diffBunLocks(before, after), {
    added: ["c@1.2.3-beta.4"],
    removed: ["b@1.0.0"],
    changed: [{ name: "@scope/a", from: ["1.0.0"], to: ["2.0.0"] }],
  });
  assert.match(
    parseBunLock(lock({ a: ["a@workspace:packages/a"] }))[0]!,
    /^a@workspace:sha256:/,
  );
  assert.ok(
    !parseBunLock(
      lock({ a: ["a@https://user:private@fixture.invalid/path"] }),
    )[0]!.includes("private"),
  );
  for (const malformed of [
    "{",
    '{"lockfileVersion":1,"packages":[]}',
    lock({ a: ["invalid", ""] }),
    lock({ a: ["a@bad", ""] }),
  ])
    assert.throws(() => parseBunLock(malformed), { code: "env-lock-mismatch" });
});

function entry(path: string, flag: string, link = "") {
  const header = Buffer.alloc(512);
  header.write(path);
  header.write("0000755", 100);
  for (const field of [108, 116]) header.write("0000000", field);
  for (const field of [124, 136]) header.write("00000000000", field);
  header.fill(32, 148, 156);
  header.write(flag, 156);
  header.write(link, 157);
  header.write("ustar\0" + "00", 257);
  const sum = header.reduce((total, value) => total + value, 0);
  header.write(sum.toString(8).padStart(6, "0") + "\0 ", 148);
  return header;
}
const tar = (...entries: Uint8Array[]) =>
  Buffer.concat([...entries, Buffer.alloc(1024)]);
const rootEntry = entry("node_modules/", "5");
const goodArchive = tar(rootEntry, entry("node_modules/p", "0"));

test("archive validation rejects escapes, devices, FIFOs, missing roots and oversized data", () => {
  const roots = ["node_modules"];
  assert.doesNotThrow(() =>
    validateEnvironmentArchive(
      tar(
        rootEntry,
        entry("node_modules/pkg", "0"),
        entry("node_modules/bin", "5"),
        entry("node_modules/bin/cli", "2", "../pkg"),
      ),
      roots,
    ),
  );
  for (const rejected of [
    tar(rootEntry, entry("/node_modules/a", "0")),
    tar(rootEntry, entry("node_modules/../a", "0")),
    tar(rootEntry, entry("node_modules/a", "3")),
    tar(rootEntry, entry("node_modules/a", "4")),
    tar(rootEntry, entry("node_modules/a", "6")),
    tar(rootEntry, entry("node_modules/a", "2", "/etc/passwd")),
    tar(rootEntry, entry("node_modules/a", "2", "../src/a")),
    tar(rootEntry, entry("node_modules/a", "2", "../src/../node_modules/p")),
    tar(
      rootEntry,
      entry("node_modules/a", "2", "b"),
      entry("node_modules/b", "2", "a"),
    ),
    tar(
      rootEntry,
      entry("node_modules/a", "2", "."),
      entry("node_modules/a/nested", "0"),
    ),
    tar(rootEntry, entry("node_modules/a", "1", "../outside")),
    tar(rootEntry, entry("outside", "0")),
    tar(entry("node_modules", "2", ".")),
    tar(),
    goodArchive.subarray(0, -1),
  ])
    assert.throws(() => validateEnvironmentArchive(rejected, roots), {
      code: "env-build-failed",
    });
  assert.throws(() => validateEnvironmentArchive(goodArchive, roots, 64), {
    code: "env-build-failed",
  });
});

test("archive validation allows links that name a declared workspace package exactly", () => {
  const roots = ["node_modules", "packages/core/node_modules"];
  const targets = ["packages/core", "packages/team"];
  const scope = entry("node_modules/@w/", "5");
  const coreRoot = entry("packages/core/node_modules/", "5");
  const limit = 1024 * 1024;
  assert.doesNotThrow(() =>
    validateEnvironmentArchive(
      tar(
        rootEntry,
        coreRoot,
        scope,
        entry("node_modules/@w/core", "2", "../../packages/core"),
        entry("node_modules/@w/team", "2", "../../packages/team/"),
        entry("packages/core/node_modules/team", "2", "../../team"),
      ),
      roots,
      limit,
      targets,
    ),
  );
  for (const rejected of [
    // Beneath a workspace package: its contents are not in the archive.
    tar(
      rootEntry,
      scope,
      entry("node_modules/@w/x", "2", "../../packages/core/src"),
    ),
    tar(
      rootEntry,
      scope,
      entry("node_modules/@w/x", "2", "../../packages/core/.."),
    ),
    // Undeclared source directories and the tree root stay refused.
    tar(
      rootEntry,
      scope,
      entry("node_modules/@w/x", "2", "../../packages/other"),
    ),
    tar(rootEntry, scope, entry("node_modules/@w/x", "2", "../../packages")),
    tar(rootEntry, scope, entry("node_modules/@w/x", "2", "../..")),
  ])
    assert.throws(
      () => validateEnvironmentArchive(rejected, roots, limit, targets),
      { code: "env-build-failed" },
    );
  // Without declared targets the same workspace link is refused.
  assert.throws(
    () =>
      validateEnvironmentArchive(
        tar(
          rootEntry,
          scope,
          entry("node_modules/@w/core", "2", "../../packages/core"),
        ),
        roots,
      ),
    { code: "env-build-failed" },
  );
  // A target inside an output root is a layout error.
  assert.throws(
    () =>
      validateEnvironmentArchive(goodArchive, roots, limit, ["node_modules/x"]),
    { code: "env-build-failed" },
  );
});

test("archive validation rejects case and Unicode aliases that involve a symlink", () => {
  const validate = (archive: Uint8Array) =>
    validateEnvironmentArchive(archive, ["node_modules"], undefined, [
      "packages/core",
    ]);
  for (const [first, second] of [
    ["A", "a"],
    ["café", "cafe\u0301"],
    ["SS", "ß"],
  ]) {
    const a = `node_modules/${first}`;
    const b = `node_modules/${second}`;
    // Plain files that differ only by case or normalization are legitimate.
    assert.doesNotThrow(() =>
      validate(tar(rootEntry, entry(a, "0"), entry(b, "0"))),
    );
    for (const archive of [
      tar(
        rootEntry,
        entry(b + "/src/x", "0"),
        entry(a, "2", "../packages/core"),
      ),
      tar(rootEntry, entry(a, "2", "../packages/core"), entry(b, "0")),
      tar(rootEntry, entry(b, "0"), entry(a, "2", "../packages/core")),
    ])
      assert.throws(() => validate(archive), { code: "env-build-failed" });
  }
});

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(await realpath(tmpdir()), "environments-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const env = { XDG_STATE_HOME: root };
  return { root, env, store: new EnvironmentStore(project, env) };
}

test("store publishes private per-target entries and prunes by count or age with holds", async (t) => {
  const { env, store } = await fixture(t);
  const first = "1".repeat(64);
  const second = "2".repeat(64);
  const third = "3".repeat(64);
  const create = (key: string, time: number): Promise<EnvironmentManifest> =>
    store.publish(
      {
        key,
        adapter: "bun",
        profileDigest: digest,
        createdAt: new Date(time).toISOString(),
        size: goodArchive.length,
        packages: ["pkg@1.0.0"],
        hasLock: true,
      },
      goodArchive,
    );
  await create(first, 100);
  await create(second, 200);
  await create(third, 300);
  assert.deepEqual(
    store.list().map(({ key }) => key),
    [third, second, first],
  );
  assert.equal(
    new EnvironmentStore("abcdef123456", env).get(second),
    undefined,
  );
  assert.equal(
    (await create(first, 500)).createdAt,
    new Date(100).toISOString(),
  );
  const release = store.hold(first);
  assert.deepEqual(store.prune({ keep: 1 }), [second]);
  assert.deepEqual(store.prune({ maxAgeMs: 100, now: 450 }), [third]);
  assert.ok(store.get(first));
  release();
  assert.deepEqual(store.prune({ keep: 0 }), [first]);
});

test("store recovers dead and expired pruning and hold markers", async (t) => {
  const { store } = await fixture(t);
  const key = "1".repeat(64);
  const entryPath = join(store.directory, "entries", key);
  const now = Date.now();
  const old = now - 48 * 60 * 60 * 1000;
  const dead = 0x7fffffff;
  const create = () =>
    store.publish(
      {
        key,
        adapter: "bun",
        profileDigest: digest,
        createdAt: new Date(now).toISOString(),
        size: goodArchive.length,
        packages: [],
        hasLock: true,
      },
      goodArchive,
    );
  const mark = (name: string, pid: number, at: number) =>
    writeFile(join(entryPath, name), JSON.stringify({ pid, at }), {
      mode: 0o600,
    });
  await create();
  await mark(".pruning", process.pid, now);
  assert.throws(() => store.hold(key), { code: "env-build-failed" });
  assert.deepEqual(store.prune({ keep: 0, now }), []);
  await mark(".pruning", dead, now);
  store.hold(key)();
  await assert.rejects(lstat(join(entryPath, ".pruning")), { code: "ENOENT" });
  await mark(".pruning", process.pid, old);
  await mark("hold-dead", dead, now);
  // A hold whose process is alive never expires, however old it is.
  await mark("hold-alive", process.pid, old);
  assert.deepEqual(store.prune({ keep: 0, now }), []);
  await rm(join(entryPath, "hold-alive"));
  await mark("hold-expired", 0, old);
  assert.deepEqual(store.prune({ keep: 0, now }), [key]);
  await create();
  const legacy = join(entryPath, ".pruning");
  await writeFile(legacy, "", { mode: 0o600 });
  await utimes(legacy, new Date(old), new Date(old));
  store.hold(key)();
  await assert.rejects(lstat(legacy), { code: "ENOENT" });
});

test("store sweeps only old staging directories and invocation journals", async (t) => {
  const { root, store } = await fixture(t);
  store.prepare();
  const now = Date.now();
  const old = new Date(now - 48 * 60 * 60 * 1000);
  const entries = join(store.directory, "entries");
  const external = join(root, "outside-store");
  const stage = join(store.directory, ".provision-old");
  const entryStage = join(entries, ".entry-old");
  const discarded = join(entries, ".discard-old");
  const symlinkStage = join(entries, ".discard-link");
  const fresh = join(store.directory, ".provision-fresh");
  const audit = join(store.directory, "audit.sqlite");
  const started = join(
    store.directory,
    `${randomUUID()}.environment.started.json`,
  );
  const finished = join(
    store.directory,
    `${randomUUID()}.environment.finished.json`,
  );
  const freshJournal = join(
    store.directory,
    `${randomUUID()}.environment.started.json`,
  );
  const symlinkJournal = join(
    store.directory,
    `${randomUUID()}.environment.finished.json`,
  );
  for (const path of [external, stage, entryStage, discarded, fresh])
    await mkdir(path, { mode: 0o700 });
  const sentinel = join(external, "sentinel");
  await writeFile(sentinel, "keep");
  await symlink(external, symlinkStage);
  await symlink(external, join(discarded, "nested-link"));
  await symlink(sentinel, symlinkJournal);
  for (const path of [symlinkStage, symlinkJournal])
    await lutimes(path, old, old);
  for (const path of [audit, started, finished, freshJournal])
    await writeFile(path, "fixture", { mode: 0o600 });
  for (const path of [
    external,
    sentinel,
    stage,
    entryStage,
    discarded,
    audit,
    started,
    finished,
  ])
    await utimes(path, old, old);
  assert.deepEqual(store.prune({ keep: 0, now }), []);
  for (const path of [stage, entryStage, discarded, started, finished])
    await assert.rejects(lstat(path), { code: "ENOENT" });
  for (const path of [fresh, audit, freshJournal, symlinkStage, symlinkJournal])
    await lstat(path);
  assert.equal(await readFile(sentinel, "utf8"), "keep");
});

test("environment allow comes only from private layers and validates hosts and ports", () => {
  const value = (allow: string[]) => ({ version: 1, environment: { allow } });
  const user = parseConfig(value(["first.example:443"]), "user");
  const local = parseConfig(
    value(["first.example:443", "second.example:8443"]),
    "local",
  );
  assert.throws(
    () => parseConfig(value(["first.example:443"]), "approved"),
    /environment/,
  );
  assert.throws(() => mergeConfig(user, user, local), /environment/);
  assert.deepEqual(
    mergeConfig(user, undefined, local).config.environment,
    local.environment,
  );
  for (const destination of [
    "https://first.example:443",
    "127.0.0.1:443",
    "first.example:0",
    "first.example:53",
    "first.example:65536",
    "*.example:443",
    "host.microsandbox.internal:443",
  ])
    assert.throws(
      () => parseConfig(value([destination]), "local"),
      /environment.allow/,
    );
});

const profile = {
  image: `localhost/agent-bootstrap/bun@sha256:${digest}`,
  recipeDigest: digest,
  memoryMiB: 2048,
  cpus: 2,
};
const input = {
  tree: {
    ...tree({ "package.json": "{}" }),
    pack(path: string) {
      return writeFile(path, tar(), { mode: 0o600 });
    },
  },
  profile,
  operation: "build" as const,
  allow: ["internal.registry.example:8443", "registry.npmjs.org:443"],
};

test("Provisioner rejects secret, mount, provider and agent configuration fields", async (t) => {
  const { env, store } = await fixture(t);
  for (const field of [
    "secrets",
    "secretFiles",
    "secretEnv",
    "provider",
    "headerSubstitution",
    "mounts",
    "debugMounts",
    "interactive",
    "conciergeVolume",
    "claude",
    "claudeManagedSettings",
    "codex",
  ]) {
    await assert.rejects(
      provisionEnvironment(
        { ...input, [field]: [] },
        {
          env,
          store,
          async run() {
            assert.fail("unexpected backend execution");
          },
          async openGateway() {
            assert.fail("unexpected gateway");
          },
        },
      ),
      { code: "env-build-failed" },
    );
  }
});

test("Provisioner fences VM creation when its durable audit write fails", async (t) => {
  const { env, store } = await fixture(t);
  let checked = false;
  await assert.rejects(
    provisionEnvironment(input, {
      env,
      store,
      async run() {
        assert.fail("unexpected backend execution");
      },
      async openGateway({ audit }) {
        checked = true;
        (audit as SqliteAudit).close();
        return {
          socksPort: 19100,
          dnsPort: 19153,
          username: "fake",
          password: "fixture",
          quarantined: false,
          async close() {},
        };
      },
    }),
    { code: "env-build-failed" },
  );
  assert.ok(checked);
  assert.deepEqual(store.list(), []);
});

test("Provisioner reports typed failures and never caches rejected output", async (t) => {
  const { env, store } = await fixture(t);
  const diagnostics = [
    ["failed ECONNREFUSED secret-fixture", "env-fetch-failed"],
    [
      "error: lockfile had changes, but lockfile is frozen",
      "env-lock-mismatch",
    ],
    ["", "env-build-failed"],
  ] as const;
  for (const [stderr, code] of diagnostics) {
    await assert.rejects(
      provisionEnvironment(input, {
        env,
        store,
        async run(args) {
          if (args[0] === "exec" && args.at(-1)?.includes("install") && stderr)
            return { code: 1, stdout: "", stderr };
          if (args[0] === "copy") {
            await writeFile(
              args[2]!,
              tar(rootEntry, entry("node_modules/device", "3")),
            );
          }
          return { code: 0, stdout: "" };
        },
        async openGateway() {
          return {
            socksPort: 19100,
            dnsPort: 19153,
            username: "fake",
            password: "fixture",
            quarantined: false,
            async close() {},
          };
        },
      }),
      { code },
    );
    assert.deepEqual(store.list(), []);
  }
  const journal = (await readdir(store.directory)).filter((name) =>
    name.endsWith(".finished.json"),
  );
  const bodies = await Promise.all(
    journal.map((name) => readFile(join(store.directory, name), "utf8")),
  );
  assert.deepEqual(
    bodies.map((body) => JSON.parse(body).failure as string).sort(),
    ["env-build-failed", "env-fetch-failed", "env-lock-mismatch"],
  );
  assert.ok(bodies.every((body) => !body.includes("secret-fixture")));
});

test("Provisioner audits gateway reaches, packs outputs and records lock fallback and cache reuse", async (t) => {
  const { env, store } = await fixture(t);
  const calls: string[] = [];
  let id: string | undefined;
  const result = await provisionEnvironment(input, {
    env,
    store,
    async run(args, _, extra) {
      calls.push(args[0]!);
      if (args[0] === "create") {
        assert.ok(args.includes("--no-net"));
        assert.ok(args.includes("--pull"));
        assert.equal(args[args.indexOf("--pull") + 1], "never");
        assert.equal(args.filter((arg) => arg === "--copy-dir").length, 1);
        assert.ok(
          !args.some((arg) => /mount|volume|claude|codex|header/.test(arg)),
        );
        assert.equal(Object.keys(extra ?? {}).length, 1);
        const audit = new SqliteAudit(join(store.directory, "audit.sqlite"), {
          readonly: true,
        });
        try {
          assert.equal(audit.read(id!).at(-1)?.kind, "operation.allowed");
        } finally {
          audit.close();
        }
      } else if (args[0] === "copy") {
        await writeFile(
          args[2]!,
          args[1]!.endsWith("outputs.tar")
            ? goodArchive
            : lock({ pkg: ["pkg@1.0.0", ""] }),
        );
      } else if (args[0] === "exec") assert.equal(extra, undefined);
      return { code: 0, stdout: "guest output not recorded" };
    },
    async openGateway({ policy, executionId, audit, sandboxLabel, limits }) {
      id = executionId;
      assert.deepEqual(limits, provisionerGatewayLimits);
      assert.deepEqual(policy.allow, [
        { hostname: "internal.registry.example", port: 8443 },
        { hostname: "registry.npmjs.org", port: 443 },
      ]);
      assert.deepEqual(policy.allowIps, []);
      assert.deepEqual(policy.hostServices, []);
      return {
        socksPort: 19100,
        dnsPort: 19153,
        username: "fake",
        password: "fixture",
        quarantined: false,
        async close() {
          const identity = {
            invocationId: executionId,
            sandboxId: sandboxLabel,
            connectionId: randomUUID(),
          };
          await audit.appendNetwork({
            ...identity,
            destinationIp: "203.0.113.1",
            destinationPort: 443,
            channel: "egress",
            hostname: "registry.npmjs.org",
            decision: "allow",
            policyId: policy.policyId,
            reasonCode: "allowlisted-host",
          });
          await audit.appendNetworkFinished({
            ...identity,
            result: "connected",
            endReason: "upstream-closed",
            durationMs: 1,
            bytesSent: 1,
            bytesReceived: 1,
          });
        },
      };
    },
  });
  assert.deepEqual(calls, [
    "create",
    "exec",
    "exec",
    "exec",
    "copy",
    "exec",
    "copy",
    "rm",
  ]);
  assert.equal(result.warning, "env-lock-missing");
  assert.equal(result.manifest?.hasLock, false);
  assert.deepEqual(result.destinationsReached, ["registry.npmjs.org:443"]);
  assert.deepEqual(result.packageDiff.added, ["pkg@1.0.0"]);
  const cached = await provisionEnvironment(input, {
    env,
    store,
    async run() {
      assert.fail("cache hit must not run a VM");
    },
    async openGateway() {
      assert.fail("cache hit must not open a gateway");
    },
  });
  assert.equal(cached.cacheHit, true);
  const audit = new SqliteAudit(join(store.directory, "audit.sqlite"), {
    readonly: true,
  });
  try {
    const events = audit.read(id!);
    assert.equal(events[0]?.kind, "environment.started");
    assert.equal(events.at(-1)?.kind, "environment.finished");
    assert.ok(events.every(({ role }) => role === "Provisioner"));
  } finally {
    audit.close();
  }
  const journal = (await readdir(store.directory)).filter((name) =>
    name.endsWith(".json"),
  );
  assert.equal(journal.length, 4);
  const body = await readFile(
    join(store.directory, `${id}.environment.finished.json`),
    "utf8",
  );
  assert.ok(
    !body.includes("guest output") &&
      !body.includes("internal.registry.example"),
  );
});

function stoppingGateway(reason?: string) {
  // Healthy until the package command runs, then stopped, as the real
  // gateway quarantines itself while the package manager is fetching.
  const state = { created: false };
  return {
    state,
    async openGateway() {
      return {
        socksPort: 19100,
        dnsPort: 19153,
        username: "fake",
        password: "fixture",
        get quarantined() {
          return state.created && reason !== undefined;
        },
        get quarantineReason() {
          return state.created ? reason : undefined;
        },
        async close() {},
      };
    },
  };
}

async function failingInstall(
  t: TestContext,
  reason: string | undefined,
  stderr: string,
) {
  const { env, store } = await fixture(t);
  const gateway = stoppingGateway(reason);
  let installRan = false;
  const error = await provisionEnvironment(input, {
    env,
    store,
    async run(args) {
      if (
        args[0] === "exec" &&
        args.join(" ").includes("--network-concurrency")
      ) {
        installRan = true;
        // The gateway stops while the package manager is fetching.
        gateway.state.created = true;
        return { code: 1, stdout: "", stderr };
      }
      return { code: 0, stdout: "" };
    },
    openGateway: gateway.openGateway,
  }).then(
    () => assert.fail("build must fail"),
    (caught: unknown) => caught,
  );
  assert.ok(installRan, "the package command must run");
  assert.ok(error instanceof EnvironmentError);
  const [name] = (await readdir(store.directory)).filter((file) =>
    file.endsWith(".finished.json"),
  );
  const body = JSON.parse(await readFile(join(store.directory, name!), "utf8"));
  return { error, body };
}

test("Provisioner reports a mid-run gateway budget stop as a fetch failure with its reason", async (t) => {
  const { error, body } = await failingInstall(
    t,
    "rate-limited",
    "error: failed to download pkg@1.0.0: ConnectionRefused",
  );
  assert.equal(error.code, "env-fetch-failed");
  assert.equal(error.gatewayStopped, "rate-limited");
  assert.equal(body.failure, "env-fetch-failed");
  assert.equal(body.gatewayStopped, "rate-limited");
  assert.equal(parseEnvironmentEvidence(body).gatewayStopped, "rate-limited");
  assert.throws(() =>
    parseEnvironmentEvidence({ ...body, failure: undefined }),
  );
  assert.throws(() =>
    parseEnvironmentEvidence({ ...body, gatewayStopped: "other" }),
  );
  assert.ok(!JSON.stringify(body).includes("ConnectionRefused"));
});

test("Provisioner keeps the code for host-side gateway stops and records the reason", async (t) => {
  const { error, body } = await failingInstall(
    t,
    "audit-failure",
    "error: lockfile had changes, but lockfile is frozen",
  );
  assert.equal(error.code, "env-lock-mismatch");
  assert.equal(error.gatewayStopped, "audit-failure");
  assert.equal(body.gatewayStopped, "audit-failure");
});

test("Provisioner classifies Bun download errors as fetch failures without a gateway stop", async (t) => {
  for (const stderr of [
    "error: failed to download pkg@1.0.0: ConnectionRefused",
    "error: ConnectionClosed while fetching",
    "error: failed to resolve pkg",
  ]) {
    const { error, body } = await failingInstall(t, undefined, stderr);
    assert.equal(error.code, "env-fetch-failed", stderr);
    assert.equal(error.gatewayStopped, undefined);
    assert.equal(body.gatewayStopped, undefined);
  }
});

test("environment enabled is a private boolean and local settings override the user", () => {
  const value = (enabled: unknown) => ({
    version: 1,
    environment: { enabled },
  });
  const user = parseConfig(value(true), "user");
  const local = parseConfig(value(false), "local");
  assert.equal(
    mergeConfig(user, undefined, { version: 1 }).config.environment?.enabled,
    true,
  );
  assert.equal(
    mergeConfig(user, undefined, local).config.environment?.enabled,
    false,
  );
  assert.equal(
    mergeConfig({ version: 1 }, undefined, { version: 1 }).config.environment,
    undefined,
  );
  assert.throws(() => parseConfig(value(true), "approved"), /environment/);
  assert.throws(
    () => parseConfig(value("true"), "local"),
    /environment.enabled/,
  );
});

test("environment autoBuild is a private boolean with per-layer sources", () => {
  const value = (autoBuild: unknown) => ({
    version: 1,
    environment: { autoBuild },
  });
  const user = parseConfig(value(true), "user");
  const local = parseConfig(value(false), "local");
  const inherited = mergeConfig(user, undefined, { version: 1 });
  assert.deepEqual(inherited.config.environment, { autoBuild: true });
  assert.equal(inherited.sources["environment.autoBuild"], "user");
  const overridden = mergeConfig(user, undefined, local);
  assert.deepEqual(overridden.config.environment, { autoBuild: false });
  assert.equal(overridden.sources["environment.autoBuild"], "local");
  assert.throws(() => parseConfig(value(true), "approved"), /environment/);
  for (const layer of ["user", "local"] as const)
    assert.throws(
      () => parseConfig(value("true"), layer),
      /environment.autoBuild/,
    );
});

test("environment output collisions include folded roots and implicit parent aliases", () => {
  for (const [root, path] of [
    ["node_modules", "Node_Modules/x"],
    ["café/node_modules", "cafe\u0301/NODE_MODULES/x"],
    ["packages/a/node_modules", "Packages/a/source"],
    ["packages/a/node_modules", "packages/a"],
  ] as const) {
    assert.throws(
      () => checkEnvironmentTree([root], [{ path, directory: false }]),
      { code: "env-output-collision" },
    );
  }
  assert.doesNotThrow(() =>
    checkEnvironmentTree(
      ["node_modules"],
      [{ path: "src/node_modules/a", directory: false }],
    ),
  );
});
