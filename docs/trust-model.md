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

Each role runs in a separate sandbox. Direct Git integration belongs to
the host. Claude guest access depends on the configured authentication mode. Worker cannot push. The host binds explicit
human approval to the request and pinned candidate and base. Before integrating,
it rechecks the expected base, review evidence, and verification results.

**Host check.** A host check executes untrusted candidate code outside every
VM, with the host user's access to files, network, and Keychain. The design
requires a human to approve each run against a pinned candidate. The current
implementation validates private declarations and reports them in doctor.
The approval gate and execution are pending. [Host checks ADR](host-checks/adr-0001-host-checks.md)

| Threat                                         | Intended control and evidence                                                                                                                                                                                 |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Hostile repository instructions                | Treat file content as data. Capability checks and sandbox permissions apply regardless of agent instructions.                                                                                                 |
| Malicious tool output or fabricated references | Treat tool output as data. Validate schemas, scope references to the task and invocation, and verify host-computed artifact digests.                                                                          |
| Secret leakage                                 | Keep API keys in Keychain and out of guest inheritance, output, and audit records. Restrict persistent configuration mounts and gateway policy to the configured Claude actor groups.                         |
| Host or cross-workspace access                 | Restrict mounts, writable roots, and network. Test negative access using disposable canaries, including the Coordinator. A sandbox or host compromise remains a residual risk.                                |
| Unauthorized or stale integration              | Restrict effects to the host, independently authenticate human approval, and bind it to the exact reviewed candidate and expected Git base. Reject stale inputs.                                              |
| Audit loss or repeated effects after failure   | Durably record attempts, denials, authorizations, and outcomes. Require committed prerequisite events before effects. Reconcile incomplete operations and scope idempotency keys to the caller and operation. |

The audit design calls for append-only events and trace inspection. Events carry
actor, correlation, task, run and invocation identifiers where applicable, and
artifact references. Persist large artifacts separately under controlled
access and redact secrets before persistence. Process output by itself
provides partial observation.

The Concierge runs in an interactive VM with a read-only repository snapshot
and a named session volume. It reaches the Host API through a dedicated
Unix socket exposed over vsock. The Host API binds actions to the session
and reserves approval for the operator.

In default API-key mode, Microsandbox substitutes the API key into
`x-api-key` at `api.anthropic.com:443`. The guest can read the placeholder.
Concierge can also reach `platform.claude.com:443` with plain HTTPS.
Authorization-header substitution is confined to operator-configured
gateway hosts outside Anthropic domains.

In external mode, the audited gateway relays plain HTTPS and the host
supplies no API key. Added egress is granted per actor through effective
configuration. Verification stays offline.

Encrypted volumes attach while leased. The host checks directory
identity and permissions at launch and audits mount names, modes and
guest paths. Readers can share a directory. A project-scoped writer or
the operator shell takes an exclusive lease. An unconfirmed VM removal
quarantines its leases. The only adapter that can currently receive
declared mounts is Claude. A mounted actor loses shell tools, and its
file tools are limited to working paths with every mount denied.
Verification receives no mounts.

The gateway relays TCP without terminating TLS and audits DNS and
connection decisions. Host-generated managed settings are mounted
read-only in the Claude VMs. They constrain hooks, MCP and permissions.
The VM and trusted host enforce isolation, network access, and approval.

The adapter checks each component of the socket and snapshot paths from the
root using `lstat`, and repeats the checks immediately before launching VM
creation. Ancestors must be real directories owned by the host uid or root
without group or other write bits. Root-owned sticky directories with mode
`1777`, such as `/private/tmp` (or a real `/tmp`), may be ancestors. On macOS,
use `/private/tmp` directly because `/tmp` is a symlink. The snapshot directory
itself must belong to the host uid and have mode `0700`. The remaining race
between the final check and backend use requires a same-uid attacker
(assuming trusted root). That attacker can already read the host user's data
and is outside this threat model.

The operator's terminal is a trust boundary. The guest controls the bytes
sent to the terminal, including through a prompt-injected Concierge. OSC 52
can write to the clipboard, OSC 8 can display deceptive links, and title
escapes can alter the window title. Terminal report queries can return
emulator or session information to the guest over terminal input. Disable
OSC 52 clipboard access in the terminal emulator before attaching.

## Runtime observability

SQLite v6 is the authoritative audit store. In required mode the trusted
host records the sandbox binding and create-channel digest before creation,
and records the interactive host channels in the create request's event detail. The
host gateway records TCP and DNS decisions before the corresponding outbound
connect or policy reply. Audit failure stops normal execution and triggers
emergency teardown. JSONL and OTLP files are analysis copies with no tamper
resistance against the host user or administrator. Treat the audit database
and its export as sensitive because they hold host paths and raw
guest-controlled DNS names.
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

## Project configuration

The host reads private user, approved, and local project settings from
the XDG configuration directory. The project registry binds a name to a
Git common directory, shared by its worktrees. Project state lives under
the XDG state directory.

A declaration at local `main` is a request from untrusted repository
content. Approval reviews a bounded Git blob and records the pinned
commit and blob IDs with its validated contents in the private approved
file. A later commit can trigger a drift warning. The approved snapshot
continues to supply its grants until the operator approves again.
Verification stays offline. Declarations can only select profiles within
the host allowlists and can request egress only for eligible actors.
