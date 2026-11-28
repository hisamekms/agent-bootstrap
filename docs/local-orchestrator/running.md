# Run the local Concierge

From the agent-bootstrap checkout, use `bun run src/local-orchestrator/cli.ts`
with the same operator arguments as an alternative to the linked command.
To launch Concierge directly, use `bun run spike/local-orchestrator/concierge.ts --run`.

Use a macOS operator terminal with OSC 52 clipboard access disabled. Guest
output reaches that terminal directly. See the [terminal trust boundary](../trust-model.md)
for details.

## Prepare the host

- Install Bun and the mise-pinned Microsandbox 0.7.16 tool. Create
  `$HOME/.msb` or use an existing directory via the user config's
  `microsandbox.home` or the `MSB_HOME` override. The real path must be at
  most 40 bytes.
  Preload the digest-pinned Concierge image from
  `images/profiles.lock.json` and the pinned Alpine base image in that
  Microsandbox home. The base image serves Planner runs.
- Stage the pinned Alpine arm64 Claude CLI at
  `.local/claude-code/2.1.332/linux-arm64-musl/claude` in this checkout,
  or set `LO_CLAUDE_BINARY` to its absolute path. Stage the pinned Alpine
  packages under `.local/alpine/v3.23/main/aarch64/`. The filenames and
  checksums are in `src/claude-code.ts`.
- For default API-key mode, provision the API key in Keychain and configure
  its service name in the [private config file](../claude-code-auth.md#setup).
  `LO_CLAUDE_MODEL` defaults to `claude-opus-5-5`.

## Run the Executor on Codex

Concierge, Planner and Reviewer use Claude. Select Codex for the Executor
in the user configuration with `agent-bootstrap config edit` or in the
target's private `local.json` with `agent-bootstrap config edit --project
<name>`. Merge these keys into the existing version 1 file.

```json
{
  "version": 1,
  "actors": { "Executor": "codex" },
  "codex": { "model": "gpt-6.2-sol", "auth": "siwc" }
}
```

Choose a model in the pinned CLI's embedded catalog. Remove Executor from
any `mounts` or `secretEnv` grant. The Executor uses the profile selected
for the Task.

From the agent-bootstrap checkout, use the same registered target for each
target-aware command. Review the setup plan before authorizing downloads
and any required image builds.

```sh
target=/absolute/path/to/registered-project
agent-bootstrap setup --target "$target" --json
agent-bootstrap setup --target "$target" --allow-network
agent-bootstrap codex authorize
agent-bootstrap doctor --target "$target"
```

Setup verifies the release archive and stages the verified executable
under `.local/codex/`. On a macOS terminal, `codex authorize` opens the
browser for approval with an eligible ChatGPT account and workspace.
The host saves the grant in Keychain. Doctor checks the binary, catalog and
grant presence. Presence alone says nothing about the next refresh.

Before each Executor VM starts, the host exchanges the saved grant for
one access token. The guest sees a placeholder in
`AGENT_BOOTSTRAP_SUBSCRIPTION_TOKEN`. Microsandbox receives the value in
its host create process and substitutes it into the authorization header
for `api.openai.com:443`. The guest uses the derived catalog with
`tool_search` disabled. A run has no mid-run refresh and the Codex provider
has request and stream retries disabled.

| Code                            | Action                                                                                                                            |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `config-invalid`                | Follow `next:` to supply a model, remove a conflicting grant, stage the pinned binary, or choose a model in the verified catalog. |
| `siwc-missing`, `siwc-rejected` | Run `agent-bootstrap codex authorize` and retry the failed Task. The Executor VM did not start.                                   |
| `siwc-unavailable`              | Check Keychain and connectivity, then retry the Task. The Executor VM did not start.                                              |
| `codex-auth`                    | The Executor reported that the provider rejected the credential. Inspect the execution.                                           |

### Operator live check

1. Complete the setup, authorization and doctor steps above for a
   disposable registered target. Start `agent-bootstrap workplace --target
"$target" --dev-bridge` and open its private loopback URL.
2. Ask Concierge for a Goal with one small documentation edit using the
   base Task profile. Approve the Goal and Task registrations as prompted.
   Wait for the Executor and Reviewer, then inspect Task detail. Confirm
   **Executor（Codex）** and the configured model appear on the Executor
   run and review the candidate before deciding whether to integrate it.
3. Inspect the same Task with `agent-bootstrap --target "$target" show
<task-ref>`, then run `agent-bootstrap --target "$target" show-execution
<execution-id>` for the Executor. In the host audit database printed at
   launch, check the same invocation for `siwc-refresh` with status
   `started` and `ok` before successful sandbox creation and scoped
   provider egress to `api.openai.com:443`. The guest command checks the
   exact placeholder before calling Codex, so a completed turn exercises
   that check without displaying the environment value.
4. Open ChatGPT Settings → Usage → App limits → Manage limits for
   `agent-bootstrap` in the account that authorized the grant. Look for
   current-period usage attributable to the run. The earlier PoC observed
   the app listing. Usage attribution in this flow remains unverified.
5. When finished testing, `agent-bootstrap codex forget` requests
   revocation and removes the saved Keychain item. If revocation cannot be
   confirmed, disconnect Agent Bootstrap in ChatGPT settings. With the
   configured Executor still selected, a new test Task should fail with
   `siwc-missing` before VM creation. Authorize again if you want to resume.

Gate B remains unverified, including broader DNS, IPv6, LAN and metadata
denial, redirect and alternate-origin behavior, all credential surfaces,
and live refresh races. [Sign in with ChatGPT evidence record](../codex-subscription-credential-poc.md#gate-a-and-gate-b-status)

## Start or resume

Update local `main` before starting a session, for example after merging
PRs. The launcher pins local `main` for the Concierge snapshot and new
Goal planning, regardless of the branch checked out at launch.

Register the bootstrap checkout once. From the repository root, preview
the launch with the direct launcher command. The linked command starts an
audited session with egress to
`api.anthropic.com:443` and `platform.claude.com:443`. The platform host
supports Claude Code's startup connectivity check. The gateway relays its
traffic without API key substitution. This is the default API-key policy.
Repository context and conversation content can reach the provider.

```sh
agent-bootstrap project add .
bun run spike/local-orchestrator/concierge.ts
agent-bootstrap concierge
```

Run one Concierge per target. Launchers for the same target in the same
agent-bootstrap checkout share the named session volume. The Concierge
uses it for its guest home and its default configuration directory.
A declared mount can replace that directory through the adapter's
environment allowlist. The launcher prints its session ID and audit database
path. Exit Claude Code to end the session and remove temporary files. If
the launcher process is terminated abruptly, its session record and
temporary files can remain until host-side cleanup, and the backend
lifetime still applies. To continue the latest conversation, use the same
target and `MSB_HOME` from the same agent-bootstrap checkout.

```sh
agent-bootstrap concierge --continue
```

The default Claude Code permission mode is `auto`. If Claude Code reports
that it cannot start in that mode, rerun with `--mode default`. The launcher
also accepts `--mode acceptEdits` and `--mode plan`.

## Start the operator workplace

```sh
agent-bootstrap workplace --target /path/to/project --dev-bridge
```

The workplace starts an audited Concierge in a host-managed terminal and
serves the operator API on the target's private Unix socket. It accepts
`--continue`, `--mode`, and `--claude-auth` and shares the same session
slot as the TTY launcher.

With `--dev-bridge`, open the private loopback URL printed at startup.
Keep the URL private. The page shows the Concierge terminal beside a
host panel. Open the **いま** pill to see running work, queue refs and
decisions you can answer in place. **Goal** groups work by whose turn it
is. Each Goal detail shows its running Tasks, decisions and failures.
When the Goal is ready to export, **ブランチを書き出す** opens a
confirmation for the local branch in the launch target. A copyable
CLI command is available below the action. Goal and Task
refs can be used in the CLI. Within a Goal detail, `#m` is shorthand for
the Task with that number in the Goal.

On a closed decision card, **承認** opens a one-line confirmation. Open
**詳細** to read the evidence and use **承認** directly. **承認して統合**
records approval for the runner to integrate the candidate. Select two
to twenty proposals to approve them together. If a proposal changes,
the card reopens with the refreshed details. Withheld fields block
approval from Workplace. If a delegated decision is still pending,
**自分で答える** opens the evidence and asks you to confirm that you are
answering in place of the AI. Use the TTY CLI with the same target for
on-behalf answers.

After approving a Goal, its card tracks planning until the next decision
for that Goal arrives. Use **Concierge に計画を頼む** to paste a draft
request into the terminal and press Enter when ready to send it.
The **問題** tab offers **やり直す** when a failed Task can be retried.
Confirming resets the Task's budget window and queues the same work.
**Goal を取り消す** requires a separate confirmation bound to the branch
head. If the Goal changes, review the updated Goal before confirming again.
**Concierge に相談** pastes a draft and moves focus to the terminal.

`F6` moves focus between the terminal and panel. `F` toggles the
panel's fullscreen view. `Esc` closes the activity popover first.
Open **いま** for environment status, including the key, lock and size.
For a missing or stale environment, **環境を作る** previews the network
destinations and builds in the background after confirmation.

Closing the browser leaves the session running. Choose **Workplace を終える**
in **いま** to end it. The confirmation shows the number of running Tasks
when any are active. The page reports when the session has ended. Ctrl-C
and SIGTERM initiate the same cleanup from the host. If shutdown hangs, press
Ctrl-C again to exit at once without cleanup, then run
`agent-bootstrap doctor`. A third Ctrl-C kills the launcher. The launcher
also stops when the workplace command ends for any reason, including
SIGKILL.

## Choose what the Reviewer can decide

**任せ方** controls the defaults for **Goal の登録**, **Task の登録**, and
**統合**. All three start at **人** and the rule list starts empty.
Choose **AI** to let the Reviewer answer eligible gates. The panel asks
for confirmation before changes that can widen delegation. Each Goal
can override Task registration and integration. Each Task can override
its own integration. **全体に従う** and **ルールに従う** defer to the next
applicable setting.

The host checks invariants first, then the Task override, the Goal
override, the first enabled rule that matches, and the project default.
An explicitly set project default supersedes any policy in model-written
content for that gate. Gates with untouched defaults retain their legacy
inheritance from approved model content. Existing in-scope Task
auto-registration applies until the operator configures the Task-registration
default, enables a Task-registration rule, or overrides registration on the
Goal. Other Task constraints still apply.

Integration requires passing verification and review for a Reviewer answer.
Changes to symbolic links and Concierge proposals require an operator
answer. Pending integration proposals from older databases also need an
operator answer when they lack the host's symlink check record. A model's request to widen delegation requires operator approval.
The Reviewer may still reject it when the gate allows delegated rejection.
Goal discard, explicit branch export and changes to Goal auto-merge are operator commands.

The **ルール** list is evaluated from top to bottom. Rules for Task
registration can check planned paths and the proposed maximum token
budget. Integration rules check the pinned candidate's changed paths and
Git diff counts. Changed lines are additions plus deletions. Binary
changes have an unknown line count, so they cannot match a line limit.
A missing count never matches a rule that requires it. A Planner's
category can narrow a rule that also checks a path, budget, or diff count.
The Task detail labels the category as the Planner's claim.

Use repository-relative patterns such as `docs/**` and `README.*`.
`*` matches within a path component and `**` is a whole component
that can span directories. To allow a planned directory and everything
in it, use a pattern such as `docs/**`. An exclusion also checks
descendants covered by a planned directory. Each rule shows how many gate
decisions it determined in the last seven days. **判断待ち** shows recent
Reviewer answers with the recorded policy source and the Reviewer's reason
as model text.

The TTY CLI uses the same target settings:

```sh
agent-bootstrap policy show
agent-bootstrap policy set integration human
agent-bootstrap policy goal <goalId> task-registration human
agent-bootstrap policy task <taskId> rule
agent-bootstrap policy rules set --file rules.json
```

For `policy rules set`, supply the entire ordered JSON array, with unique
IDs and consecutive zero-based `order` values. Pass an empty array to
clear the rules. For example:

```json
[
  {
    "id": "small-docs",
    "name": "Small documentation integrations",
    "gate": "integration",
    "action": "agent",
    "enabled": true,
    "order": 0,
    "conditions": {
      "pathsWithin": ["docs/**"],
      "pathsExclude": ["docs/private/**"],
      "maxChangedLines": 80,
      "maxChangedFiles": 4,
      "categories": ["docs"]
    }
  }
]
```

The target's events record the before and after values with origin `cli`
or `operator-ui`. A recorded decision keeps its original source when
settings change. The panel rejects an edit to a rule list or an override
that another operation changed after it was displayed.

## Work on another repository

Run the launcher and operator CLI from agent-bootstrap. Use the same
leading `--target` for operator commands to select the target's state.
The target must be a registered local SHA-1 Git worktree root with a
local `main` commit. Relative paths resolve from the operator's current
working directory. The launcher pins the target's local `main` for the
Concierge snapshot and seeds new Goals from that commit. Planner context
includes the target's `AGENTS.md`, `README.md`, and tracked file listing.
For agent-bootstrap, Planner context also includes its local-orchestrator
docs.

```sh
target="$HOME/ghq/github.com/hisamekms/dagq-lite"
agent-bootstrap project add "$target"
agent-bootstrap concierge --target "$target"
agent-bootstrap --target "$target" status
```

Each project uses `${XDG_STATE_HOME:-~/.local/state}/agent-bootstrap/projects/<name>/`
for `state.db`, `audit.sqlite`, Git integration and observability data.
Its conversation volume is `lo-concierge-<name>`. Register the bootstrap
checkout with `agent-bootstrap project add .` to use it as the default target.

### Configure verification for the target

Preload the pinned Bun profile image and include it in the agent-bootstrap
profile lock. Configure the command before starting the launcher.

```sh
agent-bootstrap --target "$target" verification set --profile bun -- bun test
agent-bootstrap --target "$target" verification set --profile bun --timeout-ms 1800000 -- bun run verify:full
agent-bootstrap --target "$target" verification show
agent-bootstrap --target "$target" verification clear
```

`set` and `clear` require a host terminal and the exact confirmation phrase
shown in the prompt. The CLI records changes in the target's state database
and stores the verification configuration in its private `local.json`. Clearing the local value reveals any approved
or user verification command.
The optional `claude` section shares that file. `show` prints
`null` when verification is unset. The launcher reads the configuration at
startup. Keep it in place until existing integration proposals are
resolved, so integration can recheck each candidate with the same command.

The credential-free Verification sandbox runs the fixed argv in the pinned
candidate workspace. Set `verification.timeoutMs` in `local.json` or use
`--timeout-ms` to set an integer from 1 to 3,600,000 milliseconds. The default
is 240,000 milliseconds. Verification uses the smaller of this timeout and
the Task's `maxExecutionMs`. Set both budgets high enough for the suite.
A nonzero exit uses the Task's revision budget. When available, the last
16 KiB of combined output is screened for credentials and saved in the
Executor's private revision notes. Task detail shows the latest screened
failure output. The journal records the raw tail's
SHA-256 digest alongside the verification result.
The VM keeps the command's full output in a file under `/tmp` until the
command exits, so a very noisy suite uses VM disk or memory for it.
A passing command allows review to proceed and the resulting
proposal records `verified: true`. Verification runs again at integration.
Without a suite, a human must answer the integration gate.

### Declare host checks for the target

Set `hostChecks` only in the target's private `local.json`. Open it with
`agent-bootstrap config edit --project <name>`.

```json
{
  "version": 1,
  "hostChecks": [
    {
      "name": "runtime",
      "argv": ["/opt/homebrew/bin/bun", "run", "test:runtime"],
      "timeoutMs": 1800000,
      "env": { "MSB_HOME": "/private/tmp/target-msb" },
      "keychain": [{ "service": "target-runner-key", "env": "RUNNER_KEY" }],
      "triggers": ["packages/runtime/", "test/runtime.ts"],
      "vmCount": 1
    }
  ]
}
```

Declare up to eight checks with unique names of 1 to 32 lowercase letters,
digits, or hyphens. Each needs an absolute executable path as the first of
up to 32 nonempty arguments and a timeout from 1,000 to 7,200,000 milliseconds.
Use `env` for up to 32 literal, non-secret values and `keychain` for up to
eight item names and their destination variables. Variable names use
`[A-Z_][A-Z0-9_]*` and must be distinct across both fields. The host reserves
`PATH`, `HOME`, and `TMPDIR`. Declare `MSB_HOME` in literal `env`.

List 1 to 64 repository-relative triggers. A trailing slash matches a directory
prefix. Without a trailing slash, a trigger matches only that exact path.
Omit `triggers` to require the check for every candidate. An empty list is
invalid. `vmCount` defaults to zero and accepts integers up to four. A positive
count requires absolute paths for both the check's `env.MSB_HOME` and
agent-bootstrap's effective Microsandbox home. The two homes must be distinct,
and neither may contain the other.

`agent-bootstrap doctor --target <path>` reports whether the executable and
declared Microsandbox home are available, along with trigger and VM counts
and Keychain item names. Matching Tasks run the checks in declaration order
after approval. The checks reserve the shared local VM job slot to validate
and run an approved batch. Product launchers sharing a user state directory
coordinate through that slot. The `sandbox shell`, `environment build`,
`secrets test`, and `build-profile` commands refuse to start while the runner
holds the slot for any job. Direct developer smoke scripts follow the
repository's one-VM rule. Each check receives a fresh export of the pinned
commit, a fresh home and temporary directory, and the cached environment
from Verification when one was pinned. Approve from the proposal detail using its approval digest
through the single-item operator API until the detail view supports approval.
A combined approval integrates on pass. Otherwise the runner opens the
integration gate.

Task detail shows the masked output tail and per-check result. The target's
state database records before and after audit events. A check failure sends
the masked tail to the Executor as revision notes if the shared Verification
and revision budget has attempts left. A tamper finding records the run as
`tampered`, and doctor and Task detail report the block. The runner pauses
all Tasks, revisions, integrations, and agent or delegated answers for the
target. The shared slot refuses new VM jobs until an operator clears the
block. Inspect and repair any changes to configuration, policies, or approval
records before clearing it. Goal publishing also pauses while a check is
running, interrupted or tampered. The operator cannot publish, merge or set
auto-merge on a PR until the check finishes or the block is cleared.
A `host-check-cleanup-failed`
outcome also stops the Task and preserves the process audit evidence.

After an interruption, doctor reports the check, proposal ID and declared
`MSB_HOME`. Inspect that home and clean up any leftover VMs before clearing
the block. For either an interrupted or tampered check, open the affected
Task in Workplace and use the host-check clear action. It calls the operator
API method `hostCheck.clearInterrupted` with the proposal ID as `id` and
`clear-interrupted-host-check <id>` as `confirm`. If the launcher
also left an active session, use the existing `reconcile` workflow. Retry
the failed Task to submit a fresh candidate for approval.
[Host checks ADR](../host-checks/adr-0001-host-checks.md)

### Run with secret files

Before collecting output for a [secret-file run](../agent-guide.md#secrets),
the Worker launcher removes newly created empty sandbox placeholders and
preserves pre-existing paths.

## Troubleshooting

### Claude Code cannot reach platform.claude.com

If interactive Claude Code exits at startup with "Unable to connect to
Anthropic services / Failed to connect to platform.claude.com: ENOTFOUND",
check the network audit. A denied DNS lookup for `platform.claude.com` with
reason `dns-not-allowlisted` means the checkout predates commit `41ea517`.
That commit allows `platform.claude.com:443` for the Concierge only, without
credential substitution. Update to a checkout that includes it, then rerun
the launcher.

```sh
agent-bootstrap concierge
```

### MCP tool calls return invalid-arguments

If a Concierge MCP tool call such as `status` returns `invalid-arguments`,
the Host API rejected MCP `_meta` in `tools/call` params. Commit `d45c1f8`
fixed this. Update to a checkout that includes the fix and restart the
launcher. To continue the conversation, use the same checkout and
`MSB_HOME`.

```sh
agent-bootstrap concierge --continue
```

## Recover after a crash

After confirming the launcher has stopped, run the operator CLI from a
host terminal. If you use an explicit database, pass the same `--db`
you use for the other operator commands.

The session slot records unfinished work even after a crash. It does
not establish that its owner has exited, so Workplace leaves crash
recovery to the operator who can verify that the launcher has stopped.

```sh
agent-bootstrap reconcile
```

The command displays the active sessions, queued or running executions,
and running Tasks. Type `reconcile <count>` with the combined count shown
in the prompt. The transaction ends the sessions and marks unfinished executions and ordinary running Tasks
failed with code `interrupted`. The CLI prints the affected
records. Reconciliation performs no replay and leaves pending proposals
available for operator review. If the preview changes before confirmation,
run the command again to see the current records.

For an interrupted or uncertain integration, reconciliation also checks the
private Goal branch and integration journal. It records success when the ref
is at the authorized candidate, or fails the Task with
`integration-interrupted` when the ref is still at the approved base. If the
ref points elsewhere, inspect it and its journal before continuing. With a
custom `--db`, pass `--target <path>` before `reconcile` so it can locate the
target's private repository.

## Diagnose and retry a failed Task

In Workplace, open the Task and expand **Task の詳細** to see recent
execution result codes, guidance for known failures, and the environment
key and cache/build status when available. Use **やり直す** in **問題**
to confirm a retry. For `env-missing`, check the environment in **いま**
and build it before retrying.

Use the Reviewer execution ID from the Concierge status or operator
events to inspect a failed review or invalid agent approval verdict.
When available, the execution result contains a bounded `rawAnswer`.
The CLI escapes terminal control characters in that model text.

```sh
agent-bootstrap show-execution <executionId>
agent-bootstrap retry-task <taskId>
```

For a failed Task, type the confirmation shown at the host terminal prompt.
The prompt displays the canonical short ref if you invoked the command with one. The scheduler can pick up the registered Task during an
active Concierge session or the next launch. Each Task allows three
operator retries. Each retry starts a fresh token budget window.
Use `show <taskId>` to see the current budgeted usage and the total
across all attempts. Use the same `--db` as the launcher if you supplied
a custom path.

## Use short Goal and Task refs

Each target repository has its own Goal sequence. Approving a Goal assigns a
ref such as `G12`. Registering a Task assigns the next ref within its Goal,
such as `G12-3`. Refs stay with cancelled rows. UUIDs remain valid wherever
the CLI takes a Goal or Task ID, and short refs are case-insensitive.

```sh
agent-bootstrap show g12
agent-bootstrap show G12-3
agent-bootstrap retry-task G12-3
agent-bootstrap events --subject g12-3
agent-bootstrap discard-goal G12
agent-bootstrap export-goal-branch G12
```

See the [operator activity API](../operator-ui/activity-api.md) for the
Workplace protocol. Proposal and execution IDs still identify their own
records. The Concierge
`get_goal`, `request_planner` Goal argument, and `draft_task` Goal and Task
dependency arguments also take short refs.

## Update an untouched Goal to local main

Keep your local `main` current before starting the launcher. If an active
Goal already has a pinned branch and its Tasks need changes from a newer
local `main`, open Goal detail and choose **ベースを更新する**. Review the
short hashes for the old and new bases and type the displayed phrase.
If either commit changes before submission, review and confirm again.
The CLI also accepts the same confirmation format.

```sh
agent-bootstrap update-goal-base <goalId>
```

Use the Goal ref or UUID. Review the two commit IDs, then type
`update-goal-base <goalId> <first 12 hex of new base>` at the prompt. With
a custom `--db <path>`, also pass `--target <path>` for the repository the
launcher targeted. The command uses that repository's local `main` and performs
no network fetch.

The Goal branch must still point to its recorded base. A running,
awaiting-integration, or succeeded Task, or a pending integration proposal
blocks the update. Failed Tasks stay failed. Use `retry-task <taskId>` to
start a fresh budget window and a new attempt journal on the updated base.
Use `show <goalId>` or `get_goal` to read the recorded `baseCommit`.

The command first moves the Git ref with compare-and-swap, then commits
the new base and its `goal.base-updated` event together in SQLite. If
recording fails or the command is interrupted after the ref moves, Git and
SQLite can disagree. Inspect the private Goal branch and the stored base
and event before retrying.

## Discard an active Goal

Run `agent-bootstrap discard-goal <goalId>` from a host terminal. With a
custom database, pass the launcher's live `--db <path>` and its `--target <path>`.
Review the preview, then type `discard-goal <goalId> <first 12 hex of head>`
or `discard-goal <goalId> none` if the private branch is absent.

Running or awaiting-integration Tasks, queued or running executions, and
pending integration proposals block discard. After confirmation, the command
records a durable `goal.discard-authorized` event, rechecks eligibility, and
deletes the private branch only at the confirmed head,
or verifies its absence. It cancels the Goal and its registered Tasks and
records the discarded head in a `goal.status` event. Its inbox items move to
resolved history. Export and base updates refuse cancelled Goals.

Git and SQLite can disagree if recording fails or the command is interrupted
after the ref is deleted. Inspect the private branch and the Goal's stored
status and events before retrying.

## Review proposals

Use another host terminal for approval. The Concierge can draft proposals
and request Planner executions through its MCP tools.

```sh
agent-bootstrap status
agent-bootstrap proposals --status pending
agent-bootstrap show <proposalId>
agent-bootstrap approve <proposalId>
```

With a custom `--db <path>`, also supply `--target <path>` when
showing, approving or rejecting an integration proposal. Use the same
target path the launcher used so the CLI can find its pinned candidate.

Treat the target state, audit, observability files, and persistent Claude
conversation volume as sensitive.

## Approve and export a Goal branch

Use `show <proposalId>` to inspect the pinned integration diff stat. Run
`approve <proposalId>` and type `approve <first 12 hex of proposal digest>`.
Use a host terminal. If verification is unset, a human answer is required
even when the Goal allows agent approval. The
running launcher polls for decisions, and approved proposals can also be
picked up on its next launch. Use `show <taskId>` to check for
`succeeded` and `events --subject <taskId>` to see the integrated head.

When the Goal branch is ready for handoff, open its detail in Workplace
and choose **ブランチを書き出す**. Review the destination, branch name and
commit range, then choose **書き出しを確定**. If the Goal changes, review
the refreshed detail and confirm again. The host screens the Goal's
changes for credentials before exporting and records the same export
events as the CLI. When a Goal has a null `baseCommit`, scanning starts
from the first integration's base commit. If that base is missing,
the host refuses export with `invalid-object`.

To export from a host terminal, run:

```sh
agent-bootstrap [--target <path>] export-goal-branch <goalId> [--target <checkout>]
```

Type `export-goal-branch <goalId> <first 12 hex of new head>` as shown.
The leading `--target` selects the repository and its host-side state. The
export writes the branch into that repository by default. A trailing
`--target` selects a different destination checkout. The CLI accepts
`--repo` as an alias in either position. If you set a custom database path,
supply both the leading `--db <path>` and `--target <path>`.

Both commands create or fast-forward the branch locally. Switch away
from the destination branch in any worktree where it is checked out.
A branch with commits outside the Goal cannot be fast-forwarded.
If the branch already points to the Goal head, there is nothing to export.
With publishing disabled, use your usual Git workflow to publish an
exported branch.

## Publish a Goal to GitHub

Set this in the project's private `local.json` with
`agent-bootstrap config edit --project <name>`. The user configuration layer can set the remote, base, merge method and auto-merge defaults.

```json
{
  "version": 1,
  "publish": {
    "enabled": true,
    "remote": "origin",
    "base": "main",
    "autoMerge": "off",
    "mergeMethod": "squash"
  }
}
```

Publishing is off by default. The remote and base default to `origin`
and `main`. Use an existing GitHub remote with Git push authentication
configured in the launch checkout and an existing host `gh` login.
For HTTPS, configure a Git credential helper before the first run.
Configure the repository and its branch protection in GitHub.

For Goals that finish after the Workplace first observes the project opt-in,
the host exports the local `lo/goal-<id8>` branch, pushes the exact commit
to `ab/<goal-ref>-<id8>`,
and opens or finds the PR. The host screens the export and PR text and
records each outward step in the Goal journal and the append-only
`goal_publish_audit` table in the private target state database. After all Tasks
are integrated, Workplace shows an open PR under the operator's turn. It
records the Goal as done when the PR merges the current host-pushed head.
In Workplace, merge or close the PR from the decision card or Goal overview.
The merge method defaults to `publish.mergeMethod`. When GitHub auto-merge
is armed, the PR appears in the folded auto-merge section. Closing the PR
keeps its branch.
If the PR closes without merging, use the Goal overview to publish again or
discard the Goal. A retry recreates a deleted remote branch. If the branch
points to an unexpected commit, restore the last host-pushed head before
retrying. Git rejects non-fast-forward pushes.

Task registration, integration and Goal base updates return `goal-pr-open`
while the Goal's PR is open or merged. Close an open PR or discard
the Goal to continue. A discarded Goal triggers an audited auto-merge disable
on its open PR even when publishing is disabled. When publishing is enabled,
an unexpected PR head also triggers a disable. Once the expected head is
restored, use `publish-goal` to resume. If a PR merged a stale or foreign head,
Workplace shows `merged-stale`. Review the merged commit in GitHub, then use
「手で完了にする」 or `complete-goal` to record the Goal as done. The
same action is available if a merged Goal still has unfinished legacy work.
The confirmation identifies the PR number and full merged head.

Workplace polls open PRs for changes in checks, auto-merge and PR state even
when publishing is disabled. Routine
polling slows to ten-minute intervals after the first hour and stops at merge
or closure. Goals that finish while publishing is disabled require
`publish-goal`, including after publishing is re-enabled. Use the same command
for Goals that finished before the first opt-in or to retry a failed publish.
If discarding a Goal schedules an auto-merge disable, the CLI preview and API
response include `autoMergeDisarmPending`. The running Workplace performs the
disable and retries failures reported as `auto-merge-disarm-failed`.

```sh
agent-bootstrap --target <checkout> publish-goal <goal>
agent-bootstrap --target <checkout> merge-goal <goal> [--method <squash|merge|rebase>] [--no-checks]
agent-bootstrap --target <checkout> close-goal-pr <goal>
agent-bootstrap --target <checkout> set-auto-merge <goal> <off|squash|merge|rebase>
agent-bootstrap --target <checkout> complete-goal <goal>
```

The Goal overview also offers these actions and shows the PR, check results,
and current auto-merge setting. Workplace Settings shows the project defaults.
These CLI commands use typed TTY confirmations. `publish-goal` pins the
displayed head for a retry. `merge-goal` requires passed checks or zero checks
with `--no-checks`. The confirmation phrase includes `checks=passed` or
`checks=none` and must match the latest check state. Use auto-merge while
checks are pending or unknown. New Goals inherit the configured auto-merge
default at registration. An operator can override it for an individual
Goal. The running host applies setting changes to open PRs. When
GitHub reports that auto-merge is unavailable, the PR stays open for the
operator and Workplace shows a note about the GitHub settings.

Use `agent-bootstrap events --subject <goal>` to inspect publish
events. An interrupted publish is reconciled against the remote branch
and PR when the Workplace restarts.
If a Goal is cancelled just after the host writes the merge authorization,
the in-flight call may still merge the PR. The publish audit records the
authorization and the observed PR outcome.

## Analyze runs

Use `analyze` with the default checkout, the same `--target` argument as the
launcher, or `--all-targets` to compare projects. See [DuckDB analysis](analysis.md)
for the private export layout, view definitions and query examples.

## Bun packages in Task VMs

Use `agent-bootstrap config edit --project <name>` to add
`"environment": { "enabled": true }` to the target's private `local.json`.
The same setting in user configuration applies to all targets unless a target
overrides it. Environment delivery defaults to off. It uses the local cache
and never reaches the network. After committing dependency changes to local
`main`, run `agent-bootstrap environment build --target <dir> --allow-network`.
Tasks using the stored environment show a cache hit (「キャッシュ」) in Task
detail.

Use the `bun` profile for Executor and Verification. Executor gets the
packages for the Task base, and Verification gets the packages for the pinned
candidate. Both can run commands such as `bun test` with workspace imports
and tools from `node_modules/.bin`. Packages are excluded from candidate
changes. The recent executions in Task detail show the keys and cache hits.

With delivery enabled, set `environment.autoBuild` to `true` in private
configuration to authorize package network for the credential-free
Provisioner on cache misses before Executor or Verification starts. By
default, a missing key fails the Task with `env-missing` before the
corresponding VM starts. Verification remains offline. See the
[Bun environment guide](../environments/README.md) for allowed destinations
and cache management.
