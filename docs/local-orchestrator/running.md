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

Run one Concierge per checkout. Launchers in the same checkout share the
conversation volume. The launcher prints its session ID and audit database
path. Exit Claude Code to end the session and remove temporary files. If
the launcher process is terminated abruptly, its session record and
temporary files can remain until host-side cleanup, and the backend
lifetime still applies. To continue the latest conversation, use the same
checkout and `MSB_HOME`.

```sh
bun run spike/local-orchestrator/concierge.ts --run --continue
```

The default Claude Code permission mode is `auto`. If Claude Code reports
that it cannot start in that mode, rerun with `--mode default`. The launcher
also accepts `--mode acceptEdits` and `--mode plan`.

## Recover after a crash

After confirming the launcher has stopped, run the operator CLI from a
host terminal. If you use an explicit database, pass the same `--db`
you use for the other operator commands.

```sh
bun run src/local-orchestrator/cli.ts reconcile
```

The command displays the active sessions, queued or running executions,
and running Tasks. Type `reconcile <count>` with the combined count shown
in the prompt. The transaction ends the sessions and marks the executions
and Tasks failed with code `interrupted`. The CLI prints the affected
records. Reconciliation performs no replay and leaves pending proposals
available for operator review. If the preview changes before confirmation,
run the command again to see the current records.

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
a custom `--db <path>`, also pass `--repo <root>` for the checkout the
launcher used. The command uses that checkout's local `main` and performs
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

With a custom `--db <path>`, also supply `--repo <root>` when
showing, approving or rejecting an integration proposal. Use the same
checkout root the launcher used so the CLI can find its pinned candidate.

State stays in `.local/local-orchestrator/state.db`. The runtime audit is
in `.local/local-orchestrator/audit.sqlite` and OTLP files are under
`.local/local-orchestrator/observability/`. Treat those records and the
persistent Claude conversation volume as sensitive.
