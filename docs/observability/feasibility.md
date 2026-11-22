# Runtime Observability v0.1: Phase 0 feasibility

This report covers Phase 0 of the observability work: audit logging,
outbound network audit and performance telemetry for coding agents (Codex,
Claude Code) that run in agent-bootstrap sandboxes. It maps the reference
requirements, which were written for a repository called "agent-sandbox", to
this repository. It also records real Microsandbox experiments. The decisions
are in [ADR 0001](adr-0001-observability.md), the network evidence per method
is in the [network audit matrix](network-audit-matrix.md), and the
implementation DAG is in [plan.md](plan.md).

Experiments ran on 2026-11-22/23 on macOS arm64 with the pinned
`msb 0.7.16`, a dedicated `MSB_HOME`, `MSB_BACKEND=local` and `--pull never`.
At most one VM ran at a time. Every sandbox was removed afterwards, and
`msb ls` ended empty. The only network targets were:

- loopback listeners on the host;
- TEST-NET addresses (`192.0.2.0/24`, `198.51.100.0/24`, `2001:db8::/32`),
  which are not routed;
- DNS resolution of `example.com`;
- connection attempts to public IPs that were expected to be refused, with no
  payload.

## 1. Survey of existing code (reference section 3.1)

| Reference concept                       | agent-bootstrap location                                                                                                                                                                                                                                                                 | Notes                                                                                                                                                                                                                                                                 |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Execution start and end                 | `TrustedHost.#run` and `runCoordinatorSession` in `src/trusted-host.ts`: `invocation.started` / `invocation.finished`                                                                                                                                                                    | One _invocation_ is one role run (Worker, Planner, Reviewer, Verification, or a Coordinator turn). Its UUID is caller-supplied (`id?`) or generated. **The reference's execution ID maps to this invocation ID.**                                                     |
| Higher-level context                    | `CoordinatorTask` journal (`src/coordinator.ts`, `src/private-journal.ts`): task ID, `run` (turn), `attempt` (delegation)                                                                                                                                                                | `taskTrace` (`src/task-trace.ts`) joins the journal to the host audit by invocation ID. The reference's session, plan and task map to attributes, not runtime concepts.                                                                                               |
| Sandbox create, start, stop and destroy | `SandboxRuntime` port (`src/sandbox-runtime.ts`); `MicrosandboxRuntime.create` (`msb create`, which also boots) and `#destroy` (`msb rm --force`) in `src/microsandbox.ts`; `RoutingSandboxRuntime` (`src/routing-runtime.ts`)                                                           | There is no separate start or stop: create boots and destroy removes. The audit has `sandbox.create` / `sandbox.destroy` with requested, allowed and finished phases. **The sandbox ID (`bootstrap-<uuid>`, `SandboxHandle.id`) is not recorded in the audit today.** |
| Process exec and result                 | `SandboxRuntime.exec` / `openSession`; `ExecResult {status, exitCode}`; audit `sandbox.exec` with outcome `ok`, `failed`, `timed-out` or `cancelled`                                                                                                                                     | **The exit code is not audited**, only the mapped outcome. The exit code comes from the guest agent (`msb exec` return code), so it is guest-reported.                                                                                                                |
| Policy evaluation                       | `TrustedHost.#profileFor` (role to profile), the role-key allowlists in `runVerification` / `runCoordinator`, `guestRequest` (collect only), and `isSafeCredentialVariable`                                                                                                              | Denials are audited as `operation.denied` (for example, an unknown guest request). Plan-shape refusals happen _before_ any audit write, by design.                                                                                                                    |
| Microsandbox connection                 | `MicrosandboxRuntime.#run` / `#checked` (`execFile` of the pinned binary with a minimal env), version check, image digest check                                                                                                                                                          |                                                                                                                                                                                                                                                                       |
| Network boundary                        | `--no-net`; `hostTcpPort` → `--net-rule allow@host:tcp:<port>`; `provider` → `allow@dns` + `allow@<host>:tcp:<port>` + `--tls-intercept` + `--secret` (`providerArgs`); image builds use `allow@dns` + one host (`src/image-recipes.ts`)                                                 | The `allow@dns` rule is unscoped, as the code comment already says.                                                                                                                                                                                                   |
| Host credential proxy                   | Microsandbox TLS interception with secret substitution (`--secret ENV:headers=…@host`, `--secret-violation-action block`); `CredentialProvider` (`src/credentials.ts`) supplies the value only to the `msb create` environment                                                           | The audit records the `provider.egress` grant (requested, allowed and finished around the sandbox lifetime), not individual connections.                                                                                                                              |
| Current audit and trace                 | `SqliteAudit` (`src/audit.ts`), schema v4: `audit_events` + `request_claims`, append-only triggers, WAL, `synchronous=FULL`, exact schema SQL check, `quick_check`, row validation on open, `#writeFailed` quarantine, `HostAuditError` fail-closed in `TrustedHost`; `src/trace.ts` CLI | This is the source of truth and stays so (user decision). There is no telemetry, metrics or JSONL today. Token usage is parsed in `src/claude-code.ts` (`inputTokens` / `outputTokens`) but not persisted.                                                            |

### Conflicts with the reference and how they are resolved

1. **Audit persistence.** The reference stores audit as JSONL files. This
   repository keeps SQLite as the durable source of truth (user decision) and
   derives the JSONL files from it with an exporter. Durability, fail-closed
   behaviour and the single writer stay in SQLite. JSONL is an analysis copy.
   The reference's JSONL requirements (rotation, in-progress marking, partial
   write detection, no deletion, disk full) apply to the exporter and the
   telemetry files. They do not change the audit guarantee.
2. **Execution ID versus invocation ID.** These are the same identifier. The
   public field name stays `invocationId` (no breaking rename). New records
   and exports call it `executionId` and document the alias.
3. **Sandbox lifecycle.** The reference has separate `sandbox.started` and
   `sandbox.stopped` events. Microsandbox create also boots, and destroy also
   stops. v0.1 emits `sandbox.created` (which covers boot) and
   `sandbox.destroyed`. `started` / `stopped` are reserved and documented as
   not emitted.
4. **Runtime events versus an event store.** Runtime events are an in-process
   TypeScript discriminated union. They feed telemetry and the audit mapping.
   They are not persisted as their own store (the reference forbids event
   sourcing). The SQLite rows are the persisted audit records.
5. **Audit phase vocabulary.** The existing `requested` / `allowed` / `denied`
   / `finished` kinds map to the reference's intent, decision and outcome
   phases. They are kept, and the export adds a `phase` column.
6. **The "agent-sandbox" network design does not exist here.** The current
   egress relies on Microsandbox rules alone. As section 2 shows, that cannot
   give per-connection audit. A host-side Egress Audit Gateway is required.
7. **`hostTcpPort`.** This is a direct guest-to-host-loopback rule that
   bypasses any proxy (matrix N-17). In audit-required mode it cannot stay
   direct. It must be served through the gateway, or refused.

## 2. Microsandbox network capabilities (reference section 3.2)

### 2.1 How the network works (observed)

- Each VM gets a virtio NIC `eth0` with an IPv4 /30 (`172.16.0.6/30`, gateway
  `172.16.0.5`) and an IPv6 /64 (`fd42:6d73:62:1::2`, gateway
  `fd42:6d73:62:1::1`). `/etc/hosts` maps `host.microsandbox.internal` to both
  gateway addresses. `resolv.conf` points at the gateway. There is also an
  unused `dummy0`.
- Guest commands run as **root** (`uid=0`). `ip`, `route`, `sysctl` and raw
  sockets (busybox `ping`, and Perl `SOCK_RAW` and `IP_HDRINCL` in the Debian
  image) are all available.
- Networking is a **userspace network stack in the host `msb machine`
  process**, which runs as the unprivileged host user. All guest packets end
  there. Policy is applied per flow. Allowed flows are re-originated from host
  sockets, either directly or through `--proxy`. Guest-side routing, IP, MAC
  and sysctl changes do not change what leaves the host (R1–R5).
- `msb create --help` advertises the parts used below: `--net-rule` (ordered
  tokens `<action>[:<direction>]@<target>[:<proto>[:<ports>]]`, with targets
  IP/CIDR, domain, suffix, group, `host` and `dns`), `--net-default*`,
  `--dns-nameserver`, `--no-dns-rebind-protection`, `--proxy
<http|socks4|socks5>://IP:PORT` with `--socks5-username` /
  `--socks5-password-env`, `--tls-intercept`, `--secret`, `--label`,
  `--max-tcp-connections` and `--max-udp-connections`.

### 2.2 Answers to the ten questions

1. **Can TCP be forced through a host audit path? Yes, with conditions.**
   `--proxy socks5://127.0.0.1:P` makes the host netstack dial _every
   policy-allowed non-host TCP flow_ through the SOCKS5 server. This holds
   for IPv4, IPv6, NAT64 and TLS-intercepted flows (exp3–exp7, exp10). The
   SOCKS request carries the destination as an IP (ATYP 1 or 4), never a
   hostname. The guest TCP handshake completes only after the proxy
   succeeds ("upstream TCP connect failed before guest handshake"). So a
   proxy refusal appears to the guest as a refused connection.
   Conditions:
   - traffic to the `host` group (the gateway IPs) does **not** use the proxy
     (N-17);
   - TCP to port 53 of an allowed IP is answered by Microsandbox's own DNS
     forwarder, straight to the original destination (N-12). The rule set
     must therefore exclude the `host` group and TCP/53.
2. **Are refused connection attempts available? Not durably, and not for
   TCP.** Even at `--log-level trace`, `runtime.log` has no record of an
   allowed TCP flow, a UDP flow, an allowed DNS query, or a TCP or UDP flow
   that policy denied. Only some denials appear, at DEBUG:
   - `DNS query denied by network policy domain=…`;
   - `DNS resolver denied … original_dst=…`;
   - `ICMP echo denied by policy dst=…`;
   - `upstream TCP connect failed before guest handshake …` (when the proxy
     refuses).

   These lines are diagnostics. They are written after the fact, are not
   synced, are deleted with the sandbox (`msb rm` removes `logs/`), and are
   mixed with high-volume hypervisor debug output (about 3 MB in 3 minutes).
   `msb logs --source system` shows the same runtime stream. `msb inspect`
   shows the effective policy, not traffic. `msb metrics` shows only VM-level
   byte counters. **Microsandbox alone cannot provide per-connection audit.**
   Attempts that reach the gateway are audited by the gateway. Attempts
   refused before the gateway are blocked but not recorded (see the gap in
   the ADR).

3. **Where is DNS handled?** The gateway IP's port 53, on UDP and TCP, is
   served by the host netstack's forwarder. Queries to _any_ destination port
   53 are intercepted by the same forwarder:
   - With `allow@dns` and no `--dns-nameserver`, every name and type is
     resolved through the host's resolvers. That includes TXT queries for
     arbitrary names. This is a **DNS tunnel channel with no audit** (D1, D2).
   - Without `allow@dns`, queries are refused with NXDOMAIN and logged at
     DEBUG (T5).
   - With `--dns-nameserver 127.0.0.1:P`, the forwarder sends gateway queries
     to the host-side server, over UDP and TCP (G1, J1, J4). That gives an
     auditable DNS path.
   - Queries to a non-gateway resolver are refused, unless a UDP or TCP rule
     allows that IP. In that case the forwarder **sends them directly to the
     original resolver**, bypassing both `--proxy` and `--dns-nameserver`.
     This was confirmed: real `example.com` answers came from 8.8.8.8 and
     1.1.1.1 over UDP (N-11) and from 8.8.8.8 over TCP (N-12).
   - With TLS interception on, DoT to port 853 is terminated by Microsandbox,
     and the decoded query is policy-checked and refused (exp12).
   - DoT without interception is refused (T9d).
4. **UDP control.** UDP is denied by default. With `--proxy` and a UDP allow
   rule, Microsandbox issues SOCKS5 `UDP ASSOCIATE` (CMD 3) to the proxy
   (P5, G9). So a gateway can see UDP and refuse it, although the destination
   is not in the ASSOCIATE request. Because a UDP allow rule also opens the
   direct DNS bypass in question 3, **v0.1 allows no UDP rule**. UDP is
   blocked, except gateway DNS.
5. **IPv4 and IPv6.** IPv6 is enabled and gets the same treatment. IPv6 TCP
   goes through the proxy (G11), as does NAT64 `64:ff9b::/96` (M3, which
   arrives at the proxy as an IPv6 literal). IPv6 to the gateway is direct to
   host `::1` unless `deny@host` is set (G6, H4). v4-mapped forms of the
   gateway and of loopback are refused (M1, M2).
6. **Direct IP, proxy environment variables, proxy bypass.**
   - Direct-IP TCP is subject to the same rules and proxy (P1, P3).
   - Proxy environment variables in the guest change nothing: policy applies
     to the real destination (R0). They are never relied on.
   - "Bypassing" the proxy is possible only through the cases in questions 1
     and 3: the host group and direct DNS forwarding.
7. **Root in the sandbox.** Tested as root:
   - extra IPs and source spoofing (R1);
   - routes (R2, M11);
   - bringing up `dummy0` (R3);
   - a MAC change (R4);
   - `ip_forward` (R5);
   - raw ICMP (R7);
   - raw IP protocols 47, 132, 17, 6 and 255, and `IP_HDRINCL` with a
     spoofed source (exp11);
   - changing `resolv.conf` (H8).

   None of these changed what left the host. Raw non-TCP/UDP packets produced
   no host socket, no gateway contact and no log line. The unprivileged host
   process cannot emit them. Attribution relies on the per-VM netstack
   instance and per-sandbox proxy credentials, not on guest IPs. So spoofing
   does not misattribute traffic.

8. **Access to host services.** `allow@host:tcp:P` reaches only host loopback
   port P, over IPv4 and IPv6 (T1–T3, T13). With `allow@0.0.0.0/0:tcp` (no
   `deny@host`), **every host loopback port** is reachable and bypasses the
   proxy (G4–G6, N-17). With `deny@host` first, the gateway, its IPv6 address
   and mapped forms are refused (H2–H4, M1, M2, M4). Metadata
   `169.254.169.254`, RFC 1918 addresses, other pool addresses and link-local
   addresses reach the proxy and can be refused there (G7, H6, H7, M6, M8).
9. **Proxy failure behaviour.** The system fails closed:
   - a dead proxy port makes every TCP attempt fail, with no direct fallback
     (F2, F3);
   - a proxy that accepts and resets gives a refused connection (F4);
   - a dead `--dns-nameserver` gives a DNS timeout, with no fallback to the
     host resolvers (F1);
   - when a policy-allowed _host_ service is down, the guest gets a refused
     connection (the netstack tries `::1`, then `127.0.0.1`).
10. **Per-sandbox identification.** The netstack is per VM.
    - The proxy sees connections from `127.0.0.1` only. The source port does
      not identify the sandbox.
    - `--socks5-username <id>` with `--socks5-password-env` authenticates
      every SOCKS connection from that VM, and the guest sees neither value
      (exp7, exp10, exp12; the guest env had only the secret placeholder).
    - DNS forwarded to `--dns-nameserver` arrives from `127.0.0.1` with no
      identity, so DNS attribution needs **one DNS listener per sandbox**.
    - `--label` values appear in `msb inspect` (`labels`), and
      `msb ls`/`status --label` can filter by them.
    - Attribution with two concurrent VMs was **not tested**, because of the
      one-VM rule for this work. It is an acceptance test in the plan.

### 2.3 Where secret substitution goes

With `--tls-intercept` and `--proxy`, the upstream leg of an intercepted
port 443 flow is dialled through the SOCKS proxy (exp7, exp12: the request
arrived as `192.0.2.1:443`). So the credential proxy's upstream connections
can be audited by the gateway. The gateway can label them `provider-egress`
when they match the sandbox's provider binding. **End-to-end substitution
through the gateway (a fixture TLS upstream that receives the real value)
was not run.** It is an acceptance test in the plan. The gateway sees only
the IP and port. Hostname attribution comes from the per-sandbox DNS answers
(DNS pinning, see the ADR).

## 3. Resource measurement (reference section 3.3)

Commands run against short-lived sandboxes `obs-exp1` and `obs-res1`:

```sh
msb metrics <name> --format json            # one sample (running)
msb metrics <name> --follow --interval 500ms # JSON Lines stream
msb metrics -a --format json                # includes exited sandboxes
msb status <name> --format json
msb inspect <name> --format json
ps -o pid,rss,vsz,time,%cpu,etime -p <msb machine pid>
```

The fields from `msb metrics` were `cpu_percent`, `cpus`, `vcpu_time_ns`,
`memory_bytes`, `memory_available_bytes`, `memory_limit_bytes`,
`memory_host_resident_bytes`, `disk_read_bytes`, `disk_write_bytes`,
`net_rx_bytes`, `net_tx_bytes`, `upper_used_bytes` / `upper_free_bytes` /
`upper_host_allocated_bytes`, `uptime_secs`, `state` and `timestamp`. After
the VM stops and before `msb rm`, `metrics -a` keeps a terminal sample with
`state: "exited"`. Removal deletes it, together with `logs/`.

| Metric            | Source                                                                                                           | Level                         | Trust                                                                                                              | Notes                                                                             |
| ----------------- | ---------------------------------------------------------------------------------------------------------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------- |
| CPU time          | `vcpu_time_ns` (cumulative)                                                                                      | VM (all vCPUs)                | Host                                                                                                               | Usable for short runs: read once before destroy.                                  |
| CPU %             | `cpu_percent`                                                                                                    | VM                            | Host                                                                                                               | An interval value. With 1 s sampling it is meaningless for runs under about 2 s.  |
| Host overhead CPU | `ps` `time` of the `msb machine` PID                                                                             | Host process (VMM + netstack) | Host                                                                                                               | Includes the hypervisor and network engine.                                       |
| Memory            | `memory_bytes` (guest used), `memory_host_resident_bytes` (host RSS of guest RAM), `memory_limit_bytes`          | VM                            | `memory_bytes` is reported by the guest balloon/agent, so treat it as guest-influenced. Host RSS is host-measured. |                                                                                   |
| Peak memory       | **Not available.** The maximum of the samples is a lower bound.                                                  | VM                            |                                                                                                                    | No `memory.peak`. The guest has no cgroup v2 memory file.                         |
| Disk I/O          | `disk_read_bytes`, `disk_write_bytes` (+52 MB after `dd` of 50 MB)                                               | VM block device               | Host                                                                                                               |                                                                                   |
| Network I/O       | `net_rx_bytes`, `net_tx_bytes`                                                                                   | VM NIC                        | Host                                                                                                               | Non-zero even with `--no-net` (ARP/ND). Per connection, the gateway counts bytes. |
| Exit code         | `msb exec` return code (`exit 7` → 7)                                                                            | Process                       | **Guest-reported**                                                                                                 | The guest agent reports it.                                                       |
| Signal            | Unavailable. `kill -9 $$` → 255. `msb wait --format json` says "Exit code and signal are currently unavailable". | Process                       |                                                                                                                    | Record as unavailable, never as 0.                                                |
| OOM               | Unavailable from the host. Guest kernel OOM killed the process. `msb exec` → 255. Only guest `dmesg` shows it.   | Process / guest               | Guest-only evidence                                                                                                | Host-side OOM of the VM process was not tested (unknown).                         |
| Timeout           | The host timer in the adapter (trusted); `msb exec --timeout` → rc 1 and "exec timed out"                        | Process                       | Host                                                                                                               |                                                                                   |
| Lifetime expiry   | `--max-duration` → `status: "Stopped"`, with no reason field                                                     | VM                            | Host                                                                                                               | Infer it from the host-known deadline and label it `inferred`.                    |
| Startup time      | Host clock around `msb create` (about 0.34 s for Alpine, which includes boot)                                    | VM                            | Host                                                                                                               |                                                                                   |
| Process count     | Not exposed                                                                                                      |                               |                                                                                                                    | Omit.                                                                             |

Per-process metrics, other than exit code and duration, are not available from
the host. Everything except duration and exit code is at VM (whole-sandbox)
level.

## 4. Experiment log (commands and observed results)

Common prefix: `MSB_HOME=… MSB_BACKEND=local msb create --name <n> --pull
never --no-net --max-duration 300s -q <image>`. The host listeners were:

- TCP on 127.0.0.1:18080 and ::1:18080, which log the connection and reply
  `ok 18080`;
- TCP on 127.0.0.1:18081;
- UDP on 127.0.0.1:18082;
- SOCKS5 on 127.0.0.1:18083 (no auth) and 18084 (RFC 1929 auth). Both log
  each request and allow only port 18080, relayed to the local listener;
- a "broken" proxy on 18085, which accepts and resets;
- a DNS stub on 127.0.0.1:18053 (UDP and TCP), which logs each qname and
  answers A=192.0.2.1.

| Exp        | Extra flags                                                                         | Key results                                                                                                                                                                                                                                                                                                                                                                                      |
| ---------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| exp1       | `--net-rule allow@host:tcp:18080 --label …` (the current adapter shape)             | Allowed host TCP v4/v6 OK (T1–T3). Host 18081 refused (T2). Public TCP 1.1.1.1:443 refused. DNS NXDOMAIN, denial logged at DEBUG. UDP to the host did not arrive. ICMP denied (DEBUG log). Non-443 TCP to unallowed IPs completes a _local_ handshake and then closes (rc 0, no data, no host socket, verified with `lsof` on the VM process). Root tests R0–R8. Metrics, inspect and OOM tests. |
| exp2       | `allow@dns`, `allow@host:tcp:18080`, `--log-level trace`                            | Arbitrary names and TXT resolve through the host resolvers (DNS tunnel). Other resolvers refused. No TCP or UDP flow lines even at trace.                                                                                                                                                                                                                                                        |
| exp3       | `allow@192.0.2.0/24`, `--proxy socks5://127.0.0.1:18083`                            | TCP goes through the proxy (P1–P3). Proxy deny becomes a guest refusal. TCP outside the rule is refused _before_ the proxy, unlogged (P4). UDP → SOCKS UDP ASSOCIATE (P5). **ICMP to an allowed CIDR is relayed directly by the host**, without the proxy, because a protocol-less rule allows ICMP.                                                                                             |
| exp4       | `allow` 0/0 tcp+udp (v4/v6), `allow@dns`, `--dns-nameserver 127.0.0.1:18053`, proxy | Gateway DNS reaches the stub. **Host-group TCP bypasses the proxy to any host port (G4–G6).** Metadata and IPv6 through the proxy.                                                                                                                                                                                                                                                               |
| exp5       | + `deny@host`                                                                       | Host group refused (H2–H4). **DNS to 8.8.8.8 / 1.1.1.1 answered by the real resolvers, directly from the host (bypass, N-11).**                                                                                                                                                                                                                                                                  |
| exp6       | TCP-only allow, no UDP rule                                                         | UDP DNS to other resolvers refused. **DNS over TCP to 8.8.8.8:53 answered by the real resolver, directly (bypass, N-12).**                                                                                                                                                                                                                                                                       |
| exp7       | + `deny …:tcp:53`, `deny …:tcp:853`, SOCKS auth, `--tls-intercept --secret`         | TCP/53 to other resolvers refused (synthetic NXDOMAIN). Every SOCKS connection carries the per-sandbox username. TLS-intercepted 443 goes through the proxy. The guest env shows only the placeholder.                                                                                                                                                                                           |
| exp8, exp9 | Dead or broken proxy and DNS server                                                 | Fail closed (F1–F4).                                                                                                                                                                                                                                                                                                                                                                             |
| exp10      | Final rule set                                                                      | v4-mapped and NAT64 forms of the gateway, `0.0.0.0`, and other addresses in our /64 refused before the proxy. NAT64 of a public IP goes through the proxy. Multicast mDNS dropped.                                                                                                                                                                                                               |
| exp11      | Debian `browser` image, raw sockets through Perl                                    | Raw protocol sends succeed in the guest but never leave the host (no socket, no log, no gateway contact).                                                                                                                                                                                                                                                                                        |
| exp12      | Debian, `--tls-intercept`, DoT via `openssl s_client`                               | DoT intercepted by Microsandbox, then refused by policy. HTTPS 443 → gateway.                                                                                                                                                                                                                                                                                                                    |

The final, verified rule set is in the ADR. Its order matters (first match
wins).
