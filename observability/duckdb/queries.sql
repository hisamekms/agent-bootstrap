-- Run from the repository root with the CLI in :memory: mode and -init /dev/null.
-- SET VARIABLE obs_dir = '/path/to/export';
-- SET VARIABLE execution_id = '719fcff0-ee4f-4adc-a9af-124be8115e72';
-- .read observability/duckdb/views.sql
-- .read observability/duckdb/queries.sql
-- SELECT * FROM input_issues ORDER BY stream, filename, issue;
--
-- Run SELECT * FROM <view> to inspect each analysis below. Durations and
-- percentiles cover exported spans. Failure rates cover the derived audit
-- executions and report how many outcomes are missing.

CREATE OR REPLACE TEMP VIEW execution_outcomes AS
SELECT outcome, count(*) AS execution_count,
       sum(audit_record_count) AS audit_record_count,
       sum(derived_record_count) AS derived_record_count
FROM executions
GROUP BY outcome;

CREATE OR REPLACE TEMP VIEW execution_durations AS
SELECT e.execution_id, e.outcome, p.trace_id, p.span_id, p.duration_ms
FROM executions e
LEFT JOIN execution_performance p ON p.execution_id = e.execution_id
    AND p.signal = 'span' AND p.name = 'execution';

CREATE OR REPLACE TEMP VIEW sandbox_startup_overhead AS
WITH startup AS (
    SELECT execution_id, trace_id, count(duration_ms) AS startup_sample_count,
           sum(duration_ms) AS startup_ms
    FROM execution_performance
    WHERE signal = 'span' AND name = 'sandbox.create'
    GROUP BY execution_id, trace_id
)
SELECT d.execution_id, d.trace_id, s.startup_sample_count, s.startup_ms,
       d.duration_ms AS execution_ms, s.startup_ms / nullif(d.duration_ms, 0) AS overhead_ratio
FROM execution_durations d
LEFT JOIN startup s USING (execution_id, trace_id);

CREATE OR REPLACE TEMP VIEW duration_percentiles AS
SELECT name, count(duration_ms) AS sample_count,
       quantile_cont(duration_ms, 0.50) AS p50_ms,
       quantile_cont(duration_ms, 0.95) AS p95_ms
FROM execution_performance
WHERE signal = 'span' AND name IN ('execution', 'sandbox.create', 'agent.run', 'process.exec')
GROUP BY name;

CREATE OR REPLACE TEMP VIEW execution_failure_rate AS
SELECT count(*) AS execution_count,
       count(*) FILTER (WHERE outcome = 'unknown') AS unknown_count,
       count(*) FILTER (WHERE outcome <> 'unknown') AS known_count,
       count(*) FILTER (WHERE outcome NOT IN ('ok', 'unknown')) AS unsuccessful_count,
       unsuccessful_count::DOUBLE / nullif(known_count, 0) AS failure_rate
FROM executions;

-- Invocation outcomes and recorded resource failures are separate counts.
-- A resource event is evidence of what occurred, without inferring causality.
CREATE OR REPLACE TEMP VIEW failure_reasons AS
SELECT 'invocation' AS source, outcome AS reason, count(*) AS record_count,
       count(*) AS execution_count
FROM executions WHERE outcome NOT IN ('ok', 'unknown')
GROUP BY outcome
UNION ALL
SELECT 'resource.event', result, count(*), count(DISTINCT execution_id)
FROM obs_audit WHERE audit_table = 'resource_events'
GROUP BY result;

-- Histogram snapshots can be cumulative. The mean is for each snapshot
-- and label set; summing snapshots would double-count cumulative samples.
CREATE OR REPLACE TEMP VIEW cpu_memory_trends AS
SELECT end_ns, name, unit, role, profile, agent_kind, outcome, metric_kind, temporality,
       sample_count, sample_min, sample_max,
       coalesce(value_double, value_int::DOUBLE, sample_sum / nullif(sample_count, 0)) AS value
FROM execution_performance
WHERE signal = 'metric'
  AND name IN ('sandbox.cpu.time', 'sandbox.memory.usage', 'sandbox.memory.peak',
               'sandbox.memory.host_resident');

CREATE OR REPLACE TEMP VIEW outbound_destinations AS
SELECT execution_id, target, destination_ip, destination_port, hostname, channel,
       count(*) AS allowed_count,
       count(*) FILTER (WHERE outcome = 'connected') AS connected_count,
       count(*) FILTER (WHERE outcome = 'unknown') AS unknown_count,
       sum(bytes_sent) AS bytes_sent, sum(bytes_received) AS bytes_received
FROM network_connections
WHERE decision = 'allow' AND destination_ip IS NOT NULL
GROUP BY execution_id, target, destination_ip, destination_port, hostname, channel;

CREATE OR REPLACE TEMP VIEW denied_connections AS
SELECT * FROM network_connections WHERE decision = 'deny';

CREATE OR REPLACE TEMP VIEW execution_policy_decisions AS
SELECT execution_id, actor, action, target, decision, policy_id, reason_code,
       count(*) AS decision_count
FROM policy_decisions
GROUP BY execution_id, actor, action, target, decision, policy_id, reason_code;

CREATE OR REPLACE TEMP VIEW audit_trace_by_execution AS
SELECT a.execution_id, a.audit_id, a.recorded_at, a.action, a.phase,
       a.result, a.derived, s.trace_id, s.span_id, s.name AS span_name
FROM obs_audit a
JOIN obs_spans s USING (execution_id)
WHERE a.execution_id = getvariable('execution_id');

-- Two invocations can share a caller trace. Require matching execution
-- attribution as well as the trace ID from the durable context.
CREATE OR REPLACE TEMP VIEW audit_trace_by_context AS
SELECT a.execution_id, a.audit_id, a.recorded_at, a.action, a.phase,
       a.result, a.derived, s.trace_id, s.span_id, s.name AS span_name
FROM executions e
JOIN obs_audit a USING (execution_id)
JOIN obs_spans s ON s.trace_id = e.trace_id AND s.execution_id = e.execution_id
WHERE e.execution_id = getvariable('execution_id');
