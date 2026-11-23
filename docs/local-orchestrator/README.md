# Local orchestrator

Status: proposed (2026-11-23). See [ADR 0001](adr-0001-local-orchestrator.md).

Stage 1 evidence is recorded in the [Concierge PoC](front-poc.md).

| Stage | Content                                                                                                         |
| ----- | --------------------------------------------------------------------------------------------------------------- |
| 1     | Concierge (VM, vsock, read-only mount, session continuation), Planner, approval CLI, Goal and Task registration |
| 2     | Executor and Reviewer on the existing Worker and Reviewer paths, plus the distributed tests in D8               |
| 3     | Integration and the full end-to-end cycle. Start dagq-lite development on it.                                   |
| 4     | Researcher with public-internet policy, and replanning                                                          |
