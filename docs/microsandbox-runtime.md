# Microsandbox runtime

## M1 implementation plan

The bootstrap currently has provider-neutral agent contracts, credential-free
unit tests, and local Microsandbox and Codex spikes. Bun 1.4.5 is the package
manager and runner. The spike verified macOS arm64 with Microsandbox 0.7.16,
Linux arm64 Codex 0.170.0, and a loopback-only simulated Responses provider.

1. Verify the pinned runtime flags, Codex authentication and transport, and
   the supported ChatGPT plan usage path. Compare the released OpenSandbox
   credential implementation as a reference. Record the evidence in the
   [credential PoC](codex-subscription-credential-poc.md).
2. Add a provider-neutral sandbox contract and a small host-only Microsandbox
   adapter. Keep the first runtime offline and use disposable guest-local
   workspace copies. Test clean exit, failed setup, timeout, cancellation,
   cleanup, bounded collection, and concurrent isolation.
3. Exercise supported secret substitution separately with synthetic data and
   a local TLS fixture. Use the evidence to decide which credential features
   can safely integrate. Real subscription use requires a separate opt-in
   and a supported, provisioned credential.

The runtime and credential integration belong to separate modules. This
slice leaves agent orchestration, Git integration, and durable audit to later
milestones.

## Host boundary and public contract

[`SandboxRuntime`](../src/sandbox-runtime.ts) exposes create, exec, collect,
and destroy. A trusted caller supplies validated workspace files as relative
paths and byte arrays. Handles are in-process objects bound to the adapter
instance that issued them. Guest commands and artifact bytes are untrusted.

[`MicrosandboxRuntime`](../src/microsandbox.ts) accepts an absolute trusted
CLI path, a dedicated `MSB_HOME`, a private staging root, and a cached
digest-pinned image. It verifies the CLI version and launches a local
Microsandbox with `--pull never --no-net`. It supplies a minimal subprocess
environment and stages a per-VM guest-local copy at `/workspace`. The offline
M1 path uses no host directory mounts, devices, credential sources,
published ports or network exceptions. The host owns Git state and
integration. The staging directory and `MSB_HOME` are trusted inputs and
must remain inaccessible to guests and unauthorized local processes.

Import and collection are limited to 64 files, 256 KiB per file, and 1 MiB
total each. Exec accepts an argument vector and a bounded timeout. A
separate VM lifespan bounds work if the caller exits. An active operation
is exclusive to its handle. Different handles can run concurrently. To
interrupt an active command, abort its signal and await its cleanup.
Nonzero exit, timeout, cancellation, and failed collection trigger forced
VM removal. Partial setup attempts cleanup too. A failed removal blocks
future commands, permits retry on an issued handle, and reports a sandbox
ID for trusted host reconciliation when needed. Cleanup is a bounded
attempt. Recover any reported removal failure before reusing the runtime.

Collection uses bounded stdout from a guest-local file read and returns
bytes for the requested paths. There is no host archive extraction. Static
guest symlink components are rejected. A malicious process can race guest
path checks or fabricate output. Treat returned bytes as guest-controlled
evidence. CLI stdout and stderr can contain guest data or runtime
diagnostics. The adapter returns them to the trusted caller, and errors
contain fixed outcome codes. Keep raw streams out of audit logs.

## Audit-required networking

`createObservedHost` composes the runtime with writable SQLite v5 in
required mode. It opens a per-sandbox host gateway for invocations with a
provider binding or mapped host service. Microsandbox 0.7.16 applies the
pinned rule set for that gateway.
Policy-admitted non-DNS TCP reaches the gateway through authenticated SOCKS5.
The guest's configured DNS resolver reaches the gateway's UDP and TCP DNS
listeners. The gateway commits its decisions before upstream connects or
DNS policy replies. A host fixture service uses a gateway mapping in required
mode. Direct `hostTcpPort` requires disabled mode and per-run opt-in.

The Microsandbox netstack and `--proxy` are trusted for enforcement. The
host group, foreign resolvers, DoT, UDP outside gateway DNS, ICMP and raw IP
are blocked before the gateway and have no individual audit record. The
host samples resources with `msb metrics`, including an attempt at a final
sample before removal. Missing samples mean unavailable. See the
[v0.1 guarantees](observability/guarantees.md) and
[OBS-10 evidence](observability/phase1-evidence.md).

## Smoke test

Install the pinned Microsandbox CLI via the scoped mise command in
[milestone evidence](milestones.md). Use the cached Alpine arm64 image and
a short dedicated `MSB_HOME` described there. From the repository root:

```sh
bun spike/m1/runtime-smoke.ts /absolute/path/to/msb
bun spike/m1/runtime-smoke.ts /absolute/path/to/msb --extended
```

On macOS arm64 the real test completed create, exec, collect, and destroy.
It checked that the guest could read and edit its copied workspace and
could not see an unmounted host canary. The extended smoke also passed with
two concurrent live VMs. Each saw its own workspace and separate guest-local
authentication fixture state. Timeout and active cancellation each removed
the corresponding VM, confirmed through the backend listing. Fake-CLI tests
cover partial setup and cleanup failure without starting VMs. See the
[credential PoC](codex-subscription-credential-poc.md) for the separate,
explicitly network-scoped synthetic HTTPS test.
