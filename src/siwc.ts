import type { SqliteAudit } from "./audit.ts";
import { SandboxRuntimeError } from "./sandbox-runtime.ts";
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
import { link, open, readFile, unlink, writeFile } from "node:fs/promises";
import { constants, lstatSync, unlinkSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { userInfo } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { isDeepStrictEqual } from "node:util";
import {
  missing,
  privatePath,
  readPrivateConfig,
  userStateDirectory,
  writePrivateConfig,
} from "./config/layers.ts";
import { repository } from "./config/projects.ts";
import type { CredentialProvider } from "./credentials.ts";

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

const validId = (value: unknown) =>
  typeof value === "string" && /^[a-zA-Z0-9_-]{1,256}$/.test(value);
const isIssuedClientId = (value: unknown): value is string =>
  validId(value) && value !== dynamicClient;
const random = () => randomBytes(32).toString("base64url");
const sha256 = (value: string) =>
  createHash("sha256").update(value).digest("base64url");

type Registration = {
  hostId: string;
  clientId?: string;
  subjectHash?: string;
  identityVerificationPending?: true;
  migratedFrom?: string;
  legacyRetired?: true;
  /** The source account of an interrupted move, or true after the account check. */
  legacyAccountMigration?: string | true;
  legacyAccountCleanup?: string;
};
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

function serviceForHost(hostId: string) {
  const suffix = createHash("sha256").update(hostId).digest("hex").slice(0, 16);
  return `${keychainService}.${suffix}`;
}

const validAccount = (account: string | undefined): account is string =>
  !!account && /^[A-Za-z0-9._-]+$/.test(account);

export function makeKeychain(
  account: string | undefined,
  hostId: string,
  start: StartSecurity = execFile,
): Keychain {
  assert.ok(validAccount(account), "invalid Keychain account");
  const home = userInfo().homedir;
  assert.ok(isAbsolute(home), "invalid Keychain home directory");
  const item = ["-a", account, "-s", serviceForHost(hostId)];

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
  report: (message: string) => void,
) {
  assert.ok(process.stdin.isTTY && process.stdout.isTTY);
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
        "Authorization received. Return to the terminal for the result.",
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
    report("Approve Agent Bootstrap in your browser.");
    await new Promise<void>((resolve, reject) => {
      const browser = spawn(
        process.platform === "darwin" ? "/usr/bin/open" : "/usr/bin/xdg-open",
        [url.href],
        { stdio: "ignore", signal, timeout: 10_000, killSignal: "SIGKILL" },
      );
      browser.once("error", reject);
      browser.once("close", (status) => {
        if (status === 0) resolve();
        else reject(new Error("Could not open the browser"));
      });
    }).catch(() => {
      signal.throwIfAborted();
      report(
        `Open this URL in your browser to approve Agent Bootstrap: ${url.href}`,
      );
    });
    return { ...(await callback), nonce, verifier, redirectUri };
  } finally {
    clearTimeout(deadline);
    signal.removeEventListener("abort", cancel);
    server.closeAllConnections();
    server.close();
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
  let keys: readonly Record<string, unknown>[];
  try {
    const jwks = parseOAuthJson(
      await readOAuthBody(await request(issuer + "/.well-known/jwks.json")),
    );
    assert.ok(Array.isArray(jwks.keys));
    keys = jwks.keys;
  } catch {
    throw new IdentityUnavailable(
      "Retry when the OpenAI signing keys are available.",
    );
  }
  try {
    return sha256(verifyIdentity(idToken, keys, clientId, check));
  } catch {
    throw new Error("OAuth identity validation failed");
  }
}

const siwcNext = {
  "siwc-missing": "Run agent-bootstrap codex authorize.",
  "siwc-rejected": "Run agent-bootstrap codex authorize.",
  "siwc-unavailable": "Check Keychain and retry later.",
} as const;

export type SiwcCode = keyof typeof siwcNext;

export class SiwcError extends Error {
  readonly code: SiwcCode;
  readonly next: string;

  constructor(code: SiwcCode, next = siwcNext[code] as string) {
    super(code);
    this.code = code;
    this.next = next;
  }
}

class RejectedSavedGrant extends SiwcError {
  constructor() {
    super("siwc-rejected");
  }
}

class IdentityUnavailable extends SiwcError {
  constructor(next: string) {
    super("siwc-unavailable", next);
  }
}

const pendingIdentityNext =
  "Retry the refresh, or run agent-bootstrap codex forget and then agent-bootstrap codex authorize.";

// After a readable success response the issuer may already have rotated the
// token. Keep the saved rotation if signing keys are unavailable. On validation
// or persistence failure, revoke the replacement and clear the item.
async function refreshGrant(
  {
    clientId,
    subjectHash,
    identityVerificationPending,
  }: {
    clientId: string;
    subjectHash: string;
    identityVerificationPending: true | undefined;
  },
  keychain: Keychain,
  request: Request,
  saved: string,
  onUnconfirmedRevocation: () => void,
  setIdentityPending?: (pending: boolean) => void,
): Promise<string> {
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
    throw new RejectedSavedGrant();
  }
  if (response.status !== 200) throw new SiwcError("siwc-unavailable");
  const body = await readOAuthBody(response);
  let refresh = saved;
  try {
    const tokens = parseOAuthJson(body);
    if (typeof tokens.refresh_token === "string" && tokens.refresh_token)
      refresh = tokens.refresh_token;
    assert.ok(refresh !== saved, "OAuth refresh did not rotate the token");
    if (tokens.id_token !== undefined && !identityVerificationPending)
      setIdentityPending?.(true);
    await keychain.write(refresh);
    assert.ok(
      typeof tokens.token_type === "string" &&
        tokens.token_type.toLowerCase() === "bearer" &&
        typeof tokens.access_token === "string" &&
        /^\S+$/.test(tokens.access_token) &&
        tokens.access_token !== saved &&
        tokens.access_token !== refresh,
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
      setIdentityPending?.(false);
    } else if (identityVerificationPending) {
      throw new IdentityUnavailable(pendingIdentityNext);
    }
    return tokens.access_token;
  } catch (error) {
    if (error instanceof IdentityUnavailable) throw error;
    try {
      if (!(await revoke(request, clientId, refresh)))
        onUnconfirmedRevocation();
    } finally {
      await keychain.delete();
    }
    throw new SiwcError("siwc-rejected");
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
    setIdentityPending,
    authorizeOnly = false,
  }: {
    request: Request;
    keychain: Keychain | undefined;
    consent(clientId: string | undefined): Promise<Consent>;
    save(registration: Registration): Promise<void>;
    run(accessToken: string): Promise<void>;
    report(message: string): void;
    warn(message: string): void;
    onUnconfirmedRevocation(): void;
    setIdentityPending?: (pending: boolean) => void;
    authorizeOnly?: boolean;
  },
) {
  let refresh: string | undefined;
  let exchangeClientId: string | undefined;
  let kept = false;
  try {
    const { clientId, subjectHash, identityVerificationPending } = registration;
    assert.ok(clientId === undefined || isIssuedClientId(clientId));
    assert.ok(
      subjectHash === undefined ||
        (typeof subjectHash === "string" && subjectHash.length > 0),
    );
    let accessToken: string | undefined;
    if (keychain) {
      const saved = await keychain.read();
      if (saved !== null && clientId && subjectHash) {
        if (authorizeOnly) {
          if (identityVerificationPending)
            throw new IdentityUnavailable(pendingIdentityNext);
          report("A Sign in with ChatGPT grant is already saved.");
          return;
        }
        try {
          accessToken = await refreshGrant(
            { clientId, subjectHash, identityVerificationPending },
            keychain,
            request,
            saved,
            onUnconfirmedRevocation,
            setIdentityPending,
          );
          kept = true;
        } catch (error) {
          if (!(error instanceof RejectedSavedGrant)) throw error;
          warn(rejectedGrantWarning);
        }
      } else if (saved !== null) {
        if (clientId) await revoke(request, clientId, saved);
        await keychain.delete();
        warn(
          "The saved ChatGPT grant could not be matched to the SIWC registration. If you did not expect this, disconnect Agent Bootstrap in ChatGPT settings.",
        );
      }
    }

    if (accessToken === undefined) {
      const authorization = await consent(clientId);
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
    if (!kept)
      assert.ok(
        refresh && /^\S+$/.test(accessToken) && accessToken !== refresh,
      );
    if (keychain && !kept) {
      await keychain.write(refresh!);
      if (identityVerificationPending) setIdentityPending?.(false);
      kept = true;
    }
    await run(accessToken);
  } catch (error) {
    if (!kept && exchangeClientId && refresh !== undefined && keychain)
      throw new SiwcError("siwc-rejected");
    throw error;
  } finally {
    if (kept) {
      report(
        authorizeOnly
          ? "Sign in with ChatGPT grant saved in Keychain."
          : "Refresh token kept in the macOS Keychain. Run with --forget to remove it.",
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
      `The registration is unreadable, so the Keychain item cannot be located. Disconnect Agent Bootstrap in ChatGPT settings and remove any leftover ${keychainService}.* items by hand.`,
    );
    return 1;
  }
  if (registration === null) {
    report("No Sign in with ChatGPT registration found.");
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

function parseRegistration(value: unknown): Registration {
  assert.ok(value && typeof value === "object" && !Array.isArray(value));
  const {
    hostId,
    clientId,
    subjectHash,
    identityVerificationPending,
    migratedFrom,
    legacyRetired,
    legacyAccountMigration,
    legacyAccountCleanup,
  } = value as Registration;
  assert.ok(
    typeof hostId === "string" &&
      /^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
        hostId,
      ),
  );
  assert.ok(clientId === undefined || isIssuedClientId(clientId));
  assert.ok(
    subjectHash === undefined ||
      (typeof subjectHash === "string" && subjectHash.length > 0),
  );
  assert.ok(
    migratedFrom === undefined ||
      (typeof migratedFrom === "string" &&
        isAbsolute(migratedFrom) &&
        resolve(migratedFrom) === migratedFrom &&
        migratedFrom.endsWith("/.local/siwc-smoke")),
  );
  assert.ok(legacyRetired === undefined || legacyRetired === true);
  assert.ok(
    identityVerificationPending === undefined ||
      identityVerificationPending === true,
  );
  assert.ok(
    legacyAccountMigration === undefined ||
      (migratedFrom &&
        (legacyAccountMigration === true ||
          (typeof legacyAccountMigration === "string" &&
            validAccount(legacyAccountMigration)))),
  );
  assert.ok(
    legacyAccountCleanup === undefined ||
      (typeof legacyAccountCleanup === "string" &&
        validAccount(legacyAccountCleanup)),
  );
  return {
    hostId,
    ...(clientId === undefined ? {} : { clientId }),
    ...(subjectHash === undefined ? {} : { subjectHash }),
    ...(identityVerificationPending === true
      ? { identityVerificationPending }
      : {}),
    ...(migratedFrom === undefined ? {} : { migratedFrom }),
    ...(legacyRetired === true ? { legacyRetired } : {}),
    ...(legacyAccountMigration === undefined ? {} : { legacyAccountMigration }),
    ...(legacyAccountCleanup === undefined ? {} : { legacyAccountCleanup }),
  };
}

export async function loadRegistration(
  file: string,
): Promise<Registration | null> {
  try {
    return parseRegistration(parseOAuthJson(await readFile(file, "utf8")));
  } catch (error) {
    if (missing(error)) return null;
    throw new Error("Invalid SIWC registration");
  }
}

const registrationFile = "registration.json";
const lockFile = "run.lock";
const emptyLockMinAgeMs = 5 * 60_000;
const privateNext = "Check the private Sign in with ChatGPT state directory.";

function retiredLegacy() {
  return new SiwcError(
    "siwc-unavailable",
    "The checkout-local Sign in with ChatGPT launcher has been retired for this grant. Use agent-bootstrap codex authorize or agent-bootstrap codex forget with the migrated user state.",
  );
}

type ProcessStart = (pid: number) => Promise<string | null>;
type Ffi = {
  dlopen(
    library: string,
    definitions: Record<string, { args: string[]; returns: string }>,
  ): { symbols: Record<string, (...args: (number | bigint)[]) => number> };
  ptr(buffer: Buffer): number;
};
const loadFfi = () => createRequire(import.meta.url)("bun:ffi") as Ffi;
const macLibrary = "/usr/lib/libSystem.B.dylib";
let tryExclusiveLock: ((fd: number) => boolean) | undefined;
let macProcessStart: ProcessStart | undefined;

function flockForReclaim(fd: number) {
  if (!tryExclusiveLock) {
    const { dlopen } = loadFfi();
    const { symbols } = dlopen(
      process.platform === "darwin" ? macLibrary : "libc.so.6",
      { flock: { args: ["i32", "i32"], returns: "i32" } },
    );
    const { flock } = symbols;
    assert.ok(flock);
    tryExclusiveLock = (fd) => flock(fd, 2 | 4) === 0; // LOCK_EX | LOCK_NB
  }
  return tryExclusiveLock(fd);
}

const processStart: ProcessStart = async (pid) => {
  if (process.platform === "linux") {
    try {
      const status = await readFile(`/proc/${pid}/stat`, "utf8");
      const started = status.slice(status.lastIndexOf(")") + 2).split(" ")[19];
      assert.ok(started && /^\d+$/.test(started));
      const boot = await readFile("/proc/sys/kernel/random/boot_id", "utf8");
      return `${boot.trim()}:${started}`;
    } catch (error) {
      if (!missing(error)) throw error;
    }
  } else if (process.platform === "darwin") {
    if (!macProcessStart) {
      const { dlopen, ptr } = loadFfi();
      const { symbols } = dlopen(macLibrary, {
        proc_pidinfo: {
          args: ["i32", "i32", "u64", "ptr", "i32"],
          returns: "i32",
        },
      });
      const { proc_pidinfo: pidInfo } = symbols;
      assert.ok(pidInfo);
      macProcessStart = async (pid) => {
        // Darwin's struct proc_bsdinfo ends in two uint64_t start fields.
        const info = Buffer.alloc(136);
        if (pidInfo(pid, 3, 0n, ptr(info), info.length) !== info.length)
          return null;
        return `${info.readBigUInt64LE(120)}:${info.readBigUInt64LE(128)}`;
      };
    }
    const started = await macProcessStart(pid);
    if (started !== null) return started;
  }
  // A failed identity lookup alone does not prove that the process is gone.
  try {
    process.kill(pid, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return null;
    throw error;
  }
  throw new Error("Could not read process start identity");
};

function legacyLockIsUnheld(lock: string, fd: number): Promise<boolean> {
  // The old launcher holds an open descriptor but does not take flock.
  // Require lsof to find our descriptor as evidence that it inspected the file.
  return new Promise((resolve) => {
    execFile(
      process.platform === "darwin" ? "/usr/sbin/lsof" : "/usr/bin/lsof",
      ["-nP", "-a", "-u", userInfo().username, "-F", "pf", "--", lock],
      {
        env: { PATH: "/usr/bin:/bin", LC_ALL: "C" },
        timeout: 1000,
        maxBuffer: 16 * 1024,
      },
      (error, stdout, stderr) => {
        resolve(
          !error &&
            !stderr.trim() &&
            stdout.trim() === `p${process.pid}\nf${fd}`,
        );
      },
    );
  });
}

async function reclaimLock(lock: string, lookup: ProcessStart) {
  try {
    const handle = await open(
      lock,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const original = await handle.stat({ bigint: true });
      if (!original.isFile() || original.size > 512n) return;
      if (original.size === 0n) {
        if (Date.now() - Number(original.mtimeMs) < emptyLockMinAgeMs) return;
      } else {
        const { pid, start } = parseOAuthJson(await handle.readFile("utf8"));
        if (
          typeof pid !== "number" ||
          !Number.isSafeInteger(pid) ||
          pid <= 0 ||
          pid > 0x7fffffff ||
          typeof start !== "string" ||
          !start
        )
          return;
        try {
          if ((await lookup(pid)) === start) return;
        } catch (error) {
          if ((error as NodeJS.ErrnoException)?.code === "EPERM") return;
          throw error;
        }
      }
      // Serialize stale removals on the open inode. A waiter may still hold
      // that inode after another reclaimer has published its replacement.
      if (!flockForReclaim(handle.fd)) return;
      if (original.size === 0n && !(await legacyLockIsUnheld(lock, handle.fd)))
        return;
      const current = lstatSync(lock, { bigint: true, throwIfNoEntry: false });
      if (
        current?.dev === original.dev &&
        current.ino === original.ino &&
        current.size === original.size &&
        current.mtimeNs === original.mtimeNs
      )
        unlinkSync(lock);
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (!missing(error)) throw error;
  }
}

function readRegistration(directory: string, root: string, recover = false) {
  const value = readPrivateConfig(
    join(directory, registrationFile),
    root,
    "siwc",
    privateNext,
    4096,
    {
      cleanupTemporaryFiles: recover,
    },
  );
  if (directory === root && isDeepStrictEqual(value, { retired: true }))
    throw retiredLegacy();
  return value === undefined ? undefined : parseRegistration(value);
}

function retireLegacyRegistration(directory: string, hostId: string) {
  const file = join(directory, registrationFile);
  const source = readPrivateConfig(file, directory, "siwc", privateNext, 4096, {
    cleanupTemporaryFiles: false,
  });
  if (
    !source ||
    typeof source !== "object" ||
    !("hostId" in source) ||
    source.hostId !== hostId
  )
    return false;
  writePrivateConfig(file, directory, { retired: true });
  return true;
}

function primaryCheckout(checkout: string) {
  try {
    const { identity } = repository(checkout);
    if (basename(identity) === ".git") return dirname(identity);
  } catch {
    // An installed checkout need not include Git metadata.
  }
  return undefined;
}

function legacyDirectory(checkout: string) {
  const find = (root: string) => {
    const directory = join(root, ".local", "siwc-smoke");
    try {
      privatePath(directory, directory);
      if (
        lstatSync(join(directory, registrationFile), { throwIfNoEntry: false })
      )
        return directory;
    } catch (error) {
      if (!missing(error)) throw error;
    }
    return undefined;
  };
  const primary = primaryCheckout(checkout);
  return (
    (primary && primary !== checkout ? find(primary) : undefined) ??
    find(checkout)
  );
}

export type SiwcPresence = "present" | "pending" | "missing" | "unavailable";

/** Presence probe only. The callback must use a metadata-only Keychain lookup. */
export async function siwcGrantPresence(
  checkout: string,
  env: NodeJS.ProcessEnv,
  account: string | undefined,
  probe: (service: string, user: string) => Promise<SiwcPresence>,
): Promise<SiwcPresence> {
  try {
    if (!validAccount(account)) return "unavailable";
    const stateRoot = userStateDirectory(env);
    let registration = readRegistration(join(stateRoot, "siwc"), stateRoot);
    const legacyRegistration =
      !registration || registration.migratedFrom !== undefined;
    if (!registration) {
      const legacy = legacyDirectory(checkout);
      if (legacy) registration = readRegistration(legacy, legacy);
    }
    if (!registration?.clientId || !registration.subjectHash) return "missing";
    const service = serviceForHost(registration.hostId);
    const presence = await probe(service, account);
    const legacyAccount = registration.legacyAccountMigration ?? env.USER;
    // A rotated grant awaiting identity verification cannot issue tokens yet.
    if (presence === "present" && registration.identityVerificationPending)
      return "pending";
    return presence === "missing" &&
      legacyRegistration &&
      typeof legacyAccount === "string" &&
      validAccount(legacyAccount) &&
      legacyAccount !== account
      ? await probe(service, legacyAccount)
      : presence;
  } catch {
    return "unavailable";
  }
}

export type SiwcRefreshEvent =
  | { event: "siwc-refresh"; status: "ok" }
  | { event: "siwc-refresh"; status: "failed"; code: SiwcCode };

export interface SiwcProvider extends CredentialProvider {
  authorize(signal?: AbortSignal): Promise<void>;
  forget(options?: { legacy?: boolean }): Promise<number>;
  accessToken(): Promise<string>;
  /** Operator-only compatibility entry point for the M5 launcher. */
  runSmoke(options: {
    useKeychain: boolean;
    signal: AbortSignal;
    run(token: string): Promise<void>;
    onUnconfirmedRevocation(): void;
  }): Promise<void>;
}

export function siwcProvider({
  checkout,
  env = process.env,
  request: oauth = request,
  keychain = (hostId, account) => {
    assert.ok(process.platform === "darwin");
    return makeKeychain(account, hostId);
  },
  consent = waitForConsent,
  lookupProcessStart = processStart,
  lockWaitMs = 30_000,
  beforeRefresh,
  onRefresh,
  report = () => {},
  warn = () => {},
}: {
  checkout: string;
  env?: NodeJS.ProcessEnv;
  request?: Request;
  keychain?: (hostId: string, account: string) => Keychain;
  consent?: typeof waitForConsent;
  lookupProcessStart?: ProcessStart;
  lockWaitMs?: number;
  /** Persist the caller's authorization/attempt record before the exchange. */
  beforeRefresh?: () => void | Promise<void>;
  onRefresh?: (event: SiwcRefreshEvent) => void | Promise<void>;
  report?: (message: string) => void;
  warn?: (message: string) => void;
}): SiwcProvider {
  const stateRoot = userStateDirectory(env);
  const directory = join(stateRoot, "siwc");
  const file = join(directory, registrationFile);
  const account = userInfo().username;
  const itemForHost = (hostId: string) => keychain(hostId, account);

  function setIdentityPending(pending: boolean, lockedLegacy?: string) {
    const registration = readRegistration(directory, stateRoot);
    assert.ok(registration);
    if (pending) {
      // The old launcher cannot enforce the pending identity check.
      if (
        lockedLegacy &&
        retireLegacyRegistration(lockedLegacy, registration.hostId)
      )
        registration.legacyRetired = true;
      registration.identityVerificationPending = true;
    } else {
      delete registration.identityVerificationPending;
    }
    writePrivateConfig(file, stateRoot, registration);
  }

  async function lockDirectory<T>(
    directory: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const lock = join(directory, lockFile);
    const candidate = join(directory, `.run-lock-${randomUUID()}`);
    const deadline = performance.now() + lockWaitMs;
    try {
      const start = await lookupProcessStart(process.pid);
      assert.ok(start);
      // Publish a complete owner record so contenders never see a partial write.
      await writeFile(candidate, JSON.stringify({ pid: process.pid, start }), {
        flag: "wx",
        mode: 0o600,
      });
      try {
        for (;;) {
          try {
            await link(candidate, lock);
            break;
          } catch (error) {
            if ((error as NodeJS.ErrnoException)?.code !== "EEXIST")
              throw error;
          }
          await reclaimLock(lock, lookupProcessStart);
          if (performance.now() >= deadline) throw new Error("Lock timed out");
          await delay(50);
        }
      } finally {
        await unlink(candidate);
      }
    } catch {
      throw new SiwcError(
        "siwc-unavailable",
        `Check the Sign in with ChatGPT run lock at ${lock}. See the SIWC evidence record for stale locks.`,
      );
    }
    try {
      return await operation();
    } finally {
      await unlink(lock);
    }
  }

  async function locked<T>(
    operation: (
      registration: Registration | undefined,
      lockedLegacy?: string,
    ) => Promise<T>,
    legacyCaller = false,
  ): Promise<T> {
    try {
      privatePath(directory, stateRoot, true);
      return await lockDirectory(directory, async () => {
        let existing = readRegistration(directory, stateRoot, true);
        if (legacyCaller && existing?.legacyRetired) throw retiredLegacy();
        if (existing?.migratedFrom) {
          const legacy = existing.migratedFrom;
          try {
            privatePath(legacy, legacy);
          } catch (error) {
            if (!missing(error)) throw error;
            if (!existing.legacyRetired) {
              existing = { ...existing, legacyRetired: true };
              writePrivateConfig(file, stateRoot, existing);
              warn(
                "The legacy Sign in with ChatGPT state directory is missing. Do not use any moved copy of the old launcher.",
              );
            }
            if (legacyCaller) throw retiredLegacy();
            return operation(existing);
          }
          // The pre-migration launcher uses this same lock file.
          return lockDirectory(legacy, () => {
            // The source may have been retired before a failed user-state save.
            if (legacyCaller) readRegistration(legacy, legacy);
            return operation(existing, legacy);
          });
        }
        if (existing) return operation(existing);
        const legacy = legacyDirectory(checkout);
        if (!legacy) return operation(undefined);
        return lockDirectory(legacy, async () => {
          const previous = readRegistration(legacy, legacy);
          if (!previous) return operation(undefined);
          const migrated = { ...previous, migratedFrom: legacy };
          writePrivateConfig(file, stateRoot, migrated, true);
          const verified = readRegistration(directory, stateRoot);
          assert.ok(
            isDeepStrictEqual(verified, migrated),
            "Registration verification failed",
          );
          return operation(verified, legacy);
        });
      });
    } catch (error) {
      if (error instanceof SiwcError) throw error;
      throw new SiwcError("siwc-unavailable");
    }
  }

  async function migrateLegacyAccount(
    registration: Registration,
    beforeMove?: () => Promise<void>,
  ): Promise<Registration> {
    const {
      hostId,
      clientId,
      subjectHash,
      migratedFrom,
      legacyAccountMigration,
    } = registration;
    if (
      !migratedFrom ||
      !clientId ||
      !subjectHash ||
      legacyAccountMigration === true
    )
      return registration;
    const sourceAccount = legacyAccountMigration ?? env.USER;
    if (validAccount(sourceAccount) && sourceAccount !== account) {
      const target = itemForHost(hostId);
      const saved = await target.read();
      const source = keychain(hostId, sourceAccount);
      const token = await source.read();
      if (token !== null) {
        if (saved !== null && legacyAccountMigration === undefined) {
          const updated = {
            ...registration,
            legacyAccountMigration: true,
            legacyAccountCleanup: sourceAccount,
          } as const;
          writePrivateConfig(file, stateRoot, updated);
          warn("The old Keychain item still exists under the legacy account.");
          warn(
            `next: security delete-generic-password -s ${serviceForHost(hostId)} -a ${sourceAccount}`,
          );
          return updated;
        }
        await beforeMove?.();
        // Recover a partially completed move without overwriting a different grant.
        assert.ok(
          saved === null || saved === token,
          "Keychain migration item changed",
        );
        if (legacyAccountMigration === undefined)
          writePrivateConfig(file, stateRoot, {
            ...registration,
            legacyAccountMigration: sourceAccount,
          });
        if (saved === null) await target.write(token);
        await source.delete();
      }
    }
    const migrated = { ...registration, legacyAccountMigration: true } as const;
    writePrivateConfig(file, stateRoot, migrated);
    return migrated;
  }

  async function runConsent(
    registration: Registration | undefined,
    useKeychain: boolean,
    signal: AbortSignal,
    run: (token: string) => Promise<void>,
    onUnconfirmedRevocation: () => void,
    authorizeOnly = false,
    lockedLegacy?: string,
  ) {
    signal.throwIfAborted();
    if (!registration) {
      registration = { hostId: `urn:uuid:${randomUUID()}` };
      writePrivateConfig(file, stateRoot, registration, true);
    }
    if (useKeychain) registration = await migrateLegacyAccount(registration);
    const { hostId } = registration;
    const item = useKeychain ? itemForHost(hostId) : undefined;
    await runSubscription(registration, {
      request: oauth,
      keychain: item,
      async consent(clientId) {
        const result = await consent(hostId, clientId, signal, report);
        signal.throwIfAborted();
        return result;
      },
      async save(updated) {
        if (updated.migratedFrom) {
          // Older launchers already reject a registration without a host ID.
          if (lockedLegacy) retireLegacyRegistration(lockedLegacy, hostId);
          updated = { ...updated, legacyRetired: true };
        }
        writePrivateConfig(file, stateRoot, updated);
      },
      run,
      report,
      warn,
      onUnconfirmedRevocation,
      setIdentityPending: (pending) =>
        setIdentityPending(pending, lockedLegacy),
      authorizeOnly,
    });
  }

  async function accessToken() {
    let token: string;
    try {
      token = await locked(async (registration, lockedLegacy) => {
        if (!registration?.clientId || !registration.subjectHash)
          throw new SiwcError("siwc-missing");
        const { clientId, subjectHash, identityVerificationPending } =
          registration;
        let attempted = false;
        const recordAttempt = async () => {
          if (attempted) return;
          await beforeRefresh?.();
          attempted = true;
        };
        await migrateLegacyAccount(registration, recordAttempt);
        const item = itemForHost(registration.hostId);
        const saved = await item.read();
        if (saved === null) throw new SiwcError("siwc-missing");
        await recordAttempt();
        return refreshGrant(
          { clientId, subjectHash, identityVerificationPending },
          item,
          oauth,
          saved,
          () => warn(revocationWarning),
          (pending) => setIdentityPending(pending, lockedLegacy),
        );
      });
    } catch (error) {
      assert.ok(error instanceof SiwcError);
      try {
        await onRefresh?.({
          event: "siwc-refresh",
          status: "failed",
          code: error.code,
        });
      } catch {
        throw new SiwcError("siwc-unavailable");
      }
      throw error;
    }
    try {
      await onRefresh?.({ event: "siwc-refresh", status: "ok" });
    } catch {
      throw new SiwcError("siwc-unavailable");
    }
    return token;
  }

  return {
    authorize: (signal = new AbortController().signal) =>
      locked((registration, lockedLegacy) =>
        runConsent(
          registration,
          true,
          signal,
          async () => {},
          () => warn(revocationWarning),
          true,
          lockedLegacy,
        ),
      ),
    forget: ({ legacy = false } = {}) =>
      locked(async (registration, lockedLegacy) => {
        if (registration)
          registration = await migrateLegacyAccount(registration);
        const result = await forgetRefreshToken(
          async () => registration ?? null,
          itemForHost,
          oauth,
          report,
          warn,
        );
        if (!legacy && registration?.migratedFrom) {
          if (lockedLegacy)
            retireLegacyRegistration(lockedLegacy, registration.hostId);
          const {
            migratedFrom: _migratedFrom,
            legacyAccountMigration: _legacyAccountMigration,
            identityVerificationPending: _pending,
            ...remaining
          } = registration;
          writePrivateConfig(file, stateRoot, {
            ...remaining,
            legacyRetired: true,
          });
        } else if (registration?.identityVerificationPending) {
          setIdentityPending(false);
        }
        return result;
      }, legacy),
    accessToken,
    async withAccessToken(consume) {
      return consume(await accessToken());
    },
    runSmoke: ({ useKeychain, signal, run, onUnconfirmedRevocation }) =>
      locked(
        (registration, lockedLegacy) =>
          runConsent(
            registration,
            useKeychain,
            signal,
            run,
            () => {
              warn(revocationWarning);
              onUnconfirmedRevocation();
            },
            false,
            lockedLegacy,
          ),
        true,
      ),
  };
}

/** Bind one refresh to the audited sandbox create that will consume it. */
export function siwcSandboxCredential(
  audit: Pick<SqliteAudit, "read" | "append" | "isV5Writable">,
  provider: (hooks: {
    beforeRefresh: () => Promise<void>;
    onRefresh: (event: SiwcRefreshEvent) => Promise<void>;
  }) => Pick<SiwcProvider, "accessToken">,
): CredentialProvider {
  return {
    async withAccessToken(consume, invocationId) {
      if (!invocationId) throw new SandboxRuntimeError("siwc-unavailable");
      const record = async (
        detail: SiwcRefreshEvent | { event: "siwc-refresh"; status: "started" },
      ) => {
        if (!audit.isV5Writable)
          throw new SandboxRuntimeError("siwc-unavailable");
        await audit.append({
          invocationId,
          role: "Worker",
          kind: "operation.requested",
          operation: "sandbox.create",
          detail,
        });
      };
      let token: string;
      try {
        const starts = audit
          .read(invocationId)
          .filter(({ kind }) => kind === "invocation.started");
        const [invocation] = starts;
        if (
          !audit.isV5Writable ||
          starts.length !== 1 ||
          invocation?.role !== "Worker" ||
          invocation.detail !== undefined
        )
          throw new SandboxRuntimeError("siwc-unavailable");
        token = await provider({
          beforeRefresh: () =>
            record({ event: "siwc-refresh", status: "started" }),
          onRefresh: record,
        }).accessToken();
        if (!audit.isV5Writable)
          throw new SandboxRuntimeError("siwc-unavailable");
      } catch (error) {
        throw new SandboxRuntimeError(
          error instanceof SiwcError ? error.code : "siwc-unavailable",
        );
      }
      return consume(token);
    },
  };
}
