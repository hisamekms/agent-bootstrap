# Run the local Concierge

Use a macOS operator terminal with OSC 52 clipboard access disabled. Guest
output reaches that terminal directly. See the [terminal trust boundary](../trust-model.md)
for details.

## Prepare the host

- Install Bun and the mise-pinned Microsandbox 0.7.16 tool. Set
  `MSB_HOME` to an absolute path at most 40 bytes after symlink resolution.
  Preload the digest-pinned Concierge image from
  `images/profiles.lock.json` and the pinned Alpine base image in that
  Microsandbox home. The base image serves Planner runs.
- Stage the pinned Alpine arm64 Claude CLI at
  `.local/claude-code/2.1.330/linux-arm64-musl/claude` in this checkout,
  or set `LO_CLAUDE_BINARY` to its absolute path. Stage the pinned Alpine
  packages under `.local/alpine/v3.23/main/aarch64/`. The filenames and
  checksums are in `src/claude-code.ts`.
- Provision a generic password in macOS Keychain for your current account
  (`$USER`). Set `LO_CLAUDE_KEYCHAIN` to its service name and
  `LO_CLAUDE_AUTH` to `operator:ANTHROPIC_API_KEY:x-api-key` for an
  Anthropic API key. The launcher reads the value from Keychain and the
  Claude guest receives a backend placeholder. `LO_CLAUDE_MODEL` defaults
  to `claude-opus-5-5`.

## Start or resume

Update local `main` before starting a session, for example after merging
PRs. The launcher pins local `main` for the Concierge snapshot and new
Goal planning, regardless of the branch checked out at launch.

From the repository root, preview the launch with the first command. The
second command starts an audited session with egress to
`api.anthropic.com:443` and `platform.claude.com:443`. The platform host
supports Claude Code's startup connectivity check. The gateway relays its
traffic without credential substitution.
Repository context and conversation content can reach the provider.

```sh
bun run spike/local-orchestrator/concierge.ts
bun run spike/local-orchestrator/concierge.ts --run
```

Run one Concierge per target. Launchers for the same target in the same
agent-bootstrap checkout share the conversation volume. The launcher prints its session ID and audit database
path. Exit Claude Code to end the session and remove temporary files. If
the launcher process is terminated abruptly, its session record and
temporary files can remain until host-side cleanup, and the backend
lifetime still applies. To continue the latest conversation, use the same
target and `MSB_HOME` from the same agent-bootstrap checkout.

```sh
bun run spike/local-orchestrator/concierge.ts --run --continue
```

The default Claude Code permission mode is `auto`. If Claude Code reports
that it cannot start in that mode, rerun with `--mode default`. The launcher
also accepts `--mode acceptEdits` and `--mode plan`.

## Work on another repository

Run the launcher and operator CLI from agent-bootstrap. Use the same
leading `--target` for operator commands to select the target's state.
The target must be a local SHA-1 Git worktree root outside `.local/` with
a local `main` commit. Relative paths resolve from the operator's current
working directory. The launcher pins the target's local `main` for the
Concierge snapshot and seeds new Goals from that commit. Planner context
includes the target's `AGENTS.md`, `README.md`, and tracked file listing.
For agent-bootstrap, Planner context also includes its local-orchestrator
docs.

```sh
target="$HOME/ghq/github.com/hisamekms/dagq-lite"
bun run spike/local-orchestrator/concierge.ts --run --target "$target"
bun run src/local-orchestrator/cli.ts --target "$target" status
```

Each external target uses
`.local/local-orchestrator/targets/<slug>/` in agent-bootstrap for
`state.db`, `audit.sqlite`, `repository.git`, `integrations/`,
`worktrees/`, `snapshots/`, and runtime observability files. The slug
uses the target's basename and an abbreviated SHA-256 hash of its
canonical path. Its conversation volume is `lo-concierge-<slug>`.
The agent-bootstrap target keeps its existing paths directly in
`.local/local-orchestrator/` and its existing conversation volume name.

### Configure verification for the target

Preload the pinned Bun profile image and include it in the agent-bootstrap
profile lock. Configure the command before starting the launcher.

```sh
bun run src/local-orchestrator/cli.ts --target "$target" verification set --profile bun -- bun test
bun run src/local-orchestrator/cli.ts --target "$target" verification show
bun run src/local-orchestrator/cli.ts --target "$target" verification clear
```

`set` and `clear` require a host terminal and the exact confirmation phrase
shown in the prompt. The CLI records changes in the target's state database
and stores the configuration in its private `config.json`. `show` prints
`null` when verification is unset. The launcher reads the configuration at
startup. Keep it in place until existing integration proposals are
resolved, so integration can recheck each candidate with the same command.

The credential-free Verification sandbox runs the fixed argv in the pinned
candidate workspace. Its timeout is bounded by the Task's execution time
budget and the runtime limit. A nonzero exit uses the Task's revision
budget. A passing command allows review to proceed and the resulting
proposal records `verified: true`. Verification runs again at integration.
Without a suite, a human must answer the integration gate.

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
bun run spike/local-orchestrator/concierge.ts --run
```

### MCP tool calls return invalid-arguments

If a Concierge MCP tool call such as `status` returns `invalid-arguments`,
the Host API rejected MCP `_meta` in `tools/call` params. Commit `d45c1f8`
fixed this. Update to a checkout that includes the fix and restart the
launcher. To continue the conversation, use the same checkout and
`MSB_HOME`.

```sh
bun run spike/local-orchestrator/concierge.ts --run --continue
```

## Recover after a crash

After confirming the launcher has stopped, run the operator CLI from a
host terminal. If you use an explicit database, pass the same `--db`
you use for the other operator commands.

```sh
bun run src/local-orchestrator/cli.ts reconcile
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
bun run src/local-orchestrator/cli.ts show-execution <executionId>
bun run src/local-orchestrator/cli.ts retry-task <taskId>
```

For a failed Task, type `retry-task <taskId>` with the full ID at the host
terminal prompt. The scheduler can pick up the registered Task during an
active Concierge session or the next launch. Each Task allows three
operator retries. Each retry starts a fresh token budget window.
Use `show <taskId>` to see the current budgeted usage and the total
across all attempts. Use the same `--db` as the launcher if you supplied
a custom path.

## Update an untouched Goal to local main

Keep your local `main` current before starting the launcher. If an active
Goal already has a pinned branch and its Tasks need changes from a newer
local `main`, update it from a host terminal.

```sh
bun run src/local-orchestrator/cli.ts update-goal-base <goalId>
```

Use the full Goal ID. Review the two commit IDs, then type
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

## Review proposals

Use another host terminal for approval. The Concierge can draft proposals
and request Planner executions through its MCP tools.

```sh
bun run src/local-orchestrator/cli.ts status
bun run src/local-orchestrator/cli.ts proposals --status pending
bun run src/local-orchestrator/cli.ts show <proposalId>
bun run src/local-orchestrator/cli.ts approve <proposalId>
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
bun run src/local-orchestrator/cli.ts [--target <path>] export-goal-branch <goalId> [--target <checkout>]
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
