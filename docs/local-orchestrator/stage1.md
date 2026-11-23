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

## Host API

The host binds one Unix socket per Concierge session. Use a new absolute
path shorter than 100 UTF-8 bytes under a host-owned directory with mode
`0700`. The socket uses mode `0600` and accepts one client at a time. In
the Concierge VM, the stdio MCP command is
`socat STDIO VSOCK-CONNECT:2:<port>`. Microsandbox maps the socket to that
port with `--vsock <hostSocket>:<port>`.

The server accepts MCP versions `2024-11-05`, `2025-03-26`,
`2025-06-18` and `2025-11-25`. It offers `2025-11-25` for an
unrecognized version. Messages are one UTF-8 JSON-RPC object per line. The
default line limit is 1 MiB, configurable up to 4 MiB. The server closes on
an oversized line or after three parse or invalid-request errors.

The socket identifies the Concierge session. The host checks that the
session is active on each request. The tools read state, draft goal and
task proposals, and queue Planner executions. The Concierge polls
`get_execution` with the returned ID. The `status` tool counts all rows
by status and returns up to 20 of the newest pending proposals and 20 of
the newest executions. The operator approves proposals through the host
CLI. In-scope tasks can auto-register under the ordinary store rules, and
agents are ineligible to approve Concierge-origin proposals.

The store records accepted connections and disconnections against the
session ID. For each admitted tool call, it commits a `host-api.authorized`
event before reading tool data, drafting a proposal or calling the
execution requester. Each call produces one `host-api.call` outcome
event when the audit store is available, including denials and tool
errors. A host-generated call ID joins authorization to outcome.
The records include the session, known tool name, duration and fixed
outcome code as applicable. Successful execution requests and lookups
also carry the execution ID. Arguments and tool output stay out of these
records.

A failed authorization audit stops the call. A draft commits with its
own store event, and the execution requester owns the transaction for
queueing. The API records the final outcome before replying. If that
write fails, the caller receives `audit-unavailable`. Any proposal or
execution already committed stays in the store.
