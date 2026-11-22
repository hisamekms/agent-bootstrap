# Runtime Observability v0.1: implementation plan

This plan implements [ADR 0001](adr-0001-observability.md). Each task is
sized for one implementer. The rules are:

- No two tasks that can run at the same time own the same file.
- Repository rules apply: at most two subagents active at once, one writer
  per file, `bun verify` before review, Conventional Commits with a Japanese
  subject, and work on a work branch.
- A task that changes the audit, the trusted host, the sandbox adapter or the
  gateway also needs an independent **security review** before merge.

Legend for the "VM" field:

- **no**: unit tests with fakes or fixtures only;
- **yes**: needs the pinned `msb` and cached images (one VM at a time unless
  stated);
- **agent**: also needs a real coding agent with an explicitly opted-in
  credential.

## Dependency graph

```text
Wave A (no deps)    : DEP-1  OBS-01  OBS-02  OBS-03  OBS-05  OBS-06a  OBS-09a
Wave B              : OBS-04(01)
Wave C              : OBS-06b(02,04,06a)  OBS-08(04)  OBS-09b(04,09a)  OBS-12(05)
Wave D              : OBS-07(01,03,04,05,06b)  OBS-13(DEP-1,09a)
Wave E              : OBS-11(07)  OBS-14(DEP-1,01,12,13)
Gate 1 (Phase 1)    : SEC-1(04,05,06b,07) -> OBS-10(05,06b,07,11)   [VM]
Wave F              : OBS-15(DEP-1,09b,13)
Wave G              : OBS-16(10,14,15)   [VM + agent]
Phase 3             : SEC-2(13,14,16) -> OBS-17(16)
```

Tasks in the same wave can run in parallel, two at a time. The suggested
pairs are:

- (OBS-01, OBS-02), (OBS-05, OBS-06a), (OBS-03, OBS-09a), and then DEP-1 when
  the coordinator has fetched;
- (OBS-04, OBS-12), after OBS-01 and OBS-05;
- (OBS-06b, OBS-09b), then (OBS-08, OBS-13);
- (OBS-07, OBS-14);
- (OBS-11, OBS-15).

## Tasks

### DEP-1: Pin the telemetry and analysis dependencies (coordinator fetches)

- **Goal.** Add the OpenTelemetry runtime dependencies with exact versions,
  confirm their licenses and Bun compatibility, and pin the DuckDB CLI for
  analysis.
- **Files owned:** `package.json`, `bun.lock`,
  `docs/observability/dependencies.md`, `test/otel-compat.test.ts`.
- **Depends on:** nothing. The coordinator performs the network fetch, which
  is approved by the user.
- **What to pin.** Use exact versions, not `^` or `~`. Choose the latest
  stable release that is at least 14 days old at fetch time, and record it in
  `dependencies.md`.

  | Package                           | License    | Version line                                               |
  | --------------------------------- | ---------- | ---------------------------------------------------------- |
  | `@opentelemetry/api`              | Apache-2.0 | 1.9.x                                                      |
  | `@opentelemetry/core`             | Apache-2.0 | 2.x (same as the next three)                               |
  | `@opentelemetry/resources`        | Apache-2.0 | 2.x                                                        |
  | `@opentelemetry/sdk-trace-base`   | Apache-2.0 | 2.x                                                        |
  | `@opentelemetry/sdk-metrics`      | Apache-2.0 | 2.x                                                        |
  | `@opentelemetry/api-logs`         | Apache-2.0 | 0.2xx (the experimental line that matches the 2.x release) |
  | `@opentelemetry/sdk-logs`         | Apache-2.0 | 0.2xx (same)                                               |
  | `@opentelemetry/otlp-transformer` | Apache-2.0 | 0.2xx (same; provides the official OTLP JSON serializers)  |
  | DuckDB CLI                        | MIT        | 1.x                                                        |

  Rules:

  - The `core`, `resources`, `sdk-trace-base` and `sdk-metrics` versions must
    be identical. The `api-logs`, `sdk-logs` and `otlp-transformer` versions
    must be identical and must be the matching release.
  - Do **not** add `sdk-node`, `auto-instrumentations-*`,
    `exporter-*-otlp-http/grpc`, or `context-async-hooks`.
  - Install the DuckDB CLI as
    `mise --no-config --no-env --no-hooks exec duckdb@<ver> -- duckdb`, as for
    msb, and record the binary's SHA-256.

- **License check.**
  - List every transitive package in `bun.lock` with its license, for example
    `protobufjs` and `@protobufjs/*` (BSD-3-Clause, pulled in by
    `otlp-transformer`).
  - Reject GPL, AGPL, SSPL, BUSL and unknown licenses.
  - Record whether NOTICE files need attribution. Apache-2.0 requires that
    NOTICE text be kept if it is redistributed. The repository is MIT and
    private, so document the obligation.
- **Compatibility check.**
  - `test/otel-compat.test.ts` imports each package under Bun 1.4.4. It runs
    one span, one histogram and one log record through
    `InMemorySpanExporter` / `InMemoryMetricExporter` and the
    `otlp-transformer` JSON serializers. It asserts the OTLP JSON shape
    (`resourceSpans[].scopeSpans[].spans[]`, hex `traceId` and `spanId`).
  - For DuckDB, record whether `read_json` works with
    `SET autoinstall_known_extensions=false; SET autoload_known_extensions=false;`
    with no network. If it does not, stop and report (OBS-15 is blocked).
- **Acceptance:**
  - `bun verify` passes.
  - `dependencies.md` lists the exact versions, tarball integrity from
    `bun.lock`, the transitive licenses, and the DuckDB binary digest and
    offline JSON result.
- **VM:** no.

### OBS-01: Execution context and runtime event types

- **Goal.** Add provider-neutral TypeScript contracts for
  `ExecutionContext` and the Runtime Event envelope and union, as described
  in reference sections 4 and 5.
- **Files owned:** `src/execution-context.ts`, `src/runtime-events.ts`,
  `test/execution-context.test.ts`, `test/runtime-events.test.ts`.
- **Depends on:** nothing.
- **Scope.**
  - `ExecutionContext` has these fields:
    - `executionId`: a UUID, equal to the invocation ID;
    - optional `sessionId`, `retryOfExecutionId` and `correlationId`
      (UUIDs);
    - `attributes`: at most 16 keys matching `^[a-z][a-z0-9_.]{0,63}$`, each
      value a string of at most 256 bytes, or a number, or a boolean;
    - `traceContext`: a W3C `traceparent`, validated, plus an optional
      `tracestate` of at most 512 bytes.
  - `parseExecutionContext` rejects unknown keys, getters and
    credential-shaped keys or values. Reuse the `isSafeCredentialVariable`
    heuristic in reverse: reject keys ending in `_token`, `_key`, `_secret`
    or `password`.
  - `RuntimeEvent<T>` is the envelope: `eventId`, `eventType`,
    `schemaVersion`, `occurredAt`, `recordedAt`,
    `source {component, instanceId, sequence}`, optional `executionId`,
    `sandboxId`, `operationId`, `correlationId`, `traceId` and `spanId`, and
    the payload.
  - The union covers:
    - `execution.started` / `execution.finished`, with outcome `succeeded`,
      `failed`, `cancelled`, `timed_out` or `unknown`;
    - `sandbox.created` / `sandbox.destroyed`, with a failure form.
      `sandbox.started` / `sandbox.stopped` are declared as reserved;
    - `process.started` / `process.exited`, with a start failure form and
      `exitCode | null`, `signal: null` and `guestReported`;
    - `policy.evaluated`;
    - `resource.limit_exceeded`;
    - `network.connect.requested` / `decided` / `finished`;
    - `network.dns.query`.
  - `RuntimeObserver { observe(event): void }`. Throwing is contained by the
    caller.
  - `SequenceSource`: a monotonic sequence per source instance.
- **Acceptance:**
  - Unit tests cover valid and invalid contexts: bounds, secret-shaped keys,
    bad `traceparent`.
  - An exhaustive `switch` over `eventType` compiles.
  - The sequence is strictly increasing per source.
- **VM:** no.

### OBS-02: Egress policy (pure)

- **Goal.** Evaluate gateway decisions with no I/O.
- **Files owned:** `src/egress-policy.ts`, `test/egress-policy.test.ts`.
- **Depends on:** nothing.
- **Scope.**
  - `EgressPolicy` is frozen and contains:
    - `allow`: exact host names plus ports;
    - optional explicit IP plus port entries;
    - `hostServices`: a reserved name or TEST-NET address plus port, mapped
      to a loopback port;
    - `providerBinding`: host and port, used to set
      `channel=provider-egress`.
  - `policyId` is the SHA-256 of a canonical JSON form.
  - Canonicalize addresses: v4-mapped IPv6 and NAT64 `64:ff9b::/96` become
    IPv4. Malformed input is rejected.
  - Default deny ranges, which an allow entry cannot override:
    - loopback, `0.0.0.0/8`, `::`;
    - link-local, `169.254.0.0/16` (metadata);
    - RFC 1918, CGNAT `100.64.0.0/10`, ULA `fc00::/7`;
    - the msb pools `172.16.0.0/12` and `fd42:6d73:62::/48`;
    - multicast and broadcast.
  - The only exception is `hostServices`, which matches by mapped address.
  - `DnsPinTable`: a per-sandbox map from answered IP to (name, expiry).
    A hostname allow matches only a pinned, unexpired IP for that sandbox.
  - `decideConnect({ip, port, sandbox})` returns:
    - `{decision, reasonCode, hostname?, channel, upstream}`;
    - `reasonCode` is one of `allowlisted-host`, `allowlisted-ip`,
      `host-service`, `not-allowlisted`, `reserved-range`, `unpinned-ip`,
      `udp-refused` or `invalid-destination`.
  - `decideDns({qname, qtype})` allows A and AAAA for allowlisted names and
    reserved host-service names. Everything else gets NXDOMAIN, with reason
    `dns-not-allowlisted` or `dns-type-refused`.
- **Acceptance:**
  - Table tests for every matrix row N-02 to N-08 and N-14.
  - NAT64 and v4-mapped tests for the gateway, loopback and metadata
    addresses.
  - A pin expires after its TTL.
  - `policyId` is stable across key order.
- **VM:** no.

### OBS-03: Observability configuration

- **Goal.** Parse and validate `audit` and `telemetry` config (ADR D6).
- **Files owned:** `src/observability-config.ts`,
  `test/observability-config.test.ts`.
- **Depends on:** nothing.
- **Scope.**
  - The defaults are:
    - `audit.mode: "required"`;
    - `telemetry.enabled: true`;
    - `resourceSamplingIntervalMs: 1000`, with bounds 250 to 60000;
    - `traceSamplingRatio: 1`, with bounds 0 to 1.
  - The observability directory is an absolute path with no NUL bytes and is
    not under `MSB_HOME` or the staging root.
  - `requireAudited(spec, config)` refuses agent runs (`provider`, `tools` or
    `repository`) when `audit.mode` is `"disabled"`, unless
    `allowUnauditedRun: true` is passed explicitly.
- **Acceptance:**
  - Unit tests for the defaults, bounds and refusals.
  - Disabling telemetry leaves the audit config untouched.
- **VM:** no.

### OBS-04: Audit schema v5

- **Goal.** Add schema v5 tables and APIs (ADR D1), and keep every existing
  guarantee.
- **Files owned:** `src/audit.ts`, `test/audit-v5.test.ts`,
  `test/audit-v4.test.ts` (only to update expectations that change because a
  v4 database now upgrades to v5 on write-open).
- **Depends on:** OBS-01 (context validation).
- **Scope.**
  - New append-only tables, each with its own triggers and CHECKs:
    `execution_contexts`, `sandbox_bindings`, `process_results`,
    `network_events` and `resource_events`.
  - `auditSchemaSql(5)`, the exact schema check, and row validation on open
    for the new tables.
  - On write-open, upgrade v4 → v5 by creating tables in one
    `BEGIN IMMEDIATE`. v1–v3 databases still open, and v5-only writes to them
    fail closed.
  - New appends:
    - `appendExecutionContext`;
    - `appendSandboxBinding`;
    - `appendProcessResult`;
    - `appendNetwork(requested+decided)`, which writes 2 rows in one
      transaction;
    - `appendNetworkFinished`;
    - `appendDnsQuery`;
    - `appendResourceEvent`.

    All of them share the `#writeFailed` quarantine.

  - New reads: `readExecution(id)`, which returns all tables for one
    execution, and `readSince(sequenceWatermark)` for the exporter.
  - `incompleteNetwork(id)` derives allowed connections that have no
    `finished` row as `unknown`.
  - Field validation:
    - IPs are canonical;
    - ports are 1 to 65535;
    - hostnames are at most 253 bytes, LDH plus dots;
    - reason and end codes come from fixed enums;
    - byte counts are safe integers;
    - nothing free-form beyond bounded attributes.
- **Acceptance:**
  - Unit tests for: fresh v5 creation; v4 → v5 upgrade preserving rows; v1–v3
    refusing v5 writes; triggers blocking UPDATE and DELETE on every table;
    tampered schema SQL refused; quick_check.
  - Simulated append failure, by closing the underlying DB or using an
    injected failing statement, quarantines all append kinds.
  - Crash simulation: a child process killed between `decided` and
    `finished` → reopen → `incompleteNetwork` reports `unknown`.
  - `PRAGMA synchronous` is 2 and `journal_mode` is WAL on every open.
  - No secret-shaped strings are accepted in attributes.
- **VM:** no. **Security review: yes.**

### OBS-05: Microsandbox adapter egress mode and resource sample port

- **Goal.** Emit the gateway rule set from one constant (ADR D4), wire the
  per-sandbox gateway binding into `msb create`, and expose resource samples
  together with a final sample before removal.
- **Files owned:** `src/microsandbox.ts`, `src/sandbox-runtime.ts`,
  `src/microsandbox-metrics.ts`, `test/microsandbox.test.ts`,
  `test/microsandbox-metrics.test.ts`.
- **Depends on:** nothing. It defines `SandboxSpec.egressGateway` itself.
- **Scope.**
  - `SandboxSpec.egressGateway?: { socksPort, dnsPort, username,
passwordEnv }`. The password comes from the host through a callback, like
    the credential, and only into the `msb create` environment.
    `passwordEnv` must pass a name check like `isSafeCredentialVariable`, and
    the variable must not collide with the provider's secret variable.
  - `GATEWAY_NET_RULES` is the exact token string from the ADR.
    - The adapter refuses `egressGateway` together with `hostTcpPort`.
    - In gateway mode with a provider, it drops `allow@dns` and
      `allow@<host>:tcp` and keeps `--tls-intercept`, `--secret` and
      `--secret-violation-action block`.
    - It never emits a UDP rule or a protocol-less allow.
    - It returns `netRuleDigest` (the SHA-256 of the exact argv network
      section) through a new `SandboxHandle`-adjacent result, for the audit
      binding.
  - Optional port method
    `SandboxRuntime.sampleResources?(handle): Promise<ResourceSample | null>`.
    The adapter parses `msb metrics <id> --format json` with a strict,
    bounded parser that drops unknown fields, maps null to absent, and
    rejects non-finite numbers.
  - `#destroy` takes one final sample before `rm --force`. The sample is
    retrievable once through `finalResourceSample(handle)`. A sampling
    failure never blocks destroy.
  - `RoutingSandboxRuntime` forwards the optional methods. Update
    `src/routing-runtime.ts` in this task only if needed. It is owned here
    while the task is active.
- **Acceptance:**
  - Fake-CLI tests assert the exact argv in the gateway mode, with and
    without a provider.
  - The refusals are covered.
  - The gateway password never appears in argv, errors or the handle.
  - The metrics parser has fixture tests based on the observed JSON in
    feasibility section 3.
  - The final sample is taken before `rm`, and destroy still succeeds when
    sampling fails.
  - Existing tests still pass.
- **VM:** no. OBS-10 covers the real backend. **Security review: yes.**

### OBS-06a: SOCKS5 and DNS wire codecs

- **Goal.** Add pure, bounded parsers and encoders.
- **Files owned:** `src/socks5.ts`, `src/dns-wire.ts`, `test/socks5.test.ts`,
  `test/dns-wire.test.ts`.
- **Depends on:** nothing.
- **Scope.**
  - SOCKS5 (RFC 1928): greeting, CONNECT / BIND / UDP ASSOCIATE requests with
    ATYP 1, 3 or 4, and reply encoding.
  - RFC 1929 username/password subnegotiation.
  - Incremental parsing over chunks, with a strict maximum size.
  - DNS:
    - parse one question (name compression is refused in questions);
    - build NXDOMAIN, REFUSED, SERVFAIL and A/AAAA answers with a TTL;
    - TCP two-byte length framing.
- **Acceptance:**
  - Fuzz-style tests (random bytes, truncated and oversized input) never
    throw anything other than a typed error.
  - Round-trip tests.
  - Fixtures from the Phase 0 captures: CMD 1 with ATYP 1 and 4, CMD 3, and
    methods `[0,2]`.
- **VM:** no.

### OBS-06b: Egress Audit Gateway

- **Goal.** Add the host-side, per-sandbox SOCKS5 and DNS gateway, which
  makes the durable decision before it connects (ADR D4).
- **Files owned:** `src/egress-gateway.ts`, `test/egress-gateway.test.ts`.
- **Depends on:** OBS-02, OBS-04, OBS-06a.
- **Scope.**
  - `EgressGateway.open({executionId, sandboxLabel, policy, audit, observer,
resolver, connect})` returns
    `{socksPort, dnsPort, username, password, close()}`.
    - Listeners bind to 127.0.0.1 on ephemeral ports.
    - The password is 32 random bytes in hex, held in memory only.
  - For each SOCKS connection:
    1. Require method 2 and the exact credentials. On a mismatch, refuse and
       record `auth-failed`.
    2. Accept CMD 1 only. Refuse and record CMD 2 and CMD 3 (`udp-refused`).
    3. Canonicalize the destination, then call `decideConnect`.
    4. **Await `appendNetwork(requested+decided)`.** If it throws, reply
       failure, close every relay of that gateway, set `quarantined`, and
       emit an event.
    5. Connect to the upstream through an injected `connect`. Fixtures can
       map TEST-NET to loopback here. The real default is `net.connect`.
    6. Relay, counting bytes in each direction, then
       `appendNetworkFinished(result, endReason, bytes, durationMs)`.

    `result` is one of `connected`, `connect-failed`, `refused` or
    `timeout`. `endReason` is one of `client-closed`, `upstream-closed`,
    `idle-timeout`, `sandbox-destroyed`, `audit-failure` or `error`.

  - For each DNS query (UDP and TCP):
    1. Call `decideDns`.
    2. If allowed, resolve through the injected resolver. The default is
       `node:dns` `Resolver` with the host's servers, and a 5 s timeout.
    3. Pin the answers, then **await `appendDnsQuery`** with the qname,
       qtype, decision, reason and answer IPs.
    4. Only then reply.

    An append failure returns SERVFAIL and quarantines the gateway.

  - Limits: maximum concurrent relays (default 64), idle timeout, maximum
    pending handshakes, and maximum bytes per frame.
  - `close()` ends all relays with `sandbox-destroyed`.
  - No payload is ever logged or recorded.
- **Acceptance.** Unit and integration tests with real loopback sockets and a
  fake audit:
  - allow, deny and reserved-range decisions;
  - an unpinned IP;
  - NAT64 and v4-mapped destinations;
  - an auth mismatch;
  - UDP ASSOCIATE refused and recorded;
  - DNS allow, deny and non-A types;
  - no connect or reply happens before the append promise resolves. Test this
    with a deferred fake audit;
  - an append failure → refuse and close active relays;
  - an upstream that is down → `connect-failed`;
  - byte counts are exact;
  - two gateways at once keep their attribution separate;
  - an idle timeout;
  - `close` during a relay.
- **VM:** no. **Security review: yes.**

### OBS-07: Trusted host integration

- **Goal.** Wire the execution context, the gateway, the sandbox binding,
  process results, resource events and runtime events into
  `TrustedHost`. Fail closed.
- **Files owned:** `src/trusted-host.ts`, `test/trusted-host.test.ts`,
  `test/fake-gateway.ts` (new fake).
- **Depends on:** OBS-01, OBS-03, OBS-04, OBS-05, OBS-06b.
- **Scope.**
  - The `TrustedHost` constructor gains an optional
    `{config, gatewayFactory, observers}`. When `audit.mode` is `required` it
    refuses construction if any of these hold:
    - the audit is not v5-writable;
    - `gatewayFactory` is missing;
    - the runtime lacks gateway support.
  - Per invocation, in this order:
    1. `invocation.started`;
    2. `appendExecutionContext`;
    3. open the gateway (if the run has any egress);
    4. `provider.egress` grant (existing);
    5. `sandbox.create` requested with profile and image;
    6. `appendSandboxBinding` with the rule-set digest and policy ID,
       **before** create;
    7. create;
    8. `sandbox.create` finished, with the sandbox ID in the binding outcome.
  - After exec, `appendProcessResult` (exit code, `guestReported: true`) and
    a resource event for timed-out, cancelled or a lifetime deadline.
    Before destroy, take the final resource sample. It goes to telemetry
    only.
  - On destroy or failure, `gateway.close()`. The gateway's own records are
    finished `sandbox-destroyed`.
  - **Gateway quarantine:** if the gateway reports an audit failure, the
    host stops at its next step with `HostAuditError`, as for any mandatory
    write. The sandbox lifetime then applies.
  - Direct `hostTcpPort` is refused in required mode. `hostServices` goes
    through the gateway policy instead.
  - Runtime events are emitted to the observers at every step. Observer
    exceptions are swallowed and counted, and are never on the audit path.
  - Public API compatibility: existing `run*` signatures keep working, and
    the new context is an optional trailing parameter.
- **Acceptance:**
  - Fake runtime and fake gateway tests for the order of audit writes.
  - Failure injection at every new append point: no later effect, and a
    `HostAuditError`.
  - Gateway quarantine stops the invocation.
  - Required mode refuses misconfiguration at construction.
  - Disabled mode with `allowUnauditedRun` works and records nothing new.
  - The existing trusted-host tests pass unchanged, apart from the added
    rows.
- **VM:** no. **Security review: yes.**

### OBS-08: Trace readers

- **Goal.** Show v5 data in the `src/trace.ts` invocation and task views.
- **Files owned:** `src/trace.ts`, `src/task-trace.ts`,
  `test/task-trace.test.ts`.
- **Depends on:** OBS-04.
- **Scope.**
  - The invocation view adds:
    - the execution context;
    - the sandbox binding;
    - the process result;
    - the network connections, grouped by connection ID with their phases
      and derived `unknown`;
    - DNS queries;
    - resource events.
  - The task view joins the same data per invocation.
  - Output escapes control characters (the existing helper).
- **Acceptance:**
  - Fixture database tests.
  - A read-only open never writes.
  - Unknown outcomes are shown as `unknown`, not `failed`.
- **VM:** no.

### OBS-09a: Rotating JSONL file writer (shared)

- **Goal.** Provide one writer that the audit exporter and the telemetry
  exporters share.
- **Files owned:** `src/jsonl-files.ts`, `test/jsonl-files.test.ts`.
- **Depends on:** nothing.
- **Scope.**
  - File names are `YYYY-MM-DD-NNNN.jsonl` in UTC.
  - The active file is `.jsonl.partial`. It is fsynced and renamed when it
    rotates (UTC date change or size limit, default 64 MiB) or closes.
  - Directories are created with mode `0700` and files with `0600`. A
    directory that is a symlink or is group- or world-writable is refused.
  - An exclusive `writer.lock` is created with `O_EXCL` and holds the PID.
    A stale lock is reported, never stolen silently.
  - The writer never deletes. One line is one complete JSON object, and the
    writer refuses objects that contain a newline.
  - Short writes and ENOSPC surface as a typed `disk-full` or `write-failed`
    error.
  - `scan(dir)` reports leftover `.partial` files and truncated last lines
    (partial write detection).
- **Acceptance:**
  - Unit tests for rotation by date (with an injected clock) and by size.
  - Lock contention.
  - ENOSPC simulation through an injected fs.
  - A crash leaves a detectable `.partial` file.
  - Permissions are checked.
- **VM:** no.

### OBS-09b: Audit JSONL exporter

- **Goal.** Export SQLite to `audit/*.jsonl` (ADR D2).
- **Files owned:** `src/audit-export.ts`, `test/audit-export.test.ts`.
- **Depends on:** OBS-04, OBS-09a.
- **Scope.**
  - The CLI is `bun src/audit-export.ts <audit.sqlite> <obs-dir>`.
  - It opens the database read-only and keeps the watermark in
    `audit/export-state.json`, written atomically.
  - Each record has the schema `agent-bootstrap.audit/v1` with these fields:
    `auditId` (`<table>:<sequence>`), `schemaVersion`, `recordedAt`,
    `executionId`, `sandboxId`, `operationId`, `actor` (role or `host` or
    `gateway`), `action`, `target`, `phase` (`intent`, `decision` or
    `outcome`), `result`, `policyId`, `reasonCode`, `traceId`, and bounded
    `attributes`.
  - It also emits a derived `outcome: unknown` record for each open
    operation or connection that has no outcome, marked `derived: true`.
  - The export is idempotent: re-running it adds nothing.
- **Acceptance:**
  - A fixture database yields deterministic output.
  - The watermark resumes correctly.
  - A crash mid-file leaves a detectable `.partial` file, and a re-run
    recovers it.
  - No field outside the schema is emitted.
- **VM:** no.

### OBS-10: Phase 1 gate: VM network audit acceptance

- **Goal.** Prove every row of the network audit matrix with the real
  backend, through the real `TrustedHost` and gateway.
- **Files owned:** `spike/obs/network-audit-smoke.ts`,
  `spike/obs/fixtures.ts`, `docs/observability/phase1-evidence.md`.
- **Depends on:** OBS-05, OBS-06b, OBS-07, OBS-11, SEC-1.
- **Scope.** The smoke uses the pinned msb, the Alpine and Debian images,
  loopback fixtures, and TEST-NET mapping through the injected gateway
  `connect`. It runs:
  - **Bypass regression:** N-01 to N-21, with the guest commands from
    feasibility section 4. The run must fail if N-11, N-12, N-16 or N-17
    reopen.
  - **N-22:** a provider fixture, a local TLS server with its CA passed as
    `upstreamCaCertPath`, reached through the gateway. The fixture asserts
    that it received the synthetic real value and that the guest saw only
    the placeholder. The audit has `channel=provider-egress`.
  - **N-25:** two concurrent VMs (the only test that runs two). Their records
    must be attributed to the right execution and sandbox, and neither
    sandbox can use the other's gateway.
  - **N-26:** `msb rm -f` during an active relay → `sandbox-destroyed`. Also
    kill the host process between `decided` and `finished`, reopen, and
    confirm that `unknown` is derived.
  - **N-24:** an audit sink that fails after N appends → new connections and
    DNS refused, relays closed, and the invocation halted.
  - **N-23:** gateway down.
  - `hostServices` mapping.
  - DNS tunnel attempt: random labels under a non-allowlisted name →
    NXDOMAIN and recorded.
  - Gateway overhead: connect latency with and without the gateway, over
    100 connects.

  At the end, `msb ls` must be empty.

- **Acceptance:**
  - Every row is marked verified in `phase1-evidence.md`, with the commands
    and results.
  - Any failure blocks Phase 2 dogfooding and audit-required mode claims.
- **VM:** yes. Two VMs only for N-25. Remove every sandbox.

### OBS-11: Host composition root

- **Goal.** Build one tested factory that spikes and dogfooding use. Today
  each spike hand-assembles the audit, runtime and host.
- **Files owned:** `src/observed-host.ts`, `test/observed-host.test.ts`.
- **Depends on:** OBS-07.
- **Scope.**
  - `createObservedHost({config, auditPath, msb, profiles, credentials?,
providers?, observers?})` returns
    `{host, audit, runtime, close()}`. It:
    - opens a v5 audit;
    - builds the gateway factory and the `MicrosandboxRuntime` in gateway
      mode;
    - validates the required mode at startup;
    - attaches the observers. Telemetry is plugged in by OBS-14 as an
      observer.
  - `close()` closes the gateways and the audit in order.
- **Acceptance:**
  - Fake-backend tests for the startup refusals and the close order.
- **VM:** no.

### OBS-12: Resource sampler

- **Goal.** Sample resources periodically, provider-neutrally, and report
  them as runtime events or values for telemetry.
- **Files owned:** `src/resource-sampler.ts`,
  `test/resource-sampler.test.ts`.
- **Depends on:** OBS-05 (the port method).
- **Scope.**
  - Sample every `resourceSamplingIntervalMs`, using an injected timer.
  - Use non-overlapping calls: skip a tick if the previous call is still
    pending, and count the skip.
  - Track the sampled peak, the first and last `vcpu_time_ns`, and disk and
    network deltas.
  - Use the final sample from `finalResourceSample`.
  - Mark `unavailable` vs a value. Short runs have only the final sample.
- **Acceptance:**
  - Fake runtime tests: skips, failures (counted, never thrown), and peak and
    delta math.
  - Absent values stay absent.
- **VM:** no.

### OBS-13: OTLP JSON file exporters

- **Goal.** Write SpanExporter, PushMetricExporter and LogRecordExporter
  implementations to `telemetry/{traces,metrics,logs}`.
- **Files owned:** `src/otlp-file-exporters.ts`,
  `test/otlp-file-exporters.test.ts`.
- **Depends on:** DEP-1, OBS-09a.
- **Scope.**
  - Serialize with the `otlp-transformer` JSON serializers and write one
    line per export call through `jsonl-files.ts`.
  - On a write error, return `ExportResultCode.FAILED`, increment the
    dropped counter, and emit one diagnostic line on stderr per error kind
    per minute. Never throw into the SDK.
  - `shutdown` flushes and renames the `.partial` file.
- **Acceptance:**
  - Lines parse as OTLP JSON (the shape from DEP-1).
  - A failure under disk full is reported and does not throw.
  - Exporters are independent: a metrics failure does not stop traces.
- **VM:** no.

### OBS-14: Telemetry instrumentation (observer)

- **Goal.** Turn runtime events into OTel spans, metrics and logs. Telemetry
  never touches the audit.
- **Files owned:** `src/telemetry.ts`, `test/telemetry.test.ts`.
- **Depends on:** DEP-1, OBS-01, OBS-12, OBS-13.
- **Scope.**
  - `createTelemetry(config, dir)` returns a `RuntimeObserver` plus
    `shutdown()`.
  - Spans (ADR D3) use explicit parent contexts. The root `execution` span
    gets its trace ID from the context `traceparent` if one is present.
    Sampling uses a `TraceIdRatioBased` sampler with
    `traceSamplingRatio`.
  - Metrics:
    - `execution.duration`, `sandbox.startup.duration` and
      `process.duration` (histograms, in ms);
    - `sandbox.cpu.time`, `sandbox.memory.usage`, `sandbox.memory.peak`
      (sampled), `sandbox.memory.host_resident`, disk and network bytes;
    - `sandbox.active` (an up-down counter).

    Attributes are limited to `role`, `profile`, `agent.kind`, `outcome`,
    `runtime.kind`.

  - Logs carry network decisions and DNS queries. They hold the IDs and
    destinations but no payload, and they duplicate the audit only for
    analysis convenience.
  - Durations come from `performance.now()` deltas.
- **Acceptance:**
  - In-memory exporter tests:
    - the span tree and attributes for success, failure, timeout and cancel;
    - no execution or sandbox ID in metric attributes;
    - an exporter failure does not throw into the host;
    - telemetry disabled → a no-op observer, with the audit unchanged.
- **VM:** no.

### OBS-15: DuckDB views and analysis queries

- **Goal.** Analyse the JSONL files directly, without a server (reference
  section 10).
- **Files owned:** `observability/duckdb/views.sql`,
  `observability/duckdb/queries.sql`, `spike/obs/duckdb-smoke.ts`,
  `test/fixtures/obs/**`, `test/obs-fixtures.test.ts`.
- **Depends on:** DEP-1, OBS-09b, OBS-13.
- **Scope.**
  - Views:
    - `executions`, which is derived. Counts are shown with the statistics.
      It is not a source of truth;
    - `sandbox_lifecycle`, `process_executions`, `network_connections` (the
      phases pivoted), `policy_decisions`, `execution_performance` (OTLP
      spans and metrics flattened).
  - Queries:
    - executions and outcomes;
    - duration per execution;
    - sandbox startup and the overhead ratio;
    - p50 and p95;
    - failure rate and reasons;
    - CPU and memory trends;
    - outbound destinations per execution;
    - denied connections;
    - policy decisions per execution;
    - an audit ↔ trace join for one execution (by execution ID, and by the
      trace ID recorded in the context).
  - The smoke runs the pinned CLI offline against the fixture files and
    checks the expected rows. It is not part of `bun verify`, because CI has
    no DuckDB. A unit test instead checks that the fixtures match the
    exporters' schemas.
- **Acceptance:**
  - The smoke passes offline.
  - Queries tolerate a `.partial` file and a truncated last line. They are
    excluded and reported.
- **VM:** no.

### OBS-16: Dogfooding (reference section 12)

- **Goal.** Run real Codex and Claude Code tasks through
  `createObservedHost` and confirm the observability claims.
- **Files owned:** `spike/m5/dogfood.ts` (switch to
  `createObservedHost` + telemetry), `spike/obs/dogfood-scenarios.ts`,
  `docs/observability/dogfooding.md`.
- **Depends on:** OBS-10, OBS-14, OBS-15.
- **Scenarios.** Each scenario is run with a Codex Worker and with a Claude
  Code Worker where applicable:
  1. A normal coding task, success. Check that the lifecycle can be traced,
     results can be found by execution ID, the provider connection appears
     (`provider-egress`), and DNS appears.
  2. A policy denial: the agent is prompted to `curl` a non-allowlisted host
     and to resolve a random name. Check that the denied connection and DNS
     records are visible.
  3. A timeout: a small `timeoutMs`. Check `timed_out`, the span status and
     `resource.limit_exceeded`.
  4. A start failure: a wrong tool digest, or the profile image missing with
     `--pull never`. Check `sandbox.create` failed and that no gateway
     traffic exists.
  5. A process failure: a Worker command that exits non-zero. Check the exit
     code (`guestReported`).
  6. Forced termination: `msb rm -f` from outside during the run. Check that
     the records are usable and that relays end with `sandbox-destroyed`.
  7. Audit failure mid-run (an injected failing sink after N writes). Check
     that no new unaudited traffic occurs and the invocation halts.
  8. Telemetry failure: the telemetry directory is read-only. Check that the
     run succeeds, the audit is complete, and the drop counter and stderr
     diagnostic appear.
  9. Compare two executions, codex vs claude, on duration, startup overhead
     and CPU and memory, using the DuckDB queries.
  10. Join the audit and the trace for one execution.
- **Acceptance:**
  - `dogfooding.md` records the commands, execution IDs (synthetic task
    content only), the DuckDB output, and pass or fail for each claim in
    reference section 16.
  - Real provider credentials are used only with explicit human opt-in,
    following the `docs/claude-code-auth.md` and
    `codex-subscription-credential-poc.md` rules.
- **VM:** yes + agent.

### SEC-1: Security review (Phase 1 boundary)

- **Goal.** An independent Security Reviewer checks OBS-04, OBS-05, OBS-06b
  and OBS-07 as a stable change set, against ADR D1, D4 and D5 and the
  matrix. Fixes are rechecked.
- **Files owned:** none. Findings go to the implementer of each owning task.
- **Depends on:** OBS-04, OBS-05, OBS-06b, OBS-07.
- **VM:** no.

### SEC-2: Security review (telemetry and dogfood)

- **Goal.** Check OBS-13, OBS-14 and OBS-16 for secret leakage into
  telemetry or JSONL, unbounded cardinality, and failure isolation.
- **Files owned:** none.
- **Depends on:** OBS-13, OBS-14, OBS-16.
- **VM:** no.

### OBS-17: Phase 3 verification and documentation

- **Goal.** Measure overhead, update the trust documents, and state the
  guarantees and the non-guarantees.
- **Files owned:** `docs/observability/guarantees.md`, `docs/trust-model.md`,
  `docs/microsandbox-runtime.md`, `docs/milestones.md`, `AGENTS.md` (the
  ownership lines for the new modules), `README.md` (if it lists modules).
- **Depends on:** OBS-16, SEC-2.
- **Scope.**
  - Overhead figures come from OBS-10 and OBS-16: connect latency, fsync
    cost per decision, and run duration delta.
  - A compatibility check: v4 databases, old spikes, and disabled mode.
  - A final list of guaranteed vs unsupported items.
- **Acceptance:**
  - `bun verify` passes.
  - The docs match the ADR non-guarantees. Nothing that is unimplemented is
    claimed.
- **VM:** no.

## Explicit non-guarantees (carried into `guarantees.md`)

1. Microsandbox refuses some attempts before the gateway: the host group,
   other resolvers, DoT, UDP, ICMP and raw IP. They are blocked but **not
   individually audited** (gap G1).
2. Audit is connection-level only. There is no TLS body, HTTP method, path,
   header or DoH inspection inside allowlisted destinations. Exfiltration to
   an allowlisted destination is possible.
3. Direct-IP flows carry no hostname. The SOCKS requests from msb carry only
   IPs.
4. Process data:
   - exit codes are guest-reported, and signals are unavailable;
   - OOM inside the guest is invisible to the host;
   - peak memory is a sampled lower bound;
   - CPU % is meaningless for runs shorter than about two sampling
     intervals;
   - lifetime expiry is inferred.
5. There is no tamper resistance against the host user or administrator, or
   after a host compromise. JSONL and telemetry are analysis copies, not
   evidence.
6. Correct enforcement relies on the Microsandbox 0.7.16 netstack and
   `--proxy`, which are in the TCB. Any msb upgrade needs the OBS-10 bypass
   regression.
7. There is no file access audit, no token or cost accounting, no web UI,
   and no external WORM storage.
8. Concurrency attribution and end-to-end credential substitution through the
   gateway hold only after OBS-10 passes.

## Known risks and blockers

- **Credentialed runs are not audit-required compliant until OBS-07 and
  OBS-10 land.** Today's provider mode uses unscoped `allow@dns` (matrix
  N-09). Dogfooding with real agents before that cannot claim network audit.
- **N-22 is unverified.** If secret substitution does not work through
  `--proxy` with CIDR rules, audit-required provider egress is **blocked**.
  The options are then an msb change, or making the gateway the TLS endpoint
  (a larger design that would need a new ADR). Do not fall back to direct
  domain rules silently.
- **DuckDB JSON offline (DEP-1).** If the `json` extension needs a download,
  OBS-15 is blocked until it is approved.
- **Bun and OTel.** If DEP-1's compatibility test fails, stop and re-plan
  (for example, a minimal hand-written OTLP JSON mapping would need explicit
  approval, because the reference prefers the SDK).

## dagq-lite follow-ups (out of v0.1 scope)

agent-bootstrap development stops after v0.1. These items move to dagq-lite:

- Reuse or extract the audit v5 store, the gateway, `jsonl-files` and the
  OTLP file exporters as a library instead of copying them.
- Map dagq tasks, goals and attempts to `ExecutionContext.attributes` and
  `sessionId`. Join queue state to audit and traces in DuckDB.
- Upstream Microsandbox requests:
  - a structured, synchronous deny and flow event stream (closes G1);
  - hostname (SNI or DNS-learned) in SOCKS ATYP 3 for intercepted flows;
  - an exit signal and OOM reason in `exec` and `wait`;
  - a peak memory metric;
  - a stop reason for `--max-duration`.
- Per-request audit for provider API calls (method, path, status, token
  usage) at a trusted TLS endpoint, with credential handling reviewed again.
- Tamper evidence: a hash chain over the audit rows, signed checkpoints, and
  optional WORM export.
- Optional OTLP network export and SigNoz or OpenObserve import, Parquet
  compaction, and retention policy.
- Token and cost accounting from agent CLI outputs (`claude-code.ts` already
  parses usage).
