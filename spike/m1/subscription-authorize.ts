import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  createHash,
  createPublicKey,
  randomBytes,
  randomUUID,
  timingSafeEqual,
  verify,
} from "node:crypto";
import {
  mkdir,
  open,
  readFile,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const issuer = "https://auth.openai.com";
const resource = "https://api.openai.com/v1";
const scope = "chatgpt.tokens.use.direct";
const dynamicClient = "dynamic_agent_client";
const statePath = fileURLToPath(
  new URL("../../.local/siwc-smoke/", import.meta.url),
);
const smoke = fileURLToPath(
  new URL("./subscription-smoke.ts", import.meta.url),
);
const validId = (value: unknown) =>
  typeof value === "string" && /^[a-zA-Z0-9_-]{1,256}$/.test(value);
const random = () => randomBytes(32).toString("base64url");
const sha256 = (value: string) =>
  createHash("sha256").update(value).digest("base64url");
let stage = "operator opt-in and prerequisites";

type Registration = { hostId: string; clientId?: string; subjectHash?: string };
type Callback = { code: string; clientId: string };

async function saveRegistration(file: string, registration: Registration) {
  const temporary = `${file}.${randomUUID()}`;
  try {
    await writeFile(temporary, JSON.stringify(registration), {
      flag: "wx",
      mode: 0o600,
    });
    await rename(temporary, file);
  } finally {
    await unlink(temporary).catch(() => {});
  }
}

export function acceptCallback(
  url: URL,
  state: string,
  issued?: string,
): Callback | null {
  const query = url.searchParams;
  const received = query.get("state");
  if (
    url.pathname !== "/auth/callback" ||
    query.getAll("state").length !== 1 ||
    !received ||
    !timingSafeEqual(Buffer.from(sha256(received)), Buffer.from(sha256(state)))
  ) {
    return null;
  }
  assert.equal(query.has("error"), false);
  assert.equal(query.getAll("code").length, 1);
  assert.ok(query.getAll("client_id").length <= 1);
  const code = query.get("code");
  const clientId = query.get("client_id") ?? issued;
  assert.ok(
    code && validId(clientId) && clientId && clientId !== dynamicClient,
  );
  assert.ok(issued === undefined || clientId === issued);
  return { code, clientId };
}

export function verifyIdentity(
  idToken: string,
  keys: readonly Record<string, unknown>[],
  clientId: string,
  nonce: string,
): string {
  assert.match(idToken, /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  const [header, payload, signature] = idToken.split(".");
  assert.ok(header && payload && signature);
  const protectedHeader = JSON.parse(
    Buffer.from(header, "base64url").toString("utf8"),
  );
  assert.equal(protectedHeader.alg, "RS256");
  assert.ok(typeof protectedHeader.kid === "string" && protectedHeader.kid);
  const matches = keys.filter(
    (key) =>
      key.kid === protectedHeader.kid &&
      key.kty === "RSA" &&
      (key.use === undefined || key.use === "sig") &&
      (key.alg === undefined || key.alg === "RS256"),
  );
  assert.equal(matches.length, 1);
  const match = matches[0];
  assert.ok(
    match && typeof match.n === "string" && typeof match.e === "string",
  );
  const key = createPublicKey({
    key: { kty: "RSA", n: match.n, e: match.e },
    format: "jwk",
  });
  assert.ok(
    verify(
      "RSA-SHA256",
      Buffer.from(`${header}.${payload}`),
      key,
      Buffer.from(signature, "base64url"),
    ),
  );
  const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  assert.equal(claims.iss, issuer);
  assert.ok(
    claims.aud === clientId ||
      (Array.isArray(claims.aud) &&
        claims.aud.includes(clientId) &&
        (claims.aud.length === 1 || claims.azp === clientId)),
  );
  assert.ok(claims.azp === undefined || claims.azp === clientId);
  assert.equal(claims.nonce, nonce);
  const now = Date.now() / 1000;
  assert.ok(Number.isSafeInteger(claims.exp) && claims.exp > now);
  assert.ok(
    claims.nbf === undefined ||
      (Number.isSafeInteger(claims.nbf) && claims.nbf <= now),
  );
  assert.ok(typeof claims.sub === "string" && claims.sub);
  return claims.sub;
}

async function request(url: string, body?: URLSearchParams): Promise<Response> {
  const response = await fetch(url, {
    ...(body ? { method: "POST", body } : {}),
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
  });
  assert.ok(response.ok);
  return response;
}

async function waitForConsent(registration: Registration, signal: AbortSignal) {
  const state = random(),
    nonce = random(),
    verifier = random();
  let complete!: (value: Callback) => void;
  let fail!: (error: unknown) => void;
  let accepted = false;
  const callback = new Promise<Callback>((resolve, reject) => {
    complete = resolve;
    fail = reject;
  });
  void callback.catch(() => {});
  const server = createServer((req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Connection", "close");
    if (
      req.method !== "GET" ||
      !req.url?.startsWith("/auth/callback?") ||
      accepted
    ) {
      res.writeHead(404).end();
      return;
    }
    try {
      const result = acceptCallback(
        new URL(req.url, "http://127.0.0.1"),
        state,
        registration.clientId,
      );
      if (!result) {
        res.writeHead(400).end("Wrong authorization state.");
        return;
      }
      accepted = true;
      res.end(
        "Authorization received. Return to the terminal for the test result.",
        () => complete(result),
      );
    } catch {
      accepted = true;
      res.writeHead(400).end("Authorization was declined or incomplete.");
      fail(new Error("Authorization was declined or incomplete"));
    }
  });
  const cancel = () => fail(new Error("Authorization interrupted"));
  const deadline = setTimeout(cancel, 300_000);
  signal.addEventListener("abort", cancel, { once: true });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    signal.throwIfAborted();
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const redirectUri = `http://127.0.0.1:${address.port}/auth/callback`;
    const url = new URL(issuer + "/api/accounts/authorize");
    url.search = new URLSearchParams({
      client_id: registration.clientId ?? dynamicClient,
      ...(registration.clientId ? {} : { agent_name_hint: "agent-bootstrap" }),
      ext_agent_host_id: registration.hostId,
      response_type: "code",
      redirect_uri: redirectUri,
      resource,
      scope: `openid profile email offline_access resource.invoke ${scope}`,
      state,
      nonce,
      code_challenge_method: "S256",
      code_challenge: sha256(verifier),
    }).toString();
    console.log("Open this URL in your browser and approve Agent Bootstrap:");
    console.log(url.href);
    return { ...(await callback), nonce, verifier, redirectUri };
  } finally {
    clearTimeout(deadline);
    signal.removeEventListener("abort", cancel);
    server.closeAllConnections();
    server.close();
  }
}

async function runSmoke(
  msb: string,
  codex: string,
  home: string,
  token: string,
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  const child = spawn(process.execPath, [smoke, "--live", msb, codex], {
    env: { PATH: "/usr/bin:/bin", MSB_HOME: home },
    stdio: ["pipe", "inherit", "inherit"],
  });
  const cancel = () => child.kill("SIGTERM");
  signal.addEventListener("abort", cancel, { once: true });
  try {
    child.stdin.on("error", () => {});
    child.stdin.end(token);
    const status = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    signal.throwIfAborted();
    assert.equal(status, 0);
  } finally {
    signal.removeEventListener("abort", cancel);
  }
}

async function main() {
  const [optIn, msb, codex] = process.argv.slice(2);
  const home = process.env.MSB_HOME;
  assert.equal(optIn, "--authorize-and-run");
  assert.ok(process.stdin.isTTY && process.stdout.isTTY);
  assert.ok(msb && msb.startsWith("/") && !/[\0:\r\n]/.test(msb));
  assert.ok(codex && codex.startsWith("/"));
  assert.ok(home && home.startsWith("/"));
  await mkdir(statePath, { recursive: true, mode: 0o700 });
  const lockPath = join(statePath, "run.lock");
  const lock = await open(lockPath, "wx", 0o600);
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.on("SIGINT", cancel);
  process.on("SIGTERM", cancel);
  let refresh: string | undefined;
  let exchangeClientId: string | undefined;
  try {
    const file = join(statePath, "registration.json");
    let registration: Registration;
    try {
      registration = JSON.parse(await readFile(file, "utf8"));
      assert.match(registration.hostId, /^urn:uuid:[0-9a-f-]{36}$/);
      assert.ok(
        registration.clientId === undefined || validId(registration.clientId),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      registration = { hostId: `urn:uuid:${randomUUID()}` };
      await saveRegistration(file, registration);
    }
    stage = "browser consent";
    const authorization = await waitForConsent(registration, controller.signal);
    controller.signal.throwIfAborted();
    stage = "OAuth exchange and identity validation";
    const clientId = authorization.clientId;
    exchangeClientId = clientId;
    const tokens = await (
      await request(
        issuer + "/api/accounts/oauth/token",
        new URLSearchParams({
          grant_type: "authorization_code",
          client_id: clientId,
          code: authorization.code,
          code_verifier: authorization.verifier,
          redirect_uri: authorization.redirectUri,
          resource,
        }),
      )
    ).json();
    if (typeof tokens.refresh_token === "string" && tokens.refresh_token)
      refresh = tokens.refresh_token;
    assert.ok(refresh);
    assert.ok(
      typeof tokens.token_type === "string" &&
        tokens.token_type.toLowerCase() === "bearer" &&
        typeof tokens.access_token === "string" &&
        typeof tokens.id_token === "string",
    );
    assert.ok(
      typeof tokens.scope === "string" &&
        tokens.scope.split(/\s+/).includes(scope),
    );
    const jwks = await (
      await request(issuer + "/.well-known/jwks.json")
    ).json();
    assert.ok(Array.isArray(jwks.keys));
    const subjectHash = sha256(
      verifyIdentity(tokens.id_token, jwks.keys, clientId, authorization.nonce),
    );
    assert.ok(
      !registration.subjectHash || registration.subjectHash === subjectHash,
    );
    await saveRegistration(file, { ...registration, clientId, subjectHash });
    stage = "subscription smoke";
    await runSmoke(msb, codex, home, tokens.access_token, controller.signal);
  } finally {
    try {
      if (exchangeClientId) {
        const revoked = refresh
          ? await request(
              issuer + "/api/accounts/oauth/revoke",
              new URLSearchParams({
                token: refresh,
                token_type_hint: "refresh_token",
                client_id: exchangeClientId,
              }),
            ).then(
              () => true,
              () => false,
            )
          : false;
        if (!revoked) {
          console.error(
            "OAuth revocation could not be confirmed. Disconnect Agent Bootstrap in ChatGPT settings.",
          );
          process.exitCode = 1;
        }
      }
    } finally {
      await lock.close();
      await unlink(lockPath);
      process.off("SIGINT", cancel);
      process.off("SIGTERM", cancel);
    }
  }
}

if (import.meta.main) {
  try {
    await main();
  } catch {
    console.error(`Subscription authorization stopped at ${stage}.`);
    process.exitCode = 1;
  }
}
