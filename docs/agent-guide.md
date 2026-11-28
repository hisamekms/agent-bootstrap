# agent-bootstrap operator manual

Run these commands on the operator host. Paste this manual into the agent's context when it will drive the workflow.

Use a leading `--target <path>` for operator commands. Use `--all-targets` for analyze or denials. Put `--target <path>` after doctor, setup, an environment subcommand, concierge, volume shell, or secrets test. Custom databases use leading `--db <file>` where supported. Put `--json` before the verification command's `--` delimiter.

Replace shell variables such as `$task_id` with full IDs from status and use the same target throughout.

Machine-readable errors use `{ error, next }`. Environment and Sign in with ChatGPT errors include `code` and actor configuration errors include `code` and `key`. Completed doctor and secrets test runs report check results. Other next hints may appear on stderr.

- `0` Success.
- `1` Command failed or was refused.
- `2` Invalid command or arguments.
- `3` Required prerequisites are missing.

## start

Install the linked command and check this machine and a project checkout.

**Prerequisites**  
An agent-bootstrap checkout, macOS arm64, Bun 1.4.5, and a local SHA-1 Git target with local main.

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
The operator updates local main. In opted-in projects the trusted host publishes finished Goals.

## setup

Stage SHA-256-pinned guest artifacts and build the locked Concierge and Bun images.

**Prerequisites**  
Use doctor to prepare Bun, mise, Microsandbox 0.7.16, checkout dependencies, and a Microsandbox home with an absolute real path of at most 40 bytes. The default is $HOME/.msb. Override it with microsandbox.home in the user config or with MSB_HOME, which takes precedence.

```sh
mkdir -p "$HOME/.msb"
mise --no-config --no-env --no-hooks install microsandbox@0.7.16
agent-bootstrap setup --json
agent-bootstrap setup --allow-network
agent-bootstrap setup --allow-network --profiles
agent-bootstrap config edit
security add-generic-password -s agent-bootstrap-claude -a "$(id -un)" -w
```

**Expected output**  
Default setup prints pinned URLs, hashes and image references. Applying setup downloads missing inputs and builds missing images sequentially. Additional secret-file packages are included when the effective configuration grants a secret. Use --target to select a registered project's configuration. Build VMs use an audited gateway limited to recipe destinations. The browser build uses a pinned Debian base and signed, hash-pinned snapshot metadata. Setup lists the build audit database and allowlist for each profile. A digest mismatch stops setup before the image is published under its locked reference.

**Next action**  
API-key mode is the default. Enter the API key at the Keychain prompt, then run agent-bootstrap doctor.

**Human involvement**  
Authorize network access and VM builds. Agents may pass --allow-network --yes only with explicit authorization. Provision Keychain from the operator terminal.

## environment

Build, inspect or prune a registered target's Bun environment.

**Prerequisites**  
Register the target and prepare the pinned Bun profile with setup.

```sh
agent-bootstrap environment build --target /path/to/project --allow-network
agent-bootstrap environment status --target /path/to/project --json
agent-bootstrap environment prune --target /path/to/project --keep 3
```

**Expected output**  
Status reports the key, state, committed lock presence and bytes. Prune accepts --keep and --max-age-days. A failed build prints its code; when the egress gateway stopped every flow it also prints the reason (rate-limited, network-row-limit, audit-failure or listener-error).

**Next action**  
Use environment status to check the committed target.

**Human involvement**  
Authorize registry access before building. Review the target's dependencies and install scripts.

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
The operator starts the session and reviews provider access and costs. The operator updates local main. In opted-in projects the trusted host publishes finished Goals.

## workplace

Start the Concierge and the target's operator API for a separate client.

**Prerequisites**  
A registered target and passing Concierge launch prerequisites.

```sh
agent-bootstrap --target /path/to/project workplace
agent-bootstrap workplace --target /path/to/project --dev-bridge
```

**Expected output**  
The launcher prints the session ID and audit database path. With --dev-bridge it also prints a private loopback URL.

**Next action**  
Open the printed URL when using the development bridge. Answer eligible gates in the host panel or use the operator CLI. Use 任せ方 to manage delegation.

**Human involvement**  
Keep the URL private. Stop the workplace process to end the session.

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

## inbox

Inspect operator actions and recent progress from local state.

**Prerequisites**  
A registered target.

```sh
agent-bootstrap --target /path/to/project inbox
agent-bootstrap --target /path/to/project inbox --all --json
agent-bootstrap --target /path/to/project watch
```

**Expected output**  
Inbox prints current items with their state and next command. Add --all to include resolved items. Watch prints new and changed items every two seconds. Press Ctrl-C to exit.

**Next action**  
Use the command shown with each item to inspect it or take action.

**Human involvement**  
The operator answers human-policy gates unless they explicitly delegate a terminal answer.

## watch

Follow new and changed inbox items in a terminal or a script.

**Prerequisites**  
A registered target.

```sh
agent-bootstrap --target /path/to/project watch
```

**Expected output**  
One line per new or changed item. Press Ctrl-C to exit.

**Next action**  
Use inbox --all to review recent resolved items.

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
agent-bootstrap --target /path/to/project publish-goal "$goal_id"
agent-bootstrap --target /path/to/project complete-goal "$goal_id"
agent-bootstrap --target /path/to/project set-auto-merge "$goal_id" off
```

**Expected output**  
Review the digest, effective policy and integration diff stat, choose approve or reject, and type the exact confirmation phrase. Export previews the destination and heads before confirmation.

**Next action**  
Wait for integration in status. Publishing is automatic in opted-in projects.

**Human involvement**  
The operator answers human-policy gates unless they explicitly delegate a terminal answer. The operator updates local main. In opted-in projects the trusted host publishes finished Goals.

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
A registered SHA-1 Git worktree root with local main and a locked, installed verification profile.

```sh
agent-bootstrap project add /path/to/project
agent-bootstrap doctor --target /path/to/project
agent-bootstrap --target /path/to/project verification set --profile bun -- bun test
agent-bootstrap --target /path/to/project verification show --json
agent-bootstrap --target /path/to/project verification clear
agent-bootstrap --target /path/to/project update-goal-base "$goal_id"
```

**Expected output**  
Verification show returns the effective command or null. Set and clear edit the local layer after confirmation. Base updates require an eligible, untouched Goal and preview both commits.

**Next action**  
Launch with the same target. Keep verification configured until its integration proposals are resolved.

**Human involvement**  
The operator confirms verification changes and eligible base updates from a host TTY. The operator updates local main. In opted-in projects the trusted host publishes finished Goals.

## configuration

Register projects, review repository requests, and edit operator settings.

**Prerequisites**  
A Git worktree root and an operator terminal for project approval.

```sh
agent-bootstrap project add /path/to/project --name dagq-lite
agent-bootstrap project list
agent-bootstrap project show dagq-lite
agent-bootstrap project approve dagq-lite
agent-bootstrap config edit --project dagq-lite
agent-bootstrap doctor --target /path/to/project
agent-bootstrap project move dagq-lite /path/to/project
agent-bootstrap project remove dagq-lite
agent-bootstrap migrate
```

**Expected output**  
Doctor shows effective configuration keys and their layer sources and reports declaration drift. Local settings take precedence for single values, followed by approved and user settings. Lists of grants are combined. Concierge chooses its Claude model from LO_CLAUDE_MODEL, then the effective claude.model setting, then the launcher default. Removal preserves state.

**Next action**  
Use config edit for user settings. For legacy external targets, pass the original worktree paths to migrate.

**Human involvement**  
Review the declaration at local main and the approval summary, then type the project name to accept the declaration.

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
agent-bootstrap sandbox shell --json
agent-bootstrap sandbox shell --profile base --run
```

**Expected output**  
Reconcile previews unfinished records before confirmation. Retry registers a failed Task with a new attempt. For path-violation, inspect the rejected paths with show or show-execution. For unsafe-input-symlink, use relative links inside the repository and retry with the corrected commit. For env-missing, use show or show-execution for guidance on building the environment. For secret-test-required, run the self-test command printed by doctor or the launcher. Launcher codes identify configuration, volume, runtime home or version, audit store, Git integration, state store, and gateway startup failures. Follow the displayed next action and keep the audit database for diagnosis.

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
agent-bootstrap sandbox shell --allow example.com:443 --json
```

**Expected output**  
Policy reports gate defaults, ordered rules, and Goal and Task overrides. Proposals carry the effective policy and human-answer requirement. Product VMs are offline or use the audited gateway. The operator sandbox shell uses only explicitly allowed DNS names on ports 80 and 443. It runs for up to five minutes and has no provider credentials or actor configuration.

**Next action**  
Review the proposed paths, verification result, digest, and policy before answering each gate.

**Human involvement**  
The operator updates local main. In opted-in projects the trusted host publishes finished Goals. The operator answers human-policy gates unless they explicitly delegate a terminal answer. Keep API keys in Keychain. Review mount and egress grants separately.

## volume

Manage encrypted volumes and open an audited operator shell for a declared mount.

**Prerequisites**  
Define volumes in the user config. The shell requires an operator terminal.

```sh
agent-bootstrap volume init <name>
agent-bootstrap volume status <name>
agent-bootstrap volume shell <mount> [--target <path>]
```

**Expected output**  
Status reports attachment, active leases and stale state. The shell takes an exclusive lease and mounts the directory read-write.

**Next action**  
For stale state, run doctor. Confirm no VM is running before using volume detach <name> --force.

**Human involvement**  
Declare read-write mounts in a project's local.json for one actor and a dedicated directory.

## secrets

Check VM containment for a variable granted through secretEnv.

**Prerequisites**  
Define the Keychain source under secrets in the user config. Grant the variable through secretEnv and select external authentication. Prepare the pinned guest image and CLI.

```sh
agent-bootstrap secrets test "$variable"
agent-bootstrap secrets test "$variable" --target /path/to/project --json
```

**Expected output**  
The self-test runs a disposable Worker and reports check results and counts. A pass applies to the granted variable, pinned CLI version and current containment configuration.

**Next action**  
Set $variable to the granted variable name. Use --target for a project-local grant. Repeat the test when doctor reports that a current pass is required.

**Human involvement**  
Provision the configured Keychain entry and authorize model API access before running the test.

## Command reference

- `agent-bootstrap help [topic] [--json] | help --agent` → { topics, commands, exitCodes }
- `agent-bootstrap doctor [--target <path>] [--claude-auth <api-key|external>] [--json]` → Array of checks with layer sources, actor harnesses, and Sign in with ChatGPT grant presence. Exit 3 also returns the array. The next action goes to stderr.
- `agent-bootstrap codex authorize | codex forget [--json]` → Grant management on the macOS host. Authorize requires a TTY and browser consent. JSON success is { status }.
- `agent-bootstrap setup [--target <path>] [--allow-network] [--yes] [--profiles] [--json]` → { mode, artifacts, images, keychain, next } and result when applied. Output paths are relative to the bootstrap checkout.
- `agent-bootstrap environment build --target <path> --allow-network | environment status --target <path> [--json] | environment prune --target <path> [--keep <count>] [--max-age-days <days>]` → Build reports key, cacheHit, size and any warning. Status reports key, state, hasLock and size. Prune reports removed keys.
- `agent-bootstrap concierge [--target <path>] [--claude-auth <api-key|external>] [--continue] [--mode <m>] [--json]` → { status, next } after an interactive TTY session. Transcript goes to stderr.
- `agent-bootstrap workplace --target <path> [--claude-auth <api-key|external>] [--continue] [--mode <m>] [--dev-bridge]` → Text output with the optional loopback URL.
- `agent-bootstrap sandbox shell [--profile <name>] [--allow <host:port>]... [--mount-dir <host>:<guest>[:ro]]... [--json | --run]` → A plan with the pinned image, egress allowlist, requested mounts, lifetime and audit path. Use --run from an operator TTY to start the VM.
- `agent-bootstrap project add <path> [--name <name>] | project list | project show <name> | project move <name> <path> | project remove <name> | project approve <name>` → Project record, list of records, or a confirmation object.
- `agent-bootstrap config edit [--project <name>]` → { edited: true } after the editor exits and file validation succeeds.
- `agent-bootstrap migrate [<original-target-path>...]` → { projects, orphanedVolumes, volumeMigration? } with project names, legacy Concierge volume names and any mount migration guidance.
- `agent-bootstrap volume <init|attach|detach|status> <name> [--force for detach] | volume shell <mount> [--target <path>]` → { mounted, active, stale } for status or { status } after a completed action.
- `agent-bootstrap secrets test <variable> [--target <path>] [--json]` → { pass, checks, counts }. Exit 1 can also return the failed check report.
- `agent-bootstrap status` → { counts, pending, recentExecutions, recentTasks }
- `agent-bootstrap inbox [--all] [--json]` → Array of inbox items with subject IDs, state and the next command.
- `agent-bootstrap watch` → Streams human-readable inbox lines until Ctrl-C.
- `agent-bootstrap proposals [--status <pending|approved|rejected|registered>]` → Array of proposals with effective policy.
- `agent-bootstrap show <proposalId|goalId|taskId>` → One proposal, Goal, or Task object.
- `agent-bootstrap approve <proposalId> [--on-behalf --delegate-session <id> --authorization <text>]` → { preview, result } with proposal preview and recorded decision.
- `agent-bootstrap reject <proposalId> [--on-behalf --delegate-session <id> --authorization <text>]` → { preview, result } with proposal preview and recorded decision.
- `agent-bootstrap policy show | policy set <gate> <human|agent> | policy rules set --file <json> | policy goal <goalId> <task-registration|integration> <inherit|human|agent> | policy task <taskId> <rule|human|agent>` → Gate defaults, ordered rules with recent hits, and Goal and Task overrides for show.
- `agent-bootstrap events [--subject <id>] [--limit <1-1000>]` → Array of event records.
- `agent-bootstrap show-execution <executionId>` → One execution record with available outcome and usage.
- `agent-bootstrap retry-task <taskId>` → Updated Task record.
- `agent-bootstrap reconcile` → { reconciled } with sessions, executions, and tasks.
- `agent-bootstrap update-goal-base <goalId>` → { preview, result } with old and new commits and updated Goal.
- `agent-bootstrap discard-goal <goalId>` → { goalId, branch, head } preview, followed by the cancelled Goal record on confirmation.
- `agent-bootstrap verification show | verification clear | verification set --profile <name> -- <argv...>` → { profile, argv } or null for show. { target, current, verification } for set or clear.
- `agent-bootstrap export-goal-branch <goalId> [--target <checkout>]` → { goalId, checkout, branch, from, to } for the completed export.
- `agent-bootstrap publish-goal <goalId>` → Goal publish state and PR details.
- `agent-bootstrap complete-goal <goalId>` → PR number, merged head and Goal head, followed by the completion receipt on confirmation.
- `agent-bootstrap set-auto-merge <goalId> <off|squash|merge|rebase>` → { autoMerge, autoMergeSource }
- `agent-bootstrap analyze [--audit <file>] [--out <dir>] [--sql <file>]` → { report } with human-readable tables, export path, and manual DuckDB command.
- `agent-bootstrap denials [--since <iso>] [--limit <1-1000>]` → { report } with human-readable summary and export details.
