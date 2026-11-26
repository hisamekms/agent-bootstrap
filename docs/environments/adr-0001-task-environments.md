# ADR 0001: Task environments from the target's own declarations

- Status: proposed
- Date: 2026-11-27

## Context

A Task VM gets only the host-prepared Git tree (`prepareWorkspace` in
`src/git-integration.ts`) and the tools baked into its profile image. The
`bun` profile has Bun, Git and zstd. Nothing runs `bun install`,
`mise install` or `cargo fetch`, and Task VMs have no package network:

- Verification has no network at all.
- A Codex Executor reaches only `api.openai.com:443`.

A target such as wadachi already declares its toolchain and packages:

- `mise.toml` lists tools such as `npm:@informalsystems/quint`.
- `bun.lock` and the workspace `package.json` files list the packages.
- `node_modules/` is ignored by Git, so it never reaches a VM.

Today this works only while tests import nothing but Bun built-ins. These
break inside a VM:

- `dt check`, quint, and commitlint.
- A workspace import such as `@wadachi/core` (`workspace:*`).

A Task cannot update dependencies, because resolving needs a registry.

This ADR puts maintainability, observability and ease of change ahead of
code size. A user should keep their dependencies the usual way, by editing
the target's own files, and never edit agent-bootstrap to follow a
version.

## Decisions

### E1. Responsibility boundary

- **The user** is responsible for the safety of the packages and tools
  that the target declares: mise, Bun, Cargo and any later adapter. That
  includes install scripts and `build.rs`.
- **The product** is responsible for the blast radius. Code from a
  package must not reach host credentials, other targets, host paths
  outside its outputs, or the audit record. It stays inside the target's
  own work.

`environment build` shows this split once, on its first run for a target.
`docs/` states it as well.

One residual risk is accepted under the user's responsibility. Package
code that runs in an Executor VM, for example during tests, can send
requests through that VM's credentialed egress, such as the
`api.openai.com` substitution. The token itself stays outside the VM.

### E2. A Provisioner role builds environments

A new isolated role, `Provisioner`, runs adapter steps in its own VM.

- **No credentials.** No secret files, no header substitution, no
  Concierge volume.
- **Input.** A read-only copy of the Task's base tree. Workspaces and
  build scripts may need sources.
- **Output.** Only its output directory is writable, and the host
  collects it.
- **Egress.** Each adapter declares default destinations. The user may
  add more in config (`environment.allow`), for example an internal
  registry or a Git host. Every connection is recorded through the
  existing egress gateway.

This is the one exception to "Task VMs have no package network". It is
limited to a role that holds nothing worth taking.

### E3. Adapters behind a port

An `EnvironmentAdapter` declares:

- the files that form its cache key, such as `mise.toml`, `mise.lock`,
  `bun.lock`, the workspace `package.json` files, `Cargo.lock` and
  `rust-toolchain.toml`;
- its default egress destinations;
- three operations:
  - `build` installs exactly what the lock says (`--frozen-lockfile`,
    `--locked`);
  - `resolve` rewrites the lock from the declarations;
  - `update` raises versions for all packages or for named ones;
- an optional `outdated` query;
- its outputs and the `PATH` entries it adds.

The first adapters are `mise` and `bun`, then `cargo`. Adding uv or apt
means adding one adapter. This mirrors the sandbox runtime port.

Install scripts run by default (E1). A missing lock is allowed, with a
warning. See E8.

### E4. Two layers

| Layer    | Contents                                     | Form                                                                                                             |
| -------- | -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Tools    | mise tools, Rust toolchain                   | A derived image of the role's profile, built with `oci-image.ts` and pinned in a per-target lock                 |
| Packages | `node_modules`, Cargo registry and git cache | A content-addressed archive, copied into the Task workspace (`node_modules`) or mounted read-only (`CARGO_HOME`) |

Splitting the layers keeps rebuilds cheap, because tools change less
often than packages.

- **mise.** mise configuration and activation hooks stay disabled. The
  installed tool directories go on `PATH` directly.
- **Bun workspaces.** Workspace links are relative, so they survive the
  copy into the same layout.
- **Diffs.** Ignored paths stay out of workspace diffs, as they do
  today.

### E5. Cache key and reuse

`key = hash(profile image digest, adapter recipe version, contents of the
adapter's key files at the base commit)`

- **Reuse.** A Task reuses an environment with the same key.
- **Sources.** Source changes do not change the key.
- **Pruning.** `environment prune` removes old environments by count or
  age. It never removes one that a running Task holds.

### E6. When environments are built

| Trigger                          | Action                                                                  |
| -------------------------------- | ----------------------------------------------------------------------- |
| `setup` or `environment build`   | Build explicitly. This needs `--allow-network`, as `setup` does today.  |
| Before a Task starts             | Compute the key from the base commit, then reuse it or build it.        |
| The candidate changes a key file | Before Verification, `resolve`, write the lock back (E7), then rebuild. |

Verification always runs in the environment of the candidate it
verifies.

### E7. Updating dependencies

**Path A: on the host.** The user runs `bun update`, `mise upgrade` or
`cargo update` and commits. The next Task sees the new key. Nothing in
agent-bootstrap changes.

**Path B: in a Task.**

- A Task whose plan declares the capability `environment.update` may
  call that host tool. Its arguments are the adapter, all or named
  packages, and an optional target version.
- The host runs `update` or `resolve` in a Provisioner VM and writes the
  new declarations and lock into the Task workspace. The audit records
  the Provisioner as the author of those paths.
- The Executor then runs tests and fixes code. It may repeat this.
- If the Executor edits a key file by hand, the host runs `resolve` before
  Verification, so the declarations and the lock never drift.

**Locks are derived files.**

- Integration never merges a lock as text.
- On `stale-base`, the host runs `resolve` again from the new base and
  the Task's declaration changes.
- Only a conflict in the declarations themselves, such as
  `package.json` or `mise.toml`, needs the usual retry.

### E8. Observability

- **Journal.** `environment.started` and `environment.finished` record
  the key, the operation, duration, size, cache hit, the destinations
  reached, and a package diff computed from the locks.
- **Failure codes.** `env-fetch-failed`, `env-lock-mismatch`,
  `env-build-failed` and `env-lock-missing` (a warning).
- **doctor.** It shows the environment state for each target (current,
  stale or missing), its key, and whether locks exist.
- **Task detail.** It shows the environment key and, for a Task that
  changes dependencies, the package diff.
- **Workplace "いま".** It shows 「古い依存を調べ中」 and 「依存を解決中」.
- **Reviewer.** The Reviewer gets the code diff and the package-diff
  summary.

### E9. Requests through the Concierge

The Concierge keeps no write tools (#62) and no network. It gains two
read tools:

- `environment_status`: the current key, the packages, and whether locks
  exist.
- `environment_outdated`: this queues a Provisioner `outdated`
  execution. The Concierge reads the result with `get_execution` or
  `wait_execution`, the same way it does after `request_planner`.

The flow for a request such as 「quint と bun の依存を上げて」:

1. The Concierge checks what is outdated.
2. It drafts a Goal from a fixed template, 「依存の更新」. The template
   holds the targets, whether major versions are allowed, and how far
   code fixes may go. The approval view shows only the package table.
3. The human approves the Goal, as the target's policy requires.
4. The Concierge calls `request_planner`. The Planner drafts Tasks with
   category `deps` and the capability `environment.update`. It may split
   them by package, for example for major upgrades.
5. Task registration and integration follow the target's policy. For
   wadachi, the Reviewer answers both.

The Concierge does not use `draft_task` for this. Concierge proposals
always need an operator answer, which would make Task registration
human-only. There is one Goal per request, so each update has its own
`G<n>`. A standing maintenance Goal would never reach done.

### E10. Policy rules

- **New category.** `TASK_CATEGORIES` gains `deps`.
- **New rule condition.** A rule may match on a declared capability,
  `environment.update`.
- **Example.** Allow AI registration when the planned paths are only key
  files. Use a different rule when code paths are planned too.

## Consequences

- Targets can use mise tools, workspace packages and Rust without image
  changes in agent-bootstrap.
- Dependency upgrades become ordinary, audited Tasks.
- **New role.** A new role adds a database CHECK value, an audit role,
  and doctor and UI surfaces.
- **Provisioner network.** The Provisioner is the first product VM with
  package network. E2 keeps it credential-free, and every connection is
  recorded.
- **Disk.** Environments use disk. Pruning is the user's command, and
  doctor reports the size.

## Not decided here

- Automatically opening update Goals, as Renovate does. wadachi
  registers Goals by hand.
- Sharing environments across targets.
- An adapter for system packages (apt or apk).
- Remote caches.

## Implementation order

1. This ADR.
2. The port, the `bun` adapter, the packages layer, the journal events
   and doctor.
3. The `mise` adapter, the tools layer and the per-target lock.
4. `environment.update`, lock write-back, `resolve` on `stale-base`, and
   the Reviewer and Task-detail diff.
5. The Concierge tools, the 「依存の更新」 Goal template, the `deps`
   category and the capability rule condition.
6. The `cargo` adapter.
