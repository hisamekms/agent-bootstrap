# ADR 0001: One operator workplace for the Concierge and approvals

- Status: proposed
- Date: 2026-11-25

## Context

A full local run, from a Goal to an integrated Task, showed that the
operator works in two places. The Concierge conversation runs in one
terminal. Status, proposal IDs, approvals, retries and failure reasons
need a second terminal and exact CLI commands. In that run the operator:

- looked up proposal and Task IDs by hand;
- did not learn why a Task failed until the host's private state was
  inspected (`path-violation` did not name the paths);
- had no prompt that a changed launcher invalidated the self-test;
- copied shell commands that differ between shells.

The operator wants progress, and anything that needs them, to arrive
without watching a second interface. A separate inbox screen would split
the work again. The operator wants one workplace.

This repository is the testbed. The local orchestrator stays small
(local-orchestrator ADR D1). The production interface belongs to
dagq-lite, which builds it from the findings recorded here.

## Decisions

### D1. One workplace: the Concierge beside a host panel

One window holds two regions:

- **Conversation.** The interactive Concierge session, unchanged. It is
  an embedded terminal attached to the same `msb exec -t` PTY the
  launcher uses today.
- **Host panel.** Pending decisions, running and failed work, Goal
  progress, diffs, and the next action for each item. The host renders
  it from its own state. Model text never renders here unescaped.

The operator answers gates in the host panel and talks to the Concierge
in the conversation. Nothing requires a second terminal. The TTY CLI
remains for scripting and as a fallback.

### D2. The host owns an inbox as data, not as a screen

The host projects an inbox from durable records only (`state.db` events
and audit), never from model output. Each item has:

- kind (gate, failed Task, exhausted retries, budget, self-test needed,
  volume state, integration done, Goal done);
- weight: `action` (stays until resolved), `info` (may be coalesced) or
  `digest`;
- subject IDs, a short host-written title, the next action, and state
  (`open`, `seen`, `resolved`).

The host resolves an item when the underlying state changes, for example
when a gate is answered or a retry starts. Failure items carry the
host's reason, for example the paths outside a Task's scope.

### D3. A host API over a Unix socket

The UI talks to the trusted host through a per-user Unix socket in a
`0700` directory under the host state directory. No TCP port is opened.
The API offers:

- inbox and status reads, and a stream of inbox changes;
- proposal details with the pinned digest and the integration diff;
- the gate answer (D5);
- the Concierge PTY stream (input, output, resize).

The socket's file permissions are the client boundary. The API is
provider-neutral and holds no credential values.

For development before a desktop shell exists, an opt-in loopback bridge
may serve the same UI on `127.0.0.1` with a per-launch random token,
`Host` and `Origin` checks, and a strict CSP. It is off by default and
cannot answer gates.

### D4. Trusted and untrusted regions stay apart

- The conversation region shows Concierge output, which is untrusted.
  The host strips terminal control sequences that reach outside the
  pane (OSC 52 clipboard, OSC 8 links, title and notification
  sequences) before they reach the renderer.
- The host panel shows host data. Text that came from a model, such as
  a Task title, is shown as escaped plain text and is labeled as model
  text.
- The UI loads no remote resources. All assets ship with the build.

### D5. Gates are answered only in the host panel

- The Concierge cannot answer a gate. It can tell the operator that one
  is waiting and where to find it.
- An answer names the proposal and its pinned digest. The host rejects
  it if the digest changed.
- An answer needs operator presence. With the desktop shell, the shell
  asks for Touch ID through macOS LocalAuthentication and passes only
  the result to the host. Without the shell, the TTY CLI and its typed
  confirmation remain the way to answer.
- Delegated and on-behalf answers keep their current rules.

Amended 2026-11-25 by [decisions-design.md](decisions-design.md) Q1: the
development bridge answers with the per-launch token and one
confirmation. The presence check is deferred until the operator uses
software that can drive their browser or screen.

### D6. The Concierge knows the inbox

The Concierge's host API gets a read-only inbox tool that returns kinds,
IDs, weights and host-written titles. The Concierge mentions new
`action` items when the operator's turn comes. The host panel remains
the source of truth for counts and state.

### D7. Notifications call the operator back

- When the window is closed or in the background, `action` items raise
  a native notification (desktop shell) that opens the host panel at
  that item.
- Notifications carry the kind and a count only: no diffs, prompts,
  model text or paths.
- External channels (webhooks, mobile push) are out of scope here. If
  added later, they carry the same minimal content and point back to the
  workplace.

### D8. A desktop shell wraps the same UI later

Phases 1 and 2 build the UI with web technology and the host API.
Phase 3 wraps it in a macOS shell for the menu bar, badges, native
notifications and Touch ID. The shell connects only through the Unix
socket. The choice between Tauri and Electrobun is made in phase 3 after
a maturity and license check.

### D9. Record findings for dagq-lite

The testbed keeps a findings file next to this ADR. It records what
worked, what the operator ignored, and which inbox kinds and API calls
proved necessary. dagq-lite's interface starts from it.

## Phases

1. Inbox projection, the host API over the Unix socket, `inbox` and
   `watch` CLI views, and the Concierge inbox tool.
2. UI with the embedded Concierge terminal and a read-only host panel,
   through the development bridge.
3. Desktop shell, native notifications and Touch ID gate answers.

## Out of scope

- Remote or mobile access, and approval from another device.
- External notification services.
- Replacing the Concierge's terminal with a custom chat view.

## Open questions

Phase 2 settles the first three; see [phase-2-design.md](phase-2-design.md).

- PTY ownership: settled. Bun's `Bun.spawn` `terminal` option gives the
  host a PTY; no helper is needed (P1, P2).
- Focus between regions: settled. `F6` moves focus and is never sent to
  the Concierge (P6).
- `info` items: settled. They appear only in the host panel (P6).
