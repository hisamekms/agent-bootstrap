# Bun environments

Use a registered Git target and the pinned Bun profile prepared by
`agent-bootstrap setup`. The environment comes from the target's local
`main` commit. Commit dependency changes to local `main` before building
again.

```sh
agent-bootstrap environment build --target /path/to/project --allow-network
agent-bootstrap environment status --target /path/to/project --json
agent-bootstrap doctor --target /path/to/project
```

You are responsible for the packages and tools your target declares, including
install scripts. Agent-bootstrap isolates the Provisioner from host credentials,
other targets, host paths and the audit record. The first build prints this
responsibility notice for the target.

The Provisioner uses the npm registry on HTTPS. If your dependencies require
another destination, use `agent-bootstrap config edit` for all targets or
`agent-bootstrap config edit --project <name>` for one target. Add an
`environment` section to your private configuration, for example
`"environment": { "allow": ["registry.example.org:443"] }`. The two lists are
combined. Project declarations and approved permissions cannot grant Provisioner
egress. The gateway records connections in the target's private audit.

A committed `bun.lock` makes the build use Bun's frozen install. Without it,
the Provisioner resolves dependencies and reports `env-lock-missing`. The
generated lock stays out of the target checkout. The key covers the pinned
Bun image, the adapter recipe, `bun.lock`, the root `package.json`, and
workspace manifests matched by paths or globs such as `packages/*`.

Status shows the key, committed lock presence, and bytes. A current environment
matches the key. A stale environment has a cached build for a previous key, and
its size is the size of the most recent entry. A missing environment has no
cached build and shows zero bytes. Doctor reports a missing environment as
an optional check. Without a target flag, doctor also lists environments for
other registered projects.

Cached archives contain the declared `node_modules` paths. Output links can
resolve within those paths or directly to a declared workspace package
directory. Archives are limited to 256 MiB.

## Use environments in Tasks

Set `"environment": { "enabled": true }` using
`agent-bootstrap config edit --project <name>` for one target or
`agent-bootstrap config edit` for all targets. A target's private
`local.json` can override the user setting with `"enabled": false`. The
default is off. Enabling delivery uses the local cache and never reaches the
network. After committing dependency changes to local `main`, run
`agent-bootstrap environment build --target <dir> --allow-network`. Tasks
that use the stored environment show a cache hit (「キャッシュ」) in Task
detail.

Use the `bun` profile for the Executor and the configured Verification
command. The Executor uses the Task base's environment on every attempt,
including revisions that start from the previous candidate's tree.
Verification uses the pinned candidate's environment, even when the
candidate changes key files. Verification requests a revision if dependency
declarations disagree with a committed lock or generated dependency
directories collide with the candidate tree.

Set `environment.autoBuild` to `true` in private configuration to authorize
the credential-free Provisioner to use package network for cache misses
before Executor or Verification starts. This setting defaults to off and
has an effect only when delivery is enabled. The gateway uses the adapter's
defaults and your private `environment.allow`, and records connections in
audit. Without automatic builds, a missing key fails the Task with
`env-missing` before the corresponding VM starts. A candidate that changes
dependency declarations and needs a new environment requires automatic
builds, since `environment build` uses the committed local `main`.
The Executor retains its model egress policy and Verification stays offline.
The Task VM unpacks the packages into `/workspace` and adds their
`.bin` directories to `PATH`. Writes under the output roots declared by
the base or by the collected workspace are excluded from candidate
changes. Task detail shows each environment key and cache hit.

```sh
agent-bootstrap environment prune --target /path/to/project --keep 3
agent-bootstrap environment prune --target /path/to/project --max-age-days 30
```

Prune defaults to keeping the three newest entries. With both flags it removes
entries beyond either limit. Held entries are retained. Cache entries and build
events live in the per-target directory under
`${XDG_STATE_HOME:-~/.local/state}/agent-bootstrap/environments/`.
