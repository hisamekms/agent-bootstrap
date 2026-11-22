import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  writeFile,
} from "node:fs/promises";
import { createServer as createHttpServer, type Server } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { SqliteAudit } from "../../src/audit.ts";
import {
  claudeCodeCommand,
  claudeCodeProvider,
  claudeCodeTools,
  parseClaudeCodeResult,
} from "../../src/claude-code.ts";
import { MicrosandboxRuntime } from "../../src/microsandbox.ts";
import { TrustedHost } from "../../src/trusted-host.ts";

// Offline Claude Code smoke on Microsandbox. A loopback HTTPS server with a
// disposable CA stands in for the Anthropic API. The trusted host holds a
// synthetic API key; the guest sees only the backend placeholder. No real
// credential or Anthropic traffic is used.
const local = fileURLToPath(new URL("../../.local/", import.meta.url));
const image =
  "docker.io/library/alpine@sha256:5dda816445facf5f7282dc7689a333278834c74265ba25db2e2eb90509e3a9dd";
const hostname = "host.microsandbox.internal";
const model = "claude-opus-5-5";
const run = promisify(execFile);
let stage = "prerequisites";

type Seen = {
  path: string;
  key: string;
  authorization: boolean;
  stream: boolean;
  role: string;
};

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return address.port;
}

const sse = (type: string, data: object) =>
  `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;

type Reply =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "tool"; readonly name: string; readonly input: object };

/** Minimal Messages API stream: text, or one tool call. */
function messageStream(reply: Reply): string {
  const message = {
    id: `msg_${randomUUID()}`,
    type: "message",
    role: "assistant",
    model,
    content: [],
    stop_reason: null,
    usage: { input_tokens: 7, output_tokens: 0 },
  };
  const block =
    reply.kind === "text"
      ? [
          sse("content_block_start", {
            index: 0,
            content_block: { type: "text", text: "" },
          }),
          sse("content_block_delta", {
            index: 0,
            delta: { type: "text_delta", text: reply.text },
          }),
        ]
      : [
          sse("content_block_start", {
            index: 0,
            content_block: {
              type: "tool_use",
              id: `toolu_${randomUUID().replaceAll("-", "")}`,
              name: reply.name,
              input: {},
            },
          }),
          sse("content_block_delta", {
            index: 0,
            delta: {
              type: "input_json_delta",
              partial_json: JSON.stringify(reply.input),
            },
          }),
        ];
  return [
    sse("message_start", { message }),
    ...block,
    sse("content_block_stop", { index: 0 }),
    sse("message_delta", {
      delta: {
        stop_reason: reply.kind === "text" ? "end_turn" : "tool_use",
        stop_sequence: null,
      },
      usage: { output_tokens: 3 },
    }),
    sse("message_stop", {}),
  ].join("");
}

async function main() {
  const [msb, binary, openssl = "/usr/bin/openssl"] = process.argv.slice(2);
  const home = process.env.MSB_HOME;
  assert.ok(home && isAbsolute(home), "Set an absolute MSB_HOME");
  assert.ok(msb && isAbsolute(msb) && binary && isAbsolute(binary));
  const packageDir = join(local, "alpine/v3.23/main/aarch64");
  await mkdir(local, { recursive: true, mode: 0o700 });
  const root = await realpath(await mkdtemp(join(local, "m6-claude-")));
  const tls = join(root, "tls");
  await mkdir(tls, { mode: 0o700 });

  stage = "fixture TLS";
  const ssl = (args: string[]) =>
    run(openssl, args, {
      cwd: tls,
      env: { PATH: "/usr/bin:/bin" },
      timeout: 10_000,
    });
  await writeFile(
    join(tls, "ca.conf"),
    "[req]\nprompt=no\ndistinguished_name=dn\nx509_extensions=v3\n[dn]\nCN=Agent Bootstrap Synthetic CA\n[v3]\nbasicConstraints=critical,CA:true\nkeyUsage=critical,keyCertSign,cRLSign\n",
  );
  await writeFile(
    join(tls, "server.conf"),
    `[req]\nprompt=no\ndistinguished_name=dn\n[dn]\nCN=${hostname}\n`,
  );
  await writeFile(
    join(tls, "server.ext"),
    `subjectAltName=DNS:${hostname}\nbasicConstraints=critical,CA:false\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n`,
  );
  await ssl([
    "req",
    "-new",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-days",
    "1",
    "-config",
    "ca.conf",
    "-keyout",
    "ca.key",
    "-out",
    "ca.pem",
  ]);
  await ssl([
    "req",
    "-new",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-config",
    "server.conf",
    "-keyout",
    "server.key",
    "-out",
    "server.csr",
  ]);
  await ssl([
    "x509",
    "-req",
    "-in",
    "server.csr",
    "-CA",
    "ca.pem",
    "-CAkey",
    "ca.key",
    "-CAcreateserial",
    "-days",
    "1",
    "-extfile",
    "server.ext",
    "-out",
    "server.pem",
  ]);

  stage = "fixture servers";
  // A synthetic key that exists only on the host. It must reach the mock
  // in x-api-key and appear nowhere in the guest or in captured output.
  const syntheticKey = `sk-ant-synthetic-${randomBytes(18).toString("hex")}`;
  const seen: Seen[] = [];
  const anthropic = createHttpsServer(
    {
      key: await readFile(join(tls, "server.key")),
      cert: await readFile(join(tls, "server.pem")),
    },
    async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = Buffer.concat(chunks).toString();
      let parsed: { stream?: boolean; messages?: { content?: unknown }[] } = {};
      try {
        parsed = JSON.parse(body);
      } catch {}
      const role = /M6 ROLE: (\w+)/.exec(body)?.[1] ?? "unknown";
      seen.push({
        path: request.url ?? "",
        key: String(request.headers["x-api-key"] ?? ""),
        authorization: request.headers.authorization !== undefined,
        stream: parsed.stream === true,
        role,
      });
      if (
        !request.url?.startsWith("/v1/messages") ||
        request.url.includes("count_tokens")
      ) {
        response
          .writeHead(404, { "content-type": "application/json" })
          .end("{}");
        return;
      }
      if (request.headers["x-api-key"] !== syntheticKey) {
        response.writeHead(401, { "content-type": "application/json" }).end(
          JSON.stringify({
            type: "error",
            error: { type: "authentication_error", message: "fixture" },
          }),
        );
        return;
      }
      // Worker: Read, then Edit (Claude Code edits only a file it has read),
      // then finish.
      const results = body.split('"tool_result"').length - 1;
      if (process.env.M6_DEBUG === "1" && results === 0)
        console.error(
          "tools:",
          role,
          JSON.stringify(
            ((parsed as { tools?: { name?: string }[] }).tools ?? []).map(
              (tool) => tool.name,
            ),
          ),
        );
      if (process.env.M6_DEBUG === "1" && results > 0)
        for (const match of body.matchAll(
          /"tool_result"[^}]*?"content":("(?:[^"\\]|\\.)*"|\[[^\]]*\])/g,
        ))
          console.error("tool_result:", match[1]?.slice(0, 300));
      const path = "/workspace/hello.txt";
      const stream = messageStream(
        role !== "Worker"
          ? { kind: "text", text: "FIXTURE-PLAN-OK" }
          : results === 0
            ? { kind: "tool", name: "Read", input: { file_path: path } }
            : results === 1
              ? {
                  kind: "tool",
                  name: "Edit",
                  input: {
                    file_path: path,
                    old_string: "hello from base",
                    new_string: "Good day from Claude Code.",
                  },
                }
              : { kind: "text", text: "Done." },
      );
      response
        .writeHead(200, { "content-type": "text/event-stream" })
        .end(stream);
    },
  );
  const port = await listen(anthropic);
  let unapprovedHits = 0;
  const unapproved = createHttpServer((_request, response) => {
    unapprovedHits++;
    response.end("reached");
  });
  const unapprovedPort = await listen(unapproved);

  const runtime = new MicrosandboxRuntime({
    binary: msb,
    home,
    image,
    stagingRoot: join(root, "sandboxes"),
    providerHosts: [hostname],
    credentials: {
      async withAccessToken(consume) {
        return consume(syntheticKey);
      },
    },
  });
  const audit = new SqliteAudit(join(root, "audit.sqlite"));
  const host = new TrustedHost(audit, runtime);
  const provider = claudeCodeProvider(
    { mode: "api-key", credential: "host-secret" },
    { host: hostname, port, upstreamCaCertPath: join(tls, "ca.pem") },
  );
  const tools = claudeCodeTools({ binary, packageDir });
  const baseUrl = `https://${hostname}:${port}`;
  const started = performance.now();
  try {
    stage = "Planner (read-only)";
    const planner = () =>
      host.runPlanner({
        sandbox: {
          tools,
          provider,
          readOnlyFiles: [
            { path: "hello.txt", bytes: Buffer.from("hello from base\n") },
          ],
          maxLifetimeMs: 240_000,
        },
        command: claudeCodeCommand({
          role: "Planner",
          prompt: "M6 ROLE: Planner\nPlan how to make hello.txt formal.",
          model,
          maxTurns: 2,
          timeoutMs: 180_000,
          baseUrl,
        }),
      });
    // Two concurrent sandboxes: separate VMs, separate config, one key.
    const [first, second] = await Promise.all([planner(), planner()]);
    const plans = [first, second].map((runResult) =>
      parseClaudeCodeResult(runResult.response),
    );

    stage = "Worker (edit and collect)";
    const worker = await host.runWorker({
      sandbox: {
        tools,
        provider,
        files: [{ path: "hello.txt", bytes: Buffer.from("hello from base\n") }],
        maxLifetimeMs: 240_000,
      },
      command: claudeCodeCommand({
        role: "Worker",
        prompt: "M6 ROLE: Worker\nChange hello.txt to a formal greeting.",
        model,
        maxTurns: 4,
        timeoutMs: 180_000,
        baseUrl,
      }),
      collectPaths: ["hello.txt"],
    });
    const edited = worker.artifacts?.files[0]?.bytes;

    stage = "guest exposure and egress";
    // A separate VM with the same egress: search the guest for the key and
    // try an unapproved destination.
    const probe = await runtime.create({
      tools: tools.slice(0, 1),
      provider,
      maxLifetimeMs: 60_000,
    });
    let probeOut = "";
    try {
      const result = await runtime.exec(probe, {
        argv: [
          "/bin/sh",
          "-c",
          `
          printf 'placeholder=%s\\n' "$( [ "$ANTHROPIC_API_KEY" = '$MSB_ANTHROPIC_API_KEY' ] && echo yes || echo no)"
          # The pattern is split across argv and joined by the shell builtin
          # into a file outside the searched paths, so no command line
          # contains the searched string.
          mkdir -p /var/probe && printf '%s%s' "$1" "$3" > /var/probe/pattern
          hits=$(grep -r -l -a -F -f /var/probe/pattern /proc/[0-9]*/environ /proc/[0-9]*/cmdline /tmp /root /etc /.msb 2>/dev/null | wc -l)
          printf 'key-hits=%s\\n' "$hits"
          if wget -q -T 3 -O /dev/null "http://${hostname}:$2/" 2>/dev/null; then echo unapproved=reached; else echo unapproved=blocked; fi
          `,
          "probe",
          syntheticKey.slice(0, 12),
          String(unapprovedPort),
          syntheticKey.slice(12, 24),
        ],
        timeoutMs: 30_000,
      });
      probeOut = Buffer.from(result.stdout).toString();
    } finally {
      await runtime.destroy(probe).catch(() => {});
    }

    const captured = [first, second, worker]
      .map((runResult) =>
        Buffer.from(
          ("response" in runResult ? runResult.response : undefined) ??
            new Uint8Array(),
        ).toString("latin1"),
      )
      .join("\n");
    const egress = [first.id, second.id, worker.id].map((id) =>
      audit
        .read(id)
        .filter((event) => event.operation === "provider.egress")
        .map(
          (event) => `${event.kind}${event.outcome ? ` ${event.outcome}` : ""}`,
        ),
    );
    const report = {
      claudeCode: "2.1.330 linux-arm64-musl",
      seconds: Math.round((performance.now() - started) / 100) / 10,
      planners: [first.outcome, second.outcome],
      plans: plans.map(
        (plan) => plan && { text: plan.text, isError: plan.isError },
      ),
      worker: worker.outcome,
      edited: edited ? Buffer.from(edited).toString() : null,
      requests: seen.map((entry) => ({
        path: entry.path,
        role: entry.role,
        stream: entry.stream,
        substituted: entry.key === syntheticKey,
        authorization: entry.authorization,
      })),
      probe: probeOut.trim().split("\n"),
      unapprovedHits,
      keyInCapturedOutput: captured.includes(syntheticKey),
      egress,
    };
    console.log(JSON.stringify(report, null, 2));
    assert.deepEqual(report.planners, ["ok", "ok"]);
    assert.ok(
      plans.every((plan) => plan?.text === "FIXTURE-PLAN-OK" && !plan.isError),
    );
    assert.equal(worker.outcome, "ok");
    assert.equal(report.edited, "Good day from Claude Code.\n");
    const messages = seen.filter((entry) =>
      entry.path.startsWith("/v1/messages"),
    );
    assert.ok(messages.length >= 4);
    assert.ok(
      messages.every(
        (entry) =>
          entry.key === syntheticKey && entry.stream && !entry.authorization,
      ),
    );
    assert.deepEqual(report.probe, [
      "placeholder=yes",
      "key-hits=0",
      "unapproved=blocked",
    ]);
    assert.equal(unapprovedHits, 0);
    assert.equal(report.keyInCapturedOutput, false);
    for (const events of egress)
      assert.deepEqual(events, [
        "operation.requested",
        "operation.allowed",
        "operation.finished ok",
      ]);
    console.log(
      "Claude Code ran in Microsandbox with a host-held key: substituted only into x-api-key upstream, absent from the guest and output, over a streaming response.",
    );
  } finally {
    audit.close();
    anthropic.close();
    unapproved.close();
  }
}

try {
  await main();
} catch (error) {
  // Diagnostics can carry fixture values: report the stage only, unless the
  // operator asks for details of this offline fixture.
  console.error(`Claude Code smoke stopped at ${stage}.`);
  if (process.env.M6_DEBUG === "1") console.error(error);
  process.exitCode = 1;
}
