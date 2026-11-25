# Findings for dagq-lite

This file records problems met while building and running the local
orchestrator, with the lesson for dagq-lite. Entries name the change or
run and stay generic about providers.

## 2026-11-24 to 2026-11-25: secret files and the first end-to-end run

The work added secret files for actors (secrets ADR 0001, PRs #31 and
#34), fixed audit compatibility (#32), made the Microsandbox home
configurable (#33), and ran one Goal through Planner, Executor, Reviewer
and integration.

### Credentials

- **Mounted tool state did not fit actors.** A credential kept in a
  mounted tool directory removed Bash, allowed one writer per directory
  and shared state across runs. Relaying the credential by header
  substitution was not acceptable for every tool. The fix was one-shot
  delivery of a value into a tmpfs file per run.
  _Lesson:_ treat per-run credential delivery to a tool as a first-class
  host service with its own audit events, not as a mount.
- **The model refused probes that looked like credential harvesting.**
  Isolation evidence that depends on the model running a probe is weak.
  _Lesson:_ base containment evidence on signals outside the model: a
  root-side observer, the CLI's permission denials, host scans of every
  output, and a per-run nonce.
- **A self-test pass must be bound to what it tested.** The pass is tied
  to the variable, the tool version and a digest of the launcher and
  settings. Any launcher change invalidates it, and the operator was not
  told.
  _Lesson:_ surface "evidence expired" as an operator action item with
  the exact command.

### Guest runtime

- **The vsock relay dropped a half-close.** The guest could not tell the
  end of the value from a closed stream. The fix was a length-prefixed
  frame and a one-byte acknowledgement.
  _Lesson:_ never rely on half-close across the VM boundary; frame every
  message.
- **BusyBox lacked a flag a probe used** (`grep -z`), so the probe
  passed without testing anything.
  _Lesson:_ every negative probe needs a positive control that proves it
  can detect the condition.
- **The tool's own sandbox wrote into the workspace.** For protected
  paths that did not exist, it created empty placeholder files. The PoC
  checked for leaks but not for unintended changes, so the first real
  Task failed `path-violation` four times.
  _Lesson:_ acceptance for a runtime change includes one real Task end
  to end and a check that the collected diff holds only intended paths.

### Host state and compatibility

- **Removing an enum value broke old audit stores.** Two failure codes
  were retired without a schema version change. The store validates
  every row on open, so an old row made the whole store unopenable and
  the Concierge could not start.
  _Lesson:_ stored records are append-only evidence. Readers keep
  accepting retired values; writers reject them. Keep fixture stores
  from every released schema and reopen them in tests.
- **The Microsandbox home was environment-only.** The working home sat
  under `/private/tmp`, and a new empty default was created alongside
  it. Images and volumes could vanish on reboot.
  _Lesson:_ the runtime home is configuration with a durable default,
  and doctor shows which source won.
- **Cleanup lists did not match reality.** Migration reported an
  orphaned volume that did not exist and missed two that did, because it
  derived names instead of reading the runtime's records. The product
  also had no command to remove a volume.
  _Lesson:_ every resource the product creates needs list and remove
  commands that read the runtime's own records.

### Diagnosis

- **Launcher errors hid their cause.** "Concierge failed to open audited
  host" required reproducing the startup by hand to find an audit store
  error.
  _Lesson:_ every failure carries a stable code, the resource involved
  and a `next:` action.
- **Rejections did not say what was rejected.** `path-violation` did not
  record which paths were out of scope.
  _Lesson:_ record the host's reason with the decision, and show it to
  the operator.

### Operator experience

- **Two places to work.** The conversation ran in one terminal; status,
  IDs and approvals needed another. See operator-ui ADR 0001.
- **Commands depended on the shell and on PATH.** Variable syntax
  differed between shells, and the command was not on PATH without a
  package runner.
  _Lesson:_ do not make the operator compose shell commands; the
  workplace offers actions directly.
- **Updating code under a running Concierge was unclear.** The operator
  had to be told to restart it to pick up a fix.
  _Lesson:_ the host detects a version change and says when a restart is
  needed.

### Development process

- **Verification flaked under load.** Real Git tests in
  `test/local-orchestrator-tasks.test.ts` run close to the 5 s default
  timeout. Under host load the first slow test times out, its work keeps
  running into the shared temporary root, and about 18 later tests fail.
  Raising one test's timeout only moved the failure to the next test.
  _Lesson:_ give real Git tests an explicit budget, and isolate each
  test's state so one timeout cannot fail the rest. Fix this before
  relying on `verify` as a merge gate.
- **The implementing agent's sandbox could not bind sockets,** so it
  could not run the full verification. The lead had to verify and
  commit.
  _Lesson:_ give the implementer an environment that can run the full
  acceptance suite, or make the split explicit in the workflow.

## 2026-11-25: operator UI phase 1 (#36 to #38)

- **Tests the implementer could not run hid a wrong assertion.** The
  operator API's socket tests never ran in the implementing agent's
  sandbox. One compared a JSON reply with an object that held
  `undefined` fields and had never passed.
  _Lesson:_ a report that tests were "affected by the sandbox" means
  they are unverified; the lead runs them before review.
- **A host socket left by a crashed launcher blocked the next start.**
  The first version refused to start when the socket path existed.
  _Lesson:_ any host listener replaces a stale socket that refuses
  connections and refuses a live one.
- **Model text next to a host command reads like a command.** Escaping
  control characters was not enough: a Task title could hold a
  plausible fake `approve` command on the same line.
  _Lesson:_ print model text last, quoted and labeled, never between
  host-written parts.
- **Stable ids can leak the names they hash.** Self-test item ids were
  hashes of low-entropy variable names, so the Concierge could confirm
  guesses.
  _Lesson:_ ids shown to an agent are opaque or keyed with a host
  secret.
- **The egress gateway can fail to start on a port collision.** It
  takes an ephemeral TCP port for DNS and then binds UDP to the same
  number. If another process holds that UDP port, the bind fails with
  `EADDRINUSE` and the gateway does not start. A verification run hit
  this once. The gateway now closes both listeners and retries with a
  new pair, up to eight times. Any other bind error still fails at once.
  _Lesson:_ when two protocols must share a port, retry with a new port
  on collision, or let each listener choose its own port.
