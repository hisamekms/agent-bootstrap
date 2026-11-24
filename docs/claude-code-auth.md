# Claude Code authentication

Set `claude.auth` in the user config or in a registered project's private
`local.json`.

| Mode                | Host behavior                                                                                                                        |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `api-key` (default) | Reads the API key from Keychain. Microsandbox substitutes it for the guest's placeholder on requests to the API host.                |
| `external`          | Supplies no credential or substitution. The audited gateway relays plain HTTPS to the API host and to configured actor destinations. |

## Setup

For API-key mode, set `claude.apiKey.keychainService` and provision that
service in Keychain. Use `agent-bootstrap doctor --target <path>` to check
the project and the Keychain entry. Both modes use host-managed Claude
permissions. Output credential screening also applies in `api-key` mode.
`claude.leakPatterns` can add screening patterns. Built-in screening
remains active, so keep fixtures that resemble credentials out of agent
outputs and collected artifacts. Set additional failure mappings in
`claude.errors`.

## Encrypted volumes and mounts

Declare each volume under `volumes` in the user config. A definition has
an absolute sparse image path, a Keychain service and
`"attach": "while-running"`. Run `agent-bootstrap volume init <name>`
to create the encrypted APFS image and provision its passphrase.

Declare mounts under `mounts`. Each entry names a volume, one directory
at its root, a guest path under `/mnt`, and its actors. Mounts default
to read-only. A read-write mount belongs in a project's `local.json`
and has one actor and a directory dedicated to that mount across all
registered projects. The Claude adapter supports the optional
`CLAUDE_CONFIG_DIR` mount environment variable in both modes.

A mounted actor loses shell tools. Managed permissions limit file tools
to its working paths and deny access through file tools to every mounted
path. Verification runs offline without mounts. Mount permissions and
`egress` grants are configured independently. Doctor warns when a
mounted actor has added egress.

Use `agent-bootstrap volume shell <mount> --target <path>` from an
operator terminal to create or access the directory. It mounts the
directory read-write on the Concierge image, takes an exclusive lease
and applies `egress.shell`. Exit the shell before launching a run that
needs the directory.

The host checks the ownership and permissions of the volume root and
mount directory at launch. It records the mount name, mode and guest
path in the audit. It does not inspect directory contents. Read-only
leases can overlap. An exclusive lease waits up to 30 seconds for a
conflicting holder, then reports `mount-busy`.

Use `agent-bootstrap volume status <name>` to inspect the attachment and
leases. `volume attach <name>` prepares an attachment for the next run.
After doctor reports a stale attachment or lease, confirm the VMs have
stopped before running `volume detach <name> --force`.

## Migration

Stop active runs and release leases and attachments before running
`agent-bootstrap migrate`. The command reports which actors lose write
access and shell tools. For each project, it reports the count of added
mounts and egress destinations per actor. It also provides steps to
declare a project-scoped read-write mount. Converted actor grants go to
the projects that used the legacy mode. Each project keeps its legacy
egress override. The user config receives the volume definition and
the egress destinations for `volume shell`. Legacy custom screening
patterns carry over to the projects that used `config-dir`. API-key
projects can declare custom patterns using `claude.leakPatterns`.

## Live checks

From the checkout, run the smoke against a registered project's effective
configuration with `bun run spike/local-orchestrator/claude-policy-smoke.ts --run --target <path>`.
It requires mounts for Reviewer and Executor, including a read-only
mount. Use disposable mount directories with a regular
`policy-smoke.txt` file containing `ok-marker` in each directory.
The smoke checks file-tool scope, Executor symlink access, shell access,
read-only directory metadata and the absence of memory entries. The
report marks the Reviewer symlink probe as skipped because the review
snapshot only accepts regular files and is already read-only at launch.

Run `bun run spike/local-orchestrator/ro-probe.ts --run` from an operator
terminal to test the backend's read-only enforcement with a disposable
fixture directory.
