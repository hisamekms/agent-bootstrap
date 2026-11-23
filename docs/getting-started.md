# Getting started with agent-bootstrap

Run these commands on the operator host. Use `agent-bootstrap help <topic>`
for prerequisites and next actions, or paste
[the agent manual](agent-guide.md) into a host-side AI agent's context.

## 1. Set up the operator host

Clone agent-bootstrap on macOS arm64 and install Bun 1.4.4 and mise. From the
checkout, link the command and run doctor.

```sh
bun install --frozen-lockfile --ignore-scripts && bun link
agent-bootstrap doctor --json
```

Follow the first required fix. The pinned Microsandbox command uses mise. Set
`MSB_HOME` to an existing absolute directory whose real path is at most
40 bytes.

```sh
mise --no-config --no-env --no-hooks install microsandbox@0.7.16
mkdir -p "$HOME/.msb"
export MSB_HOME="$HOME/.msb"
agent-bootstrap setup --json
agent-bootstrap setup --allow-network
```

Review the URLs, SHA-256 pins, and image references before confirming `setup`
at the terminal prompt. Setup applies the default Concierge and Bun profiles.
Pass `--profiles` to include db and browser. The browser uses the existing
Debian snapshot recipe over HTTP with signed, hash-pinned release metadata.
An explicitly authorized operator agent can use
`--allow-network --yes`.

API-key mode is the default. Create the private configuration file and
provision the API key from an operator terminal.

```sh
config_dir="${XDG_CONFIG_HOME:-$HOME/.config}/agent-bootstrap"
mkdir -p "$config_dir"
(umask 077; set -C; printf '%s\n' '{"claude":{"apiKey":{"keychainService":"agent-bootstrap-claude"}}}' > "$config_dir/config.json")
security add-generic-password -s agent-bootstrap-claude -a "$(id -un)" -w
target=/path/to/project
agent-bootstrap doctor --target "$target"
```

Enter your Anthropic API key at the Keychain prompt. If the file already
exists, edit it in place and keep mode `0600`. The linked command ignores the
current directory's `.env`. For persistent Claude Code configuration
directories per actor group, kept on an encrypted volume and signed in
with the CLI's own `/login`, see [Claude Code authentication](claude-code-auth.md).
Doctor checks presence
without reading the password. When required checks pass, doctor exits 0.
Exit 3 means a required check needs attention. DuckDB is optional and uses
`mise --no-config --no-env --no-hooks install duckdb@1.5.6`.

## 2. Create Goals and run Tasks

Use the root of a local SHA-1 Git worktree with a current local `main`. You
can set a tracked verification command before launch. For a Bun project,
confirm `verification set` at the host prompt.

```sh
agent-bootstrap --target "$target" verification set --profile bun -- bun test
agent-bootstrap concierge --target "$target"
```

Start Concierge in an operator terminal with OSC 52 clipboard access
disabled. Describe the outcome you want and ask it to request a Goal design
from the Planner. In another terminal, inspect the proposal and confirm the
exact digest-bound phrase to approve it.

```sh
agent-bootstrap --target "$target" status --json
agent-bootstrap --target "$target" proposals --status pending --json
agent-bootstrap --target "$target" show "$proposal_id" --json
agent-bootstrap --target "$target" approve "$proposal_id"
```

Set `proposal_id` to the full ID from the pending list. Ask Concierge to
propose Tasks for the registered Goal, with paths, dependencies, and
acceptance criteria. Inspect any pending gates using the same commands.
The queue runs eligible Tasks, and review can produce a separate integration
proposal. The operator answers human-policy gates unless they expressly
delegate the answer. Review the effective policy, digest, and diff stat
before answering. Keep target verification configured through integration.

Once the Goal's changes are integrated, set `goal_id` to its full ID and
export the branch from a host terminal.

```sh
agent-bootstrap --target "$target" export-goal-branch "$goal_id"
```

Inspect the exported branch. The operator pushes, opens the PR, and
integrates into `main`. Use `concierge --continue` with the same target and
`MSB_HOME` to continue a conversation.

## 3. Inspect audit evidence

Concierge prints its audit database path and session ID. Use IDs from
`status` to inspect events and execution records. Use DuckDB for a denial
report from the private audit export.

```sh
agent-bootstrap --target "$target" events --subject "$task_id" --json
agent-bootstrap --target "$target" show-execution "$execution_id" --json
agent-bootstrap --target "$target" denials --limit 20 --json
```

The execution ID matches the trusted host invocation ID for the actor run.
Use the integration journal and `proposal.decided` event for integration
evidence. If the launcher stopped unexpectedly, use `agent-bootstrap help
troubleshoot` to inspect the run before reconciling. Audit and telemetry
may contain private project information.

## 4. Measure performance

```sh
agent-bootstrap --target "$target" analyze --json
agent-bootstrap --all-targets analyze --out ./private-analysis
agent-bootstrap --all-targets analyze --out ./private-analysis --sql ./report.sql
```

Start with `input_issues` and coverage counts. Use `actor_summary` for
actor duration and usage, `goal_summary` for totals, and `gate_latency` for
approval wait. Without DuckDB, `analyze` still exports the inputs and prints
the command to run with `load.sql`. Run the optional SQL example with SQL you
have reviewed. See the [analysis reference](local-orchestrator/analysis.md)
for available views.
