# ADR 0001: Host checks for candidates that VMs cannot verify

- Status: proposed
- Date: 2026-11-28

## Context

Some targets have tests that cannot run in a Task VM. wadachi is the first
(`docs/development/codex-sandbox-gaps.md` in wadachi). Its tests need one or
more of:

- a real Microsandbox, because wadachi starts microVMs itself;
- Keychain items, such as runner keys and a model credential;
- egress to a model API;
- host settings, such as `tmutil addexclusion`.

Today a human or a host coding session runs these tests outside
agent-bootstrap. That run has no audit record and no approval, and the
person running it can easily forget that the tree is agent-written code.

Verification can be made to cover more, and other work will do that: a
configurable timeout, a screened failure tail, per-user resources and a
`mise` adapter. That work cannot reach the needs above, so the trusted host
has to run something itself.

## Decisions

### H1. A check, not an actor

A host check is a command the user declares, which the trusted host runs
on a pinned candidate. No model runs on the host. The check makes no
decisions, and the host acts only on its exit status. When a failure needs
diagnosis or a fix, the screened output goes back to the Executor as a
revision, so the model stays in its VM.

### H2. The declaration is private

Host checks are declared in the target's private configuration
(`local.json`), next to `verification`. Repository content is untrusted, so
a candidate cannot add, remove or change a check.

```json
{
  "hostChecks": [
    {
      "name": "msb",
      "argv": ["bun", "run", "test:msb"],
      "timeoutMs": 1800000,
      "env": { "MSB_HOME": "/private/tmp/wmsb" },
      "keychain": [
        { "service": "wadachi-runner-audit-key", "env": "WADACHI_AUDIT_KEY" }
      ],
      "triggers": ["packages/runtime/", "test/msb/", "package.json"],
      "vmCount": 2
    }
  ]
}
```

- `argv` runs without a shell, in the check directory (H5).
- `env` holds literal values that are not secret. The child process starts
  from an empty environment, gets a fixed `PATH` and its own `HOME` and
  `TMPDIR`, and then adds these values.
- `keychain` names Keychain items and the variables that carry them. Only
  the names are stored, never the values.
- `triggers` uses the same matching as scope paths (NFC, folded case, and
  a trailing slash for a directory prefix).
- `vmCount` is advisory and appears in the approval.

The declaration's digest is part of what the human approves.

### H3. When a check is required

A check is required when the candidate's changed paths, compared with the
Task base, match one of its `triggers`. Otherwise it is skipped, and the
skip is recorded with the reason `no-trigger`. A check with no `triggers`
is always required.

Triggers should cover every file that can change what the command does:
test code, `package.json` scripts, tool declarations and the artifact
manifest. This is the user's responsibility. Approval (H4) shows the
matched paths.

### H4. Approval: a new human-only gate

The order for a Task that requires a host check is:

1. Executor, then Verification in the VM, then Reviewer (unchanged).
2. **Gate `host-check`** (new): approve running the candidate on the host.
3. Host check run.
4. Gate `integration` (unchanged).

- The `host-check` gate is always answered by a human. Its policy source is
  `invariant`, and delegation rules cannot hand it to an agent.
- The gate shows the pinned diff, the protected paths, each required
  check with its matched trigger paths, `argv`, Keychain item names,
  `vmCount`, and the declaration digest.
- Approval covers only that pinned candidate and declaration digest. A
  revision, or a change to the declaration, needs a new approval.
- By default the two gates are separate. The operator can instead choose
  "approve and integrate on pass", which records both decisions together.
  Integration then runs only if every required check passes.
- Rejection at `host-check` works like rejection at `integration`.

### H5. Running a check

- **Directory.** The host exports the pinned candidate tree into a new 0700
  directory under the target's state directory. It never uses the target
  checkout or its `.git`. The directory is removed after the run.
- **Packages.** When environments are enabled, the host unpacks the
  candidate's cached environment into the directory, as for Verification.
  A check never builds an environment and never reaches the package
  network.
- **Not a sandbox.** The check runs as the user, with the user's network
  and file access. The human approval in H4 is the boundary. This is why
  the gate cannot be delegated.
- **One job.** A check uses the local runner's single job slot. No other
  agent-bootstrap VM starts while it runs. The VMs that the check starts
  count as part of that one job.
- **Limits.** `timeoutMs` is capped at 2 hours. On timeout, the host kills
  the process group and the check fails.
- **Order.** Required checks run in declaration order and stop at the
  first failure.

### H6. Audit and results

- Before running, the host writes an audit record with the Task, the
  candidate, the declaration digest, the approver, the check name and the
  Keychain item names. If that write fails, nothing runs (fail closed).
- After running, it records the exit status, the duration, a timeout flag,
  and the SHA-256 digests of stdout and stderr.
- The host keeps the last 16 KiB of combined output, masked by the
  credential scanner, in the target's state. Task detail shows it.
- **Failure.** A failed check sends the Task to revision. The Executor
  receives the check name and the masked output tail as revision notes.
  The attempt budget is shared with Verification failures.

### H7. One verdict

A candidate passes only when Verification passes and every required host
check passes. Task detail and the integration gate show both.

## Consequences

- Targets such as wadachi can develop in VMs. The host keeps only the
  checks that need it.
- The gate CHECK constraint, the audit roles, the journal events, Task
  detail and the decision UI each gain a `host-check` case.
- A host check is as dangerous as running the candidate by hand. The
  difference is that someone approves each run and the host records it.

## Not decided here

- Confining host checks, for example with `sandbox-exec` or another user
  account.
- Fetching the artifacts a check needs. The user fetches them, and a check
  can verify them itself.
- Running checks without human approval, for example for trusted paths.
- Model-driven work on the host. This is left to dagq-lite.

## Implementation order

1. This ADR.
2. Declaration parsing, validation and the doctor output.
3. The gate, the run, the audit and the revision path, with a fake check in
   tests.
4. Task detail and the decision UI.
5. A live run with wadachi's `msb` check.
