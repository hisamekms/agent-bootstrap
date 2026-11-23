# Analyze local orchestrator runs with DuckDB

Run the operator CLI from the agent-bootstrap checkout. It uses that
checkout's local orchestrator state and can analyze any project run through
`--target`.

```sh
bun run src/local-orchestrator/cli.ts analyze
bun run src/local-orchestrator/cli.ts --target /path/to/dagq-lite analyze
bun run src/local-orchestrator/cli.ts --all-targets analyze
bun run src/local-orchestrator/cli.ts --all-targets analyze --out ./private-analysis --sql ./report.sql
```

The command works without a TTY or a running Concierge. It prints up to 40
rows each from `actor_summary`, `goal_summary` and `gate_latency`, followed by
any output from the supplied SQL file. With `--all-targets` it includes the
default target and discovers prior target slugs from the local state
directory, even when the original external checkout has moved. To aggregate
across targets, group on the relevant columns and omit `target` from the
grouping. Keep `target` in joins between views.

## Exports and ad-hoc queries

The default output is a private timestamped directory under
`.local/local-orchestrator/analysis/`. An explicit `--out` creates the
directory if needed and requires it to be private. Each target has a
subdirectory with `audit/`, `telemetry/{traces,metrics,logs}/` and, when a
state database exists, `orchestrator/`. Audit and state are read in place
with SQLite's WAL bookkeeping. Telemetry is taken from finalized rotations,
so active sessions may still have unpublished spans.

The operator CLI loads `observability/duckdb/views.sql` followed by
`orchestrator.sql`. It saves both and the target selection in `load.sql`.
Use the printed command and replace its final `-c` argument with your query.
The command uses the locally installed DuckDB 1.5.6 through mise and starts
in memory with `-init /dev/null`. If the pinned CLI is unavailable, the export
and manual command are still available. For a single exported target you can
also set `obs_dir` to its subdirectory and load the two shared SQL files in
that order. Set `obs_target` if you renamed that subdirectory.

Orchestrator JSONL contains structured IDs, state, timing, and usage.
Delegated answers retain the agent and session ID. Prompts, raw responses,
and authorization text are omitted. Re-export to the same directory to update
changed streams. The orchestrator export checkpoint selects the current
generation of each stream, so raw rotation globs can show older versions of
rows. Query the views for current state. The audit and telemetry artifacts have
the same sensitivity as the regular observability exports.

## View reference

| View                 | Rows and fields                                                                                                                                                                                                                                                          |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `actor_runs`         | One row per recorded execution with actor, mode, Goal and Task, outcome, fixed failure code, wall and reported CLI duration, turns, budgeted and raw tokens, cost, and any matched sandbox and process time. Verification uses actor `Reviewer` and mode `verification`. |
| `actor_summary`      | Counts, failure codes, success rate among finished runs with known outcomes, p50 and p95 elapsed time, and total and mean reported usage by target, actor and mode. Includes Concierge sessions.                                                                         |
| `task_outcomes`      | Current Task status, Executor attempts and revisions, review verdicts, path violations, verification outcomes, registration-to-integration time, and usage across Task runs. For older records, revisions are derived from Executor attempts within each Task claim.     |
| `goal_summary`       | Tasks by status, usage across Goal runs, and wall time from approval to the latest successful Task integration.                                                                                                                                                          |
| `gate_latency`       | Decided proposals with gate, policy, decision, created-to-decided time, answerer kind, and usage from a recorded agent answerer when available. In-scope Tasks that auto-register without an answer have no gate wait.                                                   |
| `concierge_sessions` | Concierge start and end, session duration and outcome, matched VM timing, and number of Planner requests, including queued requests.                                                                                                                                     |

Elapsed time and CLI duration use milliseconds. VM timing prefers recorded
spans and falls back to paired audit events. A Planner retry can contribute a
second VM invocation to one actor execution. USD, turns and CLI duration
include reported attempts when every attempt provides the corresponding value.
These values are advisory and older records, interactive Concierge sessions,
and credential-free verification may lack model usage or price data. SQL sums
and means use the available samples. Use `cost_samples` and `token_samples`
in `actor_summary` to check coverage. Researcher runs appear when recorded by
the orchestrator.

## Example queries

Time per actor across the selected targets.

```sql
SELECT actor, mode, sum(duration_ms) AS elapsed_ms,
       quantile_cont(duration_ms, 0.95) AS p95_ms
FROM (
    SELECT actor, mode, duration_ms FROM actor_runs
    UNION ALL
    SELECT actor, mode, duration_ms FROM concierge_sessions
)
GROUP BY actor, mode
ORDER BY elapsed_ms DESC;
```

Reported cost per Goal.

```sql
SELECT target, goal_id, total_cost_usd, cost_samples, total_budget_tokens
FROM goal_summary
ORDER BY total_cost_usd DESC NULLS LAST;
```

Failure reasons by target and actor.

```sql
SELECT target, actor, mode, failures_by_code
FROM actor_summary
WHERE failed > 0
ORDER BY target, actor, mode;
```

Gate wait time by answerer kind.

```sql
SELECT target, gate, answerer_kind, count(*) AS decisions,
       median(duration_ms) AS p50_ms, quantile_cont(duration_ms, 0.95) AS p95_ms
FROM gate_latency
GROUP BY target, gate, answerer_kind
ORDER BY target, gate, answerer_kind;
```
