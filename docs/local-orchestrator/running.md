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

From the repository root, preview the launch with the first command. The
second command starts an audited session with egress to the Anthropic API.
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

## Review proposals

Use another host terminal for approval. The Concierge can draft proposals
and request Planner executions through its MCP tools.

```sh
bun run src/local-orchestrator/cli.ts status
bun run src/local-orchestrator/cli.ts proposals --status pending
bun run src/local-orchestrator/cli.ts show <proposalId>
bun run src/local-orchestrator/cli.ts approve <proposalId>
```

State stays in `.local/local-orchestrator/state.db`. The runtime audit is
in `.local/local-orchestrator/audit.sqlite` and OTLP files are under
`.local/local-orchestrator/observability/`. Treat those records and the
persistent Claude conversation volume as sensitive.
