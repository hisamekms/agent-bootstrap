# ADR 0001: Encrypted volumes and declared mounts

- Status: proposed
- Date: 2026-11-24

## Context

agent-bootstrap has a Claude-specific configuration-directory mode. It
keeps one Claude Code configuration directory per actor group on an
encrypted volume, and mounts that directory read-write into every Claude
VM in the group. It hashes the directory before and after each run,
using a fixed list of Claude Code file names. It also provides `login`
and `credentials verify --accept`.

The officially supported part of this mode is the encrypted volume.
What a user keeps on it, and how a tool inside a VM uses it, is the
user's own choice and responsibility.

Live runs on 2026-11-23 showed that the current design is fragile:

- **Normal writes stop runs.** Each CLI release adds state files, and each
  one holds a group with `config-tampered` until someone allowlists it.
- **Unhashed paths carry state.** Paths excluded from hashing hold state
  that later sessions load, such as per-project memory.
- **Shared writes cross roles.** A read-write directory shared by several
  roles lets one role's writes reach another.

A proof of concept on 2026-11-24 mounted a group read-only for the
headless roles. The pinned CLI ran normally, all permission and memory
checks passed, and the directory was unchanged afterwards.

## Decisions

### V1. Encrypted volumes are the product feature

Volumes are defined only in the user config:

```json
"volumes": {
  "private": {
    "image": "/abs/path/private.sparseimage",
    "keychainService": "agent-bootstrap.private-volume",
    "attach": "while-running"
  }
}
```

`agent-bootstrap volume init|attach|detach|status <name>` replaces the
`credentials` commands and keeps their behaviour:

- `init` creates an AES-256 APFS image and stores a random passphrase in
  Keychain.
- The volume is attached while any lease exists and detached after the
  last lease.
- After `doctor`, `detach --force` recovers a stale lease.

### V2. Mounts are declared

```json
"mounts": {
  "tool-a": {
    "volume": "private",
    "dir": "tool-a",
    "actors": ["Planner", "Executor", "Reviewer"],
    "path": "/mnt/tool-a",
    "mode": "ro",
    "env": "TOOL_A_CONFIG_DIR"
  }
}
```

The fields follow these rules:

- **The mount name** matches `^[a-z][a-z0-9-]{0,47}$`. If the same name
  appears in two layers, the configuration is invalid. Layers never merge
  or override mounts.
- **`dir`** is a single directory name at the volume root. It matches
  `^[a-z0-9][a-z0-9._-]{0,63}$` and is neither `.` nor `..`. Nested
  directories are not allowed. A mount can therefore never contain
  another mount.
- **`path`** is `/mnt/<segment>`, where `<segment>` uses the same pattern
  as `dir`. Two mounts never share a `path`.
- **`mode`** is `ro` or `rw` and defaults to `ro`.
- **`env`** is optional. If it is set, the guest receives that variable,
  and its value is the mount path. The variable must be on the actor's
  adapter allowlist (V7). No other variable can be set this way.

**Where mounts are declared.**

- A `rw` mount is allowed only in a project's `local.json`, so it is
  scoped to one project.
- A `ro` mount may also be declared in the user config, where it
  applies to every project.
- A project declaration cannot declare mounts.

A `rw` mount in the user config is an error, because it would give every
project the same writable channel.

**What a `rw` mount means.** It persists whatever its actor writes into
that actor's later runs of the same project. Choose it knowingly.

### V3. Invariants in code

The following rules hold whatever the configuration says:

1. **One writer per directory.** Each `(volume, dir)` is used in one
   of two ways, across all registered projects:
   - by exactly one `rw` mount, in one project's `local.json`, with
     exactly one actor;
   - only by `ro` mounts.

   Leases are keyed by `(volume, dir)`, not by mount name. The check runs
   over the `local.json` of every registered project, so two projects
   cannot share a writable directory.

   When the check fails, only the project being launched fails. Its
   `next:` names the other project that uses the directory. Other
   projects keep running. `project remove` drops the removed project's
   claims.

2. **No mounts for Verification.** Verification never receives a mount.
3. **A mount narrows an actor's tools.** An actor that receives any mount
   gets only an explicit allowlist of tools, and every other tool is
   denied:
   - It has no shell tools.
   - Its file tools, Read, Glob, Grep, Edit and Write, are allowed only
     in its working paths and denied on every mount path.
   - It has no other read-capable tool unless the adapter names one.

   The rules use managed permission rules only, as today.
   Migration and `doctor` print which actors lose shell tools because of
   a mount.

4. **Supported adapters only.** An adapter that cannot enforce rule 3
   cannot receive mounts. Today that is every adapter other than Claude.
   Configuration that gives such an actor a mount is invalid.
5. **Mounts never grant network.** Egress comes only from the `egress`
   configuration. If an actor has both a mount and added egress, `doctor`
   prints a warning. Project approval also highlights egress added for
   an actor that has a mount.
6. **Directory checks at launch.** Just before each launch, the host
   checks the volume root and the mount directory with `lstat`. Each must
   be a real directory, not a link, owned by the user and mode `0700`.
   The host passes the directory's real path to the backend. This guards
   against a directory being swapped between configuration and launch.
   After the check, only a host process could swap the path before the
   backend opens it. This is an accepted residual risk.
7. **Read-only is enforced below the guest.** `ro` is passed to the
   backend's mount, and V9 tests it against a root guest.

Errors follow the message rules of the configuration ADR:

```
Invalid configuration: mounts.tool-a is "rw" but lists 2 actors.
A read-write mount shared by actors lets one actor's writes reach another.
next: Set "mode" to "ro", or give each actor its own mount in local.json.
```

### V4. Leases

- **`rw` leases.** A `rw` lease on `(volume, dir)` is exclusive.
- **`ro` leases.** `ro` leases on the same directory may overlap.
- **Waiting.** A lease that cannot be granted waits for up to 30 seconds.
  It then fails with `mount-busy`, plus a `next:` naming the holder's
  kind: an operator shell, or a run of a given actor.
- **Conflicts.** Under V3.1, a `ro` directory is never also used by a run
  with a `rw` mount. Its only writer is the operator shell (V6).

### V5. The host does not inspect mount contents

The host never hashes, parses or copies anything inside a mounted
directory. The integrity snapshot, its allowlist, the hold table and
`credentials verify --accept` are removed. The user decides what to keep
in a directory, and chooses `rw` deliberately. The host checks only the
directory itself, as V3.6 describes.

### V6. Operator shell

`agent-bootstrap volume shell <mount>` prepares a mount's contents. It:

- requires an operator terminal;
- opens the Concierge image;
- takes an exclusive lease on the mount's directory;
- mounts the directory read-write at its `path` and sets its `env`;
- allows egress only from `egress.shell`, through the audited gateway.

It is the only way to write a directory that is mounted `ro`. `shell`
can appear only in the user config and `local.json`, never in a project
declaration.

### V7. Adapters

- **Variable allowlist.** Each adapter declares the variables that a
  mount may provide. The Claude adapter allows its CLI's
  configuration-directory variable. Every other adapter has an empty
  allowlist until it can enforce V3.3. Every other variable an adapter
  sets is reserved, and a mount cannot override it. In `api-key` mode,
  this includes the credential and placeholder variables.
- **Clean environment.** The adapter applies the allowed mount variables
  inside its clean environment. A mount-provided value replaces the
  adapter's temporary directory default for that variable.
- **`claude.auth` modes.** It takes `api-key`, the default, or
  `external`. Mounts and their variables apply in both modes.
  - `api-key` is unchanged. The guest sees only a placeholder, and the
    egress gateway substitutes the key.
  - With `external`, the host supplies no credential and does no
    substitution. The API key never reaches the guest, in either mode.
- **Generic options.** The generic Claude options move to the top level
  of `claude`: the error mapping patterns and the output leak patterns.
  The credential scan of outputs continues in both modes.

### V8. Removal and migration

The change removes the following at once, with no compatibility period:

- `claude.configDir`, including groups, `egress` and `loginEgress`;
- `login` and `credentials verify`;
- the integrity snapshot and the hold table;
- the Claude file-name constants.

`agent-bootstrap migrate` also converts `claude.configDir`. It refuses to
run while any lease exists, a run is active or a volume is attached. It
can be rerun safely. It writes new files atomically and removes the old
keys last. It converts as follows:

- **Volume.** The configured volume becomes a `volumes` entry.
- **Groups.** Every group becomes a `ro` mount in the user config. The
  mount keeps `dir` as the group name and lists the group's actors.
- **Write access.** The command prints which actors lose it. It also
  prints the `local.json` entry and the `volume shell` steps for
  creating a project-scoped `rw` directory when one is wanted. Under
  V3.1, a writable directory cannot be granted to several projects
  automatically.
- **Egress.** `egress` becomes per-actor `egress` for exactly the actors
  that the old group granted it to. `loginEgress` becomes
  `egress.shell`.
- **Concierge volumes.** Named Concierge volumes are renamed from the
  project name. Existing `lo-concierge-*` volumes are listed for the
  operator to review and remove, and their contents are never converted.

### V9. Validation before acceptance

Test 1 must pass before this ADR is accepted. Until then, read-only
enforcement against a root guest is unproven.

1. **Read-only against a root guest.** On Microsandbox 0.7.16, a guest
   running as root tries all of the following on a `ro` mount:
   - overwrite a file;
   - create a file;
   - `mount -o remount,rw`;
   - write through any visible block or virtiofs device.

   Every attempt must fail, and the host directory must be unchanged.

2. **Policy smoke.** The smoke
   (`spike/local-orchestrator/claude-policy-smoke.ts`) passes with mounts.
   It shows:
   - the mount path is denied to file tools;
   - no shell is available to an actor with a mount;
   - nothing is written to a `ro` directory.

## Consequences

- Benign tool writes cannot stop a run, because nothing inspects mount
  contents.
- `ro` mounts carry no state between runs or roles. A `rw` mount carries
  state only into its single actor's later runs of one project.
- Anything a user keeps on a volume is outside the product's
  guarantees. The product guarantees only:
  - encryption at rest;
  - mount modes;
  - the V3 rules.
- Update `docs/claude-code-auth.md`, the trust model, the agent guide and
  CLI help. Remove the configuration-directory sections.
