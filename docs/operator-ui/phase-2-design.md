# Operator UI phase 2: the workplace

- Status: proposed
- Date: 2026-11-25
- Builds on: [ADR 0001](adr-0001-operator-ui.md), phase 1 (#38)

Phase 2 puts the Concierge conversation and a read-only host panel in one
browser window, served by the development bridge (ADR D3). Gates are
still answered with the TTY CLI. The desktop shell, notifications and
Touch ID stay in phase 3.

## Findings that shape this phase

- **Bun owns the PTY.** Bun 1.4.4 `Bun.spawn` with the `terminal` option
  gives a real PTY with `write` and `resize`. A probe ran `tty`,
  `stty size`, a resize and input as expected. No native helper is
  needed. This closes the ADR's PTY open question.
- **Nothing hosts the phase 1 API yet.** `listenOperatorApi` is only
  called by tests. `inbox` and `watch` read the store directly. Phase 2
  adds the first long-lived process that serves it.
- **The launcher attaches with `stdio: "inherit"`.** The Concierge PTY
  belongs to the operator's terminal today
  (`MicrosandboxRuntime.attachTerminal`).

## Decisions

### P1. One command starts the workplace

`agent-bootstrap --target <dir> workplace` does what the Concierge
launcher does today, with three differences:

- the host spawns `msb exec -t` inside a Bun PTY instead of inheriting
  the operator's TTY;
- the same process serves the operator API (phase 1 methods plus P3) on
  the Unix socket;
- with `--dev-bridge`, it also serves the UI on loopback (P4) and prints
  the one-time URL.

The current `concierge` command stays unchanged as the TTY path and the
fallback. One Concierge session exists per target. A second `workplace`
or `concierge` for the same target fails as it does today.

Closing the browser leaves the session running. Opening the URL again
reattaches. Stopping the `workplace` process ends the Concierge session,
as closing the terminal does today. The interactive lifetime limit does
not change.

### P2. The sandbox port gains a PTY sink

`attachTerminal` takes an optional sink:

```ts
interface TerminalSink {
  readonly cols: number;
  readonly rows: number;
  data(chunk: Uint8Array): void;
}
interface AttachedTerminal {
  write(input: Uint8Array): void;
  resize(cols: number, rows: number): void;
}
```

Without a sink, the adapter keeps `stdio: "inherit"`. With one, it spawns
the same argv in a Bun PTY and returns `AttachedTerminal` beside the
existing `finished` promise. The port stays provider-neutral. The trusted
host keeps its current checks before attaching.

### P3. The operator API streams the Concierge terminal

New methods on the Unix socket:

| Method             | Direction      | Content                                                     |
| ------------------ | -------------- | ----------------------------------------------------------- |
| `concierge.attach` | client to host | replay of the screen buffer, then `concierge.output` pushes |
| `concierge.input`  | client to host | base64 bytes, at most 16 KiB per message                    |
| `concierge.resize` | client to host | `cols` 20–500, `rows` 5–200                                 |
| `concierge.exit`   | host to client | exit code, then the stream ends                             |

- Output passes the control-sequence filter (P5) before it is buffered
  or sent.
- The host keeps the last 512 KiB of filtered output for replay.
- At most one client holds input at a time. The newest attach takes
  input; earlier clients stay read-only and see a host notice.
- The existing limits apply: eight clients and 1 MiB of pending output
  per client. A client over the limit is disconnected, not slowed down.

### P4. The development bridge

- Off by default. `--dev-bridge` binds `127.0.0.1` on a random port.
  No other interface is accepted.
- A 256-bit token is generated per launch. The printed URL carries it in
  the fragment. The page sends it once in the WebSocket's first message.
  It is never put in a cookie, a query string or a log.
- Each HTTP request must carry `Host: 127.0.0.1:<port>`. The WebSocket
  upgrade must also carry `Origin: http://127.0.0.1:<port>`. Anything
  else gets 403 before any work.
- One WebSocket relays only `inbox.*`, `status`, `proposal.get` and the
  `concierge.*` methods. A gate-answer method is refused even after it
  exists.
- Responses carry `Content-Security-Policy: default-src 'none';
script-src 'self'; style-src 'self'; connect-src 'self'; img-src
'self'; font-src 'self'; base-uri 'none'; form-action 'none';
frame-ancestors 'none'`, plus `X-Content-Type-Options: nosniff`,
  `Referrer-Policy: no-referrer` and `Cache-Control: no-store`.
- Static assets are bundled at build time and served from memory. The
  bundle may contain no `http:` or `https:` URLs; a test checks this.

### P5. A control-sequence filter for the conversation

The filter is a byte state machine that keeps its state across chunks:

- It passes text, C0 controls the terminal needs (`BEL` only inside
  allowed sequences, `BS`, `HT`, `LF`, `CR`), and CSI sequences.
- It drops every OSC (including clipboard 52, links 8, titles 0/1/2 and
  notifications 9/777), DCS, APC, PM and SOS sequence.
- It caps any sequence at 4 KiB and drops one that runs longer.
- It drops C1 controls in their 8-bit form.

The renderer also turns off its own OSC 52 and link handlers, as a
second layer.

### P6. The browser UI

- Two regions side by side. The left is an xterm.js terminal. The right
  is the host panel. The divider can be moved.
- `F6` moves focus between the regions. It is never sent to the
  Concierge. A click also moves focus.
- The host panel shows, from host data only:
  - `action` items first, then `info` items, from `inbox.subscribe`;
  - a status line with Goal and Task counts;
  - on selection, the proposal's kind, IDs, pinned digest and the exact
    CLI command to answer it, with a copy button.
- All text is set with `textContent`. Model text is shown in a labeled,
  visually distinct box.
- `info` items appear only in the host panel. The Concierge still
  mentions new `action` items (ADR D6). This closes the ADR's `info`
  open question.
- The panel marks items seen with `inbox.markSeen` when they are shown.

### P7. Dependencies

The UI needs a terminal emulator. The proposal is `@xterm/xterm` and
`@xterm/addon-fit` (MIT), as the only new dependencies, pinned in the
lockfile. Fetching them needs the operator's approval. Until then, the
host side (P1–P5) can be built and tested without them.

## Tests

- Filter: a table of sequences, chunk splits at every byte, the length
  cap, and 8-bit C1 controls.
- PTY sink: a fake runtime that spawns `/bin/sh` in a Bun PTY; input,
  resize, exit and replay.
- API: attach, input ownership handover, size limits, output limits and
  disconnects.
- Bridge: wrong `Host`, wrong `Origin`, a missing or wrong token, the
  refused methods, and the response headers.
- Bundle: no remote URLs.
- A manual run against a real Concierge, recorded in the findings file.

## Out of scope for phase 2

- Answering gates from the UI.
- Notifications, badges and Touch ID.
- Diffs in the host panel. They need a size and escaping design of their
  own.
