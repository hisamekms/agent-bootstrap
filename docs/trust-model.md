# Trust boundaries

The human authorizes integration through the trusted host. The host owns
authoritative task and invocation state, workspaces, approvals, audit events,
and artifact storage. These stores must live outside writable sandbox storage.
The host derives role and invocation identity from the authenticated sandbox
session, validates inputs and artifact grants, and applies capability checks
before calling any privileged implementation.

| Role        | Repository access                 | Other capabilities                                                                     |
| ----------- | --------------------------------- | -------------------------------------------------------------------------------------- |
| Coordinator | None                              | Delegate, inspect task and invocation status, ask a human, submit integration requests |
| Planner     | Read-only snapshot                | Writable scratch and plan evidence                                                     |
| Worker      | One writable isolated workspace   | Local tests and a local commit or receipt                                              |
| Reviewer    | Read-only pinned diff or snapshot | Writable scratch and structured review evidence                                        |

Each role runs in a separate sandbox. Agent sandboxes have no host credentials
or direct host Git integration. Worker cannot push. The host binds explicit
human approval to the request and pinned candidate and base. Before integrating,
it rechecks the expected base, review evidence, and verification results.

| Threat                                         | Intended control and evidence                                                                                                                                                                                 |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Hostile repository instructions                | Treat file content as data. Capability checks and sandbox permissions apply regardless of agent instructions.                                                                                                 |
| Malicious tool output or fabricated references | Treat tool output as data. Validate schemas, scope references to the task and invocation, and verify host-computed artifact digests.                                                                          |
| Secret leakage                                 | Keep credentials out of sandbox mounts, inheritance, output, and audit records. Use controlled provider connectivity and artifact access. Check with synthetic canaries before real use.                      |
| Host or cross-workspace access                 | Restrict mounts, writable roots, and network. Test negative access using disposable canaries, including the Coordinator. A sandbox or host compromise remains a residual risk.                                |
| Unauthorized or stale integration              | Restrict effects to the host, independently authenticate human approval, and bind it to the exact reviewed candidate and expected Git base. Reject stale inputs.                                              |
| Audit loss or repeated effects after failure   | Durably record attempts, denials, authorizations, and outcomes. Require committed prerequisite events before effects. Reconcile incomplete operations and scope idempotency keys to the caller and operation. |

The audit design calls for append-only events and trace inspection. Events carry
actor, correlation, task, run and invocation identifiers where applicable, and
artifact references. Persist large artifacts separately under controlled
access and redact secrets before persistence. Process output by itself
provides partial observation.

## Runtime observability

SQLite v5 is the authoritative audit store. In required mode the trusted
host records the sandbox binding and rule-set digest before creation, and the
host gateway records TCP and DNS decisions before the corresponding outbound
connect or policy reply. Audit failure stops normal execution and triggers
emergency teardown. JSONL and OTLP files are analysis copies with no tamper
resistance against the host user or administrator. Treat the audit database
and its export as sensitive because they hold raw guest-controlled DNS names.
Telemetry is best effort and leaves the audit unchanged.

The Microsandbox 0.7.16 netstack and `--proxy` are part of the trusted
computing base. Blocks enforced before the gateway have no per-attempt audit
record. Gateway records cover connections and DNS, with no inspection of
requests inside permitted connections. An allowed destination can receive
exfiltrated data. See the [v0.1 guarantees](observability/guarantees.md) for
scope, evidence and operational limits.

## Baseline evidence

M0 exercises the TypeScript contracts using fake ports and fixtures. Actual
isolation, authorization, audit durability, restart behavior, and approval
provenance require tests against the later runtimes.
