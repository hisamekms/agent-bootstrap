# Stage 1 local orchestrator state

The host opens a private SQLite file in a host-controlled directory. New files
use mode `0600`. Connections use WAL, full synchronization, foreign keys and
a one-second busy timeout. [ADR 0001](adr-0001-local-orchestrator.md) defines
the actors, approval boundaries and scope of the local orchestrator.

- `project_policy` starts with all gates set to `human`. Operator updates
  merge the supplied gates into the stored defaults.
- `proposals` stores validated content, origin, digest and decision state.
  `goals` and `tasks` store registered content and reference their proposal.
  `approvals` records one decision per pending proposal, including the
  digest, gate, effective policy and source, answerer and timestamp.
- `executions` records the caller, context, state and optional result.
  Queued executions can start or be cancelled. Running executions can
  succeed, fail, time out or be cancelled. `actor_sessions` records runtime
  bindings and the transition from active to ended.
- `events` records state changes in the same immediate transaction as the
  relational writes. Triggers reject updates, deletions and replacements.
  An unsuccessful event insert rolls back the entire operation. Event data
  is limited to 4 KiB of structured metadata. Proposal text, model output and
  execution results stay in their state tables. Event reads return the newest
  matching records first.

Goals start as pending proposals. Canonical JSON sorts object keys and
preserves array order so a SHA-256 digest covers both the text and the
structured scope. Decisions check that digest and resolve policy against
the defaults and applicable layers in the same transaction. Pending tasks
use the inherited registration gate. A task request for human registration
also makes agent answers ineligible. Approving any requested loosening
requires a human, even when it targets a different gate and the inherited
registration policy is `agent`. The registered Goal or Task supplies its
policy overrides to subsequent operations.

An agent answer must reference a running Reviewer execution in `approval`
mode with origin `{ kind: "host" }`. Actors cannot request approval-mode
executions. For a task proposal, the execution must be correlated to the
proposal's goal. A registered task ID on the execution supplies that task's
goal. The proposal producer and agent answers to Concierge-origin proposals
are ineligible.

A task auto-registers when it fits the approved scope, has same-goal
dependencies and requests no loosening. A gate decision can approve an
exception to the path, actor or profile grant. The host still checks the
active goal, task count, dependency membership and each budget at
registration. Executor tasks must name at least one repository path.
Researcher tasks have an empty path list and receive no repository.
A trailing slash grants descendants of a path. Other paths match exactly.

The limits are 1,000 registered tasks per goal, 1–3,600,000 ms per
execution, 0–10 retries per task and 1–10,000,000 model tokens. Accepted
descriptions and individual acceptance entries are at most 20,000 UTF-16
code units. Execution results must be JSON and fit within 256 KiB of UTF-8.

The store takes caller and answerer identities from trusted host code. The
Host API and operator CLI own caller authentication and role permissions.
The host supplies the execution ID when it submits an agent's answer.
Scheduling and budget consumption will use the stored execution and task
records.

## Runner

One host-owned `ActorRunner` shares a FIFO queue between Planner runs and
Reviewer approvals, with eight waiting jobs by default. Production uses
`claudeRoleHarness` with the configured API key boundary. Concurrent calls to
`drain()` share the same worker. Execution records are durable. The queue,
Planner briefs and queued proposal references live in memory, so this runner
cannot resume queued work after a host restart.

The Planner reads `/review/request.json` and host-selected read-only files
under `/review/repo/`. The runner applies Microsandbox's count, per-file and
aggregate byte limits to the complete file set. The first Planner attempt and
each approval use the stored execution ID as the host invocation ID. A
Planner can retry a non-timeout actor failure or invalid answer once inside
the same stored execution. The trusted host audit allows one context per
invocation ID, so the retry uses a fresh ID with `retryOfExecutionId` set to
the original execution ID. Forward that context when wiring `runPlanner`.
The runner checks the returned invocation ID before acting on a response.
Timeouts are terminal. Successful Planner results record the attempt count
and total reported token usage when available.

The runner validates the entire Planner answer before submitting proposals.
Task references such as `#0` resolve to the earlier entry's registered task
ID, or to its proposal ID if it is pending. A dependent proposal with a
pending dependency also stays pending. Approval creates a separate task ID,
so the dependent proposal must be resubmitted with that registered ID.
Each proposal is a separate store transaction. A later write failure leaves
earlier audited proposals recorded. If the store cannot persist a terminal
status, `drain()` rejects and stops processing. The stored execution can
remain running until the host recovers the state.

An approval starts only for a pending proposal with an effective agent
policy. The runner uses the store's public policy query and accounts for
pending content that tightens the registration gate to human. The Reviewer
gets the digest-bound proposal in `proposal.json` and, for a task, the
registered Goal content in `goal.json`. The store checks the digest, policy
and approval eligibility while the Reviewer execution is running. A store
refusal or invalid verdict ends the execution without a decision by the
runner. Approval runs have one attempt.
