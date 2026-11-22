# Phase 1 network audit evidence

Status as of 2026-11-23: **verified on the local lab host with a rootless witness, except N-10, N-11, N-15, N-16, N-18 at packet level**; see the Run results and Escape witness sections. Phase 2
dogfooding and audit-required mode claims remain gated on the runs below.

## Coordinator commands

Run from the repository root on an offline lab host with loopback sockets
and the local Microsandbox backend available. Set `MSB_HOME` to a dedicated,
empty sandbox inventory with the pinned Alpine image and the Debian browser
image from `images/profiles.lock.json` already cached. Install neither tool
nor image during this run. The runner requires an installed `mise` and
Microsandbox 0.7.16 and creates VMs with `--pull never`.

The bypass, outage, and crash cases use a rootless host-socket witness
(no packet capture). See "Escape witness" below for its method and limits.
The injected gateway resolver answers only fixture names, and every gateway
dial is mapped to loopback. Guest bypass probes use documentation addresses,
local addresses, and TCP connection attempts to reserved addresses expected
to be refused.

```sh
export MSB_HOME=/absolute/path/to/dedicated-cached-msb-home
OBS10_VM=1 bun spike/obs/network-audit-smoke.ts bypass
OBS10_VM=1 bun spike/obs/network-audit-smoke.ts provider
OBS10_VM=1 bun spike/obs/network-audit-smoke.ts outage
OBS10_VM=1 bun spike/obs/network-audit-smoke.ts fault
OBS10_VM=1 bun spike/obs/network-audit-smoke.ts concurrency
OBS10_VM=1 bun spike/obs/network-audit-smoke.ts forced
OBS10_VM=1 bun spike/obs/network-audit-smoke.ts crashed
OBS10_VM=1 bun spike/obs/network-audit-smoke.ts limits
OBS10_VM=1 bun spike/obs/network-audit-smoke.ts overhead
```

Run the commands sequentially. Only `concurrency` runs two VMs at once.
Each command emits JSON records with `case`, `row`, `status`, and the
artifact directory. A failing assertion or residual sandbox returns a
nonzero exit status. Attach the JSON output and named audit artifacts to
this evidence record. The SQLite files remain under `.local/obs10-*`
and the credential, writer-fault, and host-crash commands also export JSONL.
Keep the two `N-26` records, which have distinct `case` values. Mark a row
verified only after its assertions and cleanup have passed.

## Acceptance results

| Row             | Command suffix      | Evidence to record                                                                                                                                | Status                                                                        |
| --------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| N-01            | `provider`          | DNS pin, durable allow before upstream dial, completed TLS relay                                                                                  | Verified                                                                      |
| N-02            | `bypass`            | TCP deny for a non-allowlisted destination                                                                                                        | Verified                                                                      |
| N-03            | `bypass`            | Separate literal-IP denial with no hostname attribution                                                                                           | Verified                                                                      |
| N-04            | `bypass`            | IPv6 TCP denial                                                                                                                                   | Verified                                                                      |
| N-05            | `bypass`            | NAT64 denial stored against the canonical IPv4 destination                                                                                        | Verified                                                                      |
| N-06            | `bypass`            | Reserved-range decisions for metadata, private, link-local, and VM pool targets                                                                   | Verified                                                                      |
| N-07            | `bypass`            | Durable binding, blocked host aliases and mapped addresses, zero hits on v4/v6 loopback canaries                                                  | Verified                                                                      |
| N-08            | `bypass`            | Mapped service handshake and `host-service` outcome                                                                                               | Verified                                                                      |
| N-09            | `bypass`            | Durable allowed DNS and random-name NXDOMAIN on TCP and UDP                                                                                       | Verified                                                                      |
| N-10            | `bypass`            | External-resolver UDP attempts, no gateway DNS record or escaped packet                                                                           | Unverified at packet level (needs root capture); socket witness + digest pass |
| N-11            | `bypass`            | No broad UDP rule in the durable digest, no DNS packets escaped                                                                                   | Unverified at packet level (needs root capture); socket witness + digest pass |
| N-12            | `bypass`            | TCP/53 refused before gateway on IPv4 and IPv6, no escaped packets                                                                                | Verified                                                                      |
| N-13            | `bypass`            | TCP/853 blocked before gateway on IPv4 and IPv6                                                                                                   | Verified                                                                      |
| N-14            | `bypass`            | TCP/443 policy deny for a DoH-style destination                                                                                                   | Verified                                                                      |
| N-15            | `bypass`            | NTP, QUIC, and arbitrary UDP probes never appear on host egress                                                                                   | Unverified at packet level (needs root capture); socket witness + digest pass |
| N-16            | `bypass`            | No IPv4 or IPv6 ICMP echo escapes                                                                                                                 | Unverified at packet level (needs root capture); socket witness + digest pass |
| N-17            | `bypass`            | Host-group denial precedes broad TCP rules, both loopback canaries untouched                                                                      | Verified                                                                      |
| N-18            | `bypass`            | No GRE, SCTP, or spoofed raw IP probes escape                                                                                                     | Unverified at packet level (needs root capture); socket witness + digest pass |
| N-19            | `bypass`            | Root mutation attempts, durable binding and subsequent TCP denial                                                                                 | Verified                                                                      |
| N-20            | `bypass`            | Proxy environment attempt cannot hit the host canary and direct-TCP control is audited                                                            | Verified                                                                      |
| N-21            | `bypass`            | Direct SOCKS and DNS listeners are unreachable                                                                                                    | Verified                                                                      |
| N-22            | `provider`          | Guest placeholder, exact synthetic credential at the local TLS fixture, `provider-egress` audit and clean export                                  | Verified                                                                      |
| N-23            | `outage`            | Runtime listener loss closes the relay, no TCP/DNS fallback succeeds, factory outage fails durably                                                | Verified                                                                      |
| N-24            | `fault`             | SQLite writer lock outlasts busy timeout, gateway and host quarantine, no policy reply or new outbound relay, exported unknown                    | Verified                                                                      |
| N-25            | `concurrency`       | Two simultaneous VM bindings and DNS/relay accounting, cross-address and cross-identity denials                                                   | Verified                                                                      |
| N-26            | `forced`, `crashed` | Active relay force removal records `sandbox-destroyed`. Actual host SIGKILL leaves the relay outcome derived as `unknown` with no further egress. | Verified                                                                      |
| SEC-1 limits    | `limits`            | Steady rate and burst admissions using defaults 32 and 16/s, 4,096-row default cap, 12-row override, durable limit events                         | Verified                                                                      |
| Connect latency | `overhead`          | 100 connects per mode to one loopback canary, p50/p95 to first verified bytes, 100 audited gateway outcomes                                       | Verified                                                                      |

For pre-gateway blocks, the durable audit assertion is the expected rule
digest plus absence of a matching gateway record. Host canaries and the
socket witness check whether traffic escaped. The Alpine root test attempts
interface and routing mutations that the guest kernel may refuse. The
latency baseline explicitly opts into the audit-disabled host-port path.

The gateway factory accepts `attemptBurst`, `attemptsPerSecond`, and
`maxNetworkRows` as trusted-host inputs. The limits case raises the rate
settings for the 4,096-row measurement and exercises a lower row cap.
The public observability configuration has no fields for these settings.

## Forced removal end reason

`msb rm -f` kills the VMM, whose netstack closes its socket to the gateway.
That close races the host's own gateway close, so the durable end reason is
either `sandbox-destroyed` or `client-closed`. Observed on the lab host:
`client-closed` (3 bytes sent, 18 received, one `finished` row,
`connected`). Both reasons prove the same facts: the relay was an audited,
durably decided connection, exactly one outcome row exists, the upstream
fixture socket closed (`fixture.active === 0`), and no further traffic occurs.
The case accepts exactly these two reasons and still requires `connected`,
byte accounting, one `finished` row, and a closed upstream. `idle-timeout`,
`upstream-closed`, `error`, and `audit-failure` still fail.

## Escape witness (rootless)

`tcpdump` needs root, which is not available. `captureBypasses` in
`spike/obs/fixtures.ts` instead polls `lsof -nP -i` back to back (about
30 ms per poll, no privileges) for the whole guest run plus 1.1 s, and fails
if any host TCP or connected-UDP socket has a witnessed address as its peer
(`->ip:port`). Witnessed addresses are the probe targets (TEST-NET-2/3,
2001:db8::/32, `64:ff9b::c633:644b`) and the other guest-probed addresses
(169.254.169.254, 10.22.33.44, 169.254.10.11, 172.31.254.249,
fd42:6d73:62:ffff::2). A calibration step first opens a real loopback
connection and requires the witness to see it. Every gateway dial is mapped
to loopback by the harness, so a socket to a witnessed address could only
come from an escaped dial by the Microsandbox network engine.

Complementary evidence: durable rule digest (`expectedRules`), host canary
listeners that count accepted connections (v4/v6 loopback, control service),
and the absence of matching gateway rows for pre-gateway blocks.

Limits:

- A dial refused or reset faster than one poll leaves no observable socket.
  TEST-NET destinations are unrouted, so a real dial would sit in `SYN_SENT`
  far longer than the poll interval.
- Unconnected UDP (`sendto` without `connect`), ICMP, GRE, and SCTP leave no
  socket peer row. For those rows (N-10, N-11, N-15, N-16, N-18) the
  witness only shows that the engine opened no connected socket to a
  witnessed address. It is **not** packet evidence, and the rows rely on the
  rule digest (no broad UDP rule, `allow@dns` only) plus the host canaries.
- `msb metrics` `net_tx_bytes`/`net_rx_bytes` count at the VM NIC, so they
  include packets the policy then dropped. They cannot attribute
  destinations or separate blocked from escaped traffic, and sub-sample-
  interval leaks are invisible. They were therefore not used as a pass/fail
  witness. A packet-level confirmation of N-10, N-11, N-15, N-16, N-18 needs
  a root capture: **unverified (needs root capture)** at packet level.
- The witness polls all host sockets, not only the VMM's. A foreign process
  dialing a witnessed address would false-fail, never false-pass.

## Run results (sequential, one VM at a time; two for `concurrency`)

| Case          | Rows        | Status | Key numbers                                                                                                                                   |
| ------------- | ----------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `bypass`      | N-02..N-21  | pass   | 20 rows pass; 27 network rows in the main VM; socket witness clean (see limits above)                                                         |
| `provider`    | N-01, N-22  | pass   | 5 network rows; DNS pin before dial; exact synthetic credential at the fixture; clean export                                                  |
| `outage`      | N-23        | pass   | 3 network rows; factory outage failed durably                                                                                                 |
| `fault`       | N-24        | pass   | relay closed, invocation halted                                                                                                               |
| `concurrency` | N-25        | pass   | two VMs, 8 network rows each                                                                                                                  |
| `forced`      | N-26        | pass   | one `finished` row, `client-closed`, upstream closed                                                                                          |
| `crashed`     | N-26        | pass   | outcome `unknown`, 2 network rows                                                                                                             |
| `limits`      | SEC-1       | pass   | 32 burst admissions, 4,096-row cap, 12-row override                                                                                           |
| `overhead`    | connect p50 | pass   | direct p50 2.7 ms / p95 3.6 ms; gateway p50 6.7 ms / p95 8.0 ms; p50 overhead about 3.9-4.2 ms over 100 connects (plan sets no numeric bound) |

`msb ls` was empty after the final run.
