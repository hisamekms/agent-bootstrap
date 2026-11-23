# Stage 2 Task execution

The Concierge launcher runs a single host-side actor queue. The host checks
for registered Executor Tasks when a Task registers, after a queued job
finishes, and on drain. While the Concierge session is active it also
checks the database once per second for operator decisions from another
process. A Task is eligible when its Goal is active and every dependency
has succeeded. Planner jobs, Executor and Reviewer runs, optional
verification, and agent approvals share one actor slot alongside the
Concierge. Researcher Tasks are reserved for a later stage.

On the first eligible Task, the host imports the source checkout's local
`main` into the private `.local/local-orchestrator/repository.git` and
creates `lo/goal-<first 8 hex of goalId>` there. The bare repository keeps
the existing Git integration adapter's strict configuration checks and
the host-pinned candidates. It uses only local objects. The per-Task
integration journal lives under `integrations/<taskId>/` and host staging
lives under `worktrees/` alongside the database.

The Executor uses the existing Worker plan in tree mode. The Task title,
description, acceptance criteria and paths travel as a single prompt
argument. A prompt that exceeds the runtime argument bound fails with
`prompt-too-large`. The host compares the candidate to the pinned base
before starting verification or review. A path ending in `/` grants
descendants and other paths grant an exact match. A path rejection records
`path-violation` and can start a revision. A Reviewer can also request a
revision. Both share the Task retry budget, capped at the integration
journal's three revisions. Host callers can provide a verification plan
to `startConcierge`. The stock launcher has no suite configured.

Each Worker attempt and candidate review has a correlated SQLite execution
record and uses that ID for the TrustedHost invocation. Worker and Reviewer
command timeouts are capped by the Task budget and the Microsandbox limit.
The host records available Claude input and output token counts after each
run and checks the cumulative total before proceeding. Missing usage
remains unknown. Worker usage depends on a complete, bounded result
envelope. A crash can leave a Task or session active for operator
reconciliation. The scheduler avoids automatically replaying those
invocations.

A passing review creates one `integration` proposal and atomically sets
the Task to `awaiting-integration`. The proposal binds the branch, base,
candidate, diff digest, changed paths and review. The effective policy
comes from the Task, then Goal, then project defaults. For a human gate,
inspect the paths and diff stat with the operator CLI's `show` or
`approve` command. For an agent gate, the host gives the pinned diff to
a dedicated Reviewer in `approval` mode. An approval keeps the Task in
`awaiting-integration`. A rejection fails the Task.

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
the approval gate and operator CLI. A live run is still needed to verify
Claude behavior, Microsandbox tree transport, profile provisioning and
usage reporting in the assembled Concierge path.
