# Stage 1 Concierge live runs

The first operator-authorized live runs took place on 2026-11-23 with
Microsandbox 0.7.16, Claude Code v2.1.330, and Opus 5.5. Claude drove the
interactive session through a pseudo-terminal, and the operator input log
records every input. The host loaded the operator credential from the macOS
Keychain and substituted it at egress.

## Run 1

Interactive Claude Code exited at startup with
“Unable to connect to Anthropic services / Failed to connect to
platform.claude.com: ENOTFOUND”. The network audit recorded denied DNS for
`platform.claude.com` with reason `dns-not-allowlisted`. Commit `41ea517`
allowed `platform.claude.com:443` for the Concierge only, without credential
substitution.

## Run 2

The connectivity check passed. The session kept the automatic theme, acknowledged
the security notes, and accepted workspace trust for the read-only repository
snapshot at `/repo`. Auto mode was enabled.

The Concierge called the MCP `status` tool. The call reached the Host API over
vsock and returned `invalid-arguments` because the Host API rejected MCP `_meta`
in `tools/call` params. Commit `d45c1f8` fixed the rejection.

## Run 3

Claude Code restored the previous conversation from the named volume with
`--continue`. The `status` call succeeded, and the Concierge called
`request_planner` for `goal-design`. The Planner ran in its own VM through
`TrustedHost`. Execution `961466b9-97b6-494f-9d22-8f9279b7d7bf` succeeded in one
attempt using 6 input tokens and 1,451 output tokens.

The Planner created goal proposal `240e037e-dfdf-4727-94bf-178110f51093`, with the
Planner and its execution ID recorded as the origin. The proposal stayed pending
at the `goal-registration` gate under the default `human` policy. It scoped the
work to `docs/local-orchestrator/`, selected the `base` profile and the Executor
and Reviewer actors, and set `maxTasks` to 2.

## Audit and cleanup

| Network audit entry      | Runs 2–3                                                                                                                               |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| `api.anthropic.com`      | 16 allowed provider egress connections                                                                                                 |
| `platform.claude.com`    | 1 plain connection, 534 bytes sent and 5,021 received. It closed after a 60-second idle timeout, consistent with a startup check only. |
| `dl-cdn.alpinelinux.org` | 24 denied DNS requests                                                                                                                 |
| `downloads.claude.ai`    | 4 denied DNS requests                                                                                                                  |
| `github.com`             | 2 denied DNS requests                                                                                                                  |

The invocation audit recorded three Concierge invocations and one Planner
invocation. All VMs were removed after each run. The named state volume
`lo-concierge-4b63f3eb498946f0` was intentionally retained.

## Verification

The runs verified the interactive TTY, auto mode, the Host API over vsock,
session continuation, Planner execution through the Host API, and the pending
state at the human gate. Live terminal resize, secret rotation, and CLI approval
of a real proposal remain unverified. The proposal was left pending for the
operator to approve.

## Follow-ups

- Done. The Host API now offers `wait_execution` for up to 60 seconds. In run 3,
  the Concierge polled `get_execution` five times while the Planner was running,
  then stopped.
- Consider documenting denied update, changelog, and plugin lookups as expected
  audit noise. They did not block the session.
- Add the host PTY relay that filters terminal escapes, already listed in the
  [Stage 1 implementation notes](stage1.md).
