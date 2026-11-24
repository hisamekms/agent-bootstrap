# ADR 0001: UI evidence for review

- Status: proposed
- Date: 2026-11-24

## Context

A Reviewer receives a Task, `candidate.diff` and `candidate.message`.
When a Task changes a user interface, the diff does not show what the
candidate looks like. A CSS rule inside a media query, a colour that
matches its background, or a dialog that opens after a click can be
reviewed only by rendering the candidate.

The design must keep the existing boundaries:

- The Reviewer judges and never executes candidate code.
- The trusted host alone produces audit evidence.
- The party under review does not produce the evidence for its own review.

Two proofs of concept ran on 2026-11-24 (branch `poc/ui-evidence`).
Their results are recorded under [Evidence](#evidence).

## Principles

**P1. A VM that holds model credentials never executes candidate code.**
The Reviewer VM can hold model credentials. It must not run the candidate
application.

**P2. A VM that executes candidate code holds no credentials and no
network.** Verification already meets this. It is offline, has no
mounts, and runs no model.

**P3. Evidence is reproducible and produced by the host.** Every image is
explained by the tree id, the steps and its SHA-256. An image the Executor
produced is never evidence.

Rejected alternatives follow from these principles:

| Alternative                                       | Rejected because                                                                           |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| The Reviewer runs a browser in its own VM         | Violates P1                                                                                |
| A separate AI role with a browser                 | That role holds credentials and executes candidate code, so it violates P1                 |
| The Executor captures and hands over images       | Violates P3                                                                                |
| Pixel diffs without a model                       | Shows that something changed, not whether the change was intended. Kept as an optional aid |
| A stateful browser session driven by the Reviewer | An image depends on the session history instead of (tree, steps). Violates P3              |

## Decisions

### U1. Verification captures the evidence

The capture runner is fixed product code. It runs in a Verification VM
with the `browser` profile, without network and without mounts. It
starts the application from the tree under test, waits until the
application is ready, and replays **steps**. Steps are data, never code:

- `goto` with a path that starts with `/`
- `click`, `fill` and `wait` with a locator: `{role, name}`, `{label}`,
  `{testId}` or `{text}`
- `wait` for a bounded number of milliseconds
- `screenshot` with a declared viewport and an optional full page

The runner allows no script evaluation and no other origin. Each step and
each scene has a time limit, and each plan has bounded counts. Every
scene starts in a fresh browser context.

The `browser` image pins an Active LTS release of Node.js and
`playwright-core` as staged files. Each staged file is checked against
its SHA-256 on the host and again in the build VM. Debian recipes gain
staged-file support for this. Before adoption, the release checksum list
is also verified against the Node.js release signing keys.

### U2. Scenes have three tiers

| Tier           | Where it lives                                          | Lifetime   | Written by                                                     |
| -------------- | ------------------------------------------------------- | ---------- | -------------------------------------------------------------- |
| Route capture  | Declaration: `routes` × `viewports`                     | Persistent | Declaration, approved by a human                               |
| Task scene     | The Task record and the audit. **Never the repository** | That Task  | The Planner. The Executor and the Reviewer may only add scenes |
| Promoted scene | Declaration: `scenes`                                   | Persistent | Promoted from a Task scene when a human approves it            |

Evidence scenes assert nothing. A scene fails only when it cannot be
captured, so evidence scenes add no tests to maintain. Behavioural
end-to-end tests stay an ordinary project decision.

The project declaration gains `verification.evidence`. This key is part
of the v1 `verification` key and follows the approval rules of the
configuration-layers ADR (C4).

```json
"verification": {
  "evidence": {
    "app": { "argv": ["node", "server.mjs"], "port": 4173, "readyPath": "/" },
    "routes": ["/", "/members"],
    "viewports": ["desktop", "mobile"],
    "triggers": [{ "paths": ["src/ui/**"], "scenes": ["route:/members"] }],
    "scenes": { "edit-dialog": [{ "goto": "/" }, { "click": { "role": "button", "name": "Edit" } }, { "screenshot": { "viewport": "desktop" } }] },
    "limits": { "scenes": 10, "images": 20 }
  }
}
```

Doctor lists the promoted scenes and route captures that no change has
triggered for a configured period, as candidates for removal.

### U3. Anyone may add scenes. No one may remove them

The scenes captured for a candidate are the union of the following:

1. Scenes the host derives from changed paths through `triggers`
2. Scenes the Planner chose for the acceptance criteria
3. Scenes the Executor proposes
4. Scenes the Reviewer pulls (U5)

Every entry must name a declared scene or route, or carry steps that pass
validation. When a limit is exceeded, the run fails visibly and scenes are
never dropped silently.

### U4. Push: evidence and the diff arrive before review

The host captures each push scene for both the base and the candidate.
It checks the images and gives the Reviewer the following read-only
files:

- `/review/candidate.diff`, as today
- `/review/evidence/{base,candidate}/<scene>-<n>.png`
- `/review/evidence/manifest.json`, with the base and candidate ids,
  the route catalog, and the steps, viewport, size and SHA-256 of each
  image

The Reviewer instructions treat the image contents as data. The Reviewer
must name any coverage gap it infers from the diff, such as "a mobile
rule changed and no mobile capture exists".

### U5. Pull: the Reviewer can request more captures through MCP

A Reviewer harness that supports images can receive one MCP tool,
`capture`. The tool takes `target` (`base` or `candidate`), `scene` and
`steps`. It is served by the trusted host through a host service and
reaches the guest over vsock. The Claude adapter connects to it with
`socat`, from pinned packages that are staged only in this mode.

- **Stateless replay.** Each call starts a fresh browser context and
  replays its steps. Images are explained by (tree, steps, SHA-256).
- **Discoverability.** The manifest carries the route catalog. On
  `locator-not-found`, the result includes up to 20 interactive `{role,
name}` pairs from the failing page. Names are truncated and stripped of
  control characters, and the result labels them as untrusted page data.
- **Budget.** A review has a maximum number of calls and a maximum
  total time. Beyond them, calls fail with `capture-budget-exhausted`.
- **Audit.** Every call records the target, scene, steps digest, result
  code, duration and image hashes.
- **Permissions.** Managed settings allow only Read on `/review` and
  this one tool. Every other MCP server stays disabled.

### U6. The host checks and keeps evidence

The host accepts PNG only. Images are bounded in width (2560), height
(8000), bytes per image (2 MiB), total bytes (12 MiB) and count (20). The
host stores the images with the execution and records their hashes in
the audit. The operator CLI can open the evidence of a Task, so a human
reviewer sees the same evidence as the model.

### U7. Short feedback loops

- **Executor pre-run.** The Executor's `browser` profile includes the
  same runner and the approved scenes as read-only files. The Executor
  can capture before submitting. These images are not evidence.
- **Capture failures go back directly.** When Verification cannot
  capture a scene, the host returns the scene, the step index and the
  result code to the Executor without running a Reviewer.
- **No Executor round trip for more evidence.** Pull covers requests for
  more captures within the same review.
- **Cache.** Captures are keyed by (tree id, steps digest, viewport,
  runner and image digest). Base captures are reused across revisions.

### U8. Answers cite evidence

Reviewer findings name an evidence id or file. The answer is requested in
a structured form and parsed strictly. A malformed answer is retried once
before the run reports `reviewer-answer-invalid`.

## Open questions

- **Warm application state.** Pull keeps both applications running for
  the review. A candidate application can keep state across captures.
  The choice is between restarting per capture (slower) and a declared
  reset step.
- **Sign-in and data.** Applications that need a signed-in state or seed
  data need declared fixtures that Verification loads at start-up. The
  fixtures must not contain real credentials.
- **Other harnesses.** Image input and MCP support for the Codex adapter
  are not yet checked. A harness that cannot read images fails closed
  when evidence is configured.
- **Visual diff aid.** A pixel diff could highlight changed regions for
  the Reviewer and the human. It is not required for v1.

## Evidence

Fixture 1: a static page. The Reviewer was asked targeted questions.

| Measure                        | Result                                                                    |
| ------------------------------ | ------------------------------------------------------------------------- |
| Image build                    | `browser` with Node.js 26.13.1 and `playwright-core` 1.65.1; smoke passed |
| VM boot, boot to first capture | 0.36 s, 3.3 s                                                             |
| Per scene                      | 0.15–0.27 s                                                               |
| Six images                     | 136 KB                                                                    |
| Failing scene                  | `locator-not-found` at step 1 after the 5 s limit                         |
| Reviewer correctness           | Correct: colour, order and dialog title                                   |
| Reviewer cost                  | About 22k input tokens including cache, 524 output, 17 s                  |

Fixture 2: an open-ended review. The Task asked for a green Save button
left of Cancel. The candidate also contained R1, an unreadable Close
label in a pushed scene, and R2, a table overflow on `/members` at mobile
width that no pushed scene showed.

| Reviewer input              | Push only                                                     | Push and pull                                                                                             |
| --------------------------- | ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Images only                 | R1 found. R2 missed (no image)                                | R1 found. R2 missed: wrong locator first, then `/members` on desktop only                                 |
| Images and `candidate.diff` | R1 found. R2 named from the diff as an uncovered gap (2 of 2) | R1 found. R2 confirmed by capturing `/members` on mobile in 2 calls (1 run; 1 run had a malformed answer) |
| Cost                        | About 20.5k input tokens, 19 s                                | About 38k input tokens, 21 s                                                                              |

The route catalog and locator hints removed the capture failures. The
diff told the Reviewer what to capture.
