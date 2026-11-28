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
on a pinned candidate. No model runs on the host. The host decides only
from the command's exit status. When a failure needs diagnosis or a fix,
the screened output goes back to the Executor as a revision, so the model
stays in its VM.

The check runs untrusted, agent-written code outside every VM. It is a new
executor of untrusted code beside the four roles, and the trust model and
the audit roles list it explicitly (`host-check`).

### H2. The declaration is private

Host checks are declared only in the target's private configuration
(`local.json`), next to `verification`. The configuration loader rejects
`hostChecks` in the project declaration and in the user layer, as it does
for `publish.enabled`. Repository content is untrusted, so a candidate
cannot add, remove or change a check.

```json
{
  "hostChecks": [
    {
      "name": "msb",
      "argv": ["/opt/homebrew/bin/bun", "run", "test:msb"],
      "timeoutMs": 1800000,
      "env": { "MSB_HOME": "/private/tmp/wmsb" },
      "keychain": [
        { "service": "wadachi-runner-audit-key", "env": "WADACHI_AUDIT_KEY" }
      ],
      "triggers": ["packages/runtime/", "test/msb/"],
      "vmCount": 2
    }
  ]
}
```

- `argv[0]` is an absolute path and runs without a shell. A shell is
  allowed only when named explicitly, and the approval shows it.
- `timeoutMs` is required, from 1 second to 2 hours.
- `env` holds literal values that are not secret. The child process starts
  from an empty environment. It gets a fixed `PATH`, plus a `HOME` and a
  `TMPDIR` that are created for the run and removed afterwards. The `env`
  values are added last.
- `keychain` names Keychain items and the variables that carry them. Only
  the names are stored. The values never enter configuration, audit, the
  journal, Task detail or the decision UI.
- `triggers` uses the same matching as scope paths (NFC, folded case, and
  a trailing slash for a directory prefix).
- `vmCount` is advisory and appears in the approval. When it is above
  zero, both the check's `env.MSB_HOME` and agent-bootstrap's own
  `MSB_HOME` must be absolute paths. The homes must be distinct, and
  neither may contain the other.

### H3. When a check is required

A check that omits `triggers` is always required, on every candidate.
An empty trigger list is invalid.

A check that declares `triggers` is required when any change between the
candidate and the current expected base (after any base refresh) matches
them or a fixed host baseline that the declaration cannot remove:

- any file named `package.json`, `bunfig.toml`, `.bunfig.toml`,
  `bun.lockb`, `tsconfig*.json`,
  `mise.toml`, `.mise.toml`, `mise.local.toml`, `.mise.local.toml`,
  `mise.*.toml`, `.mise.*.toml`, `mise.lock`, `.tool-versions`, `.env`,
  `.env.*`, `.npmrc`, or a lockfile that an environment adapter declares;
- at any depth, any path under `.config/mise/` or a file at
  `mise/config.toml`, `.mise/config.toml`, or `.config/mise.toml`;
- every adapter key file and output path (E3);
- any added, removed or retargeted symlink, and any change of mode or file
  type.

Both sides of a rename count as changes. Otherwise the check is skipped, and the
skip is recorded with the reason `no-trigger` and the list of changed
paths. Approval (H4) shows the matched paths.

The baseline covers files that the user's tools load implicitly. The
user's triggers must cover the code that the command runs.

### H4. Approval: a new human-only gate

The order for a Task that requires a host check is:

1. Executor, then Verification in the VM, then Reviewer (unchanged).
2. **Gate `host-check`** (new): approve running the candidate on the host.
3. Host check run.
4. Gate `integration` (unchanged).

**Who can answer.** Only an undelegated human answer through the operator
UI is accepted. The CLI cannot answer this gate, because a TTY check does
not prove that a human is present. An agent on the host can open a
pseudo-terminal. The gate also rejects:

- answers with a `delegate`, which is how an agent session answers for a
  human;
- answers that come from the Concierge;
- delegation rules (`RULE_GATES` does not include it);
- Goal or Task policies, takeover, and agent policy.

Its policy source is always `invariant`.

**What the approval pins.** One digest, recomputed and compared
immediately before each check in the ordered list starts, covers:

- the candidate commit and the expected base commit;
- the declaration of each required check;
- the resolved `argv[0]` (its real path and SHA-256) and the fixed `PATH`;
- the environment archive digest, when one is used;
- the Keychain item service names.

If any of these changes, including a new candidate produced by a revision
or by `stale-base` handling, the approval lapses. The gate opens again.

**What the gate shows.**

- The pinned diff and the protected paths.
- Each required check, with its matched paths, `argv`, `env` names,
  Keychain items, `vmCount` and the digest.
- A plain statement of the exposure (H5).

**Combining the gates.** By default the two gates are separate. The
operator can instead choose "approve and integrate on pass", which records
both decisions together. Integration then runs only if every required
check passes. Every existing integration invariant still applies:
verification, review, the symlink rules and acknowledging the protected
paths. The integration half also lapses with the pinned digest.

Rejection at `host-check` fails the Task, as a rejection at `integration`
does.

### H5. Running a check

- **Exposure.** The check runs as the user, with the user's network, files
  and Keychain. It can read other Keychain items that `security` releases
  without a prompt, and it can rewrite files the user can write. The
  declared Keychain items are the minimum it receives, not the limit of
  what it can reach. The approval is the only control. The gate states this
  in plain words.
- **Directory.** The host exports the pinned candidate from its commit
  object, never from a worktree. The export goes to a new 0700 directory
  outside the agent-bootstrap state, configuration and audit roots, and
  outside the target checkout. The directory is removed after the run.
- **Packages.** When environments are enabled, the host first validates the
  exported candidate tree. It refuses the run if the tree has a symlink at
  or above an adapter output path. It then unpacks the cached environment
  without following links and refuses any entry that would resolve outside
  the directory. A cache miss fails the check. A check never builds an
  environment and never reaches the package network.
- **Tamper detection after the run.** Before and after the process runs,
  the host hashes:
  - the target's `local.json` and the user `config.json`;
  - the delegation rules, the Goal policies and the open approval rows in
    the store.

  If any hash changed, the run fails. Integration and revision stay
  blocked until a human looks. This is a best-effort detector, not a
  guarantee. A check can change state and restore it before it exits, and
  it can write state that is not hashed.

- **One job.** The runner's single job slot is held only while the check
  runs, never while the gate waits. While it runs, no other
  agent-bootstrap VM starts. The check may start up to `vmCount` VMs
  itself, under its declared `MSB_HOME`. For the AGENTS.md rule of one VM
  job at a time, this counts as one job.
- **Limits.** On timeout, the host kills the process group and the check
  fails.
- **Order.** Required checks run in declaration order and stop at the
  first failure.
- **Interruption.** If the host stops during a check, the run is recorded
  as `interrupted` on restart. It never reruns without a new approval.
  VMs may still be running under the check's `MSB_HOME`. The job slot
  stays blocked until a human clears it. Doctor reports the location and
  any VMs found there, and cleaning them up is the user's job.

### H6. Audit and results

- **Before.** The host writes an audit record with the Task, the pinned
  digest, the approver, the check name and the Keychain item names. If this
  write fails, nothing runs (fail closed).
- **After.** It records the exit status, the duration, a timeout or
  interruption flag, and the SHA-256 digests of stdout and stderr. If this
  write fails, the Task stops. Neither integration nor revision proceeds.
- **Output.** The host keeps the last 16 KiB of combined output. It
  redacts the exact injected Keychain values and their base64 and hex
  forms. It then masks the rest with the credential scanner and stores the
  result in the target's state. Task detail shows it.
- **Failure.** A failed check sends the Task to revision. The Executor
  receives the check name and the masked tail as revision notes. The
  attempt budget is shared with Verification failures. The tail goes to
  the model provider, and a check that wants to leak a value can do so
  over the network. Masking prevents accidental leaks, not deliberate ones.

### H7. One verdict

A candidate passes only when Verification passes and every required host
check passes. Task detail and the integration gate show both.

## Consequences

- Targets such as wadachi can develop in VMs. The host keeps only the
  checks that need it.
- The gate CHECK constraint, the answer validation, the audit roles, the
  journal events, Task detail, the decision UI and doctor each gain a
  `host-check` case. `docs/trust-model.md` lists the host check as an
  executor of untrusted code.
- A host check is more dangerous than running the candidate by hand,
  because the host injects the declared Keychain values automatically. The
  difference from running it by hand is that a human approves every run
  and the host records it.
- A candidate whose lock differs from the base environment runs with the
  base packages, as Verification does today. This gap is shared.

## Not decided here

- Confining host checks, for example with `sandbox-exec` or another user
  account.
- Fetching the artifacts a check needs. The user fetches them, and a check
  can verify them itself.
- Running checks without human approval, for example for trusted paths.
- Authenticating the human behind the operator UI beyond the local
  channel. This gap is shared with the `integration` gate.
- Model-driven work on the host. This is left to dagq-lite.

## Implementation order

1. This ADR.
2. Declaration parsing, layer restrictions, validation, the doctor output,
   and the `docs/trust-model.md` entry.
3. The gate and answer validation, the pinned digest, the run, the audit
   and the revision path, with a fake check in tests.
4. Task detail and the decision UI.
5. A live run with wadachi's `msb` check.
