import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { realpathSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  open,
  readFile,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test, { type TestContext } from "node:test";
import {
  userStateDirectory,
  writePrivateConfig,
} from "../src/config/layers.ts";
import {
  siwcGrantPresence,
  siwcProvider,
  SiwcError,
  type SiwcRefreshEvent,
} from "../src/siwc.ts";
import { configEnv, fixtureGit, initConfigRepo } from "./config-fixture.ts";

const registration = {
  hostId: "urn:uuid:20000000-0000-4000-a000-000000000000",
  clientId: "fixture_client",
  subjectHash: "fixture_subject",
};
const oldToken = "fixture-refresh-before";
const newToken = "fixture-refresh-after";
const access = "fixture-access";
type Options = Parameters<typeof siwcProvider>[0];

async function fixture(t: TestContext, options: Partial<Options> = {}) {
  const root = await mkdtemp(join(realpathSync(tmpdir()), "siwc-provider-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const checkout = join(root, "checkout");
  await mkdir(checkout);
  const env = configEnv(root);
  const state = userStateDirectory(env);
  const file = join(state, "siwc", "registration.json");
  let token: string | null = oldToken;
  const actions: string[] = [];
  const events: SiwcRefreshEvent[] = [];
  const deps = {
    checkout,
    env,
    keychain(hostId) {
      assert.ok(hostId === registration.hostId);
      return {
        async read() {
          actions.push("read");
          return token;
        },
        async write(replacement) {
          actions.push("write");
          token = replacement;
        },
        async delete() {
          actions.push("delete");
          token = null;
        },
      };
    },
    async request(url, body) {
      if (url.endsWith("/revoke")) {
        actions.push("revoke");
        return new Response(null, { status: 503 });
      }
      actions.push("refresh");
      assert.ok(
        url.endsWith("/token") && body?.get("refresh_token") === oldToken,
      );
      return Response.json({
        token_type: "Bearer",
        refresh_token: newToken,
        access_token: access,
      });
    },
    async consent() {
      assert.fail("unexpected browser consent");
    },
    onRefresh(event) {
      events.push(event);
    },
    ...options,
  } satisfies Options;
  return {
    actions,
    checkout,
    deps,
    env,
    events,
    file,
    root,
    state,
    provider: siwcProvider(deps),
    register: () => writePrivateConfig(file, state, registration),
    token: () => token,
  };
}

const errorCode = (code: SiwcError["code"]) => (error: unknown) =>
  error instanceof SiwcError &&
  error.code === code &&
  error.message === code &&
  error.next.length > 0;

test("SIWC saves the rotated token and records the outcome before handing off access", async (t) => {
  const f = await fixture(t);
  f.register();
  await f.provider.withAccessToken(async (token) => {
    assert.ok(token === access);
    assert.ok(f.token() === newToken);
    assert.deepEqual(f.actions, ["read", "refresh", "write"]);
    assert.deepEqual(f.events, [{ event: "siwc-refresh", status: "ok" }]);
  });
});

test("SIWC missing registration and missing Keychain item stop without consent", async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.provider.accessToken(), errorCode("siwc-missing"));
  assert.deepEqual(f.actions, []);
  f.register();
  await f.deps.keychain(registration.hostId, userInfo().username).delete();
  await assert.rejects(f.provider.accessToken(), errorCode("siwc-missing"));
  assert.deepEqual(f.actions, ["delete", "read"]);
  assert.deepEqual(
    f.events,
    Array.from({ length: 2 }, () => ({
      event: "siwc-refresh",
      status: "failed",
      code: "siwc-missing",
    })),
  );
});

for (const status of [400, 401, 503, "network"] as const) {
  test(`SIWC refresh handles ${status} without consent or private diagnostics`, async (t) => {
    const requests: string[] = [];
    const f = await fixture(t, {
      async request(url, body) {
        if (url.endsWith("/revoke")) {
          assert.ok(body?.get("token") === oldToken);
          requests.push("revoke");
          return new Response(null, { status: 503 });
        }
        requests.push("refresh");
        if (status === "network")
          throw new Error("fixture private transport detail");
        return new Response("fixture private response body", { status });
      },
    });
    f.register();
    const rejected = status === 400 || status === 401;
    const code = rejected ? "siwc-rejected" : "siwc-unavailable";
    await assert.rejects(f.provider.accessToken(), errorCode(code));
    assert.deepEqual(requests, rejected ? ["refresh", "revoke"] : ["refresh"]);
    assert.deepEqual(f.actions, rejected ? ["read", "delete"] : ["read"]);
    assert.ok(f.token() === (rejected ? null : oldToken));
    assert.deepEqual(f.events, [
      { event: "siwc-refresh", status: "failed", code },
    ]);
  });
}

test("failed refresh persistence revokes the replacement and withholds access", async (t) => {
  const f = await fixture(t);
  f.register();
  const provider = siwcProvider({
    ...f.deps,
    keychain(hostId, account) {
      return {
        ...f.deps.keychain(hostId, account),
        async write() {
          throw new Error("fixture private write detail");
        },
      };
    },
  });
  await assert.rejects(
    provider.withAccessToken(async () => assert.fail("unexpected access")),
    errorCode("siwc-rejected"),
  );
  assert.deepEqual(f.actions, ["read", "refresh", "revoke", "delete"]);
  assert.ok(f.token() === null);
  assert.deepEqual(f.events, [
    { event: "siwc-refresh", status: "failed", code: "siwc-rejected" },
  ]);
});

test("an audit callback failure withholds the access token after rotation", async (t) => {
  const f = await fixture(t, {
    onRefresh() {
      throw new Error("fixture private audit detail");
    },
  });
  f.register();
  await assert.rejects(
    f.provider.withAccessToken(async () => assert.fail("unexpected access")),
    errorCode("siwc-unavailable"),
  );
  assert.ok(f.token() === newToken);
});

test("a failed durable refresh attempt record prevents exchange and rotation", async (t) => {
  const f = await fixture(t, {
    beforeRefresh() {
      throw new Error("fixture private audit detail");
    },
  });
  f.register();
  await assert.rejects(f.provider.accessToken(), errorCode("siwc-unavailable"));
  assert.deepEqual(f.actions, ["read"]);
  assert.ok(f.token() === oldToken);
  assert.deepEqual(f.events, [
    { event: "siwc-refresh", status: "failed", code: "siwc-unavailable" },
  ]);
});

test("SIWC imports the legacy registration once from the primary checkout and shares its lock", async (t) => {
  const f = await fixture(t);
  initConfigRepo(f.checkout);
  const linked = join(f.root, "linked");
  fixtureGit(f.checkout, "worktree", "add", "--detach", linked);
  const legacy = join(f.checkout, ".local", "siwc-smoke");
  await mkdir(legacy, { recursive: true, mode: 0o700 });
  const legacyFile = join(legacy, "registration.json");
  const original = JSON.stringify(registration);
  await writeFile(legacyFile, original, { mode: 0o600 });
  const linkedLegacy = join(linked, ".local", "siwc-smoke");
  await mkdir(linkedLegacy, { recursive: true, mode: 0o700 });
  await writeFile(
    join(linkedLegacy, "registration.json"),
    JSON.stringify({
      ...registration,
      hostId: "urn:uuid:30000000-0000-4000-a000-000000000000",
    }),
    { mode: 0o600 },
  );
  const legacyLock = join(legacy, "run.lock");
  await writeFile(legacyLock, "", { mode: 0o600 });
  const provider = siwcProvider({ ...f.deps, checkout: linked });
  const pending = provider.accessToken();
  try {
    await delay(125);
    assert.deepEqual(f.actions, []);
    await assert.rejects(stat(f.file), { code: "ENOENT" });
  } finally {
    await rm(legacyLock);
  }
  assert.ok((await pending) === access);
  assert.deepEqual(JSON.parse(await readFile(f.file, "utf8")), {
    ...registration,
    migratedFrom: legacy,
    legacyAccountMigration: true,
  });
  assert.ok((await readFile(legacyFile, "utf8")) === original);
  assert.equal((await stat(f.file)).mode & 0o777, 0o600);
  assert.equal((await stat(dirname(f.file))).mode & 0o777, 0o700);

  // Later operations consult the user copy and still interoperate with the
  // original checkout's lock.
  const replacement = JSON.stringify({
    ...registration,
    hostId: "urn:uuid:40000000-0000-4000-a000-000000000000",
  });
  await writeFile(legacyFile, replacement, { mode: 0o600 });
  await writeFile(legacyLock, "", { mode: 0o600 });
  const later = siwcProvider({
    ...f.deps,
    checkout: linked,
    env: { ...f.env, USER: userInfo().username + "-legacy" },
  }).forget();
  try {
    await delay(125);
    assert.deepEqual(f.actions, ["read", "refresh", "write"]);
  } finally {
    await rm(legacyLock);
  }
  assert.equal(await later, 1);
  assert.ok(f.token() === null);
  assert.deepEqual(f.actions, [
    "read",
    "refresh",
    "write",
    "read",
    "revoke",
    "delete",
  ]);
  assert.equal(await readFile(legacyFile, "utf8"), replacement);
  assert.deepEqual(JSON.parse(await readFile(f.file, "utf8")), {
    ...registration,
    legacyRetired: true,
  });
});

test("SIWC migrates the legacy USER item only when the login account has no item", async (t) => {
  const f = await fixture(t);
  const account = userInfo().username;
  const legacyAccount =
    account === "fixture-legacy" ? "fixture-old" : "fixture-legacy";
  const env = { ...f.env, USER: legacyAccount };
  const legacy = join(f.checkout, ".local", "siwc-smoke");
  writePrivateConfig(join(legacy, "registration.json"), legacy, registration);
  const tokens = new Map([[legacyAccount, oldToken]]);
  const actions: string[] = [];
  let failSourceDelete = true;
  const provider = siwcProvider({
    ...f.deps,
    env,
    keychain(hostId, user) {
      assert.ok(hostId === registration.hostId);
      const label = user === account ? "login" : "legacy";
      return {
        async read() {
          actions.push(`read ${label}`);
          return tokens.get(user) ?? null;
        },
        async write(token) {
          actions.push(`write ${label}`);
          tokens.set(user, token);
        },
        async delete() {
          actions.push(`delete ${label}`);
          if (user === legacyAccount && failSourceDelete)
            throw new Error("fixture interrupted migration");
          tokens.delete(user);
        },
      };
    },
  });
  const probe: Parameters<typeof siwcGrantPresence>[3] = async (
    _service,
    user,
  ) => (tokens.has(user) ? "present" : "missing");
  assert.equal(
    await siwcGrantPresence(f.checkout, env, account, probe),
    "present",
  );
  await assert.rejects(
    provider.runSmoke({
      useKeychain: false,
      signal: new AbortController().signal,
      run: async () => assert.fail("unexpected run"),
      onUnconfirmedRevocation() {},
    }),
    errorCode("siwc-unavailable"),
  );
  assert.deepEqual(actions, []);
  assert.equal(
    await siwcGrantPresence(f.checkout, env, account, probe),
    "present",
  );
  await assert.rejects(provider.authorize(), errorCode("siwc-unavailable"));
  assert.ok(
    tokens.get(account) === oldToken && tokens.get(legacyAccount) === oldToken,
  );
  failSourceDelete = false;
  await provider.authorize();
  assert.deepEqual(actions, [
    "read login",
    "read legacy",
    "write login",
    "delete legacy",
    "read login",
    "read legacy",
    "delete legacy",
    "read login",
  ]);
  assert.ok(tokens.get(account) === oldToken && !tokens.has(legacyAccount));
  tokens.set(legacyAccount, oldToken);
  assert.ok((await provider.accessToken()) === access);
  assert.deepEqual(actions.slice(8), ["read login", "write login"]);
  assert.ok(tokens.get(account) === newToken);
});

test("SIWC records a legacy USER item for manual removal when the login item already exists", async (t) => {
  const f = await fixture(t);
  const account = userInfo().username;
  const legacyAccount = `${account}-legacy`;
  const warnings: string[] = [];
  const legacy = join(f.checkout, ".local", "siwc-smoke");
  writePrivateConfig(join(legacy, "registration.json"), legacy, registration);
  const provider = siwcProvider({
    ...f.deps,
    env: { ...f.env, USER: legacyAccount },
    keychain(hostId, user) {
      if (user === account) return f.deps.keychain(hostId, user);
      assert.equal(user, legacyAccount);
      return {
        read: async () => newToken,
        write: async () => assert.fail("unexpected legacy item write"),
        delete: async () => assert.fail("unexpected legacy item deletion"),
      };
    },
    warn: (message) => warnings.push(message),
  });
  await provider.authorize();
  assert.ok(f.token() === oldToken);
  assert.deepEqual(f.actions, ["read", "read"]);
  assert.deepEqual(JSON.parse(await readFile(f.file, "utf8")), {
    ...registration,
    migratedFrom: legacy,
    legacyAccountMigration: true,
    legacyAccountCleanup: legacyAccount,
  });
  assert.equal(
    warnings[1],
    `next: security delete-generic-password -s agent-bootstrap.siwc.refresh.${createHash("sha256").update(registration.hostId).digest("hex").slice(0, 16)} -a ${legacyAccount}`,
  );
});

test(
  "SIWC reclaims an aged empty legacy lock only after its descriptor closes",
  {
    skip: process.platform !== "darwin",
  },
  async (t) => {
    const f = await fixture(t, { lockWaitMs: 500 });
    const legacy = join(f.checkout, ".local", "siwc-smoke");
    writePrivateConfig(join(legacy, "registration.json"), legacy, registration);
    const lock = join(legacy, "run.lock");
    const handle = await open(lock, "wx", 0o600);
    try {
      const stale = new Date(Date.now() - 10 * 60_000);
      await utimes(lock, stale, stale);
      await assert.rejects(
        f.provider.accessToken(),
        errorCode("siwc-unavailable"),
      );
      assert.deepEqual(f.actions, []);
      assert.equal((await stat(lock)).size, 0);
    } finally {
      await handle.close();
    }
    assert.ok((await f.provider.accessToken()) === access);
    await assert.rejects(stat(lock), { code: "ENOENT" });
  },
);

test("SIWC waits when a lock owner's identity lookup returns EPERM", async (t) => {
  const pid = process.pid === 12345 ? 12346 : 12345;
  let attempts = 0;
  const f = await fixture(t, {
    async lookupProcessStart(owner) {
      if (owner === process.pid) return "caller-start";
      assert.equal(owner, pid);
      if (++attempts === 1) throw Object.assign(new Error(), { code: "EPERM" });
      return null;
    },
    lockWaitMs: 500,
  });
  f.register();
  const lock = join(dirname(f.file), "run.lock");
  await writeFile(lock, JSON.stringify({ pid, start: "owner-start" }), {
    mode: 0o600,
  });
  assert.ok((await f.provider.accessToken()) === access);
  assert.equal(attempts, 2);
  await assert.rejects(stat(lock), { code: "ENOENT" });
});

for (const liveStart of [null, "reused-start", "owner-start"]) {
  test(`SIWC checks the recorded start identity before reclaiming a lock (${liveStart ?? "dead"})`, async (t) => {
    const pid = process.pid === 12345 ? 12346 : 12345;
    const table = new Map([
      [process.pid, "caller-start"],
      [pid, liveStart],
    ]);
    const f = await fixture(t, {
      async lookupProcessStart(pid) {
        return table.get(pid) ?? null;
      },
      lockWaitMs: 200,
    });
    f.register();
    const lock = join(dirname(f.file), "run.lock");
    await writeFile(lock, JSON.stringify({ pid, start: "owner-start" }), {
      mode: 0o600,
    });
    if (liveStart === "owner-start") {
      await assert.rejects(
        f.provider.accessToken(),
        (error) =>
          errorCode("siwc-unavailable")(error) &&
          error instanceof SiwcError &&
          error.next.includes(lock),
      );
      assert.deepEqual(f.actions, []);
      await stat(lock);
    } else {
      assert.ok((await f.provider.accessToken()) === access);
      await assert.rejects(stat(lock), { code: "ENOENT" });
    }
  });
}

test("a second SIWC reclaimer preserves the first reclaimer's replacement lock", async (t) => {
  const pid = process.pid === 12345 ? 12346 : 12345;
  const checked = Promise.withResolvers<void>();
  const holdingLock = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const f = await fixture(t);
  f.register();
  const lock = join(dirname(f.file), "run.lock");
  await writeFile(lock, JSON.stringify({ pid, start: "dead-start" }), {
    mode: 0o600,
  });
  const slow = siwcProvider({
    ...f.deps,
    lockWaitMs: 0,
    async lookupProcessStart(owner) {
      if (owner === process.pid) return "caller-start";
      assert.equal(owner, pid);
      checked.resolve();
      await holdingLock.promise;
      return null;
    },
  });
  const fast = siwcProvider({
    ...f.deps,
    async lookupProcessStart(owner) {
      return owner === process.pid ? "caller-start" : null;
    },
    async beforeRefresh() {
      holdingLock.resolve();
      await release.promise;
    },
  });
  const slowDone = assert.rejects(
    slow.accessToken(),
    errorCode("siwc-unavailable"),
  );
  await checked.promise;
  const fastDone = fast.accessToken();
  try {
    await slowDone;
    assert.deepEqual(JSON.parse(await readFile(lock, "utf8")), {
      pid: process.pid,
      start: "caller-start",
    });
  } finally {
    release.resolve();
  }
  assert.ok((await fastDone) === access);
});

test("SIWC refresh locks across processes until rotation is saved", async (t) => {
  const f = await fixture(t);
  f.register();
  const tokenFile = join(f.root, "fake-keychain");
  await writeFile(tokenFile, oldToken, { mode: 0o600 });
  const keychain = () => ({
    read: () => readFile(tokenFile, "utf8"),
    write: (saved: string) => writeFile(tokenFile, saved),
    async delete() {
      throw new Error("Unexpected deletion");
    },
  });
  const refreshing = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const parent = siwcProvider({
    checkout: f.checkout,
    env: f.env,
    keychain,
    async request(_url, body) {
      assert.ok(body?.get("refresh_token") === oldToken);
      refreshing.resolve();
      await release.promise;
      return Response.json({
        token_type: "Bearer",
        access_token: access,
        refresh_token: newToken,
      });
    },
  });
  const pending = parent.accessToken();
  await refreshing.promise;

  const child = spawn(
    process.execPath,
    [
      "--no-env-file",
      "--eval",
      `
    import { readFile, writeFile } from "node:fs/promises";
    import { siwcProvider } from ${JSON.stringify(new URL("../src/siwc.ts", import.meta.url).href)};
    const [checkout, file] = process.argv.slice(1);
    const provider = siwcProvider({
      checkout,
      keychain: () => ({
        read: () => readFile(file, "utf8"),
        write: (token) => writeFile(file, token),
      }),
      async request(_url, body) {
        if (body.get("refresh_token") !== ${JSON.stringify(newToken)}) throw new Error("Used stale fixture");
        return Response.json({ token_type: "Bearer", access_token: "child-access", refresh_token: "child-rotation" });
      },
    });
    process.send("ready");
    try { await provider.accessToken(); }
    catch { process.exitCode = 1; }
    process.disconnect();
  `,
      f.checkout,
      tokenFile,
    ],
    {
      stdio: ["ignore", "ignore", "ignore", "ipc"],
      env: f.env,
    },
  );
  t.after(() => {
    child.kill();
  });
  const closed = once(child, "close");
  try {
    const [ready] = await once(child, "message", {
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(ready, "ready");
    await delay(125);
    assert.equal(child.exitCode, null);
  } finally {
    release.resolve();
  }
  assert.ok((await pending) === access);
  assert.deepEqual(await closed, [0, null]);
  assert.ok((await readFile(tokenFile, "utf8")) === "child-rotation");
});

test("SIWC grant presence reports a grant awaiting identity verification", async (t) => {
  const f = await fixture(t);
  const state = userStateDirectory(f.env);
  writePrivateConfig(join(state, "siwc", "registration.json"), state, {
    ...registration,
    identityVerificationPending: true,
  });
  const account = userInfo().username;
  assert.equal(
    await siwcGrantPresence(f.checkout, f.env, account, async () => "present"),
    "pending",
  );
});
