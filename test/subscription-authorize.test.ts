import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  acceptCallback,
  forgetRefreshToken,
  loadRegistration,
  makeKeychain,
  parseArgs,
  runSubscription,
  verifyIdentity,
} from "../spike/m1/subscription-authorize.ts";

test("M5 launcher arguments allow Keychain opt-in immediately after the mode flag", () => {
  assert.deepEqual(parseArgs(["--authorize-and-run-m5", "/msb", "/codex"]), {
    forget: false,
    useKeychain: false,
    msb: "/msb",
    codex: "/codex",
  });
  const keychain = parseArgs([
    "--authorize-and-run-m5",
    "--keychain",
    "/msb",
    "/codex",
  ]);
  assert.ok(!keychain.forget);
  assert.equal(keychain.useKeychain, true);
  assert.equal(keychain.msb, "/msb");
  assert.equal(keychain.codex, "/codex");
  assert.deepEqual(parseArgs(["--forget"]), { forget: true });
  for (const argv of [
    ["--authorize-and-run-m5", "/msb"],
    ["--authorize-and-run-m5", "/msb", "/codex", "--keychain"],
    ["--authorize-and-run-m5", "/msb", "--keychain", "/codex"],
    ["--authorize-and-run-m5", "--keychain", "/msb", "/codex", "/extra"],
    ["--forget", "--keychain"],
  ]) {
    assert.throws(
      () => parseArgs(argv),
      /^Error: Usage: .* --authorize-and-run-m5 .*\n +.* --forget$/,
    );
  }
});

test("the launcher rejects the retired mode and directs the operator to M5", () => {
  const result = spawnSync(
    process.execPath,
    [
      fileURLToPath(
        new URL("../spike/m1/subscription-authorize.ts", import.meta.url),
      ),
      "--authorize-and-run",
      "/msb",
      "/codex",
    ],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.equal(
    result.stderr,
    "--authorize-and-run has been retired. Use --authorize-and-run-m5 for the audited gateway.\n",
  );
});

test("consent callback checks state and binds the issued app client", () => {
  const url = new URL("http://127.0.0.1/auth/callback");
  url.search = "?state=state&code=code&client_id=oaiapp_fixture";
  assert.equal(acceptCallback(url, "other"), null);
  assert.throws(() => acceptCallback(url, "state", "oaiapp_other"));
  assert.deepEqual(acceptCallback(url, "state"), {
    code: "code",
    clientId: "oaiapp_fixture",
  });
  url.searchParams.delete("client_id");
  assert.deepEqual(acceptCallback(url, "state", "oaiapp_fixture"), {
    code: "code",
    clientId: "oaiapp_fixture",
  });
});

test("consent callback rejects duplicate fields and provider errors", () => {
  const url = new URL("http://127.0.0.1/auth/callback");
  url.search = "?state=state&state=state&code=code";
  assert.equal(acceptCallback(url, "state", "oaiapp_fixture"), null);
  url.search = "?state=state&code=code&code=other";
  assert.throws(() => acceptCallback(url, "state", "oaiapp_fixture"));
  url.search = "?state=state&error=access_denied";
  assert.throws(() => acceptCallback(url, "state", "oaiapp_fixture"));
});

function signedIdentity() {
  const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const keys = [
    { ...pair.publicKey.export({ format: "jwk" }), kid: "fixture" },
  ];
  const encode = (value: object) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const claims = {
    iss: "https://auth.openai.com",
    aud: "oaiapp_fixture",
    nonce: "nonce",
    sub: "fixture_user",
    exp: now + 60,
  };
  const header = encode({ alg: "RS256", kid: "fixture" });
  const token = (payload: object) => {
    const data = `${header}.${encode(payload)}`;
    return `${data}.${sign("RSA-SHA256", Buffer.from(data), pair.privateKey).toString("base64url")}`;
  };
  return { keys, claims, header, encode, token };
}

test("identity requires the provider signature and the expected claims", () => {
  const { keys, claims, header, encode, token } = signedIdentity();
  const verify = (value: string) =>
    verifyIdentity(value, keys, "oaiapp_fixture", { nonce: "nonce" });
  assert.equal(verify(token(claims)), "fixture_user");
  for (const replacement of [
    { iss: "https://example.test" },
    { aud: "oaiapp_other" },
    { aud: ["oaiapp_fixture", "oaiapp_other"] },
    { azp: "oaiapp_other" },
    { nonce: "other" },
    { exp: 0 },
  ]) {
    assert.throws(() => verify(token({ ...claims, ...replacement })));
  }
  const signature = token(claims).split(".")[2];
  assert.throws(() =>
    verify(`${header}.${encode({ ...claims, sub: "other" })}.${signature}`),
  );
});

test("identity accepts a refresh ID token without a nonce", () => {
  const { keys, claims, token } = signedIdentity();
  const id = token({ ...claims, nonce: undefined });
  assert.equal(
    verifyIdentity(id, keys, claims.aud, { refresh: true }),
    claims.sub,
  );
  assert.throws(() =>
    verifyIdentity(id, keys, claims.aud, { nonce: claims.nonce }),
  );
});

const oldToken = "fixture-saved-refresh-token";
const newToken = "fixture-rotated-refresh-token";
const clientId = "oaiapp_fixture";
const registration = {
  hostId: "urn:uuid:00000000-0000-4000-a000-000000000000",
  clientId,
  subjectHash: createHash("sha256").update("fixture_user").digest("base64url"),
};
const refreshPayload = {
  access_token: "fixture-access",
  refresh_token: newToken,
  token_type: "Bearer",
};

function flow({
  refresh = () => Response.json(refreshPayload),
  consentAccessToken = refreshPayload.access_token,
  persistFails = false,
  saved = oldToken as string | null,
  revocationStatus = 200,
  keys,
}: {
  refresh?: () => Response;
  consentAccessToken?: string;
  persistFails?: boolean;
  saved?: string | null;
  revocationStatus?: number;
  keys?: readonly Record<string, unknown>[];
} = {}) {
  const events: string[] = [];
  const warnings: string[] = [];
  const consentClientIds: (string | undefined)[] = [];
  let revoked: string | null = null;
  const deps = {
    keychain: {
      async read() {
        events.push("read");
        return saved;
      },
      async write(token) {
        events.push("write");
        if (persistFails) throw new Error("fixture write failed");
        saved = token;
      },
      async delete() {
        events.push("delete");
        saved = null;
      },
    },
    async request(url, body) {
      if (url === "https://auth.openai.com/.well-known/jwks.json") {
        return Response.json({ keys });
      }
      assert.ok(body);
      assert.equal(body.get("client_id"), clientId);
      if (url === "https://auth.openai.com/api/accounts/oauth/revoke") {
        events.push("revoke");
        assert.equal(body.get("token_type_hint"), "refresh_token");
        revoked = body.get("token");
        return new Response(null, { status: revocationStatus });
      }
      assert.equal(url, "https://auth.openai.com/api/accounts/oauth/token");
      assert.equal(body.get("resource"), "https://api.openai.com/v1");
      if (body.get("grant_type") === "refresh_token") {
        events.push("refresh");
        assert.ok(body.get("refresh_token") === oldToken);
        assert.equal(body.has("scope"), false);
        return refresh();
      }
      events.push("exchange");
      assert.equal(body.get("grant_type"), "authorization_code");
      const identity = signedIdentity();
      keys = identity.keys;
      return Response.json({
        ...refreshPayload,
        access_token: consentAccessToken,
        id_token: identity.token(identity.claims),
        scope: "openid chatgpt.tokens.use.direct",
      });
    },
    async consent(registeredClientId) {
      events.push("consent");
      consentClientIds.push(registeredClientId);
      return {
        clientId,
        code: "fixture-code",
        verifier: "fixture-verifier",
        nonce: "nonce",
        redirectUri: "http://127.0.0.1/auth/callback",
      };
    },
    async save(updated) {
      events.push("save");
      assert.deepEqual(updated, registration);
    },
    async run(token) {
      events.push("run");
      assert.ok(token === refreshPayload.access_token);
      if (events.includes("write")) assert.ok(saved === newToken);
    },
    report(message) {
      assert.match(message, /Keychain.*--forget/);
      events.push("kept");
    },
    warn(message) {
      warnings.push(message);
      events.push("warn");
    },
    onUnconfirmedRevocation() {
      events.push("warn");
    },
  } satisfies Parameters<typeof runSubscription>[1];
  return {
    deps,
    events,
    warnings,
    consentClientIds,
    saved: () => saved,
    revoked: () => revoked,
  };
}

test("refresh persists the rotation before launching and keeps it afterward", async () => {
  const { deps, events } = flow();
  await runSubscription(registration, deps);
  assert.deepEqual(events, ["read", "refresh", "write", "run", "kept"]);
});

test("refresh accepts a signed ID token bound to the registered subject", async () => {
  const { keys, claims, token } = signedIdentity();
  const { deps, events } = flow({
    keys,
    refresh: () =>
      Response.json({
        ...refreshPayload,
        id_token: token({ ...claims, nonce: undefined }),
        expires_in: 1200,
        scope: "chatgpt.tokens.use.direct",
      }),
  });
  await runSubscription(registration, deps);
  assert.deepEqual(events, ["read", "refresh", "write", "run", "kept"]);
});

for (const [label, fields, cleanupToken] of [
  ["same token", { refresh_token: oldToken }, oldToken],
  ["missing token", { refresh_token: undefined }, oldToken],
  ["wrong token type", { token_type: "Other" }, newToken],
  ["empty access token", { access_token: "" }, newToken],
  ["refresh token as access token", { access_token: newToken }, newToken],
  [
    "padded refresh token as access token",
    { access_token: ` ${newToken} ` },
    newToken,
  ],
  ["short lifetime", { expires_in: 1199 }, newToken],
  ["missing required scope", { scope: "openid" }, newToken],
] as const) {
  test(`refresh rejects ${label} and cleans up`, async () => {
    const { deps, events, revoked } = flow({
      refresh: () => Response.json({ ...refreshPayload, ...fields }),
    });
    await assert.rejects(runSubscription(registration, deps));
    assert.deepEqual(events, ["read", "refresh", "revoke", "delete"]);
    assert.ok(revoked() === cleanupToken);
  });
}

test("refresh revokes and deletes the replacement when the signed subject differs", async () => {
  const { keys, claims, token } = signedIdentity();
  const { deps, events, revoked } = flow({
    keys,
    refresh: () =>
      Response.json({
        ...refreshPayload,
        id_token: token({ ...claims, sub: "other" }),
      }),
  });
  await assert.rejects(runSubscription(registration, deps));
  assert.deepEqual(events, ["read", "refresh", "revoke", "delete"]);
  assert.ok(revoked() === newToken);
});

for (const status of [400, 401]) {
  test(`refresh HTTP ${status} attempts revocation, deletes and warns before browser consent`, async () => {
    const { deps, events, revoked, warnings } = flow({
      refresh: () => new Response(null, { status }),
      revocationStatus: 503,
    });
    await runSubscription(registration, deps);
    assert.deepEqual(events, [
      "read",
      "refresh",
      "revoke",
      "delete",
      "warn",
      "consent",
      "exchange",
      "save",
      "write",
      "run",
      "kept",
    ]);
    assert.ok(revoked() === oldToken);
    assert.deepEqual(warnings, [
      "The saved ChatGPT grant was rejected. If you did not expect this, disconnect Agent Bootstrap in ChatGPT settings.",
    ]);
  });
}

for (const missing of ["clientId", "subjectHash"] as const) {
  test(`a saved token without a registered ${missing} is discarded before consent`, async () => {
    const incompleteRegistration: Parameters<typeof runSubscription>[0] = {
      ...registration,
    };
    delete incompleteRegistration[missing];
    const { deps, events, revoked, warnings, consentClientIds } = flow({
      revocationStatus: 503,
    });
    await runSubscription(incompleteRegistration, deps);
    assert.deepEqual(events, [
      "read",
      ...(missing === "subjectHash" ? ["revoke"] : []),
      "delete",
      "warn",
      "consent",
      "exchange",
      "save",
      "write",
      "run",
      "kept",
    ]);
    assert.ok(revoked() === (missing === "subjectHash" ? oldToken : null));
    assert.deepEqual(consentClientIds, [
      missing === "subjectHash" ? clientId : undefined,
    ]);
    assert.match(warnings[0] ?? "", /could not be matched to this checkout/);
  });
}

const invalidClientIds = ["dynamic_agent_client", "malformed client ID", ""];

for (const useKeychain of [true, false]) {
  test(`invalid registered client IDs stop the run with Keychain opt-in ${useKeychain}`, async () => {
    for (const clientId of invalidClientIds) {
      const { deps, events, saved } = flow();
      await assert.rejects(
        runSubscription(
          { hostId: registration.hostId, clientId },
          { ...deps, keychain: useKeychain ? deps.keychain : undefined },
        ),
      );
      assert.deepEqual(events, []);
      assert.ok(saved() === oldToken);
    }
  });
}

test("registration loading rejects invalid client IDs and allows a missing one", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "siwc-registration-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, "registration.json");
  const incompleteRegistration = { hostId: registration.hostId };
  await writeFile(file, JSON.stringify(incompleteRegistration));
  assert.deepEqual(await loadRegistration(file), incompleteRegistration);

  for (const clientId of [...invalidClientIds, null, 42]) {
    await writeFile(file, JSON.stringify({ ...registration, clientId }));
    await assert.rejects(loadRegistration(file));
  }
});

for (const [label, refresh] of [
  ["HTTP 503", () => new Response("fixture response body", { status: 503 })],
  [
    "network failure",
    () => {
      throw new TypeError("fixture network failure");
    },
  ],
  [
    "timeout",
    () => {
      throw new DOMException("fixture timeout", "TimeoutError");
    },
  ],
  [
    "body read failure",
    () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.error(new TypeError("fixture interrupted response"));
          },
        }),
      ),
  ],
] as const) {
  test(`refresh ${label} stops and leaves the saved token alone`, async () => {
    const { deps, events, saved } = flow({ refresh });
    await assert.rejects(runSubscription(registration, deps));
    assert.deepEqual(events, ["read", "refresh"]);
    assert.ok(saved() === oldToken);
  });
}

test("refresh revokes the replacement and deletes the item if persistence fails", async () => {
  const { deps, events, revoked } = flow({ persistFails: true });
  await assert.rejects(
    runSubscription(registration, deps),
    /fixture write failed/,
  );
  assert.deepEqual(events, ["read", "refresh", "write", "revoke", "delete"]);
  assert.ok(revoked() === newToken);
});

test("an absent item uses consent and stores the first token", async () => {
  const { deps, events } = flow({ saved: null });
  await runSubscription(registration, deps);
  assert.deepEqual(events, [
    "read",
    "consent",
    "exchange",
    "save",
    "write",
    "run",
    "kept",
  ]);
});

test("a run without opt-in still consents and revokes", async () => {
  const { deps, events, revoked } = flow();
  await runSubscription(registration, { ...deps, keychain: undefined });
  assert.deepEqual(events, ["consent", "exchange", "save", "run", "revoke"]);
  assert.ok(revoked() === newToken);
});

for (const useKeychain of [true, false]) {
  test(`consent subject mismatch revokes the grant with Keychain opt-in ${useKeychain}`, async () => {
    const { deps, events, revoked } = flow({ saved: null });
    await assert.rejects(
      runSubscription(
        { ...registration, subjectHash: "different-subject" },
        { ...deps, keychain: useKeychain ? deps.keychain : undefined },
      ),
    );
    assert.deepEqual(events, [
      ...(useKeychain ? ["read"] : []),
      "consent",
      "exchange",
      "revoke",
      ...(useKeychain ? ["delete"] : []),
    ]);
    assert.ok(revoked() === newToken);
  });
}

test("without Keychain opt-in, consent cannot pass a refresh token to the runner", async () => {
  const { deps, events, revoked } = flow({ consentAccessToken: newToken });
  await assert.rejects(
    runSubscription(registration, { ...deps, keychain: undefined }),
  );
  assert.deepEqual(events, ["consent", "exchange", "save", "revoke"]);
  assert.ok(revoked() === newToken);
});

function serviceFor(hostId: string) {
  const suffix = createHash("sha256").update(hostId).digest("hex").slice(0, 16);
  return `agent-bootstrap.siwc.refresh.${suffix}`;
}

test("Keychain write passes the token only on stdin and reads it back", async () => {
  const calls: string[][] = [];
  let input = "";
  const service = serviceFor(registration.hostId);
  const keychain = makeKeychain(
    "fixture-user",
    registration.hostId,
    (file, args, options, done) => {
      assert.equal(file, "/usr/bin/security");
      assert.deepEqual(options.env, {
        PATH: "/usr/bin:/bin",
        HOME: userInfo().homedir,
      });
      assert.equal(options.maxBuffer, 16 * 1024);
      assert.equal(options.timeout, 30_000);
      assert.ok(args.every((arg) => !arg.includes(newToken)));
      calls.push(args);
      const stdin = new Writable({
        write(chunk, _encoding, next) {
          input += chunk.toString();
          next();
        },
      });
      stdin.on("finish", () =>
        done(null, args[0] === "-i" ? "" : `${newToken}\n`),
      );
      return { stdin };
    },
  );
  await keychain.write(newToken);
  assert.deepEqual(calls, [
    ["-i"],
    ["find-generic-password", "-a", "fixture-user", "-s", service, "-w"],
  ]);
  assert.ok(
    input ===
      `add-generic-password -U -a fixture-user -s ${service} -w ${newToken}\n`,
  );
});

test("Keychain uses a different service for each registration host ID", async () => {
  const hostIds = [
    registration.hostId,
    "urn:uuid:00000000-0000-4000-a000-000000000001",
  ];
  const services: (string | undefined)[] = [];
  for (const hostId of hostIds) {
    const keychain = makeKeychain(
      "fixture-user",
      hostId,
      (_file, args, _options, done) => {
        services.push(args[args.indexOf("-s") + 1]);
        done(null, oldToken);
        return { stdin: null };
      },
    );
    await keychain.read();
    await keychain.delete();
  }
  assert.deepEqual(
    services,
    hostIds.flatMap((hostId) => [serviceFor(hostId), serviceFor(hostId)]),
  );
  assert.notEqual(services[0], services[2]);
});

for (const code of [44, 1]) {
  test(`Keychain read treats exit status ${code} as ${code === 44 ? "missing" : "an error"}`, async () => {
    const keychain = makeKeychain(
      "fixture-user",
      registration.hostId,
      (_file, _args, _options, done) => {
        done(Object.assign(new Error("fixture security error"), { code }), "");
        return { stdin: null };
      },
    );
    if (code === 44) assert.equal(await keychain.read(), null);
    else await assert.rejects(keychain.read(), /Keychain command failed/);
  });
}

test("Keychain write rejects a stdin error", async () => {
  const keychain = makeKeychain(
    "fixture-user",
    registration.hostId,
    (_file, args, _options, done) => {
      assert.deepEqual(args, ["-i"]);
      const stdin = new Writable({
        write(_chunk, _encoding, next) {
          next(new Error("fixture stdin error"));
        },
      });
      stdin.on("error", () => queueMicrotask(() => done(null, "")));
      return { stdin };
    },
  );
  await assert.rejects(keychain.write(newToken), /Keychain command failed/);
});

test("Keychain write rejects a mismatched read-back", async () => {
  const keychain = makeKeychain(
    "fixture-user",
    registration.hostId,
    (_file, args, _options, done) => {
      const stdin = new Writable({
        write(_chunk, _encoding, next) {
          next();
        },
      });
      stdin.on("finish", () => done(null, args[0] === "-i" ? "" : oldToken));
      return { stdin };
    },
  );
  await assert.rejects(keychain.write(newToken), /Keychain read-back failed/);
});

for (const revocationStatus of [200, 503]) {
  test(`forget deletes after revocation HTTP ${revocationStatus}`, async () => {
    const { deps, events, revoked } = flow({ revocationStatus });
    const exit = await forgetRefreshToken(
      async () => {
        events.push("load");
        return registration;
      },
      (hostId) => {
        assert.equal(hostId, registration.hostId);
        return deps.keychain;
      },
      deps.request,
      (message) => {
        assert.match(message, /Removed.*Keychain/);
        events.push("report");
      },
      (message) => {
        assert.match(message, /Disconnect Agent Bootstrap in ChatGPT settings/);
        events.push("warn");
      },
    );
    assert.equal(exit, revocationStatus === 200 ? 0 : 1);
    assert.deepEqual(events, [
      "load",
      "read",
      "revoke",
      ...(revocationStatus === 200 ? [] : ["warn"]),
      "delete",
      "report",
    ]);
    assert.ok(revoked() === oldToken);
  });
}

test("forget succeeds when no item exists", async () => {
  const { deps, events } = flow({ saved: null });
  const exit = await forgetRefreshToken(
    async () => registration,
    () => deps.keychain,
    deps.request,
    (message) => assert.match(message, /No refresh token/),
    () => assert.fail("unexpected revocation warning"),
  );
  assert.equal(exit, 0);
  assert.deepEqual(events, ["read"]);
});

test("forget without a registration skips Keychain access and revocation", async () => {
  const reports: string[] = [];
  const exit = await forgetRefreshToken(
    async () => null,
    () => assert.fail("unexpected Keychain access"),
    async () => assert.fail("unexpected OAuth request"),
    (message) => reports.push(message),
    () => assert.fail("unexpected revocation warning"),
  );
  assert.equal(exit, 0);
  assert.deepEqual(reports, [
    "No registration found. There is nothing to forget for this checkout.",
  ]);
});

test("forget reports unreadable registration without exposing file contents", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "siwc-forget-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, "registration.json");
  const contents = "fixture malformed registration contents";
  const invalidHost = join(root, "invalid-host.json");
  const invalidClient = join(root, "invalid-client.json");
  await writeFile(file, contents);
  await writeFile(
    invalidHost,
    JSON.stringify({ ...registration, hostId: `urn:uuid:${"a".repeat(36)}` }),
  );
  await writeFile(
    invalidClient,
    JSON.stringify({ ...registration, clientId: "dynamic_agent_client" }),
  );

  // The directory cannot be read as a registration file on macOS.
  for (const path of [root, file, invalidHost, invalidClient]) {
    const warnings: string[] = [];
    const exit = await forgetRefreshToken(
      () => loadRegistration(path),
      () => assert.fail("unexpected Keychain access"),
      async () => assert.fail("unexpected OAuth request"),
      () => assert.fail("unexpected stdout report"),
      (message) => warnings.push(message),
    );
    assert.equal(exit, 1);
    assert.equal(warnings.length, 1);
    const warning = warnings[0]!;
    assert.match(warning, /registration is unreadable.*item cannot be located/);
    assert.match(warning, /Disconnect Agent Bootstrap in ChatGPT settings/);
    assert.match(
      warning,
      /remove.*agent-bootstrap\.siwc\.refresh\.\*.*by hand/,
    );
    assert.ok(!warning.includes(contents));
  }
});

test("forget attempts deletion and reports failed revocation if the item cannot be read", async () => {
  const { deps, events } = flow();
  const exit = await forgetRefreshToken(
    async () => registration,
    () => ({
      ...deps.keychain,
      async read() {
        throw new Error("fixture read denied");
      },
    }),
    deps.request,
    () => events.push("report"),
    (message) => {
      assert.match(message, /Disconnect Agent Bootstrap in ChatGPT settings/);
      events.push("warn");
    },
  );
  assert.equal(exit, 1);
  assert.deepEqual(events, ["warn", "delete", "report"]);
});
