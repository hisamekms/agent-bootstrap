import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { exportAudit } from "../../src/audit-export.ts";
import { AuditStoreError } from "../../src/audit.ts";
import type { EgressGatewayOptions } from "../../src/egress-gateway.ts";
import { createObservedHost } from "../../src/observed-host.ts";
import { parseObservabilityConfig } from "../../src/observability-config.ts";
import { ProfileCatalog } from "../../src/sandbox-profiles.ts";
import { createTelemetry } from "../../src/telemetry.ts";
import { HostAuditError } from "../../src/trusted-host.ts";
import { fakeGateway } from "../../test/fake-gateway.ts";

const repo = fileURLToPath(new URL("../../", import.meta.url));
const providerIp = "192.0.2.11";
const deniedIp = "192.0.2.99";
const providers = {
  codex: { host: "codex.invalid", secretEnv: "FIXTURE_CODEX_TOKEN" },
  claude: {
    host: "claude.invalid",
    secretEnv: "FIXTURE_CLAUDE_KEY",
    header: "x-api-key" as const,
  },
};
type Actor = keyof typeof providers;
type Scenario =
  | "normal"
  | "policy-denial"
  | "timeout"
  | "start-failure"
  | "process-failure"
  | "forced-termination"
  | "audit-failure"
  | "telemetry-failure";
type Checks = Record<string, string>;

const quote = (value: string) => "'" + value.replaceAll("'", "''") + "'";
function duckdb(directory: string, executionId: string, statements: string[]) {
  assert.ok(
    !/[\r\n]/.test(directory),
    "Unexpected newline in artifact directory",
  );
  const result = spawnSync(
    "mise",
    [
      "--no-config",
      "--no-env",
      "--no-hooks",
      "exec",
      "duckdb@1.5.6",
      "--",
      "duckdb",
      "-init",
      "/dev/null",
      "-bail",
      "-json",
      ":memory:",
    ],
    {
      cwd: repo,
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        MISE_OFFLINE: "1",
      },
      input: [
        `SET VARIABLE obs_dir = ${quote(directory)};`,
        `SET VARIABLE execution_id = ${quote(executionId)};`,
        ".read observability/duckdb/views.sql",
        ".read observability/duckdb/queries.sql",
        ...statements,
      ].join("\n"),
      encoding: "utf8",
      timeout: 60_000,
      maxBuffer: 4 * 1024 * 1024,
    },
  );
  if (result.error) throw result.error;
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function checkSql(checks: Checks) {
  return Object.entries(checks).map(
    ([name, condition]) =>
      `SELECT CASE WHEN (${condition}) IS TRUE THEN ${quote(name)} ELSE error(${quote(name)}) END AS passed;`,
  );
}

function reportSql() {
  const auditOrder =
    "recorded_at, split_part(audit_id, ':', 1), try_cast(split_part(audit_id, ':', 2) AS UBIGINT)";
  return [
    "SELECT * FROM input_issues;",
    "SELECT * FROM executions WHERE execution_id = getvariable('execution_id');",
    `SELECT action, phase, result, sandbox_id FROM sandbox_lifecycle WHERE execution_id = getvariable('execution_id') ORDER BY ${auditOrder};`,
    `SELECT action, phase, result, exit_code, guest_reported FROM process_executions WHERE execution_id = getvariable('execution_id') ORDER BY ${auditOrder};`,
    "SELECT result AS resource_event FROM obs_audit WHERE action = 'resource.event' AND execution_id = getvariable('execution_id');",
    "SELECT * FROM outbound_destinations WHERE execution_id = getvariable('execution_id');",
    "SELECT target, policy_id, reason_code FROM denied_connections WHERE execution_id = getvariable('execution_id');",
    "SELECT target, channel, decision, outcome, end_reason, bytes_sent, bytes_received FROM network_connections WHERE execution_id = getvariable('execution_id');",
    "SELECT * FROM execution_policy_decisions WHERE execution_id = getvariable('execution_id');",
    "SELECT target, decision, reason_code, dns_qtype, dns_answer_ips FROM policy_decisions WHERE action = 'network.dns' AND execution_id = getvariable('execution_id');",
    "SELECT trace_id, span_id, parent_span_id, name, outcome, duration_ms FROM obs_spans WHERE execution_id = getvariable('execution_id') ORDER BY start_ns, end_ns DESC;",
    "SELECT * FROM sandbox_startup_overhead WHERE execution_id = getvariable('execution_id');",
    "SELECT agent_kind, role, outcome, cpu_time_ns, memory_bytes, peak_memory_bytes FROM obs_spans WHERE name = 'execution' AND execution_id = getvariable('execution_id');",
    "SELECT count(*) AS matches_by_execution FROM audit_trace_by_execution;",
    "SELECT count(*) AS matches_by_context FROM audit_trace_by_context;",
  ];
}

// A scripted backend stands in for msb. It never starts a VM or a socket,
// and it cannot be pointed at any supplied binary.
async function fixtureBackend(root: string) {
  const binary = join(root, "fixture-backend");
  await writeFile(
    binary,
    `#!${process.execPath}
import { Database } from "bun:sqlite";
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const args = process.argv.slice(2);
const option = (name) => args[args.indexOf(name) + 1];
switch (args[0]) {
  case "--version": console.log("msb 0.7.16"); break;
  case "image":
    if (existsSync("image-missing")) process.exit(1);
    console.log(JSON.stringify({ digest: args.at(-1).split("@").at(-1) }));
    break;
  case "list": console.log("[]"); break;
  case "create": {
    const audit = new Database(await Bun.file("audit-path").text(), { readonly: true });
    const binding = audit.query("SELECT 1 FROM sandbox_bindings WHERE sandbox_id = ? AND egress_mode = 'gateway'").get(option("--name"));
    audit.close();
    if (!binding || option("--pull") !== "never" || !args.includes("--proxy")) process.exit(90);
    const workspace = option("--copy-dir").slice(0, -":/workspace".length);
    const input = join(workspace, "hello.txt");
    if (existsSync(input)) copyFileSync(input, "hello.txt");
    break;
  }
  case "metrics":
    console.log(JSON.stringify(JSON.parse(await Bun.file("resources.json").text())));
    break;
  case "rm": writeFileSync("removed", ""); break;
  case "exec":
    if (args.at(-3) === "collect" && args.at(-2) === "hello.txt") {
      const file = readFileSync("hello.txt");
      console.log(file.length);
      console.log(file.toString("base64"));
      break;
    }
    if (args.at(-1) === "process-failure") process.exit(23);
    writeFileSync("started", "");
    while (!existsSync("release")) await Bun.sleep(10);
    if (args.at(-1) === "normal") {
      if (readFileSync("hello.txt", "utf8") !== "Hi!\\n") process.exit(92);
      writeFileSync("hello.txt", "Good day.\\n");
      console.log('{"tool":"collect"}');
    }
    break;
  default: process.exit(91);
}
`,
    { mode: 0o700 },
  );
  return binary;
}

// Exercise the real policy and audit API through createObservedHost's fixture
// override. "Effects" here are counters and relay records with no socket I/O.
function gatewayFixture(options: EgressGatewayOptions) {
  const fake = fakeGateway([]);
  const identity = {
    invocationId: options.executionId,
    sandboxId: options.sandboxLabel,
  };
  const relayIds = new Set<string>();
  let effects = 0;

  async function finish(
    connectionId: string,
    endReason: "upstream-closed" | "sandbox-destroyed",
  ) {
    await options.audit.appendNetworkFinished({
      ...identity,
      connectionId,
      result: "connected",
      endReason,
      bytesSent: 42,
      bytesReceived: 72,
      durationMs: 3.5,
    });
    relayIds.delete(connectionId);
  }

  return {
    async open() {
      const gateway = await fake.open(options);
      return {
        ...gateway,
        get quarantined() {
          return gateway.quarantined;
        },
        async close() {
          if (!gateway.quarantined)
            for (const id of relayIds) await finish(id, "sandbox-destroyed");
          await gateway.close();
        },
      };
    },
    get effects() {
      return effects;
    },
    async dns(qname: string) {
      const qtype = 1;
      const decision = options.policy.decideDns({ qname, qtype });
      const answers = decision.decision === "allow" ? [providerIp] : [];
      await options.audit.appendDnsQuery({
        ...identity,
        queryId: randomUUID(),
        protocol: "udp",
        qname,
        qtype,
        decision: decision.decision,
        policyId: options.policy.policyId,
        reasonCode: decision.reasonCode,
        answerIps: answers,
      });
      for (const ip of answers)
        options.policy.dnsPins.pin(identity.sandboxId, qname, ip, 60);
      return decision.decision;
    },
    async connect(
      ip: string,
      port: number,
      connectionId: string = randomUUID(),
    ) {
      if (fake.gateway.quarantined) return "quarantined";
      const decision = options.policy.decideConnect({
        ip,
        port,
        sandbox: identity.sandboxId,
      });
      try {
        await options.audit.appendNetwork({
          ...identity,
          connectionId,
          destinationIp: ip,
          destinationPort: port,
          channel: decision.decision === "allow" ? decision.channel : "egress",
          ...(decision.decision === "allow" && decision.hostname
            ? { hostname: decision.hostname }
            : {}),
          decision: decision.decision,
          policyId: options.policy.policyId,
          reasonCode: decision.reasonCode,
        });
      } catch (error) {
        fake.quarantine();
        if (
          !(error instanceof AuditStoreError) ||
          error.code !== "append-failed"
        )
          throw error;
        return "audit-failed";
      }
      if (decision.decision === "deny") return "deny";
      effects++;
      relayIds.add(connectionId);
      return connectionId;
    },
    finish,
  };
}

async function runFixture(
  root: string,
  binary: string,
  actor: Actor,
  scenario: Scenario,
  sharedAudit: string,
  directory: string,
) {
  const executionId = randomUUID();
  const home = join(root, executionId);
  await mkdir(home);
  // The fake backend sees only its workspace and the audit canary query.
  await writeFile(
    join(home, "resources.json"),
    JSON.stringify({
      vcpu_time_ns: actor === "codex" ? 20_000 : 30_000,
      memory_bytes: actor === "codex" ? 4096 : 8192,
    }),
  );
  if (scenario === "start-failure")
    await writeFile(join(home, "image-missing"), "");
  if (scenario === "telemetry-failure") {
    await mkdir(join(directory, "telemetry"), { recursive: true });
    await writeFile(join(directory, "telemetry", "traces"), "");
  }
  const msb = { binary, home, stagingRoot: join(home, "staging") };
  const config = parseObservabilityConfig(
    { directory, audit: { mode: "required" } },
    {
      msbHome: home,
      stagingRoot: msb.stagingRoot,
    },
  );
  const telemetry = createTelemetry(config.telemetry, config.directory);
  let gateway: ReturnType<typeof gatewayFixture> | undefined;
  let observed: Awaited<ReturnType<typeof createObservedHost>> | undefined;
  const provider = providers[actor];
  const cancel = new AbortController();
  const auditPath = sharedAudit;
  await writeFile(join(home, "audit-path"), auditPath);
  const traceId = randomBytes(16).toString("hex");
  try {
    observed = await createObservedHost({
      config,
      auditPath,
      msb,
      profiles: new ProfileCatalog({
        base: { image: `fixture.invalid/base@sha256:${"a".repeat(64)}` },
      }),
      providerBindings: [
        {
          provider,
          credentials: {
            async withAccessToken(use) {
              return use("synthetic-fixture-credential");
            },
          },
        },
      ],
      observers: [
        {
          ...telemetry,
          observe(event) {
            telemetry.observe(
              event.eventType === "execution.started"
                ? { ...event, payload: { ...event.payload, agentKind: actor } }
                : event,
            );
          },
        },
      ],
      async openGateway(options) {
        const fixture = gatewayFixture(options);
        if (options.executionId === executionId) gateway = fixture;
        return fixture.open();
      },
    });
    const invocation = observed.host.runWorker(
      {
        sandbox: {
          provider,
          ...(scenario === "normal"
            ? { files: [{ path: "hello.txt", bytes: Buffer.from("Hi!\n") }] }
            : {}),
        },
        command: {
          argv: ["/fixture", scenario],
          timeoutMs: scenario === "timeout" ? 750 : 30_000,
          signal: cancel.signal,
        },
        collectPaths: scenario === "normal" ? ["hello.txt"] : [],
      },
      executionId,
      {
        executionId,
        traceContext: {
          traceparent: `00-${traceId}-${randomBytes(8).toString("hex")}-01`,
        },
      },
    );
    let settled = false;
    const result = invocation.then(
      (value) => {
        settled = true;
        return { value };
      },
      (error: unknown) => {
        settled = true;
        return { error };
      },
    );

    try {
      if (
        scenario !== "start-failure" &&
        scenario !== "process-failure" &&
        scenario !== "timeout"
      ) {
        const deadline = performance.now() + 15_000;
        while (!existsSync(join(home, "started"))) {
          assert.ok(
            !settled && performance.now() < deadline,
            "Fixture exec did not start",
          );
          await sleep(10);
        }
        assert.ok(gateway);
        if (scenario === "policy-denial") {
          assert.equal(await gateway.connect(deniedIp, 80), "deny");
          assert.equal(
            await gateway.dns(`denied-${randomUUID()}.invalid`),
            "deny",
          );
          assert.equal(gateway.effects, 0);
        } else if (scenario !== "telemetry-failure") {
          assert.equal(await gateway.dns(provider.host), "allow");
          const connectionId = await gateway.connect(providerIp, 443);
          assert.match(connectionId, /^[a-f0-9-]{36}$/);
          if (scenario === "normal")
            await gateway.finish(connectionId, "upstream-closed");
          if (scenario === "forced-termination") cancel.abort();
          if (scenario === "audit-failure") {
            // Reuse a live ID to exercise SQLite's transactional UNIQUE failure.
            assert.equal(
              await gateway.connect(providerIp, 443, connectionId),
              "audit-failed",
            );
            assert.equal(observed.audit.isV5Writable, false);
            assert.equal(await gateway.connect(providerIp, 443), "quarantined");
          }
          assert.equal(gateway.effects, 1);
        }
        if (scenario !== "forced-termination" && scenario !== "audit-failure")
          await writeFile(join(home, "release"), "");
      }
      const completed = await result;
      if (scenario === "timeout")
        assert.ok(
          existsSync(join(home, "started")),
          "Expected in-flight timeout",
        );
      if (scenario === "audit-failure") {
        assert.ok(
          "error" in completed && completed.error instanceof HostAuditError,
        );
      } else {
        if ("error" in completed) throw completed.error;
        assert.equal(completed.value.outcome, expectedOutcome(scenario));
        if (scenario === "normal") {
          const files = completed.value.artifacts?.files;
          assert.equal(files?.length, 1);
          assert.equal(files[0]?.path, "hello.txt");
          assert.equal(Buffer.from(files[0]!.bytes).toString(), "Good day.\n");
        }
      }
      if (scenario !== "start-failure")
        assert.ok(
          existsSync(join(home, "removed")),
          "Expected fixture teardown",
        );
    } finally {
      if (!settled) cancel.abort();
      await result;
    }
  } finally {
    try {
      await observed?.close();
    } finally {
      await telemetry.shutdown();
    }
  }
  exportAudit(auditPath, directory);
  const checks = scenarioChecks(scenario, executionId, traceId, provider.host);
  duckdb(directory, executionId, checkSql(checks));
  console.log(
    JSON.stringify({
      actor,
      scenario,
      executionId,
      checks: Object.keys(checks),
    }),
  );
  return executionId;
}

function expectedOutcome(scenario: Scenario) {
  switch (scenario) {
    case "timeout":
      return "timed-out";
    case "forced-termination":
      return "cancelled";
    case "start-failure":
    case "process-failure":
      return "failed";
    case "audit-failure":
      return "unknown";
    default:
      return "ok";
  }
}

function scenarioChecks(
  scenario: Scenario,
  executionId: string,
  traceId: string,
  providerHost: string,
): Checks {
  const run = "execution_id = getvariable('execution_id')";
  const checks: Checks = {
    "clean finalized inputs":
      "(SELECT count(*) = 0 FROM input_issues WHERE issue <> 'missing-stream')",
    "result by execution ID": `
      (SELECT count(*) = 1 AND min(outcome) = ${quote(expectedOutcome(scenario))}
        AND min(audit_record_count) > 0 AND bool_and(started_at IS NOT NULL)
        AND bool_and((finished_at IS NULL) = (outcome = 'unknown'))
       FROM executions WHERE ${run})
    `,
    "durable sandbox binding": `
      (SELECT count(*) = 1 FROM sandbox_lifecycle WHERE ${run} AND action = 'sandbox.bind'
        AND sandbox_id IS NOT NULL AND egress_mode = 'gateway' AND length(net_rule_digest) = 64)
    `,
    "sandbox create outcome": `
      (SELECT count(*) = 1 FROM sandbox_lifecycle WHERE ${run} AND action = 'sandbox.create'
        AND phase = 'outcome' AND NOT derived
        AND result = '${scenario === "start-failure" ? "failed" : "ok"}')
    `,
  };
  if (scenario === "telemetry-failure") {
    checks["trace export failure counted"] = `
      (SELECT count(*) = 0 FROM obs_spans WHERE ${run})
      AND (SELECT count(*) > 0 FROM obs_metric_points
           WHERE name = 'obs.telemetry.dropped' AND coalesce(value_int, value_double) > 0)
    `;
  } else {
    checks["duration and startup overhead"] = `
      (SELECT count(*) = 1 FROM sandbox_startup_overhead WHERE ${run}
        AND startup_sample_count = 1 AND startup_ms > 0 AND execution_ms >= startup_ms
        AND overhead_ratio > 0 AND overhead_ratio <= 1)
    `;
    checks["audit and trace joined by both IDs"] = `
      (SELECT count(*) > 0 AND bool_and(trace_id = ${quote(traceId)}) FROM audit_trace_by_context)
      AND (SELECT count(*) FROM audit_trace_by_execution) =
          (SELECT count(*) FROM audit_trace_by_context)
      AND (SELECT count(*) = 1 FROM obs_spans WHERE ${run} AND trace_id = ${quote(traceId)}
           AND name = 'execution')
    `;
  }
  if (scenario === "start-failure") {
    checks["start failed without process or gateway traffic"] = `
      (SELECT count(*) = 0 FROM obs_audit WHERE ${run}
        AND (audit_table = 'network_events' OR action IN ('sandbox.exec', 'sandbox.destroy')))
      AND (SELECT count(*) = 1 FROM obs_spans WHERE ${run}
           AND name = 'sandbox.create' AND outcome = 'failed')
    `;
    return checks;
  }
  if (scenario === "audit-failure") {
    checks["interrupted audit remains usable"] = `
      (SELECT count(*) = 1 FROM network_connections WHERE ${run} AND decision = 'allow'
           AND outcome = 'unknown' AND finished_at IS NULL AND bytes_sent IS NULL)
      AND (SELECT count(*) = 1 FROM network_connections WHERE ${run})
      AND (SELECT count(*) = 1 FROM obs_audit WHERE ${run} AND action = 'sandbox.exec'
           AND phase = 'outcome' AND derived AND result = 'unknown')
      AND (SELECT count(*) = 0 FROM obs_audit WHERE ${run}
           AND action IN ('sandbox.destroy', 'sandbox.collect'))
    `;
    return checks;
  }
  checks["execution and sandbox teardown recorded"] = `
    (SELECT count(*) = 1 FROM sandbox_lifecycle WHERE ${run} AND action = 'sandbox.destroy'
     AND phase = 'outcome' AND result = 'ok')
    AND (SELECT count(*) = 1 FROM process_executions WHERE ${run} AND action = 'sandbox.exec'
         AND phase = 'outcome' AND NOT derived AND result = ${quote(expectedOutcome(scenario))})
  `;
  switch (scenario) {
    case "normal":
      checks["lifecycle trace"] = `
        (SELECT list(child.name ORDER BY child.name) FROM obs_spans child
         JOIN obs_spans parent ON child.parent_span_id = parent.span_id
            AND child.trace_id = parent.trace_id AND child.execution_id = parent.execution_id
         WHERE parent.execution_id = ${quote(executionId)} AND parent.name = 'execution')
        = ['agent.run', 'agent.start', 'sandbox.create', 'sandbox.destroy']
      `;
      checks["audited artifact collection"] = `
        (SELECT count(*) = 1 FROM obs_audit WHERE ${run} AND action = 'sandbox.collect'
         AND phase = 'outcome' AND NOT derived AND result = 'ok')
      `;
      checks["successful guest exit"] = `
        (SELECT count(*) = 1 FROM process_executions WHERE ${run}
         AND exit_code = 0 AND guest_reported AND signal IS NULL)
      `;
      checks["provider connection and DNS"] = `
        (SELECT count(*) = 1 FROM outbound_destinations WHERE ${run} AND channel = 'provider-egress'
         AND destination_ip = ${quote(providerIp)} AND destination_port = 443
         AND hostname = ${quote(providerHost)} AND connected_count = 1 AND allowed_count = 1)
        AND (SELECT count(*) = 1 FROM policy_decisions WHERE ${run} AND action = 'network.dns'
             AND decision = 'allow' AND dns_answer_ips = [${quote(providerIp)}])
      `;
      break;
    case "policy-denial":
      checks["unapproved TCP destination and DNS denied"] = `
        (SELECT count(*) = 1 FROM denied_connections WHERE ${run}
         AND destination_ip = ${quote(deniedIp)} AND destination_port = 80
         AND reason_code = 'not-allowlisted' AND finished_at IS NULL AND outcome IS NULL)
        AND (SELECT count(*) = 1 FROM policy_decisions WHERE ${run} AND action = 'network.dns'
             AND decision = 'deny' AND reason_code = 'dns-not-allowlisted' AND len(dns_answer_ips) = 0)
        AND (SELECT count(*) = 0 FROM outbound_destinations WHERE ${run})
      `;
      break;
    case "timeout":
      checks["timeout resource and error span"] = `
        (SELECT count(*) = 1 FROM obs_audit WHERE ${run} AND action = 'resource.event' AND result = 'timed-out')
        AND (SELECT count(*) = 1 FROM obs_spans WHERE ${run} AND name = 'execution' AND outcome = 'timed_out')
        AND (SELECT count(*) = 1 FROM obs_records('telemetry/traces'),
             unnest(json_extract(record, '$.resourceSpans[*].scopeSpans[*].spans[*]')) AS spans(span)
             WHERE (span ->> 'traceId') = ${quote(traceId)} AND (span ->> 'name') = 'execution'
               AND (span ->> '$.status.code') = '2'
               AND list_contains(json_extract_string(span, '$.events[*].name'), 'resource.limit_exceeded'))
      `;
      break;
    case "process-failure":
      checks["guest-reported exit code"] = `
        (SELECT count(*) = 1 FROM process_executions WHERE ${run}
         AND exit_code = 23 AND guest_reported AND signal IS NULL)
      `;
      break;
    case "forced-termination":
      checks["terminated execution retains relay outcome"] = `
        (SELECT count(*) = 1 FROM obs_audit WHERE ${run}
         AND action = 'resource.event' AND result = 'forced-termination')
        AND (SELECT count(*) = 1 FROM network_connections WHERE ${run}
             AND decision = 'allow' AND outcome = 'connected' AND end_reason = 'sandbox-destroyed'
             AND requested_at <= decided_at AND decided_at <= finished_at)
      `;
      break;
  }
  return checks;
}

async function fixtureRoot() {
  const artifacts = join(repo, ".local");
  await mkdir(artifacts, { recursive: true, mode: 0o700 });
  return realpath(await mkdtemp(join(artifacts, "obs16-")));
}

async function fixtures() {
  const root = await fixtureRoot();
  const auditPath = join(root, "audit.sqlite");
  const directory = join(root, "observability");
  const binary = await fixtureBackend(root);
  console.log(JSON.stringify({ root, directory }));
  const normals: { executionId: string; actor: Actor }[] = [];
  for (const actor of ["codex", "claude"] as const) {
    for (const scenario of [
      "normal",
      "policy-denial",
      "timeout",
      "start-failure",
      "process-failure",
      "forced-termination",
      "audit-failure",
    ] as const) {
      const executionId = await runFixture(
        root,
        binary,
        actor,
        scenario,
        auditPath,
        directory,
      );
      if (scenario === "normal") normals.push({ executionId, actor });
    }
  }
  const comparison = `
    WITH runs(execution_id, actor) AS (VALUES ${normals
      .map(
        ({ executionId, actor }) => `(${quote(executionId)}, ${quote(actor)})`,
      )
      .join(", ")})
    SELECT runs.actor, s.execution_id, s.execution_ms, s.startup_ms, s.overhead_ratio,
           p.cpu_time_ns, p.memory_bytes, p.peak_memory_bytes
    FROM runs
    JOIN sandbox_startup_overhead s USING (execution_id)
    JOIN obs_spans p ON p.execution_id = s.execution_id AND p.trace_id = s.trace_id
                    AND p.agent_kind = runs.actor
    WHERE p.name = 'execution' ORDER BY runs.actor
  `;
  const rows = JSON.parse(
    duckdb(directory, normals[0]!.executionId, [comparison + ";"]),
  ) as {
    actor: Actor;
    execution_ms: number;
    startup_ms: number;
    overhead_ratio: number;
    cpu_time_ns: number;
    memory_bytes: number;
    peak_memory_bytes: number;
  }[];
  assert.deepEqual(
    rows.map((row) => [
      row.actor,
      row.cpu_time_ns,
      row.memory_bytes,
      row.peak_memory_bytes,
    ]),
    [
      ["claude", 30_000, 8192, 8192],
      ["codex", 20_000, 4096, 4096],
    ],
  );
  for (const row of rows) {
    assert.ok(row.execution_ms >= row.startup_ms && row.startup_ms > 0);
    assert.ok(row.overhead_ratio > 0 && row.overhead_ratio <= 1);
  }
  console.log(JSON.stringify({ comparison: rows }));

  const telemetry = spawnSync(
    process.execPath,
    [fileURLToPath(import.meta.url), "--fixture-telemetry"],
    {
      encoding: "utf8",
      timeout: 60_000,
    },
  );
  if (telemetry.error) throw telemetry.error;
  assert.equal(telemetry.status, 0, telemetry.stderr);
  assert.equal(
    telemetry.stderr.match(/obs\.telemetry\.dropped signal=traces kind=/g)
      ?.length,
    2,
  );
  console.log(telemetry.stdout.trim());
  console.log(
    JSON.stringify({
      checks: ["telemetry stderr diagnostics", "comparison"],
      status: "passed",
    }),
  );
}

const [mode, ...args] = process.argv.slice(2);
if (mode === "--fixture" && !args.length) {
  await fixtures();
} else if (mode === "--analyze" && args.length === 2) {
  const [directory, executionId] = args as [string, string];
  assert.match(executionId, /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/);
  console.log(duckdb(resolve(directory), executionId, reportSql()));
} else if (mode === "--fixture-telemetry" && !args.length) {
  const root = await fixtureRoot();
  const binary = await fixtureBackend(root);
  console.log(JSON.stringify({ root, scenario: "telemetry-failure" }));
  for (const actor of ["codex", "claude"] as const)
    await runFixture(
      root,
      binary,
      actor,
      "telemetry-failure",
      join(root, actor + ".sqlite"),
      join(root, actor),
    );
} else {
  throw new Error(
    "Usage: bun spike/obs/dogfood-scenarios.ts --fixture | --analyze <observability-dir> <execution-id>",
  );
}
