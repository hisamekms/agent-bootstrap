import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const run = "719fcff0-ee4f-4adc-a9af-124be8115e72";
const failedRun = "f6abac75-6df0-4775-a035-f2290f54f819";
const openRun = "6d0c4a77-b72d-4474-95a8-3ec70ab43268";
const flow = "b4741cf7-5b33-42d5-a8ef-ecf08e3475b9";
const openFlow = "300ae758-9b30-49af-81a4-fd20e1337aff";

const checks = {
  "input issues": `
    (SELECT list(issue ORDER BY filename) FROM input_issues)
      = ['truncated-last-line', 'truncated-last-line', 'partial-file']
  `,
  "incomplete records excluded": `
    (SELECT count(*) = 1 AND min(outcome) = 'unknown' AND bool_and(started_at IS NOT NULL
      AND finished_at IS NULL AND audit_record_count = 1)
     FROM executions WHERE execution_id = '${openRun}')
  `,
  "execution outcomes": `
    (SELECT list(outcome ORDER BY outcome) = ['ok', 'timed-out', 'unknown']
      AND min(execution_count) = 1 AND max(execution_count) = 1
      AND sum(audit_record_count) = 27 AND sum(derived_record_count) = 3
     FROM execution_outcomes)
  `,
  "sandbox lifecycle": `
    (SELECT count(*) = 8 AND count(*) FILTER (WHERE action = 'sandbox.bind'
      AND runtime_kind = 'microsandbox' AND egress_mode = 'gateway') = 2
      AND count(*) FILTER (WHERE action = 'sandbox.destroy' AND result = 'ok') = 1
     FROM sandbox_lifecycle)
  `,
  "guest process result": `
    (SELECT count(*) FROM process_executions
     WHERE execution_id = '${run}' AND exit_code = 0 AND guest_reported
       AND operation_id IS NULL AND signal IS NULL) = 1
  `,
  "connection phase pivot": `
    (SELECT count(*) FROM network_connections) = 3
    AND (SELECT count(*) FROM network_connections
      WHERE execution_id = '${run}' AND connection_id = '${flow}'
        AND requested_at IS NOT NULL AND decided_at IS NOT NULL AND finished_at IS NOT NULL
        AND decision = 'allow' AND outcome = 'connected' AND duration_ms = 3.5
        AND end_reason = 'upstream-closed' AND bytes_sent = 42 AND bytes_received = 72) = 1
    AND (SELECT count(*) FROM network_connections
      WHERE connection_id = '${openFlow}' AND decision = 'allow' AND outcome = 'unknown'
        AND finished_at IS NULL AND bytes_sent IS NULL AND bytes_received IS NULL) = 1
  `,
  "outbound destinations": `
    (SELECT count(*) FROM outbound_destinations) = 1
    AND (SELECT count(*) FROM outbound_destinations WHERE execution_id = '${run}'
      AND target = '[2001:db8::1]:443' AND hostname = 'provider.example' AND allowed_count = 2
      AND connected_count = 1 AND unknown_count = 1 AND bytes_sent = 42) = 1
  `,
  "denied connections": `
    (SELECT count(*) FROM denied_connections) = 1
    AND (SELECT count(*) FROM denied_connections
      WHERE execution_id = '${failedRun}' AND connection_id = '${flow}'
      AND target = '192.0.2.1:80' AND reason_code = 'not-allowlisted'
      AND finished_at IS NULL AND outcome IS NULL) = 1
  `,
  "policy decisions": `
    (SELECT sum(decision_count) FROM execution_policy_decisions
      WHERE execution_id = '${run}' AND decision = 'allow' AND actor = 'gateway') = 2
    AND (SELECT count(*) FROM policy_decisions
      WHERE execution_id = '${failedRun}' AND action = 'network.dns'
        AND decision = 'deny' AND dns_qtype = 1 AND len(dns_answer_ips) = 0) = 1
  `,
  "durations and startup overhead": `
    (SELECT list(duration_ms ORDER BY duration_ms NULLS LAST) = [100, 200, NULL]
     FROM execution_durations)
    AND (SELECT count(*) FROM sandbox_startup_overhead
      WHERE execution_id = '${run}' AND startup_ms = 20 AND execution_ms = 100
        AND startup_sample_count = 1 AND overhead_ratio = 0.2) = 1
  `,
  percentiles: `
    (SELECT count(*) FROM duration_percentiles
      WHERE name = 'execution' AND sample_count = 2 AND p50_ms = 150 AND p95_ms = 195) = 1
  `,
  "failure rate and reasons": `
    (SELECT execution_count = 3 AND unknown_count = 1 AND known_count = 2
      AND unsuccessful_count = 1 AND failure_rate = 0.5 FROM execution_failure_rate)
    AND (SELECT list(source ORDER BY source) = ['invocation', 'resource.event']
      AND sum(execution_count) = 2 FROM failure_reasons WHERE reason = 'timed-out')
  `,
  "metrics and CPU/memory trends": `
    (SELECT count(*) FROM execution_performance WHERE signal = 'metric'
      AND execution_id IS NULL AND sandbox_id IS NULL AND len(bucket_counts) = 2) = 4
    AND (SELECT list(value ORDER BY end_ns, name) = [2000, 4096, 3000, 6144]
      AND list(sample_count ORDER BY end_ns, name) = [1, 1, 2, 2]
      AND bool_and(temporality = 2) FROM cpu_memory_trends)
  `,
  "trace joined by execution ID": `
    (SELECT count(*) = 63 AND count(DISTINCT span_id) = 3
      AND count(DISTINCT trace_id) = 2 AND bool_and(execution_id = '${run}')
     FROM audit_trace_by_execution)
  `,
  "trace joined by recorded context": `
    (SELECT count(*) = 42 AND count(DISTINCT span_id) = 2
      AND count(DISTINCT trace_id) = 1
      AND list(DISTINCT span_id ORDER BY span_id) = ['0000000000000001', '0000000000000002']
     FROM audit_trace_by_context)
  `,
};

const samplingFixture = JSON.stringify({
  resourceSpans: [
    {
      scopeSpans: [
        {
          spans: [
            {
              name: "execution",
              spanId: "0000000000000001",
              attributes: [
                {
                  key: "agent_bootstrap.sandbox_id",
                  value: { stringValue: "fixture-sandbox" },
                },
                {
                  key: "resource.sampling.status",
                  value: { stringValue: "unavailable" },
                },
              ],
            },
            { name: "execution", spanId: "0000000000000002", attributes: [] },
          ],
        },
      ],
    },
  ],
});

const sql = [
  "SET VARIABLE obs_dir = 'test/fixtures/obs';",
  `SET VARIABLE execution_id = '${run}';`,
  ".read observability/duckdb/views.sql",
  ".read observability/duckdb/queries.sql",
  ...Object.entries(checks).map(
    ([name, condition]) =>
      `SELECT CASE WHEN (${condition}) IS TRUE THEN 'ok' ELSE error('${name}') END;`,
  ),
  // Exercise the view with a resource status and an execution without a sandbox.
  `CREATE OR REPLACE TEMP MACRO obs_records(stream) AS TABLE
     SELECT 'sampling-fixture' AS filename, '${samplingFixture}'::JSON AS record;`,
  `SELECT CASE WHEN (
    SELECT count(*) = 2
      AND count(*) FILTER (WHERE sandbox_id IS NOT NULL AND resource_sampling_status = 'unavailable') = 1
      AND count(*) FILTER (WHERE sandbox_id IS NULL AND resource_sampling_status IS NULL) = 1
      AND bool_and(cpu_time_ns IS NULL AND memory_bytes IS NULL)
    FROM obs_spans
  ) IS TRUE THEN 'ok' ELSE error('resource sampling status') END;`,
].join("\n");

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
    ":memory:",
  ],
  {
    cwd: root,
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      MISE_OFFLINE: "1",
    },
    input: sql,
    encoding: "utf8",
  },
);

if (result.error) throw result.error;
assert.equal(result.status, 0, result.stderr);
console.log(`DuckDB smoke passed (${Object.keys(checks).length + 1} checks)`);
