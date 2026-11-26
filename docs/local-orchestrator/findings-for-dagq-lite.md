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

## 2026-11-25: cleanup and phase 2 design

- **A tested API had no process serving it.** Phase 1 added the operator
  socket API with tests, but no command hosts it; `inbox` and `watch`
  read the store directly. Unit tests passed while the feature could
  not be reached.
  _Lesson:_ every API ships with the process that serves it and one
  test that starts that process.
- **A finished experiment cannot be discarded.** The end-to-end check
  left a Goal `active` with its private branch. There is no operation to
  close or discard a Goal. Deleting the branch by hand would leave a
  recorded base that no longer matches, so later work on that Goal would
  fail as stale.
  _Lesson:_ Goals need a host-recorded discard that closes the Goal,
  resolves its inbox items and removes its private refs together.
- **A locked image drifted with the calendar.** The browser image was
  reproducible on one day and not two days later. The build normalized
  `/etc/shadow` dates but not the `/etc/shadow-` backup. Two rebuilds on
  the same day agreed, which hid the problem.
  _Lesson:_ reproducibility checks must build on different days (or with a
  shifted clock), and setup must print why a locked build differs instead
  of only the stage.
- **A security change silently broke a smoke test.** Moving image builds
  behind the audited gateway also routed the smoke test through it with
  an empty allowlist. Chromium's startup lookups exceeded the burst limit
  and quarantined the gateway. No locked build had reached the smoke stage
  since, so nothing noticed.
  _Lesson:_ when a boundary changes, run every profile's full build path
  once, and give no-network stages no network instead of an empty
  allowlist.

## 2026-11-25: operator UI phase 2 (#43 to #47)

- **A table of escape sequences missed real holes.** Three review rounds
  of the terminal filter found a raw `0x9c` that ended a string, a `BEL`
  that ended DCS and APC as well as OSC, and one stray byte that stopped
  all later output. A fourth claim was a false positive.
  _Lesson:_ state the filter's output invariant (valid UTF-8, no C1,
  every ESC starts a complete CSI) and test it with random input and
  random chunking, not only with known sequences.
- **The terminal widget did not run under the strict CSP.** xterm 6
  inserts `<style>` elements, which `style-src 'self'` blocks. The bundle
  now swaps them for constructed stylesheets in the pinned version and
  fails at startup if the code it replaces moves. The rule "no `http:` in
  the bundle" also hit XML namespace strings that are never fetched.
  _Lesson:_ check a UI dependency under the real CSP in a real browser
  before adopting it. Enforce "no remote loads" with the CSP; a text scan
  of the bundle is only a second layer.
- **Only the real agent showed a broken layout.** The default terminal
  font drew block and box characters 1.67 cells wide on macOS, so the
  agent's banner broke. Tests with a plain shell passed; the operator
  saw it on the first real run.
  _Lesson:_ set the terminal font explicitly and include the real
  agent's startup screen in the manual check.
- **A detached launcher outlived its parent.** The workplace launcher
  runs in its own session so the CLI can forward signals. When the CLI
  was killed with SIGKILL, the launcher kept the agent session running
  until its lifetime limit. A second Ctrl-C did nothing while shutdown
  hung.
  _Lesson:_ give every detached child a lifeline pipe from its parent
  and stop when it closes; escalate on repeated signals.
- **The implementer could not run browser or socket checks.** Its
  sandbox could not bind sockets or start a headless browser. The lead
  checked the page with a small harness that put `/bin/sh` behind the
  real terminal hub and bridge and drove Chrome over its debugging
  protocol.
  _Lesson:_ keep a fake-agent harness for UI work so anyone can check
  the page without starting a VM.
- **Discarding a Goal is now one recorded operation** (#44). The
  operator previews the private ref, types a confirmation, and the host
  rechecks that the Goal is idle, deletes the ref by compare-and-swap,
  closes the Goal and records the event under one lock.

## 2026-11-26: answering and delegating decisions (#49 to #52)

- **The locked browser image is now stable across days.** A rebuild on
  2026-11-26 produced the digest locked on 2026-11-25, after #42 cleared
  the install date from `/etc/shadow-`.
  _Lesson:_ keep one cross-day rebuild in the release checklist for every
  locked image.
- **A "problems" view showed history, not problems.** The first version
  listed every path violation a Task ever hit, including ones fixed by a
  later attempt and Tasks of a discarded Goal. A budget overrun stayed
  listed after the operator retried the Task.
  _Lesson:_ define when each problem kind is resolved, test it with the
  same retry and discard sequences as the inbox, and keep history
  behind an explicit option.
- **Store states did not map one to one to stages.** An integrating Task
  is stored as `running` with an integration code, so the panel showed
  it moving back from "awaiting integration" to "running".
  _Lesson:_ derive UI stages from status plus code, not status alone,
  and test every transition the integrator makes.
- **Delegation opened a path that had no scheduler before.** A Reviewer
  could approve a Task registration outside the Goal's scope once rules
  or Goal overrides allowed agent answers. Before, nothing scheduled an
  agent for registrations, so a scope exception was a human act in
  practice.
  _Lesson:_ when a change adds a new automatic answerer, list every
  pending reason it could now answer and make scope exceptions an
  invariant.
- **A migration can widen authority.** Marking old defaults as
  "explicit" while adding a precedence where explicit defaults win would
  have let an old `agent` default override Goal and Task `human`
  policies after an upgrade.
  _Lesson:_ migrations that touch authority keep the old precedence and
  let the operator opt in.
- **Text checks on paths need their own case rules.** Exclusions matched
  exactly, so `src/Secret/a` escaped `src/secret/**` on a
  case-insensitive checkout. Exclusions now fold case and Unicode form;
  allow-lists stay exact.
  _Lesson:_ fold exclusions and keep allow-lists strict.
- **Headless Chrome can report a page as hidden.** A long-lived headless
  instance reported `document.hidden`, so the panel skipped its refresh
  and looked broken. A fresh instance behaved.
  _Lesson:_ start a fresh browser for each UI check and assert
  visibility before judging the page.

## 2026-11-26: what happens after an approval (#59 to #61)

- **Approving a Goal did not start anything.** Only the Concierge asks
  the Planner to split a Goal, and it acts only on an operator turn. The
  operator approved a Goal and saw nothing move.
  _Lesson:_ every approval needs a visible next step and an owner. Show
  "nobody is working on this" as its own state.
- **The host cannot speak to a CLI agent first.** Claude Code reads its
  inbox only during a turn. Its Monitor tool (each line a background
  process prints wakes the model) needed a shell, because the CLI checks
  Monitor commands through its Bash permission rules. A Concierge with a
  mounted volume must not have a shell, so the watcher worked only
  without mounts. MCP channels need a development-only flag. We closed
  the watcher PR (#61) and kept a draft button that the operator sends.
  _Lesson:_ design host-to-agent events into the orchestrator from the
  start (a session-level event input the host owns), not through the
  agent's shell.
- **The Concierge runs as root with writing tools.** Edit on an existing
  executable plus a root process that runs it (for example a git
  setting) runs code without a shell. The Concierge now has Edit, Write
  and NotebookEdit denied. Dropping root before the CLI starts needs a
  pinned helper.
  _Lesson:_ run each agent CLI as an unprivileged user, and give the
  coordinator no writing tools.
- **Show whose turn it is, not every state.** Goal, Task and execution
  states fold into five owners: the operator, AI, stopped, nobody, done.
  Each view shows only what its use case needs. The header shows a
  one-line count. The work may run in parallel later.
  _Lesson:_ keep the state model complete in the API and fold it per
  view in the UI.
