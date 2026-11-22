# Milestones and evidence

## M0 repository baseline

Run `bun install --frozen-lockfile --ignore-scripts` followed by `bun verify` in
a clean copy with Bun 1.4.4. The checks cover formatting, Oxlint, TypeScript
typecheck, the emitted build, and credential-free fake-agent contract tests.
The fixtures exercise dynamic delegation, request replay and conflict,
task status, human-question receipts, scoped artifact reads, role workspace
restrictions, and submission for human approval. They run in memory.

The clean-copy check uses the frozen lockfile with lifecycle scripts disabled.
On macOS arm64, the checks passed, including all seven contract tests and an
import of the emitted JavaScript.

Development review used an Implementer, an independent Reviewer, and a
Security Reviewer. Findings led to adding digest-pinned evidence, artifact
read grants, idempotency keys, human-question receipts, and a Coordinator
fixture with the five host tools. The integration request now pins the
candidate and expected base and returns a submission receipt. Both reviewers
rechecked the revision.

Codex CLI 0.170.0 recognizes the project configuration keys in strict startup
config validation and lists the requested models and reasoning levels in its
bundled catalog. Startup validation checks the keys, while model access
depends on the active environment. The development session's subagent tool
did not expose GPT-6 Luna, so GPT-6.1 Sol / Medium handled implementation and
review. GPT-6.2 Astra / High handled security review.

The provisional repository name requires confirmation before remote
creation. Public repository creation and publication require separate human
authorization.

### Tooling selection and licenses

Bun formats and typechecks the source and runs the scripts and dependency-free
tests. TypeScript emits the plain contracts. Oxlint handles lint. The
lockfile pins dependencies. Package manifests identify the upstream projects
and list MIT for Oxlint, its installed macOS arm64 binding, Node types, and
`undici-types`. The TypeScript package is Apache-2.0 and includes its license
and third-party notice. The repository distributes original source under MIT.
The build has no runtime package dependencies and keeps development tools out
of the emitted artifacts. Distribution of third-party packages themselves
would require their applicable license and notice files.

## M1 compatibility spike

Codex CLI 0.170.0 provides `exec --json` and `exec resume` in its local help.
Generating its app-server schema with
`codex app-server generate-json-schema --out .local/m1/codex-schema` exposed
`item/tool/call`, `item/commandExecution/requestApproval`,
`thread/tokenUsage/updated`, `turn/interrupt`, and `thread/resume`.
This establishes the available protocol surface. Real-provider turns and
coverage of SDK-native operations remain unverified.

Microsandbox remains the candidate backend. The M1-specific
[`mise.toml`](../spike/m1/mise.toml) pins version 0.7.16. The installed mise
registry resolves `microsandbox` through
[`aqua:superradcompany/microsandbox`](https://github.com/aquaproj/aqua-registry/blob/main/pkgs/superradcompany/microsandbox/registry.yaml),
which installs the `msb` executable from a release archive with SHA-256
verification. The configuration lives under `spike/m1/` so M0 checks can run
without installing the sandbox.

The installation passed on macOS arm64 with mise 2026.10.24. Both `msb
--version` and the host checks in `msb doctor` passed. The Microsandbox
upstream project is Apache-2.0 and publishes a security policy. The spike
uses its release binaries as external tools. See the [tagged release](https://github.com/superradcompany/microsandbox/releases/tag/v0.7.16)
and [upstream security policy](https://github.com/superradcompany/microsandbox/blob/v0.7.16/SECURITY.md).

### Local sandbox observations

The [smoke test](../spike/m1/sandbox-smoke.sh) ran on macOS arm64 with the
[pinned Alpine 3.23.8 arm64 image](https://github.com/docker-library/repo-info/blob/master/repos/alpine/tag-details.md#alpine3238---linux-arm64-variant-v8),
no provider credentials, and `--pull never --no-net`. It booted a Linux guest,
read a synthetic repository fixture, observed a read-only filesystem error
on an attempted write, wrote to a scratch mount, and did not see an unmounted
synthetic host file. The guest command started and hit a one-second configured
timeout after approximately two seconds of wall time. The sandbox still
responded to ping, then reported terminal `Stopped` before removal.

On macOS the long repository path exceeded the 104-byte Unix socket limit.
A short disposable `MSB_HOME` allowed the same cached image to boot. The CLI
discarded guest stdout on timeout, so the fixture uses scratch markers and
checks the timeout diagnostic and elapsed time. The
[network smoke test](../spike/m1/network-smoke.ts) sets up a
loopback-only HTTP canary and compares two guests against the same IP and TCP
port. It checks the host-side request count as well as the guest result. The
first attempts stopped before guest launch because the host could not start
new processes (`Resource temporarily unavailable`, or `EAGAIN`). A bounded
retry for this spawn error started the CLI, which then failed its protected
runtime-state version probe on a timeout. After stopping the runaway mise
process group, the test passed. The guest with an explicit allow rule
received the canary response, and the second guest delivered no HTTP request
to the same local address and TCP port. This covers the measured endpoint.

With authorization to fetch the image and create the disposable runtime,
reproduce from `spike/m1/`:

```sh
mise --no-config --no-env --no-hooks install microsandbox@0.7.16
mise --no-config --no-env --no-hooks exec microsandbox@0.7.16 -- msb --version
export MSB_HOME="$(mktemp -d /private/tmp/ab-msb.XXXXXX)"
mise --no-config --no-env --no-hooks exec microsandbox@0.7.16 -- msb image pull docker.io/library/alpine@sha256:5dda816445facf5f7282dc7689a333278834c74265ba25db2e2eb90509e3a9dd
mise --no-config --no-env --no-hooks exec microsandbox@0.7.16 -- sh sandbox-smoke.sh
mise --no-config --no-env --no-hooks exec microsandbox@0.7.16 -- bun network-smoke.ts
```

An earlier unscoped mise execution loaded global tool configuration and
attempted to resolve unrelated tools. During the subsequent host process
failure, a single process group contained hundreds of recursive mise
processes with the spike working directory. The group was identified by
executable path and working directory, then stopped. Use the scoped commands
above for the spike.

### Codex guest IPC

The [Codex IPC smoke test](../spike/m1/codex-ipc-smoke.sh) used the official
[0.170.0 Linux arm64 release asset](https://github.com/openai/codex/releases/expanded_assets/rust-v0.170.0).
The downloaded tarball matched upstream SHA-256
`0da6b061f6b5223901a5a73e841bd1466596e2ef620d68823360febed2ff7ebc`.
Extract its sole executable and pass its absolute path to the smoke script,
which verifies the binary digest and copies only that file to the guest.
Keep the image cache described above.

The executable ran inside the Alpine guest with `--no-net`. The script
confirmed the version, Linux platform, successful JSONL initialization, and
the `thread/started` notification from an ephemeral thread configured
`readOnly`, `networkAccess: false`, and approval policy `never`. Direct
execution from a read-only mount was denied in the initial probe. Codex
reported falling back to bundled
bubblewrap and logged a failed startup Responses WebSocket attempt. The run
had no credentials or model turns. No SDK-native command interception was
exercised.

### Codex guest tool round trip

The [tool smoke test](../spike/m1/codex-tool-smoke.ts) ran the same verified
Codex binary in a disposable VM. The guest could reach just the fixture HTTP
server's loopback TCP port. The simulated provider drove two app-server
`item/tool/call` requests. The host allowed the in-memory read and denied the
write. Both outcomes returned to the simulated provider with the matching
call IDs. A second turn interrupted a live simulated provider request. The
test resumed the same thread in the same app-server process and completed
another turn with prior context. A synthetic usage notification was observed.

Use the binary and cached image from the previous checks:

```sh
mise --no-config --no-env --no-hooks exec microsandbox@0.7.16 -- bun codex-tool-smoke.ts /absolute/path/to/codex
```

The exchange uses an experimental app-server API, fixture tool decisions,
and synthetic usage. It verifies tool visibility over JSONL for that path.
Native tool coverage, restart recovery, durable audit, and real-provider
usage attribution still require separate evidence.

### Codex guest subscription turn

On 2026-11-22, the operator completed a live turn using an app-specific
ChatGPT plan OAuth grant. The pinned Microsandbox and Codex versions were
0.7.16 and 0.170.0. The date, configuration, and operator-reported success
line are recorded in the [Gate A evidence](codex-subscription-credential-poc.md#gate-a-and-gate-b-status).
App usage attribution and the broader credential hardening matrix remain
open.

Codex CLI/app-server remains a provider candidate based on the local schema.
Claude Agent SDK remains an
alternative. Check tagged upstream source, maintenance/security guidance and
licenses before adopting either adapter or the sandbox. Defer OpenTelemetry,
OPA, and a scheduler until a demonstrated need. M0 adds no runtime OSS
dependency.

Complete the spike with an approved isolated runtime, a disposable synthetic
repository, and separately approved provider connectivity:

1. Record the runtime version and demonstrate that a guest can start, report
   an ID, and stop. Verify stop after timeout as well as normal completion.
2. Verify permitted fixture reads and writes, read-only repository mounts,
   denial of host and other-workspace canaries, and denial of unapproved
   network destinations. Use synthetic secrets to check for leakage.
3. Run one short provider invocation inside the guest. Exercise an allowed
   and a denied host tool request. Compare structured tool requests and
   outcomes with process output and list gaps for SDK-native operations.
4. Exercise stop/cancel, timeout and continuation. Record available model,
   wall time, and reported usage. Select an adapter only if the evidence
   supports isolation and host interception.

Running an external provider invocation requires separate authorization.
Proceed to M2 after verifying the M1 acceptance checks.

## M2 trusted Worker and durable audit

The implementation uses three steps. Persist an allowlisted event schema in
host-owned SQLite, route one synthetic Worker through the offline runtime,
then verify the trace after success, denial, timeout, write failure, and
process death. Request receipts use task-scoped keys so repeated delegation
or integration submissions can return their original identities after reopen.

Run the isolated Worker smoke with the cached image and pinned Microsandbox
from M1. The command prints the SQLite filename and three invocation IDs.

```sh
MSB_HOME=/absolute/short/msb-home \
  bun spike/m2/host-smoke.ts /absolute/path/to/msb
bun src/trace.ts /absolute/path/to/audit.sqlite <invocation-id>
```

Use the printed UUID in place of the last argument. Keep SQLite and its
sidecar files in a trusted host directory that the guest cannot write.
The Worker can request collection of host-selected output paths. The
host records requests, authorizations, denials, and outcomes before proceeding
to the next action. Each adapter authorization includes its automatic cleanup
on failure. Explicit teardown has a separate authorization.

The trace command opens SQLite read-only. A trace without a recorded terminal
event is incomplete. An authorized operation without a finish event might
have run, so its effect is marked unknown and restart does not replay it.
To locate a surviving VM on the same
trusted backend, filter `msb list` by
`--label agent-bootstrap-invocation=<invocation-id>`. A VM has a bounded
lifetime. Automatic reconciliation of staging files and surviving VMs is
outside this slice.

The receipt registry accepts canonical request fingerprints from trusted
Coordinator ingress and detects changed payloads under an existing key. A
receipt does not enqueue work or grant integration permission. Coordinator
sandbox routing, review and approval workflows, a durable artifact store,
and native provider tool audit remain later work. This Worker smoke traces
fixed operation categories and host identifiers. Command digests and
collected artifact identities are not retained in the trace yet, and receipt
conflicts return a fixed error without a separate audit event.

On 2026-11-22 the pinned backend produced traces of 14 events for a completed
Worker, 13 for a denied guest request, and 11 for a timeout. The trace command
reopened all three and found the denial event in the expected trace. Backend
lookup by each invocation label found no remaining sandbox. Local tests also
verified write rejection before sandbox creation, interruption between
authorization and a finish record, and request receipt replay after reopen.

## M3 reviewed integration

The local smoke creates a private, disposable bare SHA-1 repository with one
file. Worker edits a copy inside a network-disabled VM. The host imports
the allowlisted regular file using a detached worktree, creates a
single-parent candidate, and pins its commit under an internal ref. Reviewer
receives the pinned diff and candidate file on a read-only mount in a
separate VM. Only a structured pass can be submitted for approval.

```sh
MSB_HOME=/absolute/short/msb-home \
  bun spike/m3/integration-smoke.ts prepare /absolute/path/to/msb
MSB_HOME=/absolute/short/msb-home \
  bun spike/m3/integration-smoke.ts review /absolute/path/to/msb <run-id>
bun spike/m3/integration-smoke.ts trace <run-id>
```

The review command shows the exact diff, base, candidate and diff digest.
It accepts a typed decision from a local terminal. The approval binds the
canonical repository and local ref, base, candidate, diff digest, and
verification command. The host rechecks the diff, runs verification in a
separate VM, commits an authorization event, and updates only the disposable
local ref using the expected old OID. A ref race or a failed mandatory audit
write prevents the update. A lost acknowledgement after the update is
reported as uncertain and requires trace inspection before any further
operation.

The append-only workflow journal records the pin, decisions and outcomes
under the run ID. Trace inspection includes related Worker, Reviewer and
verification records from SQLite. Repository and journal directories depend
on trusted host ownership. The supported write surface is one existing
top-level regular file; remote Git, general patches and provider-driven
review are outside this smoke.

On 2026-11-22, the network-disabled Worker and Reviewer finished. The
operator approved run `80dc7e9f-a69b-462c-9088-f4c0c204da4a`, and a
separate VM verified the pinned change. The journal recorded
`human.decided`, `verification.finished` with `pass`,
`integration.authorized`, and `integration.completed`. A separate Git read
confirmed that the disposable repository's `refs/heads/main` advanced from
`d43e244648f8a3c3c934dcd19421c4cf01721293` to
`505bf36e08807be767cac90d46cf0a87a7f0cee9`.

Automated tests cover successful integration, competing requests, stale
base, missing or rejected approval, wrong target, failed verification, and
failure to write authorization.

## M4 Coordinator and human interaction

The offline smoke accepts a natural-language task in a terminal. A
deterministic Coordinator fixture makes each delegation decision inside a
separate VM from task text and status. It receives one read-only control
file and no repository snapshot. Planner and Reviewer receive only their
read-only inputs. Worker and integration reuse the M3 candidate, review and
approval path. The guest cannot answer its own question or approve the
candidate.

```sh
export MSB_HOME=/absolute/short/msb-home
msb=/absolute/path/to/pinned/msb
bun spike/m4/coordinator-smoke.ts submit "$msb"
bun spike/m4/coordinator-smoke.ts status "$msb" <task-id>
bun spike/m4/coordinator-smoke.ts answer "$msb" <task-id> <question-id>
bun spike/m4/coordinator-smoke.ts approve "$msb" <task-id> <approval-id>
bun spike/m4/coordinator-smoke.ts trace "$msb" <task-id>
```

For the Planner and answer path, enter “Plan first, then change the greeting
in hello.txt. Please ask me which greeting to use.” For the direct Worker
path, enter “Change the greeting in hello.txt.” The answer prompt accepts
`friendly` or `formal`. Review the displayed diff and type the full
approval command to integrate into the disposable repository.

The task and response text live in private input files. The journal records
their digests, tool decisions, invocation IDs, and request identities. An
authorized attempt without a finish record reopens as uncertain and is
never replayed automatically. The recorded VM ID can be correlated with
the SQLite trace and backend label. A finished denial or uncertain update
keeps that status after reopening. Matching completed tool keys replay
without side effects, and conflicting keys are denied.

This smoke exercises keyword-driven choices and a single candidate per task.
It leaves general model-driven coordination, multi-candidate replanning, and
automatic recovery of uncertain effects outside its acceptance evidence.

On 2026-11-22, the Planner path ran separate Coordinator and Planner VMs
before opening question `05cf4456-74a8-47c3-9c63-bc77750df09c` for task
`2e2d9f01-cea3-409f-ad4e-cd951abd7463`. A fresh host process returned the
same pending question and Planner invocation without opening another turn.
The direct path reached approval after Worker and Reviewer with no Planner
event. The operator's answer resumed the Planner path using the same
question ID. Worker and Reviewer finished and the journal recorded a pass
for candidate `de6115573f8b9cd909f74dfeaaa1f3444320426a`. Approval
`9638bcac-06ba-46b0-afa7-3fb082034cfe` was recorded. The independent VM
verification passed and the journal recorded `integration.completed` and
`approval.finished`. A Git read confirmed that the disposable
repository's `refs/heads/main` points to the approved candidate.

### Model-driven Coordinator turn with a mock provider

[`src/model-coordinator.ts`](../src/model-coordinator.ts) defines a
provider-neutral `CoordinatorModel` port and `modelStep`, which plugs into
`CoordinatorDriver.step`. Each turn registers the five Coordinator host
tools plus `finish`, then takes the model's first proposed call. That call
is encoded unchanged as the router's action bytes. The adapter makes no
authorization decision, so unknown tools, extra fields, forged roles and
non-object arguments stay malformed and the existing router denies them.

[`src/codex-app-server.ts`](../src/codex-app-server.ts) is the first adapter.
It registers the tools as app-server dynamic tools on a read-only,
`approvalPolicy: "never"`, ephemeral thread. It captures the first
`item/tool/call`, answers it with a fixed "submitted" result, and interrupts
the turn. It voids the turn when any of the following happens:

- the model makes another dynamic call;
- the app-server sends any other server request;
- a thread item other than a user or agent message, reasoning, a dynamic
  tool call or a context compaction starts.

Line size, total bytes and server requests are bounded. A timeout covers
connecting and the whole turn. Diagnostics are fixed codes.

Native tools are the main residual risk. Under `approvalPolicy: "never"`,
Codex runs its own tools without any approval request, so the adapter
cannot decline them in advance. On 2026-11-22, the mock provider recorded
the tools that Codex 0.170.0 offered upstream with the default model:

- Without hardening, the model saw 29 tools, including `exec_command`,
  `write_stdin`, `apply_patch`, MCP resources and `spawn_agent`.
- `CODEX_COORDINATOR_CONFIG` removed the shell, stdin and goal tools.
- Code mode `exec` with nested `apply_patch`, MCP resource and `view_image`
  tools remained, along with `request_user_input`, `clock.sleep` and the
  `collaboration` tools. The model catalog enables these, and config keys
  do not remove them. An uncataloged model name left only
  `request_user_input` and `view_image`.
- The guest has no code-mode host, and Codex reported that code mode fails
  closed.

The adapter therefore treats starting a native item as a policy violation,
but this is detection, not prevention: the item may already be running.
Before real-provider use, the Coordinator needs a model configuration
that offers no native tools, and this needs to be verified upstream.

The credential-free tests in `test/model-coordinator.test.ts` use an
in-memory app-server with a scripted mock provider. They send the router's
decisions through `TrustedHost` and SQLite audit. The tests cover:

- an authorized Worker delegation with a complete Worker audit trace;
- an out-of-policy `requestIntegration` with no host audit event;
- forged and injected calls, and only the first of two calls being used;
- a declined native approval request and a turn with no tool call;
- native command, file, MCP, collaboration, web, image and sleep items
  that start without an approval request;
- malformed, non-object, duplicate and truncated output;
- bounded line reading;
- connection failure and a connection that outlives the deadline;
- a timeout that reopens as uncertain and is not retried.

The smoke runs the verified Codex 0.170.0 app-server in a disposable VM per
turn. It uses a loopback mock Responses provider and no credential:

```sh
MSB_HOME=/absolute/short/msb-home \
  mise --no-config --no-env --no-hooks exec microsandbox@0.7.16 -- \
  bun spike/m4/model-coordinator-smoke.ts /absolute/path/to/codex
```

On 2026-11-22, the smoke ran two tasks in about 9 seconds.

- **First task.** The provider made a `delegate` call. The router
  authorized it, and the Worker VM's SQLite trace ended with
  `invocation.finished ok`. In the second turn, the provider saw the Worker
  outcome in the prompt and made a `requestIntegration` call without a
  review. The router recorded `tool.denied`.
- **Second task.** The provider called the native `clock.sleep` tool. The
  adapter voided the turn when the `sleep` item started, and the router
  recorded `turn.denied`.

The interrupts reached Codex before it returned any tool output to the
provider. The smoke asserts that no shell tool is offered. No sandbox
remained after the run.

### Coordinator trace

On 2026-11-22, the trace work closed the gaps that the first model turn
left in the evidence. Each Coordinator turn now runs through
`TrustedHost.runCoordinatorSession`, which audits the session like any other
role. The `SandboxRuntime` port gains an optional streamed session, and the
Microsandbox adapter implements it with `msb exec --stream`. A session has
bounded lines, a bounded byte total and a deadline, and it holds the handle
busy until the command stops. Sandbox specs can now name host tools and one
host TCP port:

- **Tools.** Each tool is a host file copied to `/tmp/<name>`. The adapter
  checks its SHA-256 on the host before creating the sandbox, and the guest
  command checks it again.
- **Host port.** This is the only egress. It is applied as
  `--no-net --net-rule allow@host:tcp:<port>`.

A Coordinator session accepts only those fields and a lifetime, and it
receives no files.

The router journal adds three events:

| Event           | Records                                                                                                                                            |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `turn.proposed` | The SHA-256 of the model's raw proposal. Proposals up to 16 KiB are also kept as a private file.                                                   |
| `turn.voided`   | A fixed-shape reason when the adapter voided the turn: `no-call`, `extra-call`, `foreign-call`, `server-request/<method>` or `native-item/<type>`. |
| `turn.failed`   | A fixed failure code when a turn throws, such as `timed-out`, `connect`, `limit` or `host-audit`.                                                  |

The task then reopens as uncertain and is not retried. Because a turn now
has one more event, a task reaches its event limit after 31 status turns
instead of 41.

`src/task-trace.ts` joins one task's journal with the host audit. Turn run
IDs are the Coordinator invocation IDs, and delegation attempt IDs are the
delegated role invocation IDs. From the command line:

```sh
bun src/trace.ts task /path/to/audit.sqlite /path/to/task-journal-root <task-id>
```

The output lists the journal, each stored proposal as untrusted text, and
the audit of every Coordinator turn and delegated role.

The smoke now uses this product path and no direct `msb` calls. On
2026-11-22, it finished in about 10 seconds. The trace for the first task
showed two Coordinator invocations and one Worker invocation. Each one had
`sandbox.create`, `sandbox.exec` and `sandbox.destroy` finished `ok`. The two
stored proposals were the `delegate` and `requestIntegration` actions. The
second task recorded `turn.voided native-item/sleep` and one audited
Coordinator invocation. No sandbox remained.

Known gaps:

- **Native tools are detected, not prevented.** A native item may already
  be running when the turn is voided. The Coordinator VM, its audit and the
  voiding reason now make this traceable, but nothing records what the item
  did inside the guest.
- **Usage is not collected.** Usage notifications are ignored. M5 will
  collect them.
- **Reviewed-integration records are not joined.** The task trace does not
  join the reviewed-integration journal used by the M4 smoke.

## Later acceptance checks

| Milestone                            | Executable acceptance scenario                                                                                                                                                        |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M2 audit and host                    | Run an isolated invocation. Force a denied tool, timed-out invocation, audit-write failure, and restart. Read the trace and verify attempts, decisions, effects, and replay behavior. |
| M3 reviewed integration              | Use a disposable repository. Produce a commit and pinned review, demonstrate rejection or stale-base denial, then approve and integrate a valid candidate with trace evidence.        |
| M4 Coordinator and human interaction | Submit a natural-language task. Observe Coordinator choose its delegation path, pause for an answer or approval, and resume with the same request IDs.                                |
| M5 dogfood                           | Complete one small local change. Collect timing, available usage, retries, review iterations, human interventions, and known audit gaps.                                              |
