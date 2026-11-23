-- DuckDB 1.5.6. Set obs_dir to a trusted, local exporter output directory
-- before loading this file. Use one audit source per directory.
SET autoinstall_known_extensions = false;
SET autoload_known_extensions = false;
SET TimeZone = 'UTC';

CREATE OR REPLACE TEMP MACRO obs_root() AS (
    (CASE
        WHEN getvariable('obs_dir') IS NULL OR getvariable('obs_dir') = ''
            THEN error('Set obs_dir to a local exporter directory')
        WHEN regexp_matches(getvariable('obs_dir'), '[*?\[\]]')
            THEN error('obs_dir cannot contain glob characters')
        WHEN starts_with(getvariable('obs_dir'), '/') THEN getvariable('obs_dir')
        ELSE './' || getvariable('obs_dir')
    END)
);

-- When obs_targets is set, obs_dir is the parent of the selected target slugs.
CREATE OR REPLACE TEMP MACRO obs_paths(stream, suffix) AS (
    CASE WHEN getvariable('obs_targets') IS NULL
        THEN [obs_root() || '/' || stream || suffix]
        ELSE list_transform(getvariable('obs_targets')::VARCHAR[], lambda slug:
            obs_root() || '/' ||
            CASE WHEN NOT regexp_full_match(slug, '[a-z0-9-]+')
                THEN error('Invalid target slug') ELSE slug END || '/' || stream || suffix)
    END
);

CREATE OR REPLACE TEMP MACRO obs_file_patterns(stream, suffix) AS (
    obs_paths(stream, '/[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]-[0-9][0-9][0-9][0-9].jsonl' || suffix)
);

CREATE OR REPLACE TEMP MACRO obs_source_target(filename, depth) AS (
    coalesce(getvariable('obs_target'), string_split(filename, '/')[-depth])
);

-- DuckDB reads finalized rotations directly. For an interrupted final write,
-- the prefix through the last LF remains usable, even if the UTF-8 tail is torn.
CREATE OR REPLACE TEMP MACRO obs_finalized(stream) AS TABLE
WITH decoded AS (
    SELECT filename, content, try(decode(content)) AS strict_text
    FROM read_blob(obs_file_patterns(stream, ''))
), split AS (
    SELECT filename, content, strict_text IS NOT NULL AS valid_utf8,
           coalesce(strict_text, decode(content, 'replace')) AS body
    FROM decoded
), framed AS (
    SELECT filename, content, valid_utf8, body <> '' AND NOT suffix(body, chr(10)) AS truncated,
           list_slice(string_split(body, chr(10)), 1, -2) AS complete_lines
    FROM split
)
SELECT filename, truncated,
       valid_utf8 OR (truncated AND (len(complete_lines) = 0 OR starts_with(
           hex(content), hex(encode(array_to_string(complete_lines, chr(10)) || chr(10)))
       ))) AS valid_prefix,
       complete_lines
FROM framed;

CREATE OR REPLACE TEMP MACRO obs_records(stream) AS TABLE
SELECT filename, try_cast(line AS JSON) AS record
FROM obs_finalized(stream), unnest(complete_lines) AS lines(line)
WHERE valid_prefix;

CREATE OR REPLACE TEMP MACRO obs_stream_issues(stream) AS TABLE
SELECT stream AS stream, file AS filename, 'partial-file' AS issue
FROM glob(obs_file_patterns(stream, '.partial'))
UNION ALL
SELECT stream, filename, 'truncated-last-line'
FROM obs_finalized(stream) WHERE truncated
UNION ALL
SELECT stream, filename, 'invalid-utf8'
FROM obs_finalized(stream) WHERE NOT valid_prefix
UNION ALL
SELECT DISTINCT stream, filename, 'invalid-json'
FROM obs_records(stream) WHERE json_type(record) IS DISTINCT FROM 'OBJECT';

CREATE OR REPLACE TEMP VIEW input_issues AS
SELECT * FROM obs_stream_issues('audit')
UNION ALL SELECT * FROM obs_stream_issues('telemetry/traces')
UNION ALL SELECT * FROM obs_stream_issues('telemetry/metrics')
UNION ALL SELECT * FROM obs_stream_issues('telemetry/logs');

CREATE OR REPLACE TEMP VIEW obs_audit AS
SELECT record ->> 'auditId' AS audit_id,
       split_part(audit_id, ':', 1) AS audit_table,
       try_cast(split_part(audit_id, ':', 2) AS UBIGINT) AS audit_sequence,
       try_cast(record ->> 'recordedAt' AS TIMESTAMPTZ) AS recorded_at,
       record ->> 'executionId' AS execution_id,
       record ->> 'sandboxId' AS sandbox_id,
       record ->> 'operationId' AS operation_id,
       record ->> 'actor' AS actor,
       record ->> 'action' AS action,
       record ->> 'target' AS target,
       record ->> 'phase' AS phase,
       record ->> 'result' AS result,
       record ->> 'policyId' AS policy_id,
       record ->> 'reasonCode' AS reason_code,
       record ->> 'traceId' AS trace_id,
       record -> 'attributes' AS attributes,
       coalesce(try_cast(record ->> 'derived' AS BOOLEAN), false) AS derived,
       obs_source_target(filename, 3) AS source_target
FROM obs_records('audit')
WHERE (record ->> 'schemaVersion') = 'agent-bootstrap.audit/v1';

-- Derived from audit snapshots. Missing invocation outcomes stay unknown
-- even when telemetry happens to contain a completed execution span.
CREATE OR REPLACE TEMP VIEW executions AS
SELECT execution_id,
       min(recorded_at) FILTER (WHERE audit_table = 'audit_events'
           AND action = 'invocation' AND phase = 'intent') AS started_at,
       arg_max(recorded_at, audit_sequence) FILTER (WHERE audit_table = 'audit_events'
           AND action = 'invocation' AND phase = 'outcome' AND NOT derived) AS finished_at,
       coalesce(arg_max(result, audit_sequence) FILTER (WHERE audit_table = 'audit_events'
           AND action = 'invocation' AND phase = 'outcome' AND NOT derived), 'unknown') AS outcome,
       arg_max(trace_id, audit_sequence) FILTER (WHERE audit_table = 'execution_contexts') AS trace_id,
       count(*) FILTER (WHERE NOT derived) AS audit_record_count,
       count(*) FILTER (WHERE derived) AS derived_record_count
FROM obs_audit
WHERE execution_id IS NOT NULL
GROUP BY execution_id;

CREATE OR REPLACE TEMP VIEW sandbox_lifecycle AS
SELECT audit_id, execution_id, sandbox_id, operation_id, recorded_at, phase, action,
       result, derived, policy_id,
       attributes ->> 'runtimeKind' AS runtime_kind,
       attributes ->> 'egressMode' AS egress_mode,
       attributes ->> 'netRuleDigest' AS net_rule_digest,
       attributes ->> 'gatewayPolicyDigest' AS gateway_policy_digest,
       attributes ->> 'profile' AS profile,
       attributes ->> 'image' AS image_digest
FROM obs_audit
WHERE audit_table = 'sandbox_bindings'
   OR action IN ('sandbox.create', 'sandbox.destroy');

-- Sandbox.exec phase records and guest-reported process.exit data are
-- separate rows. The process_results table exports no operation identifier.
CREATE OR REPLACE TEMP VIEW process_executions AS
SELECT audit_id, execution_id, sandbox_id, operation_id, recorded_at, actor, action,
       phase, result, derived,
       try_cast(attributes ->> 'exitCode' AS INTEGER) AS exit_code,
       attributes ->> 'signal' AS signal,
       try_cast(attributes ->> 'guestReported' AS BOOLEAN) AS guest_reported
FROM obs_audit
WHERE audit_table = 'process_results' OR action = 'sandbox.exec';

CREATE OR REPLACE TEMP VIEW network_connections AS
WITH phases AS (
    SELECT execution_id, sandbox_id, operation_id AS connection_id,
           coalesce(arg_max(target, audit_sequence) FILTER (WHERE phase = 'decision'),
                    arg_max(target, audit_sequence) FILTER (WHERE phase = 'intent')) AS target,
           max(attributes ->> 'protocol') AS protocol,
           max(attributes ->> 'channel') AS channel,
           max(attributes ->> 'destinationIp') AS destination_ip,
           max(try_cast(attributes ->> 'destinationPort' AS USMALLINT)) AS destination_port,
           max(attributes ->> 'hostname') AS hostname,
           arg_max(recorded_at, audit_sequence) FILTER (WHERE phase = 'intent') AS requested_at,
           arg_max(recorded_at, audit_sequence) FILTER (WHERE phase = 'decision') AS decided_at,
           arg_max(recorded_at, audit_sequence) FILTER (WHERE phase = 'outcome' AND NOT derived) AS finished_at,
           arg_max(result, audit_sequence) FILTER (WHERE phase = 'decision') AS decision,
           arg_max(policy_id, audit_sequence) FILTER (WHERE phase = 'decision') AS policy_id,
           arg_max(reason_code, audit_sequence) FILTER (WHERE phase = 'decision') AS reason_code,
           arg_max(result, audit_sequence) FILTER (WHERE phase = 'outcome' AND NOT derived) AS observed_outcome,
           arg_max(attributes ->> 'endReason', audit_sequence) FILTER (WHERE phase = 'outcome' AND NOT derived) AS end_reason,
           arg_max(try_cast(attributes ->> 'bytesSent' AS UBIGINT), audit_sequence)
               FILTER (WHERE phase = 'outcome' AND NOT derived) AS bytes_sent,
           arg_max(try_cast(attributes ->> 'bytesReceived' AS UBIGINT), audit_sequence)
               FILTER (WHERE phase = 'outcome' AND NOT derived) AS bytes_received,
           arg_max(try_cast(attributes ->> 'durationMs' AS DOUBLE), audit_sequence)
               FILTER (WHERE phase = 'outcome' AND NOT derived) AS duration_ms
    FROM obs_audit
    WHERE audit_table = 'network_events' AND action = 'network.connect'
      AND NOT derived AND operation_id IS NOT NULL
    GROUP BY execution_id, sandbox_id, operation_id
)
-- A late durable finish supersedes a historical exported unknown. A deny
-- has a decision only and therefore does not imply a relay outcome.
SELECT * EXCLUDE (observed_outcome),
       CASE WHEN decision = 'deny' THEN NULL
            ELSE coalesce(observed_outcome, 'unknown') END AS outcome
FROM phases;

CREATE OR REPLACE TEMP VIEW policy_decisions AS
SELECT audit_id, execution_id, sandbox_id, operation_id, recorded_at, actor,
       action, target, result AS decision, policy_id, reason_code,
       try_cast(attributes ->> 'qtype' AS USMALLINT) AS dns_qtype,
       try_cast(attributes -> 'answerIps' AS VARCHAR[]) AS dns_answer_ips
FROM obs_audit
WHERE phase = 'decision' AND NOT derived;

-- Match OTLP KeyValue keys literally, including dots. A missing attribute
-- returns SQL NULL. Only known fields are projected.
CREATE OR REPLACE TEMP MACRO obs_attribute(attributes, name) AS (
    list_extract(list_filter(attributes, lambda kv: (kv ->> 'key') = name), 1) -> 'value'
);

CREATE OR REPLACE TEMP VIEW obs_spans AS
WITH spans AS (
    SELECT filename, span, json_extract(span, '$.attributes[*]') AS attrs
    FROM obs_records('telemetry/traces'),
         unnest(json_extract(record, '$.resourceSpans[*].scopeSpans[*].spans[*]')) AS flat(span)
)
SELECT obs_attribute(attrs, 'agent_bootstrap.execution_id') ->> 'stringValue' AS execution_id,
       obs_attribute(attrs, 'agent_bootstrap.sandbox_id') ->> 'stringValue' AS sandbox_id,
       span ->> 'traceId' AS trace_id,
       nullif(span ->> 'parentSpanId', '') AS parent_span_id,
       span ->> 'spanId' AS span_id,
       span ->> 'name' AS name,
       try_cast(span ->> 'startTimeUnixNano' AS BIGINT) AS start_ns,
       try_cast(span ->> 'endTimeUnixNano' AS BIGINT) AS end_ns,
       CASE WHEN start_ns >= 0 AND end_ns >= start_ns
            THEN (end_ns - start_ns) / 1000000.0 END AS duration_ms,
       obs_attribute(attrs, 'role') ->> 'stringValue' AS role,
       obs_attribute(attrs, 'profile') ->> 'stringValue' AS profile,
       obs_attribute(attrs, 'agent.kind') ->> 'stringValue' AS agent_kind,
       obs_attribute(attrs, 'outcome') ->> 'stringValue' AS outcome,
       obs_attribute(attrs, 'resource.sampling.status') ->> 'stringValue' AS resource_sampling_status,
       try_cast(obs_attribute(attrs, 'sandbox.cpu.time') ->> 'intValue' AS BIGINT) AS cpu_time_ns,
       try_cast(obs_attribute(attrs, 'sandbox.memory.usage') ->> 'intValue' AS BIGINT) AS memory_bytes,
       try_cast(obs_attribute(attrs, 'sandbox.memory.peak') ->> 'intValue' AS BIGINT) AS peak_memory_bytes,
       obs_source_target(filename, 4) AS source_target
FROM spans;

CREATE OR REPLACE TEMP VIEW obs_metric_points AS
WITH metrics AS (
    SELECT metric,
           scope -> 'scope' ->> 'name' AS scope_name
    FROM obs_records('telemetry/metrics'),
         unnest(json_extract(record, '$.resourceMetrics[*]')) AS rm(resource),
         unnest(json_extract(resource, '$.scopeMetrics[*]')) AS sm(scope),
         unnest(json_extract(scope, '$.metrics[*]')) AS m(metric)
), points AS (
    SELECT metric, scope_name, kind, point,
           json_extract(point, '$.attributes[*]') AS attrs
    FROM metrics,
         (VALUES ('gauge'), ('sum'), ('histogram'), ('exponentialHistogram'), ('summary')) AS kinds(kind),
         unnest(json_extract(json_extract(metric, '/' || kind), '$.dataPoints[*]')) AS flat(point)
)
SELECT metric ->> 'name' AS name,
       metric ->> 'unit' AS unit,
       kind AS metric_kind,
       scope_name,
       try_cast(json_extract(metric, '/' || kind) ->> 'aggregationTemporality' AS INTEGER) AS temporality,
       try_cast(point ->> 'startTimeUnixNano' AS BIGINT) AS start_ns,
       try_cast(point ->> 'timeUnixNano' AS BIGINT) AS end_ns,
       obs_attribute(attrs, 'role') ->> 'stringValue' AS role,
       obs_attribute(attrs, 'profile') ->> 'stringValue' AS profile,
       obs_attribute(attrs, 'agent.kind') ->> 'stringValue' AS agent_kind,
       obs_attribute(attrs, 'outcome') ->> 'stringValue' AS outcome,
       try_cast(point ->> 'asInt' AS BIGINT) AS value_int,
       try_cast(point ->> 'asDouble' AS DOUBLE) AS value_double,
       try_cast(point ->> 'count' AS UBIGINT) AS sample_count,
       try_cast(point ->> 'sum' AS DOUBLE) AS sample_sum,
       try_cast(point ->> 'min' AS DOUBLE) AS sample_min,
       try_cast(point ->> 'max' AS DOUBLE) AS sample_max,
       try_cast(point -> 'bucketCounts' AS UBIGINT[]) AS bucket_counts,
       try_cast(point -> 'explicitBounds' AS DOUBLE[]) AS explicit_bounds
FROM points;

CREATE OR REPLACE TEMP VIEW execution_performance AS
SELECT 'span' AS signal, * FROM obs_spans
UNION ALL BY NAME
SELECT 'metric' AS signal, * FROM obs_metric_points;
