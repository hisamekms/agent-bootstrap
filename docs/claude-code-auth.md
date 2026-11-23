# Claude Code authentication

| Mode                | What the Claude VM receives                                                                                                                                                                                       |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `api-key` (default) | A guest placeholder for `ANTHROPIC_API_KEY`. Microsandbox substitutes the Keychain API key into `x-api-key` for `api.anthropic.com:443`.                                                                          |
| `config-dir`        | Persistent Claude Code configuration directories per actor group, kept on an encrypted volume, signed in with the CLI's own `/login`. Each Claude VM mounts its group's directory read-write at `/claude-config`. |

## Setup

Use a private `${XDG_CONFIG_HOME:-~/.config}/agent-bootstrap/config.json`
owned by the current user, with mode `0600`. The CLI refuses symlinks.
Store the Keychain service name in the file and enter the API key at the prompt.

```sh
config_dir="${XDG_CONFIG_HOME:-$HOME/.config}/agent-bootstrap"
mkdir -p "$config_dir"
(umask 077; set -C; printf '%s\n' '{"claude":{"apiKey":{"keychainService":"agent-bootstrap-claude"}}}' > "$config_dir/config.json")
security add-generic-password -s agent-bootstrap-claude -a "$(id -un)" -w
agent-bootstrap doctor
```

Edit an existing file in place and preserve its permissions. An optional
`claude` section in the target state directory's `config.json` overrides
user settings per key. Target files must be user-owned with no group or
other permission bits. The target file can coexist with the target's verification
settings. The invocation's `--claude-auth` flag takes precedence over
both files. Doctor reports the mode and its source. The legacy
`LO_CLAUDE_AUTH` and `LO_CLAUDE_KEYCHAIN` environment variables are a
deprecated fallback for API-key mode.

API-key mode uses the `ANTHROPIC_API_KEY` variable. Authorization-header
substitution requires an exact host in the operator file’s `claude.gateway`
list (`hostname:443`). IP literals and Anthropic domains are excluded. The API endpoint uses `x-api-key`.

## Configuration directory fields

- `claude.auth` selects the mode. `claude.apiKey.keychainService` names the
  Keychain item. If `claude.apiKey.variable` is supplied, it must be
  `ANTHROPIC_API_KEY`. Use letters, digits, dots, underscores and hyphens
  in Keychain service names.
- `claude.configDir.volume` contains the absolute path `image` to the
  encrypted `.sparseimage`, its `keychainService`, and the `attach`
  policy `while-running`.
- `claude.configDir.groups` maps lowercase group names to `actors` lists.
  Assign each of Concierge, Planner, Executor, and Reviewer once. For
  different exposure between roles, use different groups. If Researcher
  or verification is listed, the CLI warns and ignores that entry.
- `claude.configDir.egress` and `loginEgress` list DNS names with port
  `443`. Runs can reach the API host and the configured `egress` hosts
  using plain HTTPS through the audited gateway. The login VM also
  receives the `loginEgress` hosts.
- `claude.configDir.errors` can map operator-written `match` regexes to
  `auth-required`, `rate-limited`, or `config-invalid`. Patterns are
  bounded and time-limited. Keep provider-specific text in your own
  configuration.
- `claude.configDir.leakPatterns` adds case-insensitive host-side patterns
  to the built-in credential shape checks. Each file accepts up to 16
  expressions of at most 160 characters. A scan exceeding its time or
  size budget blocks the output. A rejection records a private evidence
  path and the fixed code `credential-leak` without copying the match.
  A target that has used configuration-directory mode continues to screen
  later operator output and exports when the launch mode changes.

`credentials init` creates a small AES-256 encrypted APFS image and saves
a randomly generated passphrase in Keychain. The launcher attaches it
before granting a group mount and detaches it after the last lease ends.
The SQLite lease serializes runs in the same group across launchers. A
second run waits up to 30 seconds for its group. Use a dedicated Concierge
group when Planner, Executor, or Reviewer must run during its session.
The default Keychain ACL allows processes running as the same user to
read the volume passphrase. This is an accepted risk of this setup.
`credentials attach` prepares an attachment for the next run.
`credentials status` reports active leases and stale state. For a stale
lease, run `agent-bootstrap doctor`, confirm that no VM is still using
the volume, and run `agent-bootstrap credentials detach --force`. Use
the same target and mode options as the affected run.

`login` opens the Concierge image with the selected group, an audited
gateway, and a TTY. Use the CLI's own `/login` and exit afterwards.
The Concierge uses its group directory for Claude Code state. The named
Concierge volume also holds its guest home.

## Integrity and managed settings

The host hashes the group directory before and after each run. It skips
the contents of `.credentials.json`, `.claude.json`, `.claude.json.*`,
`*.lock` and `*.lock.owner` files and the `backups/`, `projects/`,
`sessions/`, `todos/`, `statsig/` and `shell-snapshots/` directories
at the group root. Links and special files fail the integrity check
throughout the tree, including the state directories. A change in the checked paths fails
the run with `config-tampered`. Inspect the evidence path and use
`credentials verify --accept` from an operator terminal to accept intended
changes. Use `--group` to accept one group. Stop active Claude runs before
accepting. A failed run can report a CLI version change since the group's
last success. Interactive exits report lifecycle and integrity failures.
The terminal transcript stays with the operator, so text matching applies
to headless CLI results.

The pinned CLI accepts `disableAllHooks`, `allowManagedMcpServersOnly`,
`allowedMcpServers`, `allowManagedPermissionRulesOnly`, and
`permissions.disableBypassPermissionsMode` in managed settings. The host
generates the file and mounts it read-only. The Concierge's MCP allowlist
matches the fixed orchestrator relay command and arguments. Other actors
and login have an empty MCP allowlist. Headless roles use fixed tool lists,
managed permission rules, strict MCP, empty setting sources, and no
session persistence.

Managed file permissions limit Planner and Reviewer to `/review` and
Executor to `/workspace`. The rules deny access to `/claude-config` and
`/etc/claude-code`. Claude permission rules use `//` for guest-absolute
paths. Directory-mode Workers can return an optional commit message in
the final answer. Worker shell is available only in API-key mode. The host audits
the managed-settings digest, guest mount paths, mode and group for each
run. The volume database records integrity holds and accepted baselines.
