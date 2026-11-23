# Local orchestrator

Status: proposed (2026-11-23). See [ADR 0001](adr-0001-local-orchestrator.md).

Stage 1 evidence is recorded in the [Concierge PoC](front-poc.md) and the
[Concierge live runs](stage1-live.md).
The [Stage 2–3 live runs](stage23-live.md) cover Task decomposition,
execution, review, integration, and branch export.

| Stage | Content                                                                                                         |
| ----- | --------------------------------------------------------------------------------------------------------------- |
| 1     | Concierge (VM, vsock, read-only mount, session continuation), Planner, approval CLI, Goal and Task registration |
| 2     | Executor and Reviewer on the existing Worker and Reviewer paths, plus the distributed tests in D8               |
| 3     | Integration and the full end-to-end cycle. Start dagq-lite development on it.                                   |
| 4     | Researcher with public-internet policy, and replanning                                                          |

- Start an audited Concierge session in a VM with a read-only snapshot at `/repo` and Host API access over vsock, and resume it with `--continue`. The combined interactive path still needs real-VM verification.
- From the Concierge, draft Goal and Task proposals and request Planner executions that submit proposals. In-scope Tasks auto-register.
- Approve or reject proposals with the operator CLI by typing the first 12 hex digits of the digest, and list recorded audit events with `events`.
