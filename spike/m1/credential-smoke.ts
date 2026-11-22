/** Opt-in Gate A fixture only: synthetic credentials, loopback mock, no login.
 * Usage: MSB_HOME=/absolute/dedicated/cache bun spike/m1/credential-smoke.ts
 *   /absolute/verified/linux-arm64/codex /absolute/pinned/msb [/absolute/openssl]
 * This does not establish ChatGPT Subscription, refresh or WebSocket compatibility.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer as createHttpServer, get } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import type { Server } from "node:net";
import { isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import type { CredentialProvider } from "../../src/credentials.ts";

const run = promisify(execFile);
const secretName = "AGENT_BOOTSTRAP_FIXTURE_ACCESS_TOKEN";
const expectedPlaceholder = `$MSB_${secretName}`;
const hostname = "host.microsandbox.internal";
const image =
  "docker.io/library/alpine@sha256:5dda816445facf5f7282dc7689a333278834c74265ba25db2e2eb90509e3a9dd";
const codexDigest =
  "6a95492ca9d85ee76bd9fc5a4d8f72dd98a6130d1bb409bcfc50e61573106616";
const terminalText = "Fixture credential turn complete";

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return address.port;
}

async function main(): Promise<void> {
  const [codex, msb, openssl = "/usr/bin/openssl"] = process.argv.slice(2);
  const msbHome = process.env.MSB_HOME;
  for (const path of [codex, msb, openssl, msbHome]) {
    assert.ok(
      path && isAbsolute(path) && !/[\0:\r\n]/.test(path),
      "Use absolute dedicated fixture paths",
    );
  }
  assert.ok(codex && msb && msbHome);
  assert.equal(
    createHash("sha256")
      .update(await readFile(codex))
      .digest("hex"),
    codexDigest,
    "Codex binary digest mismatch",
  );
  const env = {
    PATH: "/usr/bin:/bin",
    MSB_HOME: msbHome,
    MSB_BACKEND: "local",
  };
  const token = randomBytes(32).toString("hex");
  const credentials: CredentialProvider = {
    withAccessToken: (consume) => consume(token),
  };
  const id = randomUUID();
  const name = `credential-fixture-${id}`;
  const cleanupLabel = `agent-bootstrap-credential-fixture=${id}`;
  const fixtures = new URL("../../.local/", import.meta.url);
  await mkdir(fixtures, { recursive: true });
  const staging = await mkdtemp(join(fixtures.pathname, "credential-fixture-"));
  let createAttempted = false;
  let cleanupFailed = false;
  let failed = false;
  let stage = "version";
  let requests = 0;
  let exactHeaders = true;
  let unapprovedRequests = 0;
  let mock: ReturnType<typeof createHttpsServer> | undefined;
  let unapproved: ReturnType<typeof createHttpServer> | undefined;
  const safeMsb = async (args: string[], create = false, timeout = 20_000) => {
    assert.equal(
      JSON.stringify(args).includes(token),
      false,
      "Synthetic token must not enter arguments",
    );
    try {
      const invoke = (environment: Record<string, string>) =>
        run(msb, args, {
          env: environment,
          cwd: staging,
          timeout,
          maxBuffer: 1024 * 1024,
          killSignal: "SIGKILL",
        });
      const result = await (create
        ? credentials.withAccessToken((value) =>
            invoke({ ...env, [secretName]: value }),
          )
        : invoke(env));
      assert.equal(
        result.stdout.includes(token) || result.stderr.includes(token),
        false,
        "Synthetic token appeared in captured output",
      );
      return result;
    } catch {
      // Never attach a backend exception: it can contain captured output or env.
      throw new Error("Fixture sandbox command failed");
    }
  };
  const localOpenSsl = async (args: string[]) => {
    try {
      await run(openssl, args, {
        cwd: staging,
        env: { PATH: "/usr/bin:/bin" },
        timeout: 10_000,
        maxBuffer: 64 * 1024,
      });
    } catch {
      throw new Error("Fixture certificate generation failed");
    }
  };
  try {
    assert.equal(
      (await safeMsb(["--version"])).stdout.trim(),
      "msb 0.7.16",
      "Pinned Microsandbox version required",
    );
    stage = "fixture TLS and listeners";
    const caKey = join(staging, "ca.key");
    const caCert = join(staging, "ca.pem");
    const serverKey = join(staging, "server.key");
    const serverCert = join(staging, "server.pem");
    await writeFile(
      join(staging, "ca.conf"),
      "[req]\nprompt=no\ndistinguished_name=dn\nx509_extensions=v3\n[dn]\nCN=Agent Bootstrap Synthetic CA\n[v3]\nbasicConstraints=critical,CA:true\nkeyUsage=critical,keyCertSign,cRLSign\n",
      { mode: 0o600 },
    );
    await writeFile(
      join(staging, "server.conf"),
      `[req]\nprompt=no\ndistinguished_name=dn\n[dn]\nCN=${hostname}\n`,
      { mode: 0o600 },
    );
    await writeFile(
      join(staging, "server.ext"),
      `subjectAltName=DNS:${hostname}\nbasicConstraints=critical,CA:false\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n`,
      { mode: 0o600 },
    );
    await localOpenSsl([
      "req",
      "-new",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-days",
      "1",
      "-config",
      join(staging, "ca.conf"),
      "-keyout",
      caKey,
      "-out",
      caCert,
    ]);
    await localOpenSsl([
      "req",
      "-new",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-config",
      join(staging, "server.conf"),
      "-keyout",
      serverKey,
      "-out",
      join(staging, "server.csr"),
    ]);
    await localOpenSsl([
      "x509",
      "-req",
      "-in",
      join(staging, "server.csr"),
      "-CA",
      caCert,
      "-CAkey",
      caKey,
      "-CAcreateserial",
      "-days",
      "1",
      "-extfile",
      join(staging, "server.ext"),
      "-out",
      serverCert,
    ]);
    mock = createHttpsServer(
      { key: await readFile(serverKey), cert: await readFile(serverCert) },
      async (request, response) => {
        if (request.method !== "POST" || request.url !== "/v1/responses") {
          response.writeHead(404).end();
          return;
        }
        requests += 1;
        const matched = request.headers.authorization === `Bearer ${token}`;
        exactHeaders = exactHeaders && matched;
        if (!matched) {
          response.writeHead(401).end();
          return;
        }
        let length = 0;
        try {
          for await (const chunk of request) {
            length += chunk.length;
            if (length > 1024 * 1024) {
              response.writeHead(413).end();
              return;
            }
          }
        } catch {
          response.destroy();
          return;
        }
        const id = `fixture-response-${requests}`;
        const message = {
          type: "message",
          role: "assistant",
          id: "fixture-message",
          status: "completed",
          content: [{ type: "output_text", text: terminalText }],
        };
        const events = [
          { type: "response.created", response: { id, status: "in_progress" } },
          { type: "response.output_item.done", item: message },
          {
            type: "response.completed",
            response: {
              id,
              status: "completed",
              output: [message],
              usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
            },
          },
        ];
        response
          .writeHead(200, {
            "Content-Type": "text/event-stream",
            Connection: "close",
          })
          .end(
            events
              .map(
                (event) =>
                  `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
              )
              .join(""),
          );
      },
    );
    const port = await listen(mock);
    unapproved = createHttpServer((_request, response) => {
      unapprovedRequests += 1;
      response.end("fixture-positive-control");
    });
    const blockedPort = await listen(unapproved);
    const control = await new Promise<string>((resolve, reject) => {
      const request = get(
        `http://127.0.0.1:${blockedPort}/canary`,
        (response) => {
          let body = "";
          response.on("data", (chunk) => {
            body += chunk;
          });
          response.on("end", () => resolve(body));
        },
      );
      request.setTimeout(2000, () =>
        request.destroy(new Error("Fixture control timed out")),
      );
      request.once("error", reject);
    });
    assert.equal(control, "fixture-positive-control");
    assert.equal(unapprovedRequests, 1);
    stage = "sandbox create";
    createAttempted = true;
    await safeMsb(
      [
        "create",
        "--name",
        name,
        "--label",
        cleanupLabel,
        "--pull",
        "never",
        "--no-net",
        "--net-rule",
        "allow@dns",
        "--net-rule",
        `allow@host:tcp:${port}`,
        "--tls-intercept",
        "--tls-intercept-port",
        String(port),
        "--tls-upstream-ca-cert-for",
        `${hostname}=${caCert}`,
        "--secret",
        `${secretName}:headers=authorization@${hostname}`,
        "--secret-violation-action",
        "block",
        "--max-duration",
        "90s",
        "--copy-file",
        `${codex}:/tmp/codex`,
        image,
      ],
      true,
    );
    const guest = (script: string, args: string[] = [], timeout = 15_000) =>
      safeMsb(
        [
          "exec",
          "--no-stdin",
          "--no-tty",
          "--timeout",
          `${Math.ceil(timeout / 1000)}s`,
          name,
          "--",
          "/bin/sh",
          "-ec",
          script,
          "fixture",
          ...args,
        ],
        false,
        timeout + 2000,
      );
    stage = "guest placeholder";
    const inspection = await guest(
      `test ! -e /root/.codex/auth.json; printf '%s\\n' "$${secretName}"`,
    );
    stage = "unapproved destination";
    assert.equal(
      inspection.stdout.split("\n")[0],
      expectedPlaceholder,
      "Expected guest placeholder not observed",
    );
    const denied = await guest(
      `
      command -v wget >/dev/null
      if wget -T 2 -qO- "http://${hostname}:$1/canary" >/dev/null 2>&1; then exit 41; fi
      gateway=$(ip -4 route show default | awk '$1 == "default" && $2 == "via" {print $3; exit}')
      test -n "$gateway"
      if wget -T 2 -qO- "http://$gateway:$1/canary" >/dev/null 2>&1; then exit 42; fi
      printf 'fixture-denial-observed\\n'
    `,
      [String(blockedPort)],
    );
    assert.ok(denied.stdout.includes("fixture-denial-observed"));
    assert.equal(
      unapprovedRequests,
      1,
      "Unapproved guest traffic reached the listener",
    );
    stage = "Codex HTTPS/SSE";
    const completion = await guest(
      `
      printf '%s  /tmp/codex\\n' '${codexDigest}' | sha256sum -c - >/dev/null
      chmod 700 /tmp/codex
      exec /tmp/codex \
        -c 'model_provider="fixture"' \
        -c 'model_providers.fixture.name="Synthetic fixture"' \
        -c 'model_providers.fixture.base_url="https://${hostname}:'"$1"'/v1"' \
        -c 'model_providers.fixture.env_key="${secretName}"' \
        -c 'model_providers.fixture.wire_api="responses"' \
        -c 'model_providers.fixture.supports_websockets=false' \
        -c 'model_providers.fixture.request_max_retries=0' \
        -c 'model_providers.fixture.stream_max_retries=0' \
        exec --json --ephemeral --skip-git-repo-check --sandbox read-only -C /tmp -m fixture-model \
        'Return the synthetic fixture completion message without using tools.'
    `,
      [String(port)],
      30_000,
    );
    assert.ok(
      completion.stdout.includes(terminalText),
      "Codex terminal message not observed",
    );
    assert.ok(
      completion.stdout.includes("turn.completed"),
      "Codex completion event not observed",
    );
    assert.ok(
      requests > 0 && exactHeaders,
      "Exact host-side credential header not observed",
    );
    assert.equal(unapprovedRequests, 1);
  } catch {
    failed = true;
  } finally {
    if (createAttempted) {
      try {
        await safeMsb(["rm", "--force", "--label", cleanupLabel]);
      } catch {
        cleanupFailed = true;
      }
    }
    mock?.closeAllConnections();
    mock?.close();
    unapproved?.closeAllConnections();
    unapproved?.close();
    try {
      await rm(staging, { recursive: true, force: true });
    } catch {
      cleanupFailed = true;
    }
  }
  if (failed || cleanupFailed) {
    console.error("Fixture evidence", {
      stage,
      requests,
      exactHeaders,
      cleanupFailed,
    });
    throw new Error("Fixture verification failed");
  }
  console.log(
    JSON.stringify({
      gate: "A-synthetic",
      codexHttpSseCompleted: true,
      exactScopedHeader: true,
      expectedGuestPlaceholder: true,
      hostTokenAbsentFromCapturedGuestOutput: true,
      unapprovedDestinationDenied: true,
    }),
  );
}

try {
  await main();
} catch {
  console.error(
    "Gate A synthetic credential fixture failed; inspect the fixture locally without logging credential values.",
  );
  process.exitCode = 1;
}
