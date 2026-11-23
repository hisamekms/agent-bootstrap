# Runtime Observability v0.1 guarantees

These guarantees assume a trusted host and correct enforcement by the
Microsandbox 0.7.16 netstack and `--proxy`. Both are in the trusted computing
base. Re-run the OBS-10 network regression when upgrading Microsandbox.
See [ADR 0001](adr-0001-observability.md) for the design.

## Durable audit

SQLite schema v5 is the sole source of audit truth. In required mode the host
records the execution context, sandbox binding and network rule-set digest
before sandbox creation. The gateway commits requested and decided records
together before an upstream TCP connect or DNS policy reply. Lifecycle,
process results and resource limit events are recorded by execution.
The execution ID is the invocation ID. When a durable decision has no
recorded outcome, analysis derives `unknown`.

An audit write failure blocks further gateway effects for the sandbox. The
host stops normal invocation operations and attempts emergency teardown.
SQLite JSONL exports and OTLP telemetry are analysis copies. They have no
tamper resistance against the host user or administrator, and the SQLite
store also assumes a trusted host. v0.1 provides no WORM storage, file-access
audit, or model token and cost accounting.

## Network coverage

- Audit covers connections and DNS decisions at the gateway. It does not
  inspect TLS bodies, HTTP methods, paths or headers, or DoH inside allowed
  connections. Exfiltration to an allowlisted destination is possible.
  Direct-IP flows carry no hostname.
- G1 remains open. Microsandbox blocks the host group, foreign resolvers,
  DoT, UDP outside gateway DNS, ICMP and raw IP before the gateway. Those
  attempts have no individual audit record. Gateway refusals that leave no
  per-attempt record are counted only. The gateway sends aggregate counts to
  runtime observers, including telemetry. The counts are absent from SQLite.
- N-10, N-11, N-15, N-16 and N-18 have no packet-level evidence. The
  rootless socket witness and recorded rule digest are the evidence for
  those rows. See the [matrix](network-audit-matrix.md) and
  [OBS-10 witness limits](phase1-evidence.md#escape-witness-rootless).
- On forced removal, the relay end reason can be `client-closed` or
  `sandbox-destroyed`. OBS-10 verified the teardown race on real VMs. See
  [forced removal](phase1-evidence.md#forced-removal-end-reason).

## Telemetry and analysis files

- Telemetry is best effort. Failures are counted in `obs.telemetry.dropped`
  and reported to stderr with rate limiting. Telemetry never changes audit
  content or invocation outcomes.
- A denied DNS name appears in telemetry only as a per-process HMAC. The key
  is never persisted, and the HMAC cannot be used to link the name across
  processes. SQLite and its JSONL export hold the raw guest-controlled name,
  up to 253 bytes. Treat both as sensitive. Export files use mode `0600`.
  Run with a restrictive umask and keep the SQLite database and its
  sidecars at `0600` in a private host directory. The audit store relies
  on the operator for those SQLite permissions.
- Metric attributes use bounded labels. Per-execution identifiers appear
  only in telemetry spans and logs. Traces are sampled according to
  `traceSamplingRatio`. Spans still open at graceful shutdown end with
  outcome `unknown`.
- Missing resource values mean unavailable, never zero. Peak memory is a
  sampled lower bound. CPU percentage is meaningless for runs shorter than
  about two sampling intervals. Exit codes are guest-reported. Signals are
  unavailable, guest OOM is invisible to the host, and lifetime expiry is
  inferred from the host deadline.
- A host crash or write failure can leave `.partial` files. The DuckDB
  views exclude each such file in full and report it in `input_issues`. A
  stale `writer.lock` requires manual removal after confirming the writer
  has stopped. Until then, that signal's telemetry is silently dropped
  from the run's perspective, with only the drop counter and rate-limited
  diagnostics as visibility.
- JSONL rejects records containing escaped line breaks (`\n` or `\r`).
  The telemetry batch containing the record is dropped. Audit export stops
  at the offending row and leaves the SQLite audit intact.

## Evidence and overhead

OBS-10 and the M5, M4 and M6 fixture runs provide the real-VM evidence.
OBS-16 scenario runs are socket-free fixtures with scripted resource data.
Live Codex and Claude Code observability dogfooding is pending operator
opt-in. See the [OBS-10 results](phase1-evidence.md#run-results-sequential-one-vm-at-a-time-two-for-concurrency)
and [OBS-16 dogfooding](dogfooding.md).

OBS-10 measured 100 connects per mode to a loopback fixture, timed through
the first verified bytes. Direct connect was p50 2.7 ms and p95 3.6 ms. The
gateway path was p50 6.7 ms and p95 8.0 ms, about 4 ms added at p50. The
measurement includes the durable decision and gateway work. It does not
isolate fsync cost. OBS-16 records fixture durations without a paired
observability-disabled run, so there is no measured whole-run overhead.

## Compatibility

- Audit databases at v1 through v4 can be opened and read. New audited
  invocations require writable v5. Opening a valid v4 database for writing
  upgrades it to v5 in one transaction. Draft v5 layouts fail the exact
  schema check and are refused.
- The legacy three-argument `TrustedHost` constructor is for offline
  callers. Use the configured host for gateway-backed runs.
- With `audit.mode: "disabled"`, a run that supplies `provider`, `tools`,
  a repository or `hostTcpPort` requires explicit per-run
  `allowUnauditedRun: true`. Disabling telemetry leaves audit enabled in
  required mode.

## Verified after the final security review (SEC-2)

These changes were made after SEC-2. On 2026-11-23 the coordinator verified
them with `bun verify` (441 tests, default timeout). The run included the
gateway socket tests outside any sandbox, and the regression test that a
stalled telemetry exporter does not delay a gateway decision. The same day it
re-ran on real VMs the OBS-10 `provider`, `fault`, `limits` and `bypass`
cases (all pass) and one M5 configuration (tree mode, `browser`, Claude
Coordinator and Reviewer, Codex Worker: `done`).

- Telemetry is written through bounded queues and drained asynchronously.
  Overflow is dropped and counted in `obs.telemetry.dropped`, and the queues
  are flushed at shutdown.
- Telemetry has a disk budget, `telemetry.maxTotalBytes`, which defaults to
  1 GiB. The audit export is not capped and shares the volume.
- The gateway limits are configurable through `audit.network`:
  `attemptBurst`, `attemptsPerSecond`, `maxNetworkRows` and `maxRelays`. The
  defaults are unchanged.
- Refused SOCKS accepts are closed promptly. The refusal reply has up to
  250 ms to drain.
- The DuckDB CLI runs with a minimal environment: `PATH`, `HOME` and
  `MISE_OFFLINE`.
- The `obs_spans` view exposes `resource_sampling_status`.

## dagq-lite follow-ups

- Add structured Microsandbox deny-event emission to close G1.
- Verify N-10, N-11, N-15, N-16 and N-18 at packet level with root capture.
- Stream tar parsing.
- Use shallow clones and make deeper history available by request.
- Add credential fallback between invocations.
- Record who answered each human gate (Coordinator questions and candidate
  approval): the operator, or an agent acting for the operator. Today the
  audit and the integration journal record the decision only. The 2026-11-23
  live runs kept this in a local log.
