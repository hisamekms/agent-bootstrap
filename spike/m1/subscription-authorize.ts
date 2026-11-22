import assert from "node:assert/strict";
import {
  execFile,
  spawn,
  type ChildProcess,
  type ExecFileException,
} from "node:child_process";
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
import { userInfo } from "node:os";
import { isAbsolute, join } from "node:path";
import { createInterface, type Interface } from "node:readline/promises";
import { fileURLToPath } from "node:url";

const issuer = "https://auth.openai.com";
const resource = "https://api.openai.com/v1";
const scope = "chatgpt.tokens.use.direct";
const dynamicClient = "dynamic_agent_client";
const keychainService = "agent-bootstrap.siwc.refresh";
const maxKeychainOutput = 16 * 1024;
const revocationWarning =
  "OAuth revocation could not be confirmed. Disconnect Agent Bootstrap in ChatGPT settings.";
const rejectedGrantWarning =
  "The saved ChatGPT grant was rejected. If you did not expect this, disconnect Agent Bootstrap in ChatGPT settings.";
const statePath = fileURLToPath(
  new URL("../../.local/siwc-smoke/", import.meta.url),
);
// The operator chooses which live runner receives the access token.
const runners: Record<string, string> = {
  "--authorize-and-run": fileURLToPath(
    new URL("./subscription-smoke.ts", import.meta.url),
  ),
  "--authorize-and-run-m5": fileURLToPath(
    new URL("../m5/dogfood.ts", import.meta.url),
  ),
};
const validId = (value: unknown) =>
  typeof value === "string" && /^[a-zA-Z0-9_-]{1,256}$/.test(value);
const isIssuedClientId = (value: unknown): value is string =>
  validId(value) && value !== dynamicClient;
const random = () => randomBytes(32).toString("base64url");
const sha256 = (value: string) =>
  createHash("sha256").update(value).digest("base64url");
let stage = "operator opt-in and prerequisites";

type Registration = { hostId: string; clientId?: string; subjectHash?: string };
type Callback = { code: string; clientId: string };
type Consent = Callback & {
  nonce: string;
  verifier: string;
  redirectUri: string;
};
type Request = (url: string, body?: URLSearchParams) => Promise<Response>;
type IdentityCheck = { nonce: string } | { refresh: true };
type Keychain = {
  read(): Promise<string | null>;
  write(token: string): Promise<void>;
  delete(): Promise<void>;
};
type StartSecurity = (
  file: string,
  args: string[],
  options: {
    env: { PATH: string; HOME: string };
    maxBuffer: number;
    timeout: number;
  },
  callback: (error: ExecFileException | null, stdout: string) => void,
) => Pick<ChildProcess, "stdin">;

export function makeKeychain(
  account: string | undefined,
  hostId: string,
  start: StartSecurity = execFile,
): Keychain {
  assert.ok(
    account && /^[A-Za-z0-9._-]+$/.test(account),
    "invalid Keychain account",
  );
  const home = userInfo().homedir;
  assert.ok(isAbsolute(home), "invalid Keychain home directory");
  const suffix = createHash("sha256").update(hostId).digest("hex").slice(0, 16);
  const item = ["-a", account, "-s", `${keychainService}.${suffix}`];

  function security(args: string[], input?: string): Promise<string | null> {
    return new Promise((resolve, reject) => {
      let inputFailed = false;
      const child = start(
        "/usr/bin/security",
        args,
        {
          env: { PATH: "/usr/bin:/bin", HOME: home },
          maxBuffer: maxKeychainOutput,
          timeout: 30_000,
        },
        (error, stdout) => {
          if (
            inputFailed ||
            (error && (input !== undefined || error.code !== 44))
          ) {
            reject(new Error("Keychain command failed"));
          } else {
            resolve(error ? null : stdout);
          }
        },
      );
      child.stdin?.on("error", () => {
        // Wait for the command to exit before the caller can delete the item.
        inputFailed = true;
      });
      child.stdin?.end(input);
    });
  }

  function findPassword() {
    return security(["find-generic-password", ...item, "-w"]);
  }

  return {
    async read() {
      return (await findPassword())?.trim() ?? null;
    },
    async write(token) {
      assert.ok(
        /^[A-Za-z0-9._~+/=-]{20,8192}$/.test(token),
        "invalid Keychain token format",
      );
      await security(
        ["-i"],
        `add-generic-password -U ${item.join(" ")} -w ${token}\n`,
      );
      const stored = (await findPassword())?.replace(/\r?\n$/, "");
      assert.ok(
        stored !== undefined &&
          timingSafeEqual(
            Buffer.from(sha256(stored)),
            Buffer.from(sha256(token)),
          ),
        "Keychain read-back failed",
      );
    },
    async delete() {
      await security(["delete-generic-password", ...item]);
    },
  };
}

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
  assert.ok(code && isIssuedClientId(clientId));
  assert.ok(issued === undefined || clientId === issued);
  return { code, clientId };
}

export function verifyIdentity(
  idToken: string,
  keys: readonly Record<string, unknown>[],
  clientId: string,
  check: IdentityCheck,
): string {
  // assert.ok, not assert.match: a failed match would quote the token.
  assert.ok(
    /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(idToken),
    "token shape",
  );
  const [header, payload, signature] = idToken.split(".");
  assert.ok(header && payload && signature);
  const protectedHeader = JSON.parse(
    Buffer.from(header, "base64url").toString("utf8"),
  );
  assert.ok(protectedHeader.alg === "RS256");
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
  assert.ok(claims.iss === issuer);
  assert.ok(
    claims.aud === clientId ||
      (Array.isArray(claims.aud) &&
        claims.aud.includes(clientId) &&
        (claims.aud.length === 1 || claims.azp === clientId)),
  );
  assert.ok(claims.azp === undefined || claims.azp === clientId);
  if ("nonce" in check) assert.ok(claims.nonce === check.nonce);
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
  return fetch(url, {
    ...(body ? { method: "POST", body } : {}),
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
  });
}

async function waitForConsent(
  hostId: string,
  clientId: string | undefined,
  signal: AbortSignal,
) {
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
        clientId,
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
  let prompt: Interface | undefined;
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
      client_id: clientId ?? dynamicClient,
      ...(clientId ? {} : { agent_name_hint: "agent-bootstrap" }),
      ext_agent_host_id: hostId,
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
    // Enter opens the issuer URL in the default browser. The callback is
    // accepted meanwhile, so opening it by hand still works.
    if (process.platform === "darwin") {
      prompt = createInterface({
        input: process.stdin,
        output: process.stdout,
      });
      prompt.question("Press Enter to open it in your browser. ").then(
        () => {
          if (url.origin !== issuer) return;
          spawn("/usr/bin/open", [url.href], { stdio: "ignore" }).on(
            "error",
            () =>
              console.log("Could not open the browser; open the URL above."),
          );
        },
        () => {},
      );
    }
    return { ...(await callback), nonce, verifier, redirectUri };
  } finally {
    prompt?.close();
    clearTimeout(deadline);
    signal.removeEventListener("abort", cancel);
    server.closeAllConnections();
    server.close();
  }
}

async function runSmoke(
  smoke: string,
  msb: string,
  codex: string,
  home: string,
  token: string,
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  const child = spawn(process.execPath, [smoke, "--live", msb, codex], {
    // Only the non-secret M5 settings (and USER, for the keychain
    // lookup) pass through; the token goes on stdin.
    env: {
      PATH: "/usr/bin:/bin",
      MSB_HOME: home,
      ...Object.fromEntries(
        Object.entries(process.env).filter(
          ([name, value]) =>
            value !== undefined &&
            (name === "USER" ||
              /^M5_(ACTORS|DEBUG_WORKER|CLAUDE_(BINARY|MODEL|AUTH|KEYCHAIN))$/.test(
                name,
              )),
        ),
      ),
    },
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

async function revoke(request: Request, clientId: string, token: string) {
  try {
    return (
      await request(
        issuer + "/api/accounts/oauth/revoke",
        new URLSearchParams({
          token,
          token_type_hint: "refresh_token",
          client_id: clientId,
        }),
      )
    ).ok;
  } catch {
    return false;
  }
}

function parseOAuthJson(body: string): Record<string, unknown> {
  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    throw new Error("Invalid OAuth response");
  }
  assert.ok(payload && typeof payload === "object" && !Array.isArray(payload));
  return payload as Record<string, unknown>;
}

async function readOAuthBody(response: Response): Promise<string> {
  assert.ok(response.ok, "OAuth request failed");
  return response.text().catch(() => {
    throw new Error("Could not read OAuth response");
  });
}

async function verifiedSubjectHash(
  idToken: string,
  clientId: string,
  request: Request,
  check: IdentityCheck,
) {
  const jwks = parseOAuthJson(
    await readOAuthBody(await request(issuer + "/.well-known/jwks.json")),
  );
  assert.ok(Array.isArray(jwks.keys));
  try {
    return sha256(verifyIdentity(idToken, jwks.keys, clientId, check));
  } catch {
    throw new Error("OAuth identity validation failed");
  }
}

export async function runSubscription(
  registration: Registration,
  {
    request,
    keychain,
    consent,
    save,
    run,
    report,
    warn,
    onUnconfirmedRevocation,
  }: {
    request: Request;
    keychain: Keychain | undefined;
    consent(clientId: string | undefined): Promise<Consent>;
    save(registration: Registration): Promise<void>;
    run(accessToken: string): Promise<void>;
    report(message: string): void;
    warn(message: string): void;
    onUnconfirmedRevocation(): void;
  },
) {
  let refresh: string | undefined;
  let exchangeClientId: string | undefined;
  let kept = false;
  try {
    const { clientId, subjectHash } = registration;
    assert.ok(clientId === undefined || isIssuedClientId(clientId));
    assert.ok(
      subjectHash === undefined ||
        (typeof subjectHash === "string" && subjectHash.length > 0),
    );
    let accessToken: string | undefined;
    if (keychain) {
      stage = "Keychain lookup and OAuth refresh";
      const saved = await keychain.read();
      if (saved !== null && clientId && subjectHash) {
        const response = await request(
          issuer + "/api/accounts/oauth/token",
          new URLSearchParams({
            grant_type: "refresh_token",
            client_id: clientId,
            refresh_token: saved,
            resource,
          }),
        );
        if (response.status === 400 || response.status === 401) {
          await revoke(request, clientId, saved);
          await keychain.delete();
          warn(rejectedGrantWarning);
        } else {
          assert.ok(response.status === 200, "OAuth refresh failed");
          // A transport failure while reading the body also leaves the item alone.
          const body = await readOAuthBody(response);
          exchangeClientId = clientId;
          // If the response omits the replacement, attempt to revoke the saved token.
          refresh = saved;
          const tokens = parseOAuthJson(body);
          if (typeof tokens.refresh_token === "string" && tokens.refresh_token)
            refresh = tokens.refresh_token;
          assert.ok(
            refresh !== saved,
            "OAuth refresh did not rotate the token",
          );
          assert.ok(
            typeof tokens.token_type === "string" &&
              tokens.token_type.toLowerCase() === "bearer" &&
              typeof tokens.access_token === "string" &&
              tokens.access_token !== saved,
          );
          assert.ok(
            tokens.scope === undefined ||
              (typeof tokens.scope === "string" &&
                tokens.scope.split(/\s+/).includes(scope)),
          );
          assert.ok(
            tokens.expires_in === undefined ||
              (typeof tokens.expires_in === "number" &&
                Number.isFinite(tokens.expires_in) &&
                tokens.expires_in >= 1200),
          );
          if (tokens.id_token !== undefined) {
            assert.ok(typeof tokens.id_token === "string");
            assert.ok(
              (await verifiedSubjectHash(tokens.id_token, clientId, request, {
                refresh: true,
              })) === subjectHash,
            );
          }
          accessToken = tokens.access_token;
        }
      } else if (saved !== null) {
        if (clientId) await revoke(request, clientId, saved);
        await keychain.delete();
        warn(
          "The saved ChatGPT grant could not be matched to this checkout's registration. If you did not expect this, disconnect Agent Bootstrap in ChatGPT settings.",
        );
      }
    }

    if (accessToken === undefined) {
      stage = "browser consent";
      const authorization = await consent(clientId);
      stage = "OAuth exchange and identity validation";
      exchangeClientId = authorization.clientId;
      const response = await request(
        issuer + "/api/accounts/oauth/token",
        new URLSearchParams({
          grant_type: "authorization_code",
          client_id: exchangeClientId,
          code: authorization.code,
          code_verifier: authorization.verifier,
          redirect_uri: authorization.redirectUri,
          resource,
        }),
      );
      const tokens = parseOAuthJson(await readOAuthBody(response));
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
      const verifiedHash = await verifiedSubjectHash(
        tokens.id_token,
        exchangeClientId,
        request,
        { nonce: authorization.nonce },
      );
      assert.ok(!subjectHash || subjectHash === verifiedHash);
      await save({
        ...registration,
        clientId: exchangeClientId,
        subjectHash: verifiedHash,
      });
      accessToken = tokens.access_token;
    }
    assert.ok(refresh && /^\S+$/.test(accessToken) && accessToken !== refresh);
    if (keychain) {
      stage = "Keychain persistence";
      await keychain.write(refresh);
      kept = true;
    }
    stage = "subscription smoke";
    await run(accessToken);
  } finally {
    if (kept) {
      report(
        "Refresh token kept in the macOS Keychain. Run with --forget to remove it.",
      );
    } else if (exchangeClientId) {
      try {
        if (!refresh || !(await revoke(request, exchangeClientId, refresh))) {
          onUnconfirmedRevocation();
        }
      } finally {
        if (refresh !== undefined) await keychain?.delete();
      }
    }
  }
}

export async function forgetRefreshToken(
  loadRegistration: () => Promise<Registration | null>,
  keychainForHost: (hostId: string) => Keychain,
  request: Request,
  report: (message: string) => void,
  warn: (message: string) => void,
): Promise<number> {
  let registration: Registration | null;
  try {
    registration = await loadRegistration();
  } catch {
    warn(
      `The registration is unreadable, so this checkout's Keychain item cannot be located. Disconnect Agent Bootstrap in ChatGPT settings and remove any leftover ${keychainService}.* items by hand.`,
    );
    return 1;
  }
  if (registration === null) {
    report(
      "No registration found. There is nothing to forget for this checkout.",
    );
    return 0;
  }
  const keychain = keychainForHost(registration.hostId);
  const token = await keychain.read().catch(() => undefined);
  if (token === null) {
    report("No refresh token found in the macOS Keychain.");
    return 0;
  }

  let revoked = false;
  try {
    if (token !== undefined) {
      const { clientId } = registration;
      if (isIssuedClientId(clientId)) {
        revoked = await revoke(request, clientId, token);
      }
    }
    if (!revoked) warn(revocationWarning);
  } finally {
    await keychain.delete();
  }
  report("Removed the refresh token from the macOS Keychain.");
  return revoked ? 0 : 1;
}

export async function loadRegistration(
  file: string,
): Promise<Registration | null> {
  try {
    const registration: Registration = JSON.parse(await readFile(file, "utf8"));
    assert.ok(
      typeof registration.hostId === "string" &&
        /^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
          registration.hostId,
        ),
    );
    const { clientId, subjectHash } = registration;
    assert.ok(clientId === undefined || isIssuedClientId(clientId));
    assert.ok(
      subjectHash === undefined ||
        (typeof subjectHash === "string" && subjectHash.length > 0),
    );
    return registration;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return null;
  }
}

export function parseArgs(argv: readonly string[]) {
  const [optIn, ...args] = argv;
  if (optIn === "--forget") {
    assert.ok(args.length === 0);
    return { forget: true } as const;
  }
  assert.ok(optIn && Object.hasOwn(runners, optIn));
  const runner = runners[optIn]!;
  const useKeychain = args[0] === "--keychain";
  const positional = useKeychain ? args.slice(1) : args;
  assert.ok(positional.length === 2);
  const [msb, codex] = positional;
  assert.ok(msb && msb.startsWith("/") && !/[\0:\r\n]/.test(msb));
  assert.ok(codex && codex.startsWith("/"));
  return { forget: false, useKeychain, runner, msb, codex } as const;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const home = process.env.MSB_HOME;
  assert.ok(process.stdin.isTTY && process.stdout.isTTY);
  if (!options.forget) assert.ok(home && home.startsWith("/"));
  if (options.forget || options.useKeychain) {
    assert.ok(process.platform === "darwin");
  }
  await mkdir(statePath, { recursive: true, mode: 0o700 });
  const lockPath = join(statePath, "run.lock");
  const lock = await open(lockPath, "wx", 0o600);
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.on("SIGINT", cancel);
  process.on("SIGTERM", cancel);
  try {
    const file = join(statePath, "registration.json");
    const keychainForHost = (hostId: string) =>
      makeKeychain(process.env.USER, hostId);
    if (options.forget) {
      stage = "Keychain removal";
      process.exitCode = await forgetRefreshToken(
        () => loadRegistration(file),
        keychainForHost,
        request,
        console.log,
        console.error,
      );
      return;
    }

    let registration = await loadRegistration(file);
    if (registration === null) {
      registration = { hostId: `urn:uuid:${randomUUID()}` };
      await saveRegistration(file, registration);
    }
    await runSubscription(registration, {
      request,
      keychain: options.useKeychain
        ? keychainForHost(registration.hostId)
        : undefined,
      async consent(clientId) {
        const authorization = await waitForConsent(
          registration.hostId,
          clientId,
          controller.signal,
        );
        controller.signal.throwIfAborted();
        return authorization;
      },
      save: (updated) => saveRegistration(file, updated),
      run: (token) =>
        runSmoke(
          options.runner,
          options.msb,
          options.codex,
          home!,
          token,
          controller.signal,
        ),
      report: console.log,
      warn: console.error,
      onUnconfirmedRevocation() {
        console.error(revocationWarning);
        process.exitCode = 1;
      },
    });
  } finally {
    await lock.close();
    await unlink(lockPath);
    process.off("SIGINT", cancel);
    process.off("SIGTERM", cancel);
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
