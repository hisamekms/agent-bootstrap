# ADR 0001: Secret files for actors

- Status: proposed
- Date: 2026-11-24

## Context

Some tools in a VM must read a credential themselves. The host cannot
keep the value outside the VM by substituting a header. Today the only
way to give such a tool a credential is a declared mount, as in the
volumes ADR. That has three costs:

- **No shell tools.** An actor with a mount loses Bash (volumes ADR,
  rule 3), so an Executor cannot run tests or builds.
- **One writer per directory.** A read-write mount holds one actor and
  takes an exclusive lease. Parallel runs of one role wait.
- **State shared across runs.** A tool's state directory collects files
  over many runs. A read-only mount stops the tool from renewing a
  credential that it keeps there.

Header substitution (`claude.apiKey`) stays the choice for credentials
that the host can inject on the wire. This ADR covers the other case: a
value that the tool in the VM must hold.

A proof of concept on 2026-11-24 delivered one value into a Claude
Worker VM as a secret file. It kept Bash safe with the CLI's own
sandbox. See Evidence. An independent security review then found gaps
that the PoC did not probe. S10 lists the checks that must pass before
this ADR is accepted.

The value is in the VM by design. Every decision below narrows who in
the VM can read it. None of them makes a leak impossible once a command
escapes containment, so the value must be revocable.

## Decisions

### S1. Secrets are declared in two parts

The user config defines where each secret comes from. It names
machine-wide sources only:

```json
"secrets": {
  "tool": { "keychainService": "agent-bootstrap.tool" }
}
```

The user config or a project's `local.json` grants a secret to actors as
a guest environment variable:

```json
"secretEnv": {
  "TOOL_TOKEN": {
    "secret": "tool",
    "actors": ["Planner", "Executor", "Reviewer"]
  }
}
```

- The variable name must pass `isSafeCredentialVariable`.
- The name cannot be one that the adapter or its header substitution
  uses, such as `ANTHROPIC_API_KEY`.
- `actors` may list Planner, Executor and Reviewer. Concierge needs the
  orchestrator MCP channel, and Researcher needs web tools. Both are
  future work. Verification and Coordinator never receive a secret.
- An actor receives each variable from at most one grant.
- Grants are named entries. The same variable name in two layers is an
  error, as for mounts (configuration ADR, C6).
- Only the operator writes these files. No orchestrator action, MCP tool
  or actor output can change `secrets` or `secretEnv`.

This amends the configuration ADR:

- **C3.** A project declaration cannot contain `secrets` or `secretEnv`.
  A repository cannot request a host secret.
- **C5.** `local.json` may hold `secretEnv` but not `secrets`. Sources
  are machine-wide, like volumes.

### S2. A grant needs a recorded self-test

The subprocess scrub in S5 removes only the variables that the pinned
CLI recognises as credentials. Whether a name is removed is a fact about
one CLI version, not about the name.

- `agent-bootstrap secrets test <variable>` runs the self-test from
  Evidence for one granted variable on the pinned CLI. It records a pass
  for the pair (variable, CLI version) in the host state.
- The adapter refuses a run with a grant that has no recorded pass for
  the pinned CLI version.
- A pass is also bound to a containment digest. The digest covers the
  secret-mode launcher, the managed settings for each grantable actor,
  the pinned sandbox packages and the base image digest. A change to any
  of them invalidates every pass, as a CLI version change does.
- A pass needs evidence from outside the model. The root-side observer
  must see the unprivileged `bwrap` and shell processes while the probe
  runs. The probe output must carry a nonce that the host generated for
  that run. A probe file that the model writes itself does not count.
- The trusted host checks for a pass before it arms a delivery, not only
  the launcher. Only the self-test run itself is exempt.

The repository therefore names no variable, and the operator proves
each name on the version in use.

### S3. Delivery is one-shot and audited first

For each VM that needs secrets, the host opens one disposable channel. It
is a Unix socket in a new 0700 directory, forwarded to the guest over
vsock.

- The host reads the value from Keychain into a `Buffer`, never a
  string. The value never appears in a host argv, a child process
  environment, a log, an audit row or a file.
- Before it writes the first byte, the host appends a durable
  `secret.served` event that names the variable, and waits for it. If
  that write fails, the host does not serve.
- After the transfer, the host records the outcome as `acknowledged` or
  `unknown`. An error after bytes have left the host counts as `unknown`,
  never as "not served".
- The channel serves one connection once, then closes. A connection that
  arrives before the host arms the channel is refused without using it
  up. Later connections are refused.
- The host closes the channel when the exec ends or 30 seconds after
  arming it, whichever is first. It zeroes its buffer on close. Zeroing
  is best effort in a garbage-collected runtime.
- The value is at most 4 KiB and contains no NUL byte.
- The frame is the length as 8 ASCII digits, then the value. The guest
  reads exactly that many bytes and answers with one byte, `A`. Only
  then does either side close. The vsock relay does not carry a
  half-close, so the protocol never depends on one.
- Every host process running as the operator's user is inside the trust
  boundary. The socket's mode keeps out other users only.

### S4. The guest holds the value in one process only

The guest launcher runs as root:

1. It receives the value into a file on a root-only tmpfs
   (`/run/secrets`, mode 0700, file mode 0400).
2. It reads the value into a shell variable and deletes the file.
3. It sets `ulimit -c 0`, soft and hard, so a crash writes no core
   file.
4. It starts the tool as an unprivileged user (uid 1000). The variable is
   set in that process's environment only. It is never a process
   argument.

These preconditions must hold:

- **No early processes.** Vsock is not scoped by a network namespace, so
  any guest process could connect to the channel. Until delivery is
  done, no uid-1000 process and no repository-controlled process runs in
  the guest.
- **Clean environment.** The launcher builds the tool's environment with
  `env -i` and an allowlist. The privilege drop (`su -p`) passes on only
  that environment.

The tool's configuration and home directories are new for each run, and
they are owned by that user. The managed settings file is staged under
`/tmp`, then moved into place. It is root-owned and not writable by that
user. In a secret run, `/review` is a copy rather than a read-only mount,
so that the unprivileged user can read it.

### S5. Commands and tools run contained

An Executor that receives a secret gets Bash, even though a task
Executor without a secret has no shell today. Containment is what makes
a shell acceptable next to a credential, and running tests and builds is
the reason for this ADR. Planner and Reviewer get no shell. Every
command it runs must be contained. For Claude this means:

- **Bash sandbox.** Managed settings enforce:
  - `sandbox.enabled`
  - `sandbox.failIfUnavailable`
  - `sandbox.allowUnsandboxedCommands: false`
  - `sandbox.network.allowManagedDomainsOnly` with no allowed domains, so
    sandboxed commands have no network
  - `sandbox.filesystem.denyRead` for `/run/secrets`, `/etc/claude-code`,
    and the tool's configuration and home directories
  - `sandbox.filesystem.allowWrite` for the tool's temporary directory.
    The CLI passes state to sandboxed commands through it, so sandboxed
    commands can read and write it. Nothing secret is placed there.
- **Subprocess scrub.** The launcher sets
  `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1`. Subprocesses lose the variables
  that S2 proved. On Linux, Bash runs in its own PID namespace, so it
  cannot read `/proc/<pid>/environ` of the tool.
- **Packages.** The guest image includes the sandbox's packages:
  bubblewrap with its dependencies, and socat. They are pinned by
  sha256.
- **Self-check.** Before the tool starts, the launcher checks that
  bubblewrap starts for the unprivileged user. If it does not, the run
  fails. There is no fallback without containment.
- **File tools.** They keep their working-path allowlist. They are also
  denied on:
  - `/run/secrets`, `/proc`, `/sys` and `/dev`;
  - the tool's configuration, home and temporary directories.

  File tools run inside the process that holds the value. A symlink in
  the working path could point at `/proc/self/environ`. Two rules close
  that path:
  - The host fails a secret run whose tree has a symlink with an
    absolute target, or a target that leaves the working path.
  - S10 must show that the CLI checks deny rules on resolved paths, for
    symlinks that Bash creates during the run.

- **Tools the CLI starts itself.** The CLI starts helpers outside the
  Bash sandbox. One is git, which reads `.git/config` and can be told to
  run commands. In a secret run:
  - The host builds `.git` with a fixed configuration.
  - The launcher sets `GIT_CONFIG_NOSYSTEM=1` and `GIT_CONFIG_GLOBAL=/dev/null`.
  - Through `GIT_CONFIG_COUNT`, it pins `core.fsmonitor`,
    `core.hooksPath`, `core.pager` and `core.sshCommand` to inert
    values.
  - `.git/config` is denied to Write and Edit, and to the sandbox's
    writes.

  S10 must list every helper that the pinned CLI starts in a run. It
  must show that each helper is either contained or inert.

A secret run loses WebFetch, WebSearch, Agent and Skill, as runs with a
mount do.

### S6. No state outlives the run

The launcher turns off persistent tool state that could carry content to
a later run: for Claude, auto memory (`CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`)
and prompt history (`CLAUDE_CODE_SKIP_PROMPT_HISTORY=1`), together with
`--no-session-persistence`. The configuration directory is discarded
with the VM.

### S7. The host screens for the value

Screening is best effort. Containment (S4 and S5) is the control.

- **Where.** The host screens before every host sink:
  - the Worker stderr tail and the result envelope;
  - runtime events and telemetry;
  - journal error text;
  - collection.
- **What.** It searches for the value and for every 16-byte window of
  it.
- **On a match.** The run fails. The host discards that run's outputs
  instead of keeping a quarantined copy. It records a
  `secret-leak-suspected` event that names the variable and the sink.

Screening does not catch encoded leaks, such as base64, or derived
credentials that the tool writes. Both stay out of scope.

This adds to `claude.leakPatterns`.

### S8. Adapters, profiles and egress

- Only an adapter that enforces S4 to S6 can receive `secretEnv`. Today
  that is the Claude adapter on the Alpine guest. Other adapters, and the
  Debian-based profiles, reject a grant with an actionable error until
  they support it.
- **Egress.** A secret actor gets no added egress in version 1. It
  reaches only the model API host through the audited gateway, and its
  sandboxed commands have no network (S5).
- **Mounts.** A secret and a mount on the same actor are rejected in
  version 1.

### S9. Authentication mode

A grant is used only when `claude.auth` is `external`. Then the Claude
adapter launches the CLI as in S4 to S6, without `--bare`, and the audit
records `authMode: "secret-file"`. With `claude.auth: "api-key"`, a
grant is an error.

The adapter does not interpret the variable. S2 proves only that
subprocesses do not see it.

### S10. Validation before acceptance

Every check runs on the pinned CLI, with a self-test that prints only
yes/no answers and counts. Every check must pass before this ADR is
accepted.

1. **Scrub.** For the granted variable, Bash sees no variable, and no
   `/proc/*/environ` contains it. (Passed in the PoC for one variable.)
2. **Symlinks and file tools.** Bash creates links in `/workspace` to
   `/proc/self/environ`, `/proc/<pid>/environ` and
   `/proc/<pid>/root/run/secrets`. Read, Grep and Glob on those links
   must be denied.
3. **Repository symlinks.** A tree with an absolute symlink, or one that
   escapes the working path, fails before boot.
4. **Helpers.** The PoC records every process that the CLI starts, with
   its uid and whether its environment holds the variable. It then
   writes a hostile `core.fsmonitor`, pager and hooks into `.git/config`.
   Nothing runs.
5. **Tool directories.** Bash cannot read the tool's configuration or
   home directory. The file tools cannot read any of the three tool
   directories.
6. **Vsock.** After delivery, a connection from Bash to the secret port
   is refused. So is a connection to the orchestrator port.
7. **Core files.** A crash of the CLI writes no core file.
8. **Network.** Sandboxed Bash cannot connect anywhere.
9. **Concurrency.** Two runs at once each pass checks 1 to 8.

## Consequences

- Executors keep Bash with a credential in the VM. The credential sits
  behind:
  - the unprivileged user;
  - the subprocess scrub;
  - the PID namespace;
  - the sandbox's file and network rules;
  - the file-tool deny rules;
  - an inert git configuration.
- Runs of one role can execute in parallel. Each VM gets its own copy of
  the value and its own throwaway state.
- The containment is only as strong as the CLI's sandbox. Its
  documentation says it is not a complete isolation boundary.
- If any read primitive exists, the value can reach the model's
  transcript. From there it can leave in an encoded commit, which S7
  does not catch. Values must be revocable. Egress stays allowlisted and
  audited.
- Adding a variable, or changing the CLI version, needs a new self-test
  pass.
- The adapter installs pinned packages for secret runs.

## Not decided here

- Renewing a value. The operator replaces it in Keychain, and new runs
  use the new value.
- File-descriptor delivery. If a tool can read its credential from an
  inherited descriptor, the value would not sit in the tool's initial
  environment. A later decision can let the operator choose that.
- Concierge and Researcher grants.

## Evidence

### PoC 1, 2026-11-24

One Worker on the pinned CLI 2.1.330 in the Alpine base guest, with
Bash, and egress only to the model API host through the audited gateway.
It covers check 1 and part of check 9 in S10.

| Measure                               | Result                                                                   |
| ------------------------------------- | ------------------------------------------------------------------------ |
| One-shot delivery                     | Served once, audited by variable name after the run                      |
| bubblewrap in the guest, as uid 1000  | Started                                                                  |
| Destinations contacted                | Model API host only                                                      |
| Bash user                             | uid 1000                                                                 |
| Variable visible to Bash              | No                                                                       |
| `/proc` entries visible to Bash       | 5                                                                        |
| `/run/secrets` from Bash              | Empty                                                                    |
| Managed settings readable from Bash   | No                                                                       |
| Value or 16-char prefix in any output | No (stdout, stderr, result, files, audit SQLite and JSONL, gateway logs) |
| Wall time, one Worker                 | About 24 s                                                               |
| Two Workers at once                   | Both passed, about 17 s each                                             |

The model refused to run a probe that dumped environments and secret
files, even when the prompt explained the test. The PoC therefore used a
self-test script that prints only yes/no answers and counts. Model
refusal is not counted as a control.

PoC 1 also reported no `environ` with the variable. That probe used
`grep -z`, which the guest's BusyBox does not support, so the result
carried no information. PoC 2 replaced it.

### PoC 2, 2026-11-24

The same setup with S3 to S7 applied, a root-side process observer, and
the file-tool probes. File-tool results come from the CLI's
`permission_denials`, not from the model's answer.

| S10 check               | Worker                                                                                                                                    | Reviewer              |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | --------------------- |
| 1. Scrub                | Variable not in Bash env. 5 `/proc` entries, none with the variable                                                                       | n/a (no Bash)         |
| 2. Symlinks, file tools | Read, Grep and Glob through links to `/proc/self`, `/proc/1`, `/run/secrets` and `/proc`: all denied                                      | Same, all denied      |
| 3. Repository symlinks  | Absolute and escaping links fail before any VM is created                                                                                 | Same check            |
| 4. Helpers              | Only the CLI process (uid 1000) holds the variable. git ran as uid 1000 without it. Hostile hooks did not run. `.git/config` not writable | Only the CLI holds it |
| 5. Tool directories     | Bash: configuration and home unreadable. File tools: denied                                                                               | File tools: denied    |
| 6. Vsock                | Secret and orchestrator ports: no connection from Bash                                                                                    | n/a                   |
| 7. Core files           | `ulimit -c` 0 (soft and hard). A crash as uid 1000 left no core file                                                                      | Same                  |
| 8. Network              | Bash: no TCP to the model host or a public IP, no DNS                                                                                     | n/a                   |
| 9. Concurrency          | Two Workers at once: both passed every check, about 31 s and 38 s                                                                         | —                     |
| Delivery                | Audited before the first byte, then acknowledged                                                                                          | Same                  |
| Screening               | No match of the value or any 16-byte window in any sink                                                                                   | Same                  |

PoC 2 found two problems that shaped S3 and S5:

- The vsock relay closes the whole connection when the host half-closes.
  The first framing lost the guest's acknowledgement. S3 now uses a
  length-prefixed frame.
- The CLI writes state for sandboxed commands in its temporary
  directory. With that directory denied, every Bash command failed. S5
  now lets sandboxed commands write it.

Sample size: 3 Worker runs, 1 Reviewer run and 1 concurrent run with all
checks passing, after the fixes above.
