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
  `.local/claude-code/2.1.330/linux-arm64-musl/claude` in this checkout,
  or set `LO_CLAUDE_BINARY` to its absolute path. Stage the pinned Alpine
  packages under `.local/alpine/v3.23/main/aarch64/`. The filenames and
  checksums are in `src/claude-code.ts`.
- For default API-key mode, provision the API key in Keychain and configure
  its service name in the [private config file](../claude-code-auth.md#setup).
  `LO_CLAUDE_MODEL` defaults to `claude-opus-5-5`.

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
host panel. **判断待ち** shows the inbox, proposal details and a
copyable CLI command. **問題** links failures, rejected paths and budget
overruns to their Task or Goal. **Goal** shows Task progress and estimates
for the current plan based on completed work in this target. Task details show the stage,
attempts, elapsed time, token usage, acceptance criteria and recent events.
`F6` moves focus between the terminal and panel. Closing the browser
leaves the session running. To end it, press Ctrl-C or send SIGTERM to the
workplace process. The launcher closes the operator API and the bridge at
shutdown. If that shutdown hangs, press Ctrl-C again to exit at once
without cleanup, then run `agent-bootstrap doctor`. A third Ctrl-C kills
the launcher. The launcher also stops when the workplace command ends for
any reason, including SIGKILL.

In **判断待ち**, choose **承認** or **却下** on a proposal that needs the
operator. **承認して統合** records approval for the runner to integrate
the candidate. Check the proposal kind, model-generated title and
pinned digest prefix, then choose **確定** to record the answer.
Select two to twenty proposals to approve them in one confirmation.
The panel reports the outcome for each proposal and refreshes the inbox.
If a proposal changed, review the refreshed details before answering
again. The copyable CLI command remains available as a fallback. Use the
TTY CLI with the same target for on-behalf answers.

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
Goal discard and branch export remain operator commands.

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
candidate workspace. Its timeout is bounded by the Task's execution time
budget and the runtime limit. A nonzero exit uses the Task's revision
budget. A passing command allows review to proceed and the resulting
proposal records `verified: true`. Verification runs again at integration.
Without a suite, a human must answer the integration gate.

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
local `main`, update it from a host terminal.

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

When the Goal branch is ready for handoff, run:

```sh
agent-bootstrap [--target <path>] export-goal-branch <goalId> [--target <checkout>]
```

Type `export-goal-branch <goalId> <first 12 hex of new head>` as shown.
The leading `--target` selects the repository and its host-side state. The
export writes the branch into that repository by default. A trailing
`--target` selects a different destination checkout. The CLI accepts
`--repo` as an alias in either position. If you set a custom database path,
supply both the leading `--db <path>` and `--target <path>`.

The branch is created or fast-forwarded locally. A divergent branch or
one checked out in any worktree must be resolved before exporting.
Review the exported branch, then push it and open a PR to `main`
from your usual Git workflow.

## Analyze runs

Use `analyze` with the default checkout, the same `--target` argument as the
launcher, or `--all-targets` to compare projects. See [DuckDB analysis](analysis.md)
for the private export layout, view definitions and query examples.
