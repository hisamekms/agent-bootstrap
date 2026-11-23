# agent-bootstrap

agent-bootstrap runs coding agents in isolated Microsandbox VMs and records
their actions in a durable host audit. The local orchestrator opens an
interactive **Concierge** that works with a **Planner** to turn a Goal into
Tasks. An **Executor** implements each eligible Task and a **Reviewer** reviews
the candidate. The trusted host authorizes tools, checks approvals, and
integrates approved work into a private Goal branch.

## Quick start

On an Apple silicon Mac with Bun 1.4.4, clone this repository and link the
command. Put `$HOME/.bun/bin` on your PATH if your shell needs it.

```sh
git clone https://github.com/hisamekms/agent-bootstrap.git
cd agent-bootstrap
bun install --frozen-lockfile --ignore-scripts && bun link
agent-bootstrap doctor
agent-bootstrap setup
agent-bootstrap setup --allow-network
agent-bootstrap project add /path/to/project
agent-bootstrap doctor --target /path/to/project
agent-bootstrap concierge --target /path/to/project
```

Follow the first doctor result to prepare mise, pinned Microsandbox, and a short
`MSB_HOME`. Review the setup plan before authorizing downloads and image builds.
Configure the Keychain service for default API-key mode and rerun doctor. The target
must be a local Git worktree rooted at the supplied directory with a local
`main` commit. Start Concierge from a terminal with OSC 52 access disabled.

Use `agent-bootstrap config edit` for user settings and `config edit --project
<name>` for project-local settings. To adopt requests committed on local
`main`, review them with `agent-bootstrap project approve <name>`.
Run `agent-bootstrap migrate` for legacy state and supply the original
worktree paths for any legacy external targets.

Use `agent-bootstrap help --agent` to give an AI agent the operating manual,
or `agent-bootstrap help --json` for help topics and machine-readable command
contracts. Read [Getting started](docs/getting-started.md) for the setup,
Goal and Task, audit, and performance workflows.

## Reference

- [Concierge and operator commands](docs/local-orchestrator/running.md)
- [DuckDB analysis](docs/local-orchestrator/analysis.md)
- [Claude Code authentication and encrypted mounts](docs/claude-code-auth.md)
- [Sandbox profiles](docs/sandbox-profiles.md)
- [Trust model](docs/trust-model.md) and [milestone checks](docs/milestones.md)

Contributors can use `bun run lo` and `bun run concierge` from the checkout.
Run `bun fmt` before review and `bun verify` for the local acceptance checks.
The build emits JavaScript and TypeScript declarations in `dist/`.

Licensed under the [MIT License](LICENSE). The project is experimental and
provided as is, with no guaranteed maintenance, support, or security updates.
