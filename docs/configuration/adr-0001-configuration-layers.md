# ADR 0001: Configuration layers and project approval

- Status: proposed
- Date: 2026-11-24

## Context

agent-bootstrap reads two configuration files today:

- **User config.** `${XDG_CONFIG_HOME:-~/.config}/agent-bootstrap/config.json`.
- **Target config.** `config.json` in the target's state directory,
  `.local/local-orchestrator/targets/<slug>/` inside the agent-bootstrap
  checkout. The default target uses `.local/local-orchestrator/` directly.

This layout has five problems:

- A project cannot share settings through its own repository, such as its
  verification command.
- The target directory mixes configuration with state: the audit
  database, `state.db` and observability data.
- The slug comes from the worktree's real path. Every worktree of one
  repository gets its own settings. Moving the repository silently
  orphans them.
- Target values override user values key by key. Nothing shows where an
  effective value came from.
- Most validation errors print `Invalid Claude configuration.` without
  the key, the reason or a fix.

Repository content is untrusted. Agents produce it. Settings that decide
what a VM can see or reach must never come from a file inside the
repository, whatever checks surround that file.

## Decisions

### C1. Trust follows the writer

| File                 | Location                                                             | Written by                    | Effective                 |
| -------------------- | -------------------------------------------------------------------- | ----------------------------- | ------------------------- |
| User config          | `${XDG_CONFIG_HOME:-~/.config}/agent-bootstrap/config.json`          | Operator                      | Yes                       |
| Project declaration  | `<repo>/.agent-bootstrap/project.json`, committed                    | The project. It is untrusted. | No. It is only a request. |
| Approved permissions | `…/agent-bootstrap/projects/<name>/approved.json`                    | CLI, on operator approval     | Yes                       |
| Local permissions    | `…/agent-bootstrap/projects/<name>/local.json`                       | Operator                      | Yes                       |
| Project state        | `${XDG_STATE_HOME:-~/.local/state}/agent-bootstrap/projects/<name>/` | Host                          | Not configuration         |

A declaration never takes effect by itself. The operator imports it into
approved permissions with the CLI. Changes that agents make to the
repository can therefore only cause a drift warning (C4).

### C2. Projects are registered by name

`agent-bootstrap project add <path> [--name <name>]` registers a project.

- **Name.** It defaults to the repository directory name, normalised to
  `^[a-z][a-z0-9-]{0,47}$`. An existing name is an error.
- **Identity.** It is the real path of `git rev-parse --git-common-dir`.
  All worktrees of a repository share it. `projects/<name>/project.json`
  records the identity and a randomly generated project ID.
- **Lookup.** `--target <path>` resolves the common directory and finds the
  project that records it. A target that is not registered is an error
  with `next: agent-bootstrap project add <path>`. The CLI never registers
  a project implicitly.
- **Moving.** If the recorded directory no longer exists, `doctor` reports
  the project as missing. `project move <name> <path>` updates the
  identity after checking that the new path is a Git repository. The
  project ID and its Concierge volume name stay the same.
- **Other commands.** `project list`, `project show <name>` and
  `project remove <name>` exist. Removal keeps the state directory, and
  the operator deletes it by hand.
- **Remote URLs** are not used. A repository may have none, and two
  clones of one remote can serve different purposes.

The agent-bootstrap checkout is registered like any other project.

### C3. Project declaration

The declaration is read from Git objects, never from the working tree,
with plumbing commands only:

1. Find the exact `refs/heads/main` with `git for-each-ref`. Require a
   direct commit reference and use its object ID.
2. Check with `git ls-tree` that `.agent-bootstrap` is a tree and that
   `project.json` is a blob with mode `100644`. A symlink or a submodule
   is rejected.
3. Check the blob size with `git cat-file -s` and reject a blob over
   64 KiB.
4. Read the blob with `git cat-file blob <oid>`, without textconv.
5. Parse it as JSON, with a depth of at most 8 and at most 64 entries in
   each list. Validate it fully against the schema before anything is
   shown or used.

Version 1 allows only these keys:

- `verification`: `profile` and `argv`, as the target config holds them
  today.
- `profiles`: sandbox profiles. They must stay within each role's
  allowlist in `src/sandbox-profiles.ts`. A declaration cannot widen that
  allowlist.
- `egress`: added destinations for Concierge, Planner, Researcher,
  Executor and Reviewer. `shell`, Verification and Coordinator cannot
  appear (C8).

Anything that refers to the machine, such as volumes or mounts, cannot
appear in a declaration.

### C4. Approval and drift

`agent-bootstrap project approve <name>` does the following:

1. Reads and validates the declaration at local `main` (C3).
2. Shows the changed configuration keys and egress destination counts.
   Configuration values stay out of the preview. Egress added for an
   actor that has a mount is highlighted. The operator can inspect the
   declaration at the displayed local commit before confirming.
3. Reads the confirmation from `/dev/tty`. The operator types the
   project name. The command fails when stdin or stdout is not a
   terminal. There is no `--yes`.
4. Writes `approved.json`. It contains the validated value parsed from
   the blob that was read, together with the commit and blob object IDs.
   The command never reads the declaration again after confirmation.

The drift check compares the blob object ID at local `main` with the
approved blob object ID.

Approval is all or nothing. To allow part of a request, edit the
declaration, or leave it unapproved and add the needed entries to
`local.json`.

On each `doctor` and each launch, the CLI compares the declaration at
local `main` with the approved digest. When they differ, it prints a
warning. Approved permissions stay in effect unchanged, in both
directions: added requests are not granted, and removed requests stay
granted until approval. The warning lists added and removed entries,
without values that could be private:

```
Warning: .agent-bootstrap/project.json at main (a1b2c3d) differs from the approved copy (from 9f8e7d6).
Added requests: egress.Executor (1 destination). Not granted until approved.
Removed requests: egress.Reviewer (1 destination). Still granted until approved.
next: Review the change, then run agent-bootstrap project approve dagq-lite.
```

Re-approval replaces only `approved.json`. It never touches `local.json`.

### C5. Local permissions

`local.json` takes every key the user config takes, except volume
definitions. Volumes are machine-wide and are defined only in the user
config. `local.json` can refer to them. `agent-bootstrap config edit
[--project <name>]` opens the right file in `$EDITOR`.

### C6. Merging

- **Lists** of grants, such as egress destinations and mounts, are the
  union of the user config, approved permissions and local permissions.
- **Single values** follow this order: local, then approved, then user.
  Version 1 has these single values: `claude.auth`, `claude.model` and
  `verification`.
- **Named entries**, such as mounts, are never merged. The same name in
  two layers is an error.
- **Negation.** No layer can remove a grant from a lower layer in
  version 1.

`doctor --target <path>` prints effective configuration keys and their
layer sources.

### C7. Validation and messages

Every file has `"version": 1`, and an unknown key is an error. A
relative `XDG_CONFIG_HOME` or `XDG_STATE_HOME` is ignored, as the XDG
specification requires. Every ancestor of a configuration or state
directory is checked the way private directories are checked today. Every
file and directory must be owned by the current user, and it must not be
a link. Files have mode `0600` and directories `0700`. The project
declaration is exempt from these file checks, because it is read from a
Git object.

Each error names three things: the key path, the reason in one
sentence, and a `next:` action. Errors never echo configuration values,
only key paths and the fixed vocabulary, such as actor names:

```
Invalid local configuration: egress.Verification is not allowed.
Verification runs tests against unreviewed changes and always stays offline.
next: Remove "Verification" from "egress" in ~/.config/agent-bootstrap/projects/dagq-lite/local.json, then run agent-bootstrap doctor.
```

`doctor --json` reports each such error as a check with `status`
`wrong`, a `detail`, a `fix` and `needsHuman: true`.

Configuration is read once, at launch. Approval and edits take effect
at the next launch.

### C8. Invariants in code

Some rules hold whatever any layer says:

- Verification never receives added egress.
- The mount rules in the volumes ADR also apply.

These protect agent-bootstrap's own guarantees, such as offline
verification. They do not encode any one deployment's choices.

### C9. Migration

The change replaces the current layout immediately. There is no
compatibility period. `agent-bootstrap migrate` runs once. It does the
following:

1. Registers each existing target directory as a project, including the
   default target. The project is named after its repository.
2. Moves state into the XDG state directory.
3. Moves each target `config.json` into `local.json`.
4. Lists the legacy Concierge volume names for operator review and cleanup.
   New Concierge volume names incorporate the project name and its stored
   random ID.

Migration refuses to run while a lease or a run is active. It writes new
files atomically and removes old locations last, so it can be rerun
after a crash.

Old locations then produce an error with `next: agent-bootstrap migrate`.

## Consequences

- A project can share its needs, and the operator still decides what
  takes effect. Agents cannot escalate through repository files.
- Settings are found by project name rather than by path hash, and every
  worktree uses the same ones.
- Update the README, getting-started, the agent guide, CLI help and the
  trust model.
