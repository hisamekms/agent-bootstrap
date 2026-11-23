# Stage 2 Task execution

The Concierge launcher runs a single host-side actor queue. The host checks
for registered Executor Tasks when a Task registers, after a queued job
finishes, and on drain. While the Concierge session is active it also
checks the database once per second for operator decisions from another
process. A Task is eligible when its Goal is active and every dependency
has succeeded. Planner jobs, Executor and Reviewer runs, optional
verification, and agent approvals share one actor slot alongside the
Concierge. Researcher Tasks are reserved for a later stage.

Goals are designed and executed against local `main`. Update local
`main` before starting a Concierge session, for example after merging
PRs. The launcher pins its commit for the Concierge snapshot and
records it in the session row and the `session.snapshot` event.
Planner context for new Goals comes from that snapshot. When planning
Tasks for an existing Goal, the Planner uses that Goal's pinned commit
even if local `main` has since advanced.

On the first eligible Task, the host imports the pinned commit into
`.local/local-orchestrator/repository.git`, records it as the Goal's
`baseCommit` and creates `lo/goal-<first 8 hex of goalId>`. Use
`show <goalId>` or `get_goal` to see the base. A Goal created before
commit tracking uses its existing branch if present, or the session's
snapshot when the host first plans or runs a Task for it. Once the Goal
base is imported, the Planner can read it from the private repository.
The bare repository keeps the existing Git integration adapter's strict
configuration checks and the host-pinned candidates. It uses only local objects. The per-Task
integration journal lives under `integrations/<taskId>/`. Each operator
retry uses a fresh journal in `integrations/<taskId>/retry-<number>/`.
Host staging lives under `worktrees/` alongside the database.

The Executor uses the existing Worker plan in tree mode. The Task title,
description, acceptance criteria and paths travel as a single prompt
argument. A prompt that exceeds the runtime argument bound fails with
`prompt-too-large`. The host compares the candidate to the pinned base
before starting verification or review. A path ending in `/` grants
descendants and other paths grant an exact match. A changed symlink's
normalized target must fit the Task's paths when resolved from the link's
directory. A path rejection records `path-violation` and can start a
revision. Verification failures and Reviewer requests for changes share
the same retry budget, capped at three revisions. Every Executor Task
that reaches review uses an automatic Reviewer run. Planners may mention
review in acceptance criteria and can create Executor or Researcher Tasks.

The Reviewer gets the Task fields as data and reads the candidate diff
and message in `/review/`. Its prompt ends with the JSON answer contract
and asks for at most 1500 characters of revision notes. The host accepts
Claude result text enclosed in a single plain or JSON Markdown fence.
Prose around the verdict yields a concern. The shared byte limit for
review notes still applies. Review concerns and unparseable agent approval
verdicts retain the first 4 KiB of available raw answer text on a UTF-8
boundary in the execution result.

Host callers can provide a verification suite to `startConcierge`. The
stock launcher explicitly opts into review without a suite. Each Worker,
verification and Reviewer run uses its SQLite execution ID as the
TrustedHost invocation ID. SQLite records the verification suite under
actor `Reviewer` in mode `verification`. TrustedHost uses its own
credential-free Verification role. Only an immediately preceding
pre-review verification pass for the same pin allows review to proceed.
An interrupted integration stays terminal.

The host computes budgeted tokens for each Claude run as
`input + output + cache_creation + ceil(cache_read / 10)`. Execution
results retain the four raw usage counts when available. Planner results
keep one raw usage entry per reported attempt. Executor, Reviewer and
integration approval runs share the Task's budget. The credential-free
verification suite counts as zero model tokens. The Planner contract
suggests about 60,000 budgeted tokens for one Executor and Reviewer pair,
with more for revisions and agent approval. Worker stdout carries the
collect request.
The opt-in guest command puts a marker and the complete Claude JSON result
at the end of stderr when the result fits in 64 KiB. The host receives the
last 66 KiB, parses the marked result for `usage` and `is_error` and
persists the token count. An actor run with missing, invalid or oversized
usage stops a budgeted Task with `usage-unavailable`.

The exclusive launcher refuses to start while its database has an active
Concierge session, unfinished executions or a running Task. After the
launcher has stopped, use the terminal-only `reconcile` command to close
out the displayed records in one audited transaction. Reconciliation
ends sessions and marks unfinished executions and running Tasks
`failed` with code `interrupted`. An operator can use the terminal-only
`retry-task <taskId>` command to re-register a failed Task. The host
records each retry as `task.retried` in the same transaction and allows
up to three per Task. The scheduler applies the usual eligibility checks.
Each event records a budget reset. Only executions queued after the
latest retry event count toward the Task's current budget. The CLI
`show <taskId>` and `get_goal` show both the current window and the
lifetime total. Older results retain their originally recorded counts.

A passing review creates one `integration` proposal and atomically sets
the Task to `awaiting-integration`. The proposal binds the branch, base,
candidate, diff digest, changed paths, symlink paths and review. The
effective policy comes from the Task, then Goal, then project defaults.
A proposal with symlink changes requires a human answer, as does a
legacy proposal without recorded symlink evidence. The operator CLI
shows the pinned candidate's diff stat using the empty Git attribute
tree. Use `--repo` to identify the launcher's repository when specifying
a custom `--db`.

For an eligible agent gate, the host gives the pinned diff to a dedicated
Reviewer in `approval` mode. A failed approval within the Task's known
token budget allows one new request. An interrupted approval or an
unknown or exceeded token budget leaves the proposal pending for a
human. Approval keeps the Task in `awaiting-integration`. Rejection
fails it.

The Stage 3 entry point, `integrateApprovedProposal`, currently throws
`stage-3`. Stage 3 will check approval evidence
and call the reviewed integration path before marking the Task
`succeeded`. The human handles pushes and PRs to `main`.

## Distributed development

Executors developing dagq-lite will need a sandbox profile with enough
CPU and memory to run a control plane and several nodes on VM loopback.
Stage 2 adds no profile. Assume nested VMs are unavailable and use a fake
runtime for node behavior that starts VMs.

## Verification

Local fixtures exercise the queue, real SQLite migration, real Git
candidate pinning and path checks, optional verification ordering,
the approval gate and operator CLI. These review fixes were exercised
with local fixtures. Live guest usage reporting was outside this review.
