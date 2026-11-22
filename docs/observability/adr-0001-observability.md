# ADR 0001: Runtime Observability v0.1 (audit, network audit, telemetry)

- Status: accepted for implementation (Phase 0 complete). The Phase 1 gate
  is pending.
- Date: 2026-11-23
- Evidence: [feasibility.md](feasibility.md),
  [network-audit-matrix.md](network-audit-matrix.md)

## Context

Coding agents (Codex, Claude Code) run in Microsandbox VMs under
`TrustedHost`. The SQLite audit (schema v4) records invocations and
operations and fails closed. It does not record:

- sandbox IDs;
- exit codes;
- the execution context;
- individual network connections or DNS queries;
- performance data.

Microsandbox enforces egress rules. It exposes no durable record of
connections, either allowed or denied (feasibility, section 2.2, question 2).
Its `allow@dns` rule is an unaudited DNS tunnel. Several naive configurations
bypass `--proxy` (matrix N-11, N-12, N-16, N-17).

## Decisions

### D1. The SQLite audit stays the source of truth; schema v5 is additive

- `SqliteAudit` remains the only durable audit store. Its rules are unchanged:
  - single writer per host process;
  - `BEGIN IMMEDIATE` and a commit per record;
  - `synchronous=FULL` and WAL;
  - append-only triggers;
  - an exact schema SQL check;
  - `quick_check`;
  - row validation on open;
  - a write-failure quarantine.
- Schema v5 **adds append-only tables**. It does not alter `audit_events`, so
  the v1–v4 exact-schema checks stay valid. The new tables are:
  - `execution_contexts`: invocation (execution) ID, optional session,
    retry-of and correlation IDs, `traceparent`, and bounded attributes;
  - `sandbox_bindings`: invocation ID, sandbox ID, runtime kind, egress mode,
    network rule-set digest, gateway policy ID and digest;
  - `process_results`: invocation ID, operation, exit code or null, signal
    (always null in v0.1: unavailable), and a `guest_reported` flag;
  - `network_events`: connection or query ID, invocation ID, sandbox ID,
    phase, protocol, channel, destination IP and port, optional hostname,
    decision, policy ID, reason code, result, end reason, bytes sent and
    received, and duration;
  - `resource_events`: limit exceeded, timed out, lifetime expired, forced
    termination, abnormal exit.

  Each table has its own append-only triggers and CHECK constraints.

- Opening a v4 database for writing upgrades it to v5 in one transaction that
  only creates tables (the v1 → v2 pattern). v1–v3 databases still open. Any
  write that needs v5 to them fails closed (the v3/v4 pattern).
- The execution ID **is** the invocation ID (a UUID, caller-supplied or
  generated). It is exported as `executionId`, and `invocationId` stays the
  API name. It is distinct from the sandbox ID (`bootstrap-<uuid>`) and from
  the OpenTelemetry trace ID.
- Required records are written **before** the effect:
  - the sandbox binding and rule-set digest before `msb create`;
  - network `requested` + `decided` (in one transaction) before the gateway
    connects or answers.

  Outcome records follow the effect. A missing outcome is _derived_ as
  `unknown`. It is never fabricated.

- If an outcome write fails after an allowed effect, the audit quarantines
  itself (`#writeFailed`). The gateway refuses new flows for that sandbox and
  closes its active relays. `TrustedHost` cancels an in-flight non-session
  exec, stops normal workflow, and attempts emergency sandbox removal.
  It throws `HostAuditError` and reports an unknown outcome to telemetry.
  Emergency removal has no durable audit record. The sandbox lifetime
  remains the backstop if removal fails.
- Never recorded: credentials, environment values, Authorization or other
  headers, request or response bodies, URLs or paths, guest stdout and
  stderr, raw `msb` diagnostics.
- Tamper resistance against the host user or an administrator is out of
  scope for v0.1.

### D2. JSONL export for analysis, derived from SQLite

An exporter, `bun src/audit-export.ts <audit.sqlite> <obs-dir>`, appends
records past a watermark to `<obs-dir>/audit/YYYY-MM-DD-NNNN.jsonl`. It:

- writes `*.jsonl.partial`, then fsyncs and renames;
- rotates by UTC date and by size;
- never deletes;
- takes an exclusive lock file, so there is one exporter;
- detects ENOSPC and short writes;
- leaves a partial file detectable on crash.

Records use the schema `agent-bootstrap.audit/v1`: the reference's audit
fields, plus `phase` and a derived `outcome: unknown`. JSONL is not a durability
boundary. A failed export never affects runs.

### D3. Telemetry uses the OpenTelemetry JS SDK and OTLP JSON files

- Packages: `@opentelemetry/api`, `core`, `resources`, `sdk-trace-base`,
  `sdk-metrics`, `api-logs`, `sdk-logs`, and `otlp-transformer` (for the
  official OTLP/JSON serialization). There is no `sdk-node`, no
  auto-instrumentation, no network exporter, and no context manager:
  contexts are passed explicitly.
- File exporters write one OTLP `Export*ServiceRequest` JSON object per line
  to `telemetry/{traces,metrics,logs}/YYYY-MM-DD-NNNN.jsonl`. This follows
  the OpenTelemetry file exporter's line format. The files have the same
  rotation and partial-file rules as D2.
- Spans:
  - `execution` (root), `sandbox.create`, `agent.start` (the first exec or
    session open), `agent.run` / `process.exec`, `sandbox.destroy`;
  - attributes: execution ID, sandbox ID, runtime kind, agent kind, role,
    profile, outcome.
  - Trace IDs are independent of execution IDs.
  - Durations use `performance.now()`.
- Metrics:
  - execution, sandbox startup and process durations (histograms);
  - VM CPU time, memory, host RSS, sampled peak, disk and network bytes;
  - concurrent sandboxes.

  Metric attributes are bounded (role, profile, agent kind, outcome) and
  never carry execution or sandbox IDs. Per-execution data goes in spans and
  logs.

- Resource sampling uses `msb metrics <id> --format json` at
  `resourceSamplingIntervalMs` (default 1000). There is one mandatory final
  sample before `msb rm`, because removal deletes the terminal metrics.
  Unavailable values are recorded as absent and flagged, never as 0.
- Telemetry failures (exporter, disk, sampler) are counted and reported in a
  diagnostics log line and an `obs.telemetry.dropped` counter. They never
  fail a run or touch the audit path.

### D4. A host Egress Audit Gateway is required

Microsandbox cannot audit per connection, so every non-DNS TCP flow is
forced through a host gateway:

- **Rule set.** This is a single constant in `src/microsandbox.ts`, and the
  order matters (first match wins). It was verified in exp7, exp10 and
  exp12:

  ```text
  --no-net
  --net-rule allow@dns,deny@host,deny@0.0.0.0/0:tcp:53,deny@[::/0]:tcp:53,deny@0.0.0.0/0:tcp:853,deny@[::/0]:tcp:853,allow@0.0.0.0/0:tcp,allow@[::/0]:tcp
  --dns-nameserver 127.0.0.1:<per-sandbox DNS port>
  --proxy socks5://127.0.0.1:<gateway port>
  --socks5-username <per-sandbox id> --socks5-password-env <per-sandbox secret var>
  ```

  The rule set has no UDP rule (N-11, N-15) and no protocol-less allow
  (N-16). `deny@host` comes first (N-17), and TCP/53 and 853 are denied
  (N-12, N-13). For provider egress, `--tls-intercept`, `--secret …@host`
  and `--secret-violation-action block` are added. The direct
  `allow@<provider>:tcp:443` and `allow@dns` forms are dropped; the gateway
  enforces the destination.

- **Gateway.** This is a host-side, in-process (Bun) component that shares
  the host's `SqliteAudit` instance, so there is one writer. Per sandbox it
  provides:
  - a SOCKS5 listener on `127.0.0.1`, with RFC 1929 credentials unique to the
    sandbox. Only CONNECT is supported; UDP ASSOCIATE and BIND are refused
    and audited.
  - a DNS listener on `127.0.0.1`, over UDP and TCP.

  The gateway also:
  - authenticates and attributes each connection;
  - canonicalizes the destination (v4-mapped and NAT64 → IPv4);
  - evaluates the policy;
  - **durably appends requested + decided before** it connects upstream;
  - relays and counts bytes;
  - appends finished, with the result, end reason, bytes and duration.

- **DNS pinning.** The gateway DNS answers only allowlisted names. It
  resolves them upstream from the host and records the query, the decision
  and the answer IPs before it replies. Other names get NXDOMAIN and are
  recorded, which closes the DNS tunnel. A connection is allowed by hostname
  only if its IP was answered to _this_ sandbox for an allowlisted name
  within the TTL. The record then carries that hostname. Direct IPs are
  allowed only when they are explicitly allowlisted.
- **Default deny ranges**, which apply even if allowlisted by mistake:
  - loopback, link-local, metadata `169.254.169.254`, RFC 1918, CGNAT,
    multicast and broadcast;
  - the msb pools `172.16.0.0/12` and `fd42:6d73:62::/48`;
  - unspecified addresses.

  The exception is the gateway's own host-service mapping (D5).

- **Fail-closed behaviour.** Gateway down, audit append failure, or
  authentication mismatch → refuse. An audit append failure also closes the
  sandbox's active relays and quarantines the invocation. Telemetry is
  independent of this.

### D5. `hostTcpPort` goes through the gateway in audit-required mode

A guest cannot reach host loopback directly (`deny@host`). A host service
that a role needs, such as a mock provider in fixtures, is published by the
gateway:

- the gateway DNS answers a reserved name (for example
  `host-service.agent-bootstrap.internal`) with a TEST-NET address;
- the gateway maps that address and port to `127.0.0.1:<port>`;
- the records are written with `channel=host-service`.

The direct `allow@host:tcp:P` form is allowed only when audit mode is
`disabled`.

### D6. Configuration

```ts
audit: {
  mode: "required" | "disabled";
} // default "required"
telemetry: {
  enabled: boolean;
  resourceSamplingIntervalMs: number;
  traceSamplingRatio: number;
}
```

- Runs with `provider`, `tools`, a repository, or `hostTcpPort`
  refuse `audit.mode: "disabled"` unless the caller passes an explicit
  `allowUnauditedRun: true`.
- Required mode refuses to start if the audit cannot open for writing at v5,
  the gateway cannot bind, or the msb version is not the pinned one. This
  check happens at host construction, before any invocation.
- Disabling telemetry never disables the audit.

### D7. What is blocked in v0.1

The following are blocked: all UDP except gateway DNS; ICMP; all non-TCP/UDP
IP protocols; the host group (including `host.microsandbox.internal`, its
IPv6, mapped and NAT64 forms); DNS to any resolver other than the gateway, on
UDP or TCP; DoT; QUIC/HTTP3; direct `hostTcpPort` in required mode; and any
TCP destination that the gateway policy does not allow.

## Guarantee scope (v0.1)

All guarantees assume an honest host and a correct Microsandbox 0.7.16
netstack and `--proxy` implementation. Both are in the TCB.

The guarantees are:

- Before any upstream TCP connect, the gateway durably records its
  decision. The record has the sandbox and execution IDs, the destination
  IP and port, the hostname if it was DNS-pinned, the decision, the policy
  ID and the reason. Its outcome is recorded, or derived as unknown.
- The gateway durably records DNS decisions before sending policy replies.
  Only allowlisted names resolve. G1 lists early drops and refusals.
- Every other egress method is blocked by configuration. The per-sandbox
  rule-set digest is recorded before create.
- On an audit write failure, the gateway blocks new outbound flows and
  DNS policy replies for that sandbox. The host stops normal invocation
  operations and attempts emergency teardown.
- Lifecycle, process outcome, exit code (guest-reported) and resource limit
  events are recorded per execution.

## Explicit non-guarantees

- **G1.** Microsandbox refusals before the gateway (host group, other
  resolvers, DoT, UDP, ICMP, and raw IP) have no per-attempt record.
  Recording them requires a synchronous, structured deny-event stream
  from Microsandbox. The gateway can also refuse or drop traffic before
  writing a per-attempt record. This includes accept refusals at capacity
  or during quarantine, client disconnects before a decision is recorded,
  DNS queries over the in-flight cap, malformed queries or qnames that
  fail letter/digit/hyphen hostname validation, and DNS-over-TCP framing
  errors. The gateway sends aggregate refusal counts to runtime observers,
  including telemetry. Those counts describe volume and are absent from
  the audit.
- There is no visibility inside allowed connections: TLS bodies, HTTP
  methods and paths, headers, or DoH inside an allowed host. Exfiltration to
  an allowlisted destination is possible.
- There is no hostname for direct-IP flows, because SOCKS from msb carries
  only IPs.
- Exit codes are guest-reported. Signals are unavailable. OOM inside the
  guest is not observable from the host. Peak memory is a sampled lower
  bound. `cpu_percent` is meaningless for runs shorter than about two
  sampling intervals. Lifetime expiry is inferred from the host deadline.
- There is no tamper resistance against the host user, the administrator, or
  a host compromise. JSONL exports and telemetry are not durable evidence.
- There is no file access audit and no LLM token or cost accounting.
- Concurrency attribution and end-to-end credential substitution through the
  gateway are not yet verified (to verify in Phase 1).

## Consequences

- One new security-sensitive component (the gateway) and an audit schema
  bump. Both need an independent security review (`CONTRIBUTING.md`).
- One extra fsync per connection decision and one per finish. The overhead
  is measured in Phase 3.
- Credentialed runs change from msb domain rules to gateway policy. The
  existing `provider.egress` grant remains and now also links to the network
  records.
- Microsandbox upgrades must re-run the VM bypass regression suite.
