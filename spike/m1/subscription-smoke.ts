import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { promisify } from "node:util";
import type { CredentialProvider } from "../../src/credentials.ts";

// The human runs this with an already authorized, app-specific access token.
// Keep acquisition, storage and refresh outside this single-run harness.
const host = "api.openai.com";
const secret = "AGENT_BOOTSTRAP_SUBSCRIPTION_TOKEN";
const digest =
  "6a95492ca9d85ee76bd9fc5a4d8f72dd98a6130d1bb409bcfc50e61573106616";
const image =
  "docker.io/library/alpine@sha256:5dda816445facf5f7282dc7689a333278834c74265ba25db2e2eb90509e3a9dd";
const env = {
  PATH: "/usr/bin:/bin",
  MSB_BACKEND: "local",
  MSB_HOME: process.env.MSB_HOME,
};
const run = promisify(execFile);
let stage = "operator opt-in and prerequisites";

function turnFailure(status: unknown, info: unknown): string {
  if (status === "interrupted") return "interrupted";
  switch (info) {
    case "unauthorized":
    case "modelNotFound":
    case "badRequest":
    case "rateLimitExceeded":
    case "usageLimitExceeded":
    case "sandboxError":
    case "inferenceHookDenied":
      return info;
  }
  if (info && typeof info === "object") {
    const fields = info as Record<string, { httpStatusCode?: unknown } | null>;
    for (const key of [
      "httpConnectionFailed",
      "responseStreamConnectionFailed",
      "responseStreamDisconnected",
      "responseTooManyFailedAttempts",
    ]) {
      if (!Object.hasOwn(fields, key)) continue;
      const code = fields[key]?.httpStatusCode;
      return typeof code === "number" &&
        Number.isInteger(code) &&
        code >= 400 &&
        code <= 599
        ? `${key}, HTTP ${code}`
        : key;
    }
  }
  return "failed";
}

function checkTokenShape(token: string): void {
  assert.match(token, /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  const payload = JSON.parse(
    Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8"),
  );
  // This is only a preflight to reject obviously unsuitable inputs. The
  // provisioned session supplies provenance and OpenAI validates the bearer.
  assert.equal(payload.iss, "https://auth.openai.com");
  const audience = "https://api.openai.com/v1";
  assert.ok(
    payload.aud === audience ||
      (Array.isArray(payload.aud) && payload.aud.includes(audience)),
  );
  assert.equal(typeof payload.scope, "string");
  assert.ok(payload.scope.split(/\s+/).includes("chatgpt.tokens.use.direct"));
  assert.ok(
    Number.isSafeInteger(payload.exp) && payload.exp > Date.now() / 1000 + 60,
  );
}

async function main() {
  const [optIn, msb, codex, model = "gpt-6.2-sol"] = process.argv.slice(2);
  assert.equal(optIn, "--live");
  assert.ok(!process.stdin.isTTY);
  assert.ok(env.MSB_HOME?.startsWith("/"));
  assert.ok(msb && msb.startsWith("/") && !/[\0:\r\n]/.test(msb));
  assert.ok(codex && codex.startsWith("/") && !/[\0:\r\n]/.test(codex));
  assert.match(model, /^[a-z0-9][a-z0-9._-]{0,80}$/);
  assert.equal(
    createHash("sha256")
      .update(await readFile(codex))
      .digest("hex"),
    digest,
  );
  const control = (args: string[], extraEnv = {}) =>
    run(msb, args, {
      env: { ...env, ...extraEnv },
      timeout: 15_000,
      killSignal: "SIGKILL",
    });
  assert.equal((await control(["--version"])).stdout.trim(), "msb 0.7.16");

  stage = "authorized access token on stdin";
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    assert.ok(size <= 16_384);
    chunks.push(chunk);
  }
  const input = Buffer.concat(chunks);
  let token = input.toString("utf8").trim();
  input.fill(0);
  for (const chunk of chunks) chunk.fill(0);
  checkTokenShape(token);
  const provider: CredentialProvider = {
    async withAccessToken(consume) {
      try {
        return await consume(token);
      } finally {
        token = "";
      }
    },
  };
  const id = randomUUID();
  const name = `subscription-${id}`;
  const label = `agent-bootstrap-subscription-smoke=${id}`;
  const create = [
    "create",
    "--name",
    name,
    "--label",
    label,
    "--pull",
    "never",
    "--no-net",
    "--net-rule",
    "allow@dns",
    "--net-rule",
    `allow@${host}:tcp:443`,
    "--tls-intercept",
    "--secret",
    `${secret}:headers=authorization@${host}`,
    "--secret-violation-action",
    "block",
    "--max-duration",
    "60s",
    "--copy-file",
    `${codex}:/tmp/codex`,
    image,
  ];
  stage = "sandbox creation";
  let cleanupFailed = false;
  const interrupt = new AbortController();
  const cancel = () => interrupt.abort();
  process.on("SIGINT", cancel);
  process.on("SIGTERM", cancel);
  try {
    await provider.withAccessToken((value) =>
      control(create, { [secret]: value }),
    );
    interrupt.signal.throwIfAborted();
    stage = "guest Codex startup and initialize";
    const child = spawn(
      msb,
      [
        "exec",
        "--stream",
        "--timeout",
        "40s",
        name,
        "--",
        "/bin/sh",
        "-ec",
        `
        test ! -e /root/.codex/auth.json
        test "$${secret}" = '$MSB_${secret}'
        printf '%s  /tmp/codex\\n' '${digest}' | sha256sum -c - >/dev/null
        chmod 700 /tmp/codex
        exec /tmp/codex app-server --listen stdio:// \\
          -c 'model_provider="openai_chatgpt_plan"' \\
          -c 'model_providers.openai_chatgpt_plan.name="ChatGPT plan"' \\
          -c 'model_providers.openai_chatgpt_plan.base_url="https://${host}/v1"' \\
          -c 'model_providers.openai_chatgpt_plan.env_key="${secret}"' \\
          -c 'model_providers.openai_chatgpt_plan.wire_api="responses"' \\
          -c 'model_providers.openai_chatgpt_plan.requires_openai_auth=false' \\
          -c 'model_providers.openai_chatgpt_plan.supports_websockets=false' \\
          -c 'model_providers.openai_chatgpt_plan.request_max_retries=0' \\
          -c 'model_providers.openai_chatgpt_plan.stream_max_retries=0' \\
          -c 'web_search="disabled"'
      `,
      ],
      { env, stdio: ["pipe", "pipe", "ignore"] },
    );
    const exited = new Promise<number | null>((resolve, reject) => {
      child.once("close", resolve);
      child.once("error", reject);
    });
    void exited.catch(() => {});
    child.stdin.on("error", () => {});
    const kill = () => {
      if (child.exitCode === null && child.signalCode === null)
        child.kill("SIGKILL");
    };
    interrupt.signal.addEventListener("abort", kill, { once: true });
    const deadline = setTimeout(() => child.kill("SIGKILL"), 45_000);
    const send = (message: object) =>
      child.stdin.write(`${JSON.stringify(message)}\n`);
    let turnId: string | undefined;
    let completed = false;
    try {
      send({
        id: 0,
        method: "initialize",
        params: {
          clientInfo: {
            name: "agent-bootstrap",
            title: "Agent Bootstrap",
            version: "0.0.0",
          },
          capabilities: { experimentalApi: true },
        },
      });
      for await (const line of createInterface({
        input: child.stdout,
        crlfDelay: Infinity,
      })) {
        const message = JSON.parse(line);
        assert.ok(!message.error);
        if (message.method === undefined && message.id === 0) {
          assert.equal(message.result?.platformOs, "linux");
          stage = "guest Codex thread/start";
          send({ method: "initialized" });
          send({
            id: 1,
            method: "thread/start",
            params: {
              model,
              cwd: "/tmp",
              ephemeral: true,
              environments: [],
              sandbox: "read-only",
              approvalPolicy: "never",
            },
          });
        } else if (message.method === undefined && message.id === 1) {
          const threadId = message.result?.thread?.id;
          assert.ok(typeof threadId === "string" && threadId.length);
          assert.deepEqual(message.result?.thread?.environments, []);
          assert.equal(message.result?.thread?.ephemeral, true);
          assert.equal(message.result?.approvalPolicy, "never");
          assert.deepEqual(message.result?.sandbox, {
            type: "readOnly",
            networkAccess: false,
          });
          stage = "guest Codex turn/start";
          send({
            id: 2,
            method: "turn/start",
            params: {
              threadId,
              input: [
                {
                  type: "text",
                  text: "Reply with OK only. Do not use any tools.",
                },
              ],
            },
          });
        } else if (message.method === undefined && message.id === 2) {
          turnId = message.result?.turn?.id;
          assert.ok(turnId);
          stage = "guest Codex inference";
        } else if (message.method === "turn/completed") {
          assert.ok(turnId);
          assert.equal(message.params?.turn?.id, turnId);
          if (message.params.turn.status !== "completed") {
            const result = turnFailure(
              message.params.turn.status,
              message.params.turn.error?.codexErrorInfo,
            );
            stage = `guest Codex inference (${result})`;
            throw new Error("Guest turn did not complete");
          }
          completed = true;
          stage = "guest Codex shutdown";
          child.stdin.end();
        } else if (message.method && message.id !== undefined) {
          throw new Error("Unexpected guest server request");
        }
      }
      assert.ok(completed);
      assert.equal(await exited, 0);
      interrupt.signal.throwIfAborted();
    } finally {
      clearTimeout(deadline);
      interrupt.signal.removeEventListener("abort", kill);
      child.stdin.end();
      kill();
    }
  } finally {
    try {
      await control(["rm", "--force", "--label", label]);
    } catch {
      stage = `label-scoped cleanup (${label})`;
      cleanupFailed = true;
    } finally {
      process.off("SIGINT", cancel);
      process.off("SIGTERM", cancel);
    }
  }
  assert.ok(!cleanupFailed);
  console.log(
    "Guest Codex reported a completed turn using the supplied OAuth access token.",
  );
}

try {
  await main();
} catch {
  // CLI and protocol errors can contain provider values. Report only the stage.
  console.error(`Subscription smoke stopped at ${stage}.`);
  process.exitCode = 1;
}
