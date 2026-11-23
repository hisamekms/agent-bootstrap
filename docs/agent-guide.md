# agent-bootstrap operator manual

Run these commands on the operator host. Paste this manual into the agent's context when it will drive the workflow.

Use a leading `--target <path>` for operator commands. Use `--all-targets` for analyze or denials. Put `--target <path>` after doctor, concierge, credentials, or login. Custom databases use leading `--db <file>` where supported. Put `--json` before the verification command's `--` delimiter.

Replace shell variables such as `$task_id` with full IDs from status and use the same target throughout.

Machine-readable errors use `{ error, next }` unless a completed doctor run reports prerequisite checks. Other next hints may appear on stderr.

- `0` Success.
- `1` Command failed or was refused.
- `2` Invalid command or arguments.
- `3` Required prerequisites are missing.

## start

Install the linked command and check this machine and a project checkout.

**Prerequisites**  
An agent-bootstrap checkout, macOS arm64, Bun 1.4.4, and a local SHA-1 Git target with local main.

```sh
bun install --frozen-lockfile --ignore-scripts && bun link
agent-bootstrap doctor --json
agent-bootstrap doctor --target /path/to/project
```

**Expected output**  
Doctor reports ok, missing, wrong, or skipped for each check and prints one next action. DuckDB, db and browser assets, and target verification are optional.

**Next action**  
Run agent-bootstrap help setup, then repeat doctor after setup.

**Human involvement**  
The operator updates local main, pushes branches, and opens pull requests.

## setup

Stage SHA-256-pinned guest artifacts and build the locked Concierge and Bun images.

**Prerequisites**  
Use doctor to prepare Bun, mise, Microsandbox 0.7.16, installed checkout dependencies, and a short absolute MSB_HOME.

```sh
mkdir -p "$HOME/.msb"
export MSB_HOME="$HOME/.msb"
mise --no-config --no-env --no-hooks install microsandbox@0.7.16
agent-bootstrap setup --json
agent-bootstrap setup --allow-network
agent-bootstrap setup --allow-network --profiles
config_dir="${XDG_CONFIG_HOME:-$HOME/.config}/agent-bootstrap"
mkdir -p "$config_dir"
(umask 077; set -C; printf '%s\n' '{"claude":{"apiKey":{"keychainService":"agent-bootstrap-claude"}}}' > "$config_dir/config.json")
security add-generic-password -s agent-bootstrap-claude -a "$(id -un)" -w
```

**Expected output**  
Default setup prints pinned URLs, hashes and image references. Applying setup downloads missing inputs and builds missing images sequentially. The optional browser build pulls a pinned Debian base and uses the existing Debian snapshot recipe over HTTP with signed and hash-pinned release metadata. A digest mismatch stops setup before the image is published under its locked reference.

**Next action**  
API-key mode is the default. Enter the API key at the Keychain prompt, then run agent-bootstrap doctor.

**Human involvement**  
Authorize network access and VM builds. Agents may pass --allow-network --yes only with explicit authorization. Provision Keychain from the operator terminal.

## concierge

Open or resume the interactive Concierge that drafts plans and runs the local actor queue.

**Prerequisites**  
Passing launch prerequisites, an operator TTY, and OSC 52 clipboard access disabled.

```sh
agent-bootstrap concierge --target /path/to/project
agent-bootstrap concierge --target /path/to/project --continue
agent-bootstrap concierge --target /path/to/project --mode default
```

**Expected output**  
The launcher prints its session ID and audit database path and opens Claude Code. In JSON mode the interactive stream uses stderr and stdout receives a final status object.

**Next action**  
Describe the desired Goal in the Concierge and inspect proposals from a second host terminal.

**Human involvement**  
The operator starts the session and reviews provider access and costs. The operator updates local main, pushes branches, and opens pull requests.

## goals

Use the Concierge to draft Goals and Tasks, then inspect their progress through the operator CLI.

**Prerequisites**  
An active Concierge session and the same target in both terminals.

```sh
agent-bootstrap --target /path/to/project status --json
agent-bootstrap --target /path/to/project proposals --status pending --json
agent-bootstrap --target /path/to/project show "$proposal_id" --json
agent-bootstrap --target /path/to/project show "$goal_id" --json
agent-bootstrap --target /path/to/project show "$task_id" --json
```

**Expected output**  
Ask the Concierge to request goal-design from the Planner and present the Goal proposal. Once registered, ask the Concierge to request task planning for that Goal and draft Tasks with acceptance criteria, scoped paths, and dependencies. Eligible Tasks run in the actor queue and a passing review creates an integration proposal.

**Next action**  
Use agent-bootstrap help approve to review gate decisions. Check status again after the runner consumes them.

**Human involvement**  
The operator answers human-policy gates unless they explicitly delegate a terminal answer.

## approve

Review a pinned proposal, record an answer, and export the completed Goal branch locally.

**Prerequisites**  
A proposal ID from status or proposals and a host TTY for decisions or export.

```sh
agent-bootstrap --target /path/to/project policy show --json
agent-bootstrap --target /path/to/project show "$proposal_id" --json
agent-bootstrap --target /path/to/project approve "$proposal_id"
agent-bootstrap --target /path/to/project reject "$proposal_id"
agent-bootstrap --target /path/to/project approve "$proposal_id" --on-behalf --delegate-session "$session_id" --authorization "$authorization"
agent-bootstrap --target /path/to/project export-goal-branch "$goal_id"
```

**Expected output**  
Review the digest, effective policy and integration diff stat, choose approve or reject, and type the exact confirmation phrase. Export previews the destination and heads before confirmation.

**Next action**  
Wait for integration in status. Review the exported lo/goal-* branch before the operator pushes it and opens a PR.

**Human involvement**  
The operator answers human-policy gates unless they explicitly delegate a terminal answer. The operator updates local main, pushes branches, and opens pull requests.

## audit

Follow proposal decisions, actor executions, and network denials.

**Prerequisites**  
A prior or active run for this target and DuckDB 1.5.6 for denial summaries.

```sh
agent-bootstrap --target /path/to/project events --subject "$task_id" --limit 50 --json
agent-bootstrap --target /path/to/project show-execution "$execution_id" --json
agent-bootstrap --target /path/to/project denials --limit 20 --json
agent-bootstrap --all-targets denials --since 2026-11-23 --limit 20
```

**Expected output**  
Events and executions provide IDs and outcomes, and denials provide grouped reasons plus requested detail rows. The launcher records trusted-host evidence in audit.sqlite.

**Next action**  
Join execution IDs to audit invocation IDs. Inspect the integration journal for an uncertain private Git update.

**Human involvement**  
Get operator authorization before sharing audit, telemetry, or model output.

## performance

Export trace, audit, and orchestrator data and query latency, outcomes, usage, and cost.

**Prerequisites**  
Locally recorded runs. The export works without DuckDB, while report queries use mise's DuckDB 1.5.6. To install it, run mise --no-config --no-env --no-hooks install duckdb@1.5.6.

```sh
agent-bootstrap --target /path/to/project analyze --json
agent-bootstrap --all-targets analyze --out ./private-analysis
agent-bootstrap --all-targets analyze --out ./private-analysis --sql ./report.sql
```

**Expected output**  
The CLI creates a private export and prints input issues, actor_summary, goal_summary, gate_latency, and a manual DuckDB command for load.sql.

**Next action**  
Inspect input_issues and sample counts before comparing latency or cost across actors or targets.

**Human involvement**  
Use SQL and export destinations authorized by the operator.

## targets

Select a repository and configure a pinned candidate verification command.

**Prerequisites**  
A SHA-1 Git worktree root with local main, outside .local, and a locked, installed verification profile.

```sh
agent-bootstrap doctor --target /path/to/project
agent-bootstrap --target /path/to/project verification set --profile bun -- bun test
agent-bootstrap --target /path/to/project verification show --json
agent-bootstrap --target /path/to/project verification clear
agent-bootstrap --target /path/to/project update-goal-base "$goal_id"
```

**Expected output**  
Verification show returns its configuration or null. Set and clear require confirmation. Base updates require an eligible, untouched Goal and preview both commits.

**Next action**  
Launch with the same target. Keep verification configured until its integration proposals are resolved.

**Human involvement**  
The operator confirms verification changes and eligible base updates from a host TTY. The operator updates local main, pushes branches, and opens pull requests.

## troubleshoot

Diagnose missing prerequisites, interrupted sessions, and failed Tasks.

**Prerequisites**  
Use the same target and database as the launcher. Stop the launcher before reconciling.

```sh
agent-bootstrap doctor --target /path/to/project
agent-bootstrap --target /path/to/project reconcile
agent-bootstrap --target /path/to/project show-execution "$execution_id" --json
agent-bootstrap --target /path/to/project retry-task "$task_id"
agent-bootstrap concierge --target /path/to/project --continue --mode default
```

**Expected output**  
Reconcile previews unfinished records before confirmation. Retry registers a failed Task with a new attempt. Claude failures can include a fixed code and next action. Doctor reports the effective authentication mode and its source.

**Next action**  
Check status for the new attempt. If integration remains uncertain, inspect the private ref and integration journal before retrying.

**Human involvement**  
The operator confirms reconciliation and retries from a host TTY.

## safety

Keep host credentials, repository integration, and human approvals inside their intended trust boundaries.

**Prerequisites**  
An operator who controls Keychain, target selection, terminal settings, and gate policy.

```sh
agent-bootstrap --target /path/to/project policy show --json
agent-bootstrap --target /path/to/project proposals --status pending --json
agent-bootstrap setup --json
```

**Expected output**  
Policy reports goal-registration, task-registration, and integration defaults. Proposals carry the effective policy and human-answer requirement.

**Next action**  
Review the proposed paths, verification result, digest, and policy before answering each gate.

**Human involvement**  
The operator updates local main, pushes branches, and opens pull requests. The operator answers human-policy gates unless they explicitly delegate a terminal answer. Keep API keys in Keychain. In config-dir mode, processes inside a Claude VM can read the mounted group directory. Researcher and verification receive neither the directory nor its egress policy.

## credentials

Manage the encrypted volume for persistent Claude Code configuration directories per actor group, signed in with the CLI's own /login.

**Prerequisites**

A private config.json with the volume path, Keychain service name and actor groups. API-key mode remains the default.

**Expected output**

Status reports attachment, active leases and stale state. Init creates the encrypted image and stores its passphrase in Keychain. Attach prepares the volume for a run. Detach clears a stale attachment when no run still holds it.

**Next action**

If integrity fails, inspect the evidence path and use credentials verify --accept from an operator terminal. Use the same target and authentication options as the failing run.

**Human involvement**

The operator inspects and accepts any intended changes to the group's configuration.

## login

Open Claude Code in an audited terminal for a configured actor group.

**Prerequisites**

Config-dir mode and a configured encrypted volume. Use a terminal with OSC 52 clipboard access disabled.

**Expected output**

The CLI can reach the group's configured hosts and its additional login hosts.

**Next action**

Use the Claude Code CLI's own /login, then exit the CLI.

**Human involvement**

The operator signs in from the Claude Code CLI.

## Command reference

- `agent-bootstrap help [topic] [--json] | help --agent` → { topics, commands, exitCodes }
- `agent-bootstrap doctor [--target <path>] [--claude-auth <api-key|config-dir>] [--json]` → Array of { id, status, detail, fix, needsNetwork, needsHuman }. Exit 3 also returns the array. The next action goes to stderr.
- `agent-bootstrap setup [--allow-network] [--yes] [--profiles] [--json]` → { mode, artifacts, images, keychain, next } and result when applied. Output paths are relative to the bootstrap checkout.
- `agent-bootstrap concierge [--target <path>] [--claude-auth <api-key|config-dir>] [--continue] [--mode <m>] [--json]` → { status, next } after an interactive TTY session. Transcript goes to stderr.
- `agent-bootstrap credentials <status|init|attach|detach|verify --accept [--group <name>]> [--target <path>] [--claude-auth <mode>] [--json]` → { mounted, active, stale } for status or { status } after a completed action.
- `agent-bootstrap login --group <name> [--target <path>] [--claude-auth <mode>] [--json]` → { status } after a successful interactive session. Transcript goes to stderr in JSON mode.
- `agent-bootstrap status` → { counts, pending, recentExecutions, recentTasks }
- `agent-bootstrap proposals [--status <pending|approved|rejected|registered>]` → Array of proposals with effective policy.
- `agent-bootstrap show <proposalId|goalId|taskId>` → One proposal, Goal, or Task object.
- `agent-bootstrap approve <proposalId> [--on-behalf --delegate-session <id> --authorization <text>]` → { preview, result } with proposal preview and recorded decision.
- `agent-bootstrap reject <proposalId> [--on-behalf --delegate-session <id> --authorization <text>]` → { preview, result } with proposal preview and recorded decision.
- `agent-bootstrap policy show | policy set <gate> <human|agent>` → Gate-to-policy map for show. { updated: true } for set.
- `agent-bootstrap events [--subject <id>] [--limit <1-1000>]` → Array of event records.
- `agent-bootstrap show-execution <executionId>` → One execution record with available outcome and usage.
- `agent-bootstrap retry-task <taskId>` → Updated Task record.
- `agent-bootstrap reconcile` → { reconciled } with sessions, executions, and tasks.
- `agent-bootstrap update-goal-base <goalId>` → { preview, result } with old and new commits and updated Goal.
- `agent-bootstrap verification show | verification clear | verification set --profile <name> -- <argv...>` → { profile, argv } or null for show. { target, current, verification } for set or clear.
- `agent-bootstrap export-goal-branch <goalId> [--target <checkout>]` → { goalId, checkout, branch, from, to } for the completed export.
- `agent-bootstrap analyze [--audit <file>] [--out <dir>] [--sql <file>]` → { report } with human-readable tables, export path, and manual DuckDB command.
- `agent-bootstrap denials [--since <iso>] [--limit <1-1000>]` → { report } with human-readable summary and export details.
