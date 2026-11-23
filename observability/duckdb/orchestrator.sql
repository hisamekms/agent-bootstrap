-- Load after views.sql. For a single target set obs_target to its slug
-- if the export directory's basename is different.
CREATE OR REPLACE TEMP VIEW orchestrator_checkpoints AS
SELECT obs_source_target(filename, 3) AS target, try_cast(decode(content) AS JSON) AS state
FROM read_blob(obs_paths('orchestrator', '/export-state.json'));

CREATE OR REPLACE TEMP VIEW input_issues AS
SELECT * FROM obs_input_issues
UNION ALL
SELECT 'orchestrator', path, 'missing-stream'
FROM unnest(obs_paths('orchestrator', '/export-state.json')) AS paths(path)
ANTI JOIN glob(obs_paths('orchestrator', '/export-state.json')) ON path = file
UNION ALL
SELECT * FROM obs_missing_rotations('orchestrator/events')
UNION ALL SELECT * FROM obs_missing_rotations('orchestrator/proposals')
UNION ALL SELECT * FROM obs_missing_rotations('orchestrator/approvals')
UNION ALL SELECT * FROM obs_missing_rotations('orchestrator/tasks')
UNION ALL SELECT * FROM obs_missing_rotations('orchestrator/goals')
UNION ALL SELECT * FROM obs_missing_rotations('orchestrator/executions')
UNION ALL SELECT * FROM obs_missing_rotations('orchestrator/sessions');

CREATE OR REPLACE TEMP MACRO orchestrator_records(stream) AS TABLE
SELECT c.target, r.record
FROM obs_records('orchestrator/' || stream) r
JOIN orchestrator_checkpoints c ON c.target = obs_source_target(r.filename, 4)
WHERE (r.record ->> 'generation') = json_extract_string(c.state, '/streams/' || stream || '/generation');

-- Extract only the active generation of each stream, including mutable rows.
CREATE OR REPLACE TEMP MACRO lo_rows(stream, fields) AS TABLE
SELECT target, unnest(json_transform(record, fields))
FROM orchestrator_records(stream);

CREATE OR REPLACE TEMP VIEW lo_events AS
SELECT * FROM lo_rows('events',
    '{"sequence":"BIGINT","kind":"VARCHAR","subject_kind":"VARCHAR","subject_id":"VARCHAR",
      "at":"TIMESTAMPTZ","mode":"VARCHAR","status":"VARCHAR","code":"VARCHAR"}');

CREATE OR REPLACE TEMP VIEW lo_proposals AS
SELECT * FROM lo_rows('proposals',
    '{"id":"VARCHAR","kind":"VARCHAR","status":"VARCHAR","created_at":"TIMESTAMPTZ",
      "decided_at":"TIMESTAMPTZ","execution_id":"VARCHAR","goal_id":"VARCHAR","task_id":"VARCHAR"}');

CREATE OR REPLACE TEMP VIEW lo_approvals AS
SELECT * FROM lo_rows('approvals',
    '{"proposal_id":"VARCHAR","gate":"VARCHAR","policy":"VARCHAR","policy_source":"VARCHAR",
      "decision":"VARCHAR","at":"TIMESTAMPTZ","answerer_kind":"VARCHAR","delegated":"BOOLEAN",
      "agent":"VARCHAR","session":"VARCHAR","execution_id":"VARCHAR"}');

CREATE OR REPLACE TEMP VIEW lo_tasks AS
SELECT * FROM lo_rows('tasks',
    '{"id":"VARCHAR","proposal_id":"VARCHAR","goal_id":"VARCHAR","status":"VARCHAR","created_at":"TIMESTAMPTZ"}');

CREATE OR REPLACE TEMP VIEW lo_goals AS
SELECT * FROM lo_rows('goals',
    '{"id":"VARCHAR","proposal_id":"VARCHAR","status":"VARCHAR","created_at":"TIMESTAMPTZ"}');

CREATE OR REPLACE TEMP VIEW lo_executions AS
SELECT * FROM lo_rows('executions',
    '{"sequence":"BIGINT","id":"VARCHAR","actor":"VARCHAR","mode":"VARCHAR","goal_id":"VARCHAR","task_id":"VARCHAR",
      "session_id":"VARCHAR","invocation_id":"VARCHAR","approval_proposal_id":"VARCHAR",
      "status":"VARCHAR","failure_code":"VARCHAR","started_at":"TIMESTAMPTZ","finished_at":"TIMESTAMPTZ",
      "tokens":"BIGINT","input_tokens":"BIGINT","output_tokens":"BIGINT",
      "cache_creation_tokens":"BIGINT","cache_read_tokens":"BIGINT","usage_complete":"BOOLEAN",
      "costUsd":"DOUBLE","numTurns":"BIGINT","durationMs":"BIGINT","review_verdict":"VARCHAR",
      "verification_phase":"VARCHAR","revision":"BOOLEAN"}');

CREATE OR REPLACE TEMP MACRO lo_elapsed(started, finished) AS (
    CASE WHEN finished >= started THEN date_diff('millisecond', started, finished) END
);

CREATE OR REPLACE TEMP VIEW lo_vm_timing AS
WITH spans AS (
    SELECT DISTINCT source_target, execution_id, trace_id, span_id, name, duration_ms
    FROM obs_spans
    WHERE name IN ('sandbox.create', 'process.exec', 'agent.run')
), telemetry AS (
    SELECT source_target, execution_id,
           sum(duration_ms) FILTER (WHERE name = 'sandbox.create') AS sandbox_create_ms,
           sum(duration_ms) FILTER (WHERE name IN ('process.exec', 'agent.run')) AS process_exec_ms
    FROM spans GROUP BY source_target, execution_id
), operations AS (
    SELECT source_target, execution_id, action, operation_id,
           lo_elapsed(min(recorded_at) FILTER (WHERE phase = 'intent'),
                      max(recorded_at) FILTER (WHERE phase = 'outcome')) AS duration_ms
    FROM obs_audit
    WHERE NOT derived AND operation_id IS NOT NULL AND action IN ('sandbox.create', 'sandbox.exec')
    GROUP BY source_target, execution_id, action, operation_id
), audit AS (
    SELECT source_target, execution_id,
           sum(duration_ms) FILTER (WHERE action = 'sandbox.create') AS sandbox_create_ms,
           sum(duration_ms) FILTER (WHERE action = 'sandbox.exec') AS process_exec_ms
    FROM operations GROUP BY source_target, execution_id
)
SELECT source_target AS target, execution_id,
       coalesce(t.sandbox_create_ms, a.sandbox_create_ms) AS sandbox_create_ms,
       coalesce(t.process_exec_ms, a.process_exec_ms) AS process_exec_ms
FROM telemetry t FULL OUTER JOIN audit a USING (source_target, execution_id);

CREATE OR REPLACE TEMP VIEW actor_runs AS
WITH proposal_context AS (
    SELECT p.target, p.id AS proposal_id, p.execution_id AS producer_id,
           a.execution_id AS answerer_id, coalesce(p.goal_id, g.id) AS goal_id,
           coalesce(p.task_id, t.id) AS task_id
    FROM lo_proposals p
    LEFT JOIN lo_goals g ON (p.target, p.id) = (g.target, g.proposal_id)
    LEFT JOIN lo_tasks t ON (p.target, p.id) = (t.target, t.proposal_id)
    LEFT JOIN lo_approvals a ON (p.target, p.id) = (a.target, a.proposal_id)
), derived_goals AS (
    SELECT target, producer_id AS id, min(goal_id) AS goal_id
    FROM proposal_context WHERE producer_id IS NOT NULL GROUP BY target, producer_id
), approval_context AS (
    SELECT target, answerer_id AS id, min(goal_id) AS goal_id, min(task_id) AS task_id
    FROM proposal_context WHERE answerer_id IS NOT NULL GROUP BY target, answerer_id
), invocations AS (
    SELECT target, id, coalesce(invocation_id, id) AS invocation_id FROM lo_executions
    UNION
    SELECT source_target, attributes ->> 'retryOfExecutionId', execution_id
    FROM obs_audit
    WHERE audit_table = 'execution_contexts' AND (attributes ->> 'retryOfExecutionId') IS NOT NULL
), timing AS (
    SELECT i.target, i.id, sum(v.sandbox_create_ms) AS sandbox_create_ms,
           sum(v.process_exec_ms) AS process_exec_ms
    FROM invocations i JOIN lo_vm_timing v ON (i.target, i.invocation_id) = (v.target, v.execution_id)
    GROUP BY i.target, i.id
)
SELECT e.target, e.id AS execution_id, e.actor, e.mode,
       coalesce(e.goal_id, p.goal_id, a.goal_id, g.goal_id) AS goal_id,
       coalesce(e.task_id, p.task_id, a.task_id) AS task_id,
       e.status,
       CASE WHEN e.status IN ('failed', 'timed-out', 'cancelled')
            THEN coalesce(e.failure_code, e.status) END AS failure_code,
       e.started_at, e.finished_at, lo_elapsed(e.started_at, e.finished_at) AS duration_ms,
       e.tokens AS budget_tokens, e.input_tokens, e.output_tokens, e.cache_creation_tokens, e.cache_read_tokens,
       e.input_tokens + e.output_tokens + e.cache_creation_tokens + e.cache_read_tokens AS raw_tokens,
       e.usage_complete, e.costUsd AS cost_usd, e.numTurns AS num_turns, e.durationMs AS cli_duration_ms,
       v.sandbox_create_ms, v.process_exec_ms, coalesce(e.invocation_id, e.id) AS invocation_id,
       e.session_id, e.review_verdict, e.verification_phase, e.revision, e.sequence AS run_sequence
FROM lo_executions e
LEFT JOIN derived_goals g USING (target, id)
LEFT JOIN approval_context a USING (target, id)
LEFT JOIN proposal_context p ON (e.target, e.approval_proposal_id) = (p.target, p.proposal_id)
LEFT JOIN timing v USING (target, id);

CREATE OR REPLACE TEMP VIEW denials AS
WITH run_ids AS (
    SELECT target, execution_id, actor, 1 AS priority FROM actor_runs
    UNION ALL SELECT target, invocation_id, actor, 2 FROM actor_runs
    UNION ALL
    SELECT r.target, a.execution_id, r.actor, 3
    FROM actor_runs r JOIN obs_audit a ON r.target = a.source_target
        AND (a.attributes ->> 'retryOfExecutionId') IN (r.execution_id, r.invocation_id)
    WHERE a.audit_table = 'execution_contexts'
), actors AS (
    SELECT target, execution_id, first(actor ORDER BY priority, actor) AS actor
    FROM run_ids GROUP BY target, execution_id
)
SELECT d.* REPLACE (coalesce(a.actor, d.actor) AS actor)
FROM obs_denials d LEFT JOIN actors a USING (target, execution_id);

CREATE OR REPLACE TEMP VIEW concierge_sessions AS
WITH sessions AS (
    SELECT * FROM lo_rows('sessions',
        '{"id":"VARCHAR","actor":"VARCHAR","runtime_id":"VARCHAR","status":"VARCHAR",
          "started_at":"TIMESTAMPTZ","ended_at":"TIMESTAMPTZ"}')
), planner_requests AS (
    SELECT target, session_id, count(*) AS requests
    FROM lo_executions WHERE actor = 'Planner' GROUP BY target, session_id
), audit_outcomes AS (
    SELECT source_target AS target, execution_id,
           arg_max(result, audit_sequence) FILTER (WHERE action = 'invocation' AND phase = 'outcome') AS outcome,
           arg_max(try_cast(attributes ->> 'exitCode' AS INTEGER), audit_sequence)
               FILTER (WHERE action = 'process.exec') AS exit_code
    FROM obs_audit WHERE NOT derived GROUP BY source_target, execution_id
)
SELECT s.target, s.id AS session_id, s.runtime_id AS execution_id, s.actor,
       coalesce(e.mode, 'interactive') AS mode, s.started_at, s.ended_at,
       lo_elapsed(s.started_at, s.ended_at) AS duration_ms, coalesce(p.requests, 0) AS planner_requests,
       CASE WHEN s.status = 'active' THEN 'running'
            WHEN e.code = 'interrupted' THEN 'failed'
            WHEN e.status IS NOT NULL THEN e.status
            WHEN a.outcome = 'ok' AND a.exit_code = 0 THEN 'succeeded'
            WHEN a.exit_code <> 0 OR a.outcome <> 'ok' THEN 'failed'
            ELSE 'unknown' END AS session_outcome,
       CASE WHEN session_outcome = 'failed' THEN coalesce(e.code, 'session-failed') END AS failure_code,
       v.sandbox_create_ms, v.process_exec_ms
FROM sessions s
LEFT JOIN planner_requests p ON (s.target, s.id) = (p.target, p.session_id)
LEFT JOIN lo_events e ON (s.target, s.id) = (e.target, e.subject_id) AND e.kind = 'session.ended'
LEFT JOIN audit_outcomes a ON (s.target, s.runtime_id) = (a.target, a.execution_id)
LEFT JOIN lo_vm_timing v ON (s.target, s.runtime_id) = (v.target, v.execution_id)
WHERE s.actor = 'Concierge';

CREATE OR REPLACE TEMP VIEW actor_summary AS
WITH runs AS (
    SELECT target, actor, mode, status, failure_code, duration_ms, cost_usd, budget_tokens, raw_tokens FROM actor_runs
    UNION ALL
    SELECT target, actor, mode, session_outcome, failure_code, duration_ms, NULL, NULL, NULL FROM concierge_sessions
), failures AS (
    SELECT target, actor, mode, failure_code, count(*) AS failures
    FROM runs WHERE failure_code IS NOT NULL GROUP BY ALL
), failure_maps AS (
    SELECT target, actor, mode, json_group_object(failure_code, failures) AS failures_by_code
    FROM failures GROUP BY target, actor, mode
), stats AS (
    SELECT target, actor, mode, count(*) AS runs,
           count(*) FILTER (WHERE status = 'succeeded') AS succeeded,
           count(*) FILTER (WHERE failure_code IS NOT NULL) AS failed,
           succeeded::DOUBLE / nullif(succeeded + failed, 0) AS success_rate,
           quantile_cont(duration_ms, 0.50) AS p50_duration_ms,
           quantile_cont(duration_ms, 0.95) AS p95_duration_ms,
           count(cost_usd) AS cost_samples, sum(cost_usd) AS total_cost_usd, avg(cost_usd) AS mean_cost_usd,
           count(budget_tokens) AS token_samples,
           sum(budget_tokens) AS total_budget_tokens, avg(budget_tokens) AS mean_budget_tokens,
           sum(raw_tokens) AS total_raw_tokens, avg(raw_tokens) AS mean_raw_tokens
    FROM runs GROUP BY target, actor, mode
)
SELECT stats.*, coalesce(f.failures_by_code, '{}'::JSON) AS failures_by_code
FROM stats LEFT JOIN failure_maps f USING (target, actor, mode);

CREATE OR REPLACE TEMP VIEW task_outcomes AS
WITH task_runs AS MATERIALIZED (
    SELECT * FROM actor_runs WHERE task_id IS NOT NULL
), claims AS (
    SELECT target, subject_id AS task_id, sequence
    FROM lo_events
    WHERE subject_kind = 'task' AND kind = 'task.status' AND status = 'running' AND code IS NULL
), queued_executors AS (
    SELECT r.target, r.task_id, r.revision, r.run_sequence, q.sequence AS queued_sequence
    FROM task_runs r LEFT JOIN lo_events q
        ON (r.target, r.execution_id) = (q.target, q.subject_id) AND q.kind = 'execution.queued'
    WHERE r.actor = 'Executor' AND r.mode = 'task' AND r.started_at IS NOT NULL
), executor_attempts AS (
    SELECT r.target, r.task_id, coalesce(r.revision,
        row_number() OVER (PARTITION BY r.target, r.task_id, c.sequence ORDER BY r.run_sequence) > 1) AS revision
    FROM queued_executors r ASOF LEFT JOIN claims c
        ON r.target = c.target AND r.task_id = c.task_id AND r.queued_sequence > c.sequence
), attempts AS (
    SELECT target, task_id, count(*) AS attempts, count(*) FILTER (WHERE revision) AS revisions
    FROM executor_attempts GROUP BY target, task_id
), runs AS (
    SELECT target, task_id,
           list(review_verdict ORDER BY run_sequence) FILTER (WHERE review_verdict IS NOT NULL) AS review_verdicts,
           count(*) FILTER (WHERE failure_code = 'path-violation') AS path_violations,
           list(status ORDER BY run_sequence) FILTER (WHERE mode = 'verification') AS verification_results,
           count(cost_usd) AS cost_samples, sum(cost_usd) AS total_cost_usd,
           sum(budget_tokens) AS total_budget_tokens, sum(raw_tokens) AS total_raw_tokens
    FROM task_runs GROUP BY target, task_id
), events AS (
    SELECT target, subject_id AS task_id,
           max("at") FILTER (WHERE kind = 'task.integrated') AS integrated_at,
           arg_max_null(code, sequence) FILTER (WHERE kind = 'task.status') AS last_status_code
    FROM lo_events WHERE subject_kind = 'task' GROUP BY target, task_id
)
SELECT t.target, t.id AS task_id, t.goal_id, t.status, e.last_status_code AS failure_code,
       coalesce(a.attempts, 0) AS attempts, coalesce(a.revisions, 0) AS revisions,
       coalesce(r.review_verdicts, []) AS review_verdicts,
       coalesce(r.path_violations, 0) AS path_violations,
       coalesce(r.verification_results, []) AS verification_results,
       t.created_at AS registered_at, e.integrated_at,
       lo_elapsed(t.created_at, e.integrated_at) AS registration_to_integration_ms,
       coalesce(r.cost_samples, 0) AS cost_samples, r.total_cost_usd, r.total_budget_tokens, r.total_raw_tokens
FROM lo_tasks t
LEFT JOIN attempts a ON (t.target, t.id) = (a.target, a.task_id)
LEFT JOIN runs r ON (t.target, t.id) = (r.target, r.task_id)
LEFT JOIN events e ON (t.target, t.id) = (e.target, e.task_id);

CREATE OR REPLACE TEMP VIEW goal_summary AS
WITH tasks AS (
    SELECT target, goal_id, count(*) AS tasks,
           count(*) FILTER (WHERE status = 'registered') AS registered,
           count(*) FILTER (WHERE status = 'running') AS running,
           count(*) FILTER (WHERE status = 'awaiting-integration') AS awaiting_integration,
           count(*) FILTER (WHERE status = 'succeeded') AS succeeded,
           count(*) FILTER (WHERE status = 'failed') AS failed,
           count(*) FILTER (WHERE status = 'cancelled') AS cancelled,
           max(integrated_at) AS last_integration_at
    FROM task_outcomes GROUP BY target, goal_id
), costs AS (
    SELECT target, goal_id, count(cost_usd) AS cost_samples, sum(cost_usd) AS total_cost_usd,
           sum(budget_tokens) AS total_budget_tokens, sum(raw_tokens) AS total_raw_tokens
    FROM actor_runs WHERE goal_id IS NOT NULL GROUP BY target, goal_id
)
SELECT g.target, g.id AS goal_id, g.status,
       coalesce(t.tasks, 0) AS tasks, coalesce(t.registered, 0) AS registered,
       coalesce(t.running, 0) AS running, coalesce(t.awaiting_integration, 0) AS awaiting_integration,
       coalesce(t.succeeded, 0) AS succeeded, coalesce(t.failed, 0) AS failed,
       coalesce(t.cancelled, 0) AS cancelled,
       coalesce(a."at", g.created_at) AS approved_at, t.last_integration_at,
       lo_elapsed(coalesce(a."at", g.created_at), t.last_integration_at) AS approval_to_last_integration_ms,
       coalesce(c.cost_samples, 0) AS cost_samples, c.total_cost_usd, c.total_budget_tokens, c.total_raw_tokens
FROM lo_goals g
LEFT JOIN lo_approvals a USING (target, proposal_id)
LEFT JOIN tasks t ON (g.target, g.id) = (t.target, t.goal_id)
LEFT JOIN costs c ON (g.target, g.id) = (c.target, c.goal_id);

CREATE OR REPLACE TEMP VIEW gate_latency AS
SELECT p.target, p.id AS proposal_id, a.gate, p.kind, a.policy, a.policy_source,
       CASE WHEN a.delegated THEN 'delegated' ELSE a.answerer_kind END AS answerer_kind,
       a.delegated, a.agent, a.session, a.decision, p.created_at,
       coalesce(p.decided_at, a."at") AS decided_at,
       lo_elapsed(p.created_at, coalesce(p.decided_at, a."at")) AS duration_ms,
       a.execution_id AS answerer_execution_id, e.status AS answerer_status,
       e.costUsd AS answerer_cost_usd, e.tokens AS answerer_budget_tokens
FROM lo_proposals p
JOIN lo_approvals a ON (p.target, p.id) = (a.target, a.proposal_id)
LEFT JOIN lo_executions e ON (a.target, a.execution_id) = (e.target, e.id);
