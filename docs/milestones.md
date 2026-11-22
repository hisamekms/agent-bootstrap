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
busy until the command stops. After a kill, the session is treated as
stopped within 5 seconds even if the backend never reports `close`, and
destroy then proceeds. Sandbox specs can now name host tools and one
host TCP port:

- **Tools.** Each tool is a regular host file, not a symbolic link, copied
  to `/tmp/<name>`. The adapter copies it into private staging, checks the
  SHA-256 of that copy, and hands only the verified copy to the backend.
  The guest command checks it again.
- **Host port.** This is the only egress. It is applied as
  `--no-net --net-rule allow@host:tcp:<port>`.

A Coordinator session accepts only those fields and a lifetime, and it
receives no files. As with the other roles, a failed mandatory audit write
after create stops the host before any further effect, including destroy.
The sandbox's backend lifetime then bounds it.

The router journal adds three events:

| Event           | Records                                                                                                                                                                                                                                         |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `turn.proposed` | The SHA-256 of the router action encoded from the model's call. Actions up to 16 KiB are also kept as a private file.                                                                                                                           |
| `turn.voided`   | A fixed reason when the adapter voided the turn: `no-call`, `extra-call`, `foreign-call`, `server-request/<method>` or `native-item/<type>`. Only method and item names from the Codex 0.170.0 schema are kept; any other name becomes `other`. |
| `turn.failed`   | A fixed failure code when a turn throws, such as `timed-out`, `connect`, `limit` or `host-audit`.                                                                                                                                               |

A voided turn leaves the task denied. A failed turn reopens as uncertain
and is not retried. When a timed-out turn also loses a host audit write,
the journal records `host-audit`. A timed-out turn waits at most 30 seconds
for host teardown before reporting. If teardown takes longer, the host
finishes it and its audit after the router has recorded `turn.failed`. Because a turn now has one more event,
a task reaches its event limit after 31 status turns instead of 41.

`src/task-trace.ts` joins one task's journal with the host audit. Turn run
IDs are the Coordinator invocation IDs, and delegation attempt IDs are the
delegated role invocation IDs. From the command line:

```sh
bun src/trace.ts task /path/to/audit.sqlite /path/to/task-journal-root <task-id>
```

The output lists the journal, each stored action as untrusted text with
C1 and bidirectional control characters escaped, and the audit of every
Coordinator turn and delegated role. An unreadable stored action appears
as `null` and does not hide the rest of the trace.

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
- **Session timeouts are labelled differently.** An adapter timeout is
  `timed-out` in both records. When the session's own timer stops the
  command first, the host audit records `timed-out`, but the router records
  the adapter's `closed`.
- **Usage is not collected.** Usage notifications are ignored. M5 will
  collect them.
- **Reviewed-integration records are not joined.** The task trace does not
  join the reviewed-integration journal used by the M4 smoke.

### Revision candidates

On 2026-11-22, the reviewed integration gained revisions within one task.
A Reviewer may answer `{"review":"revise","notes":"..."}`. The notes are
untrusted text of up to 2 KiB. They are stored as a private,
content-addressed file, and the journal records only their SHA-256 in
`review.noted`. Malformed or oversized notes make the review a `concern`
without notes.

`ReviewedIntegration.revise` is allowed only when the latest event is the
current candidate's review, and that review is `revise` or `concern`. It
works like this:

1. It records `revision.requested` with the round, the current diff digest
   and the notes digest. This write is the sequence CAS that comes before
   any Worker VM.
2. A new Worker VM receives the current candidate's file and the notes as
   read-only `/review/review-notes.txt`.
3. The new candidate is a single-parent commit on the original base. It has
   its own commit, diff and digest, and needs its own review.

One integration journal, which the M4 smoke keeps per task, allows at most
`MAX_REVISIONS` (3) revisions. Verification keeps its strict format:
exactly `{"review": ...}` in at most 128 bytes, and notes are not accepted.

Review, decision and integration always use the most recent candidate, and
a review counts only if it comes after that candidate. A decision about an
earlier candidate therefore never qualifies, and no approval is reused for a
revision. `reviewedPin()` returns the current candidate only when its latest
review passed. The integration journal limit is now 31 events.

The Coordinator router follows the same order:

- **Worker** can run again only after the latest Reviewer invocation failed
  (`revise` or `concern`). The task allows up to 1 + `MAX_REVISIONS` Worker
  runs, and failed runs count toward that limit.
- **Reviewer** runs only when a Worker candidate is newer than the last
  review.
- **`requestIntegration`** needs a passing review that is newer than the
  latest Worker.

By the `CoordinatorDriver` contract, a Reviewer outcome of `ok` means the
review passed, and `failed` means it asked for changes, raised a concern or
did not finish.

The credential-free tests in `test/revision.test.ts` use a real disposable
Git repository. They cover these cases:

- the revised candidate with read-only notes;
- rejection of every decision about the earlier candidate;
- integration of the revised candidate after its own approval;
- a concern revised without notes;
- the revision cap;
- malformed notes.

`test/coordinator.test.ts` covers the router order and its denials.

The offline revision smoke runs Worker, Reviewer, a revising Worker and a
second Reviewer in separate VMs, and stops before the human decision:

```sh
MSB_HOME=/absolute/short/msb-home \
  mise --no-config --no-env --no-hooks exec microsandbox@0.7.16 -- \
  bun spike/m4/revision-smoke.ts
```

On 2026-11-22, the smoke finished in about 4 seconds.

- **First review.** The first candidate was reviewed as `revise` with notes.
- **Revising Worker.** It saw the previous candidate and the notes, and its
  write to the notes was refused.
- **Second candidate.** It had the same base and a new commit and digest,
  and it passed review.
- **Approval.** An approval of the first candidate was rejected.

All four invocations finished `ok` in the SQLite audit, and no sandbox
remained. The M4 Coordinator smoke driver now calls `revise()` for a later
Worker delegation and `reviewedPin()` for integration.

Known gaps:

- **Human rejection does not lead to a revision.** A human rejection still
  ends the task.
- **The task trace does not include the integration journal.** The
  candidate, review and revision events have to be read separately.
- **Revision rounds have only fixture evidence.** A real model has not yet
  run a review and revision round.
- **Notes are not sanitized for display.** They may contain terminal escape
  or bidirectional characters, so they must be escaped before a human sees
  them.
- **Note files are kept forever.** There is no retention rule yet.

## M5 dogfood

### Preparation

[`spike/m5/dogfood.ts`](../spike/m5/dogfood.ts) runs one small local change
with model-driven roles, all using one model (see the model selection
notes below):

- **Coordinator** runs on the Codex app-server.
- **Planner, Worker and Reviewer** run `codex exec` in their own VMs.
- **Verification** is a fixed shell check.

The task works on a disposable repository. It asks for the greeting in
`hello.txt` to become a polite, formal English greeting on one line. The
pieces are wired as follows:

- **Worker.** It may run shell commands inside its VM
  (`--dangerously-bypass-approvals-and-sandbox`, because the VM is the
  sandbox), and must only edit `/workspace/hello.txt`.
- **Reviewer.** It runs read-only with an output schema that requires
  `review` and `notes`. Blank notes mean none.
- **Human input.** Questions and approval go through `/dev/tty`. Approval
  shows the pinned diff and requires typing the full candidate ID.
- **Report.** At the end the run writes `report.json` with:
  - elapsed time and Coordinator turns;
  - delegations per role;
  - replayed requests, failed turns and voided turns;
  - reviews and revisions;
  - human answers and decisions;
  - Coordinator token usage from `thread/tokenUsage/updated`;
  - the integration journal, per-invocation durations, the result and
    known audit gaps.

The run uses `gpt-5.5` because it is the only model in the Codex 0.170.0
catalog without `tool_mode: code_mode_only`. Code mode needs a
`codex-code-mode-host` that the guest does not have, so it fails closed. A
code-mode Worker therefore could not edit files. With `gpt-5.5` and
`CODEX_COORDINATOR_CONFIG`, the mock provider recorded these tools:

- **Coordinator** saw only `request_user_input`, `apply_patch` and
  `view_image` besides its own tools, with no code mode, collaboration or
  shell tools.
- **Worker** saw `exec_command`, `write_stdin`, `request_user_input`,
  `apply_patch`, `view_image`, the goal tools and `tool_search`.

A live provider may serve a different catalog, so the live run records
what it actually saw.

The product gains these pieces for it:

- **Provider egress.** `SandboxSpec.provider` sets the host and the guest
  placeholder variable. The Microsandbox adapter applies:
  - `allow@dns` and `allow@<host>:tcp:443`;
  - `--tls-intercept`;
  - `--secret <ENV>:headers=authorization@<host>`;
  - `--secret-violation-action block`.

  The adapter's `CredentialProvider` passes the token only in the
  environment of the `msb create` process and the VM supervisor that it
  starts. It is never in argv, in other backend commands or in the guest. A canary run on 2026-11-22 showed where
  it lives on the host. The long-lived `msb machine` supervisor of that VM
  inherits it in its environment for the VM's lifetime, and it disappears
  after destroy. No file under `MSB_HOME` contained the canary, and the
  guest variable held only the placeholder.

- **Allowed hosts and variable names.** The adapter accepts only hosts in
  its configured `providerHosts` allowlist. The guest variable name must
  match `AGENT_BOOTSTRAP_*`.
- **Audit of the grant.** Before creating any sandbox that receives
  provider egress, the trusted host records `provider.egress` as requested
  and allowed. It closes the grant as `ok` exactly when no sandbox holds it
  any more, meaning none was created or the sandbox was destroyed. This uses
  audit schema version 3. Version 1 and 2 databases still open, but they
  refuse this event, so the grant fails closed.
- **Failure handling in the runner.** Only an ineligible Worker change
  counts as a failed delegation; audit, journal and unexpected errors stop
  the run. The runner exits non-zero unless the task finishes `done`.
- **Per-role sandbox options.** `ReviewedIntegration` passes tools and
  egress to Worker and Reviewer VMs, but not to verification. Model-driven
  roles get a 300-second VM lifetime and a 240-second command limit.
- **Adapter options.** The Codex adapter accepts a model and reports token
  usage.
- **Replay limit.** The router now allows one replay per request key and
  denies a repeat. A fixture run showed why: a model that kept resending
  the same delegation key had used about 40 turns before the event limit
  stopped it.

On 2026-11-22, `--fixture` mode ran the whole flow with a loopback mock
provider, real Codex and real VMs in about 18 seconds:

- **Coordinator:** three turns: delegate Worker, delegate Reviewer, then
  request integration.
- **Worker:** `codex exec` changed the file through `exec_command`.
- **Reviewer:** `codex exec` returned `pass` through the output schema.
- **Approval:** one automatic approval in fixture mode.
- **Integration:** verification passed and integration completed. The
  repository head contains the changed file.

All six VM invocations finished `ok` in the audit. In the report,
verification appears with the Reviewer role because it uses the same host
entry point.

```sh
MSB_HOME=/absolute/short/msb-home \
  bun spike/m5/dogfood.ts --fixture /absolute/path/to/msb /absolute/path/to/codex
```

The live run needs explicit operator opt-in and the browser consent flow.
Run it from a terminal; the launcher passes the single-run token on stdin:

```sh
MSB_HOME=/absolute/short/msb-home \
  bun spike/m1/subscription-authorize.ts --authorize-and-run-m5 \
  /absolute/path/to/msb /absolute/path/to/codex
```

### Model selection after the first live attempts

On 2026-11-22, the first live attempt stopped after one Coordinator turn of
about 5 seconds, with no usage. The adapter then recorded only `no-call`
because it did not look at the turn status. It now records a failed turn
as `turn-failed/<category>`, using fixed Codex error names and HTTP
statuses only. The runner also exits after writing its report; before
this fix an open `/dev/tty` read kept it alive.

The second attempt recorded `turn-failed/modelNotFound`: the ChatGPT plan
route does not serve `gpt-5.5`. The run therefore uses `gpt-6.2-sol`,
which completed the M1 subscription turn. Its catalog entry is
`code_mode_only`, so the runner works around code mode as follows:

1. It extracts the catalog embedded in the pinned Codex binary.
2. It sets `tool_mode` to `null` for that one model.
3. It passes the result as a digest-checked tool, `/tmp/models.json`, with
   `model_catalog_json`.

With this override, the mock provider recorded the following:

- **Coordinator** saw its own tools directly, plus `request_user_input`,
  `apply_patch`, `view_image`, the `clock` tools and the `collaboration`
  tools.
- **Worker** saw `exec_command`, `write_stdin` and `apply_patch`, among
  others.

The fixture run completed `done`. Whether the provider accepts this tool
layout for `gpt-6.2-sol` is what the next live run shows.

The third attempt failed after 40 seconds with an unclassified error. The
adapter now records every `CodexErrorInfo` name from the 0.170.0 schema, as
well as `none` and `unknown`.

The fourth attempt, on 2026-11-22, was the first in which real models did
the work. It took 58 seconds.

1. **Worker.** The Coordinator delegated to Worker, which changed the line
   to `Good day, and welcome.` (13 seconds).
2. **Reviewer.** It answered `revise` (10 seconds). Its notes said that
   Codex's own sandbox could not start because bubblewrap is unavailable,
   so it could not read the files.
3. **Coordinator.** It then called `getInvocation`, replayed it once, and
   was denied by the replay limit. Its prompt had not explained that a
   failed Reviewer means a revision is needed, nor that queries return
   nothing new.
4. **Usage.** Only one of five Coordinator turns reported usage before its
   interrupt: 8,979 input and 52 output tokens.

The fixes are as follows:

- **Planner and Reviewer prompts.** The guest shell inlines bounded file
  contents into these prompts, between data markers.
- **No Codex sandbox (later reverted).** In the live run below, Planner and
  Reviewer ran without Codex's own sandbox, as Worker does. The later
  review changes put them back in Codex's read-only sandbox (see below).
- **Coordinator instructions.** They now explain invocation outcomes, the
  revision step and that queries add nothing.

Known risks and gaps before the live run:

- **The token is a bearer credential that the guest can use.** Every
  model-driven VM can reach `api.openai.com:443`, and the backend
  substitutes the token into any request to that host. A Worker shell
  command or a prompt-injected model could therefore make other API
  requests with the run's credential. Method, path and request count are
  not enforced, and provider requests are not audited one by one.
- **The token is not refreshed.** It must stay valid for at least 20
  minutes when the run starts. After the run, the launcher revokes the
  refresh token, but the access token stays valid until it expires.
- **Same-user processes can read the token.** While a credentialed VM is
  alive, its `msb machine` process holds the token in its environment, so
  a process running as the same user can read it with `ps eww`.
- **Guest egress has further side channels.** `allow@dns` lets the guest
  send whatever data it can see out through DNS queries. Within the
  account, the guest can also create lasting objects, such as files or
  stored responses, and use up plan quota, with no request cap. An allowed
  upstream could also reflect the substituted header back to the guest.
- **Some usage is not collected.** Planner, Worker and Reviewer token usage
  are missing; only the Coordinator reports usage.
- **Native tools are detected, not prevented.** Native tools in the
  Coordinator are still only detected, and Worker tool calls inside its VM
  are not audited individually.

### Live run result

On 2026-11-22, the sixth live attempt completed M5. It used task
`245ae0b7-eb77-4965-9575-71b8186a67f8`, model `gpt-6.2-sol` with the
derived catalog, and a ChatGPT plan OAuth token from the browser consent
flow.

| Measure             | Result                                                                                        |
| ------------------- | --------------------------------------------------------------------------------------------- |
| Outcome             | `done`. The disposable repository's `main` holds `Good day. It is a pleasure to meet you.`    |
| Elapsed time        | 84.5 seconds, including about 40 seconds waiting for the operator's approval                  |
| Coordinator turns   | 3: delegate Worker, delegate Reviewer, request integration                                    |
| Delegations         | Planner 0, Worker 1, Reviewer 1                                                               |
| Retries             | No replayed requests, failed turns or voided turns                                            |
| Review iterations   | One review (`pass`, with notes) and no revisions                                              |
| Human interventions | One approval; no questions                                                                    |
| Coordinator usage   | Only one of three turns reported usage before its interrupt: 9,090 input and 71 output tokens |
| Invocation times    | Coordinator 6.5–7.2 s per turn, Worker 15.9 s, Reviewer 6.2 s, verification 0.5 s             |

The task trace links all six invocations:

- **Model-driven roles.** Each Coordinator, Worker and Reviewer invocation
  shows `sandbox.create`, `sandbox.exec` and `sandbox.destroy` finished
  `ok`, plus a `provider.egress` grant closed `ok`. The Worker also shows
  `sandbox.collect`.
- **Verification.** It received no grant.
- **Proposals.** The three stored proposals are the encoded `delegate`,
  `delegate` and `requestIntegration` actions.

The earlier attempts and their fixes are described above. The fifth
attempt reached approval, but the operator's input did not match exactly
and was recorded as a rejection. The approval prompt now trims input,
rejects only on an explicit `reject`, and asks again up to three times. The
launcher can now open the consent URL with Enter.

Audit gaps and open points from this run:

- **Most usage is missing.** Planner, Worker and Reviewer usage was not
  collected, and Coordinator usage covers only one turn.
- **Account usage was not checked.** ChatGPT's App limits view was not
  confirmed for this run.
- **Some activity is not audited in detail.** Provider requests are not
  audited one by one, and native tool calls inside the Worker VM are not
  audited individually.
- **Native tools were visible.** The Coordinator could see the
  `collaboration` and `clock` tools, which the catalog override had
  enabled; none were used.
- **The revision path is untested live.** It has not yet run in a live
  attempt.

### Changes after the live run review

A security review of the changes made during the live attempts led to
these follow-up changes. They were checked in fixture mode but have not
run live.

- **Codex sandbox restored.** Planner and Reviewer are back in Codex's
  read-only sandbox. Their full inputs are inlined, so they need no shell.
  Because that sandbox cannot start in the guest, any shell command the
  model tries fails closed. This was observed with the pinned image and
  Codex 0.170.0, where Codex's bundled bubblewrap cannot start. The guest
  script checks that no `bwrap` is on the image's `PATH`, so a different
  image or Codex version needs this claim checked again.
  - Only Worker can still run shell commands in a VM that has credentialed
    egress.
  - Reviewer still reads untrusted candidate text, so its verdict can be
    steered by prompt injection. The operator's own review of the full
    diff remains the independent check.
- **Narrower catalog override.**
  - The derived catalog entry now also clears
    `experimental_supported_tools` and `multi_agent_version`.
  - In fixture mode the Coordinator then sees only its own tools plus
    `request_user_input`, `apply_patch` and `view_image`. This is the same
    as the `gpt-5.5` layout, with no `collaboration` or `clock` tools.
  - The derived catalog is pinned to SHA-256
    `9a6ef910866167ed194b1374ff346256fa813fb46d768b9683d1ce61d60419b9`.
- **Bounded, marked inputs.**
  - Reviewer inputs over the inline limits, 6,000 bytes of diff or 2,000
    bytes of source, are not reviewed partially; they become a concern.
  - Data blocks are delimited with a random marker for each invocation.
    The script stops if the marker is not 24 hexadecimal characters.

### Harness per actor

Each actor (Coordinator, Planner, Worker, Reviewer) can run on the official
Codex CLI or the official Claude Code CLI. `src/actors.ts` reads a choice such
as `Coordinator=claude,Worker=codex` (or `all=claude`). Unnamed actors use
Codex.

- **Codex** roles come from `src/codex-exec.ts`: `codex exec` for Planner,
  Worker and Reviewer, and `codex app-server` for the Coordinator. The M5 runner
  used to build these commands itself.
- **Claude Code** roles come from `src/claude-code.ts`. The Claude Coordinator
  (`src/claude-coordinator.ts`) runs the CLI once per turn with no tools. Its
  only input is the host-prepared `control.json`, and it answers with one JSON
  action. The router validates that action exactly as it does a Codex tool
  call.
- Every harness follows one output contract. Worker prints the collect
  request. Reviewer yields `{"review", "notes"}`; the Claude result object is
  unwrapped by `reviewerOutput`, and verification output is never
  transformed. Planner prints its plan.

A runtime adapter holds one credential, so `RoutingSandboxRuntime` keeps one
adapter per provider binding: plain, OpenAI and Anthropic. It sends each
sandbox to the adapter whose binding matches the spec exactly, and it refuses
unknown bindings and handles it did not create. The adapter lives for the
task. Each VM still lives for one invocation: one planning, coding or review
run, or one Coordinator turn.

The fixture run serves a mock Responses API over HTTP and a mock Messages API
over HTTPS with a disposable CA:

```sh
MSB_HOME=/absolute/short/msb-home M5_ACTORS="Coordinator=claude,Worker=codex" \
  bun spike/m5/dogfood.ts --fixture /absolute/path/to/msb /absolute/path/to/codex
```

On 2026-11-22, four fixture configurations completed with outcome `done`, three
Coordinator turns, one Worker and one Reviewer, and every VM finished `ok`:
`all=codex`, `all=claude`, `Coordinator=claude,Worker=codex,Reviewer=claude`
and `Coordinator=codex,Worker=claude`. Every Claude VM recorded the
`provider.egress` grant. The Codex fixture uses a plain host port and records no
grant, and verification never has one.

For a live run, `M5_CLAUDE_AUTH` selects `api-key` or
`operator:<VARIABLE>:<header>`. `M5_CLAUDE_KEYCHAIN` names the macOS keychain
service that holds the Claude credential. The launcher forwards only these
non-secret `M5_*` settings and `USER`. Codex tokens still arrive on stdin.

### M5 with tree candidates and profiles

`M5_TREE=1` gives the Worker a repository with three files. The Reviewer
receives the candidate diff, and verification checks `hello.txt` in the
candidate repository. `M5_PROFILE` selects `base` (default), `db` or `browser`
for Worker and Verification. Coordinator, Planner and Reviewer use `base`.
The browser image includes Git. Its Claude Worker uses the pinned glibc
build, whose path can be set with `M5_CLAUDE_BINARY_GLIBC`.

With `MSB_HOME`, `MSB` and `CODEX_BINARY` set to absolute paths and the
locked images loaded, run these fixtures. The report includes `tree`,
`profile` and `changedPaths` for the integrated commit.

```sh
MSB_HOME="$MSB_HOME" M5_TREE=1 M5_PROFILE=browser M5_ACTORS=all=codex \
  bun spike/m5/dogfood.ts --fixture "$MSB" "$CODEX_BINARY"
MSB_HOME="$MSB_HOME" M5_TREE=1 M5_PROFILE=browser M5_ACTORS=Worker=claude \
  bun spike/m5/dogfood.ts --fixture "$MSB" "$CODEX_BINARY"
MSB_HOME="$MSB_HOME" M5_TREE=0 M5_PROFILE=db M5_ACTORS=all=codex \
  bun spike/m5/dogfood.ts --fixture "$MSB" "$CODEX_BINARY"
```

### OBS-11b gateway migration

The M4 Coordinator model smoke now maps its HTTP fixture through an audited
host service. The M6 Claude Code smoke uses a DNS-pinned TEST-NET provider
binding and relays TLS to its loopback fixture. Both enable telemetry at
1,000 ms and export audit JSONL under the run's `observability/` directory.
VM verification is pending, including end-to-end secret substitution.

M5 still needs a composition root that routes multiple provider bindings to
their credential-specific runtimes under one trusted host and audit writer.
Its HTTP Codex fixture needs a Codex endpoint that targets the gateway's
host-service name and `ReviewedIntegration` support for passing
`hostServices` to Worker and Reviewer runs. The M5 report and export are
pending with that migration.

## Runtime Observability v0.1

SQLite v5 records execution context, sandbox bindings, process results,
gateway decisions and resource events. Audit JSONL and OTLP telemetry files
support offline analysis. The [v0.1 guarantees](observability/guarantees.md)
record the trust boundary, compatibility and the changes pending coordinator
verification.

- **OBS-10.** Real VMs exercised gateway attribution, synthetic credential
  substitution, audit failure, host crash and forced removal. Forced removal
  can end the relay as `client-closed` or `sandbox-destroyed`. The packet
  coverage gaps remain N-10, N-11, N-15, N-16 and N-18. Across 100 connects
  per mode, direct p50/p95 were 2.7/3.6 ms and gateway p50/p95 were 6.7/8.0
  ms, about 4 ms added at p50. See [Phase 1 evidence](observability/phase1-evidence.md).
- **OBS-16.** The recorded run passed 16 socket-free fixture executions.
  The DuckDB joins link audit and spans by execution ID. CPU and memory
  values are scripted. Real-VM evidence comes from OBS-10 and the M5, M4
  and M6 fixture runs. Live Codex and Claude Code observability dogfooding
  awaits operator opt-in. See [OBS-16 dogfooding](observability/dogfooding.md).

## Planned: credential fallback per actor

Status: planned, not implemented (recorded on 2026-11-22).

An actor may need an ordered list of credentials, for example a
subscription credential, then API key A, then API key B. When a run fails
because one credential is exhausted, the host moves to the next one.

- **Switch only between invocations.** Each VM lives for one invocation, so
  the host picks the credential when it creates the VM. A failed invocation is
  retried with the next credential in a new VM, and never switches inside a
  running request. Retrying is safe because Planner and Reviewer are read-only,
  a failed Worker change is never collected, and a Coordinator turn only
  proposes.
- **Fallback triggers.** Only two kinds of failure move to the next
  credential: an exhausted usage quota (for example Codex
  `usageLimitExceeded`), and an authentication failure (HTTP 401, such as an
  expired or revoked credential). A temporary rate limit or overload (429, 529) does not, because it usually recovers and switching would spend
  another billing account early. Any other failure stays an ordinary failure.
- **Shape.** Credentials of different shapes (variable, header, bare mode)
  are separate provider bindings, so each one gets its own runtime adapter.
  Credentials of the same shape (API key A and B) share a binding, and the
  adapter's credential provider tries its candidates in order.
- **Classification.** Each harness maps its failure to a fixed category: Codex
  from `CodexErrorInfo`, Claude Code from its result object. These categories
  are the only thing that decides a switch. The Claude Code CLI's output when
  a subscription limit is reached is not verified yet. A fixture that returns
  401 and 429 will check the mapping first; the real limit behavior can only
  be confirmed live.
- **Audit.** The audit records a label for the credential, never its value
  (for example `subscription`, `api-a`), together with the reason for each
  switch. This keeps billing changes between accounts traceable.
- **Storage.** Credentials stay outside the repository, in the host keychain
  or on stdin. The repository holds only the generic ordered-candidates
  mechanism and the fixed trigger categories.

## Later acceptance checks

| Milestone                            | Executable acceptance scenario                                                                                                                                                        |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M2 audit and host                    | Run an isolated invocation. Force a denied tool, timed-out invocation, audit-write failure, and restart. Read the trace and verify attempts, decisions, effects, and replay behavior. |
| M3 reviewed integration              | Use a disposable repository. Produce a commit and pinned review, demonstrate rejection or stale-base denial, then approve and integrate a valid candidate with trace evidence.        |
| M4 Coordinator and human interaction | Submit a natural-language task. Observe Coordinator choose its delegation path, pause for an answer or approval, and resume with the same request IDs.                                |
| M5 dogfood                           | Complete one small local change. Collect timing, available usage, retries, review iterations, human interventions, and known audit gaps.                                              |
