# ADR 0001: Local orchestrator

- Status: proposed
- Date: 2026-11-23

## Context

dagq-lite will be a distributed product with a control plane and nodes. The
operator needs a provisional development environment that runs a five-actor
cycle in Microsandbox VMs on one machine. The operator will use it to develop
dagq-lite.

The local orchestrator is a separate layer on agent-bootstrap. Its planned
path is `src/local-orchestrator/`. It reuses the VM runtime, egress gateway
and network audit, SQLite audit, credential boundary, integration and
verification. Those components remain owned by agent-bootstrap.

## Decisions

### D1. Run on one machine

Use one host process and SQLite. Store current state in relational tables
and write a separate append-only audit trail. There is no distribution,
message broker, workflow engine or event sourcing.

The control-plane and node split belongs to dagq-lite. Keeping the local
layer small makes it easier to build and replace. Retire it when dagq-lite
can develop itself.

### D2. Use five actor kinds

Initially, all five actors run Claude Code in Microsandbox VMs. An actor
kind defines a responsibility. Each execution is a distinct instance with
its own identity.

| Actor      | Lifetime                 | Responsibility                                 |
| ---------- | ------------------------ | ---------------------------------------------- |
| Concierge  | Long-lived interactive   | The only conversational window with the human  |
| Planner    | Single-shot              | Goal design, task decomposition and replanning |
| Researcher | Single-shot, later stage | Web research                                   |
| Executor   | Per task                 | Code changes and tests                         |
| Reviewer   | Single-shot              | Evaluate the work without modifying it         |

Each actor runs in its own VM with its own mounts, network policy, time
limit and Host API scope. This keeps conversation, planning, research,
writing and review permissions separate.

### D3. The host schedules and routes

The local orchestrator has no Coordinator. The deterministic host
schedules and routes work. The Planner plans and replans. The Concierge
talks to the human.

In a similar system, the consulting role accumulated too many duties.
Deterministic routing makes workflow decisions auditable.

[AGENTS.md](../../AGENTS.md) and the [trust model](../trust-model.md)
describe the existing model Coordinator as deciding the workflow. The
agent-bootstrap M-series keeps its four-role flow of Coordinator,
Planner, Worker and Reviewer. The local orchestrator uses its own five
actors and maps the existing Worker path to Executor.

### D4. Route execution requests through the Host API

Actors never start other actors. All requests pass through the Host API,
where the host checks authorization and applies scheduling rules.

Use one execution model and one execution ID per run. A caller can wait
for a short result or fetch the result of an asynchronous job later.
Both paths use the same authorization, status and audit records.

### D5. Bind approvals to host state

- **Goals.** The Concierge and Planner can only create Goal Proposals.
  The `goal-registration` gate applies before the host registers a Goal.
  The content digest includes the structured scope.
- **Tasks.** The Planner creates Task Proposals. The host auto-registers a
  task only if it mechanically fits the approved Goal's structured scope.
  Examples include allowed repository paths, sandbox profiles and actors,
  a maximum task count, and time, retry and cost budgets. The host never
  interprets natural language to determine scope. Proposals outside scope
  go through the `task-registration` gate. In-scope auto-registration
  has no gate.
- **Integration.** The `integration` gate applies to changes entering
  the Goal's work branch. Only the human PR can bring those changes into
  `main`. Reuse the reviewed integration design. See
  [repository environments](../repository-environments.md).

Each gate has an approval policy of `human` or `agent`. The host resolves
the effective policy using Task override > Goal override > Goal-creation
request > project default.
Project defaults start at `human` for all gates. Only the operator CLI
can change them. Store them in host-side project configuration outside
both actor-writable workspaces and the repository that actors change.

Any source can tighten a policy from `agent` to `human`. A request or
override that loosens a policy from `human` to `agent` is part of the
content to approve. The host applies the loosening only after that content
is approved under the prior `human` policy. A request relayed by the
Concierge cannot loosen a policy on its own because the host cannot
distinguish the operator's words from the Concierge's. With a `human`
default, a Goal proposal requesting `integration: agent` needs human
Goal approval. After that approval, the Goal's integrations may be
agent-approved. A Task Proposal that loosens any policy never
auto-registers, even when it fits the scope. It goes through the
`task-registration` gate under the prior policy.

For a `human` gate, the host authenticates the operator through a separate
CLI path outside the guest and the actor API. An agent answer cannot
satisfy a gate whose effective policy is `human`. For an `agent` gate,
the host starts a dedicated Reviewer execution in `approval` mode. The
Concierge and the actor that produced the proposal or candidate are
ineligible to answer. The approval execution receives only the
digest-bound content and returns a structured verdict. The host binds
each approval to the content digest. Any content change requires
re-approval.

The operator may explicitly authorize a Claude Code session in conversation
to answer a human gate on their behalf. The host CLI records this as a
delegated human answer and still requires a terminal and the same typed
digest confirmation. The approval stores the session identifier and the
operator-provided authorization reference. The decision event marks the
delegation and identifies the agent and session.

The host authorizes registration and integration. It checks scope fit,
time and retry limits, and required verification results regardless of the answerer.
For integration, it checks the pinned candidate and rejects stale bases.
The host enforces approved grants and time and retry limits during execution and checks
collected paths before integration.

For every gate answer, the host records the gate, effective policy and
its source (`default`, `request`, `goal` or `task`), answerer kind
(`human` or `agent`), approval execution ID and model for agent answers,
content digest and decision. This fulfils the
[dagq-lite follow-up](../observability/guarantees.md#dagq-lite-follow-ups)
to record who answered each gate.

### D6. Run the Concierge as the front UI

- Run Claude Code interactively with `msb exec -t`. Use a session-enabled
  invocation with the existing credential boundary.
- Mount a read-only repository snapshot taken from the checkout.
  Keep session state on a named volume for continuation.
- Expose a dedicated per-VM host Unix socket with `msb create --vsock`.
  Use `socat` in the `concierge` profile as the guest relay to the Host
  API over vsock (CID 2). The host uses the socket identity as the client
  identity. The Host API needs no network egress.
- Allow egress only to `api.anthropic.com`. The existing host gateway
  enforces this outside the VM.
- Allow the Concierge to read, draft proposals, request actor executions
  and fetch results through the Host API. It can never approve.

Claude Code conversation history carries no authority for approval state
or permissions. Its allowedTools, hooks, MCP and managed settings are
auxiliary controls. The VM and host enforcement define the boundary.

The terminal and named volume let one conversation span multiple jobs.
The operator accepts that content can be sent to the model provider.

### D7. Give research its own egress policy

Run each Researcher in a disposable VM with no repository or secrets
mounted. Add a public HTTPS policy to the host gateway. The gateway
checks the resolved IP it will connect to and denies host addresses,
private networks, link-local addresses and cloud metadata. Research
results include sources.

This gives research access to public sources while keeping repository
files out of the research VM. The request text can still disclose Goal
content to third parties. Decide how to handle it before Stage 4.

### D8. Test distributed behavior inside the Executor VM

- Run a control plane and several nodes as processes on VM loopback.
  Size CPU and memory through [sandbox profiles](../sandbox-profiles.md).
  This needs no new egress rules.
- Assume Microsandbox cannot run nested VMs. This is unverified. Test
  node code that starts VMs against a fake runtime inside the Executor.
  After approval, run real-VM integration tests through the trusted host
  verification runner, with one VM job at a time.
- Start with an in-process fake transport for disconnects, delays and
  duplicate delivery.

This covers coordination and failure behavior during ordinary development.
Real-VM verification supplies runtime evidence at the host boundary.

### D9. Bound retries and replanning

The host detects abnormal exits, timeouts, failures, contract violations
and review rejections. It retries routine failures within limits and
triggers Planner replanning when needed once that stage is available.

The host caps retries and time. When a cap is hit, it stops and reports
through the Concierge.

Operator decision (2026-11-23). Token budgets remain advisory until enough
real usage data is available to revisit enforcement. The host records raw
usage, budgeted tokens and the reference limit for each execution and Task
retry window. It records when usage is unavailable and audits the first
known crossing of the reference limit in each window.

The host also caps concurrent VMs. The long-lived Concierge VM runs
alongside actor VMs, so the initial cap is the Concierge plus one actor
VM. Actor executions queue behind that limit. This is a product limit.
The development rule in [AGENTS.md](../../AGENTS.md), one smoke test or
image build at a time, still applies to development work. Raise the cap
only with resource evidence from the PoC and Stage 2.

### D10. Reuse the host audit

Reuse the existing SQLite audit and network audit. Commit prerequisite
audit records before privileged side effects. If a required write fails,
fail closed.

Add events for:

- VM lifecycle and executions;
- Host API calls and authorization results;
- secret injection, rotation and revocation, with no secret values;
- proposals, approvals and Goal and Task registration.

Correlate records by `sessionId`, `executionId` and `runtimeId` where
applicable. Keep the audit outside VMs, beyond actor write access. This
lets the operator trace a host decision from the conversation through
execution and registration.

### D11. Keep API keys at the credential boundary

All actors use Claude Code in the existing `operator-credential` mode
with an API key. The guest sees only a placeholder. The existing
credential boundary substitutes the real key only for the configured
provider host, `api.anthropic.com`. The same restriction applies to the
Researcher with public HTTPS access.

Use the same token accounting across actors. Future enforcement would
need usage data early enough to stop work at the cap, including during
interactive sessions. See D9 for the current advisory policy.

### D12. Stage the work

| Stage | Content                                                                                                         |
| ----- | --------------------------------------------------------------------------------------------------------------- |
| 1     | Concierge (VM, vsock, read-only mount, session continuation), Planner, approval CLI, Goal and Task registration |
| 2     | Executor and Reviewer on the existing Worker and Reviewer paths, through the integration approval gate          |
| 3     | [Implemented](stage3.md). Approved Task integration and local branch export. Live end-to-end evidence pending.  |
| 4     | Researcher with public-internet policy, and replanning                                                          |

The Stage 1 PoC covered:

- `msb create --vsock`;
- read-only repository mounts;
- `msb exec -t` TTY behavior;
- named-volume persistence across VM recreation;
- `msb exec -d` and `msb attach`;
- `msb modify --secret` on a running VM.

See the [Concierge PoC evidence](front-poc.md). Live terminal resize and
credential rotation at egress remain unverified. Recheck live resize
with Claude Code in Stage 1. On credential expiry, recreate the VM and
reuse the named volume to continue the session.

The stages put the conversation and approval path first. The full
development cycle can start dogfooding before research and replanning
are added.

### D13. Goal work branches

When the first Task under a Goal starts, the host creates a local work
branch named `lo/goal-<first 8 hex of goalId>` from the current local
`main` commit. The host stores the branch in its private bare integration
repository and uses it as the base for Tasks under that Goal. Each Task
pins its candidate independently.

Stage 2 runs Executor, optional host-configured verification, and Reviewer.
The host submits a digest-bound integration proposal after a passing
review. Stage 3 consumes approved proposals, checks the pin and current base, and
integrates into the Goal's work branch. Dependencies wait for successful
integration. The operator can export a local branch and handles branch
pushes and PRs to `main`. See [Stage 3](stage3.md).

## Consequences

- The host owns scheduling, scope checks and lifecycle state for local work.
  The model roles operate within grants issued by the host.
- The operator answers gates with a `human` policy through the host CLI.
  Opting into `agent` approval can speed up autonomous development loops.
  A compromised or mistaken approval execution can approve bad work.
  Mechanical checks, digest binding, time and retry limits, and the audit bound that risk.
- The Concierge design depends on the Stage 1 prerequisites. Research
  egress and replanning arrive in Stage 4.
- Keep the layer small enough to retire when dagq-lite can develop itself.

## Open questions

- **Research request text.** The Concierge may carry Goal content into a
  research request and on to third parties. Before Stage 4, choose between
  audit-only handling and human confirmation before sending the request.
- **Goal scope schema.** Define the field types, path matching and how to
  account for task counts and budgets.
- **Approver model.** Decide whether the agent approver should use a
  different model or provider from the producing actor.

## Follow-ups

- Update the role text in [AGENTS.md](../../AGENTS.md) once Stage 1 lands
  to distinguish the M-series roles from the local orchestrator actors.
