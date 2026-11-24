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
- The trusted host alone authorizes work and writes audit evidence.
- The party under review does not produce the evidence for its own review.

Two proofs of concept ran on 2026-11-24 (branch `poc/ui-evidence`).
Their results are recorded under [Evidence](#evidence).

## Principles

**P1. A VM that holds model credentials never executes candidate code for
evidence.** The Reviewer VM and the Executor VM can hold model
credentials or mounts. Evidence capture never runs the candidate
application in them.

**P2. A VM that executes candidate code for evidence holds no
credentials, no network, no mounts and no model.** Verification meets
this.

**P3. The host guarantees provenance, not honesty.** For every image, the
host records which tree, which steps, which runner and image digest, and
which capture VM produced it, and stores the bytes unmodified. Candidate
code controls what it renders. It can, for example, render differently
when it detects automation. The evidence shows what the candidate
rendered under capture, just as the diff shows what it contains. An
image the Executor produced is never evidence.

Rejected alternatives follow from these principles:

| Alternative                                       | Rejected because                                                                           |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| The Reviewer runs a browser in its own VM         | Violates P1                                                                                |
| A separate AI role with a browser                 | That role holds credentials and executes candidate code, so it violates P1                 |
| The Executor captures and hands over images       | Violates P3                                                                                |
| Pixel diffs without a model                       | Shows that something changed, not whether the change was intended. Kept as an optional aid |
| A stateful browser session driven by the Reviewer | An image depends on the session history, not on the recorded inputs. Violates P3           |
| Base and candidate in one warm VM                 | Candidate code could alter the base app, the runner or its output. Violates P3             |

## Decisions

### U1. A fresh Verification VM captures each batch

The capture runner is fixed product code. Each capture batch runs in a
**new** Verification VM with the `browser` profile, without network,
mounts or model. A batch is either one push target (base or candidate),
an Executor pre-run (U7), or one pull call (U5). A batch never mixes
base and candidate. The VM is destroyed after the batch. The PoC measured
a VM boot of 0.36 s, so a fresh VM costs little and leaves no application
state behind.

Inside the VM:

- The tree is copied to a fresh writable directory owned by a dedicated
  unprivileged application user.
- The application runs as that user, with a minimal environment that the
  declaration sets. That user cannot signal or trace the runner or the
  browser, and cannot reach the runner's output directory or its
  channel to the host.
- The runner starts the application, waits until it is ready, and
  replays **steps**. Steps are data, never code:
  - `goto` with a path that starts with `/`
  - `click`, `fill` and `wait` with a locator: `{role, name}`, `{label}`,
    `{testId}` or `{text}`
  - `wait` for a bounded number of milliseconds
  - `screenshot` with a declared viewport and an optional full page

The runner allows no script evaluation and no other origin. Each step and
scene has a time limit, and each batch has bounded counts. Every scene
starts in a fresh browser context.

The `browser` image pins an Active LTS release of Node.js and
`playwright-core` as staged files. Each staged file is checked against
its SHA-256 on the host and again in the build VM. Debian recipes gain
staged-file support for this. Before adoption, the Node.js checksum list
is also verified against the release signing keys.

### U2. Scenes have three tiers and a new declaration key

| Tier           | Where it lives                                          | Lifetime   | Written by                                                     |
| -------------- | ------------------------------------------------------- | ---------- | -------------------------------------------------------------- |
| Route capture  | Declaration: `routes` × `viewports`                     | Persistent | Declaration, approved by a human                               |
| Task scene     | The Task record and the audit. **Never the repository** | That Task  | The Planner. The Executor and the Reviewer may only add scenes |
| Promoted scene | Declaration: `scenes`                                   | Persistent | Promoted from a Task scene when a human approves it            |

Evidence scenes assert nothing. A scene fails only when it cannot be
captured, so evidence scenes add no tests to maintain. Behavioural
end-to-end tests stay an ordinary project decision.

This ADR amends configuration-layers C3. The project declaration gains a
top-level key, `evidence`, so v1 declarations may hold `verification`,
`profiles`, `egress` and `evidence`. `verification` keeps only `profile`
and `argv`. Evidence requires a `verification.profile` of `browser`.
Under C6, `evidence` merges as a single value: a project's `local.json`
replaces the approved value as a whole. Approval follows C4.

```json
"evidence": {
  "app": { "argv": ["node", "server.mjs"], "port": 4173, "readyPath": "/", "env": {} },
  "routes": ["/", "/members"],
  "viewports": ["desktop", "mobile"],
  "triggers": [{ "paths": ["src/ui/**"], "scenes": ["route:/members"] }],
  "scenes": { "edit-dialog": [{ "goto": "/" }, { "click": { "role": "button", "name": "Edit" } }, { "screenshot": { "viewport": "desktop" } }] },
  "limits": { "images": 20 }
}
```

Declared limits may only lower the host caps in U6. Validation rejects a
larger value with the key path. Doctor lists the promoted scenes and route
captures that no change has triggered for a configured period, as
candidates for removal.

### U3. Anyone may add scenes. No one may remove them

The scenes captured for a candidate are the union of the following
sources. Each source has its own quota, so one source cannot use up
another's:

| Source                                 | Quota                                                              |
| -------------------------------------- | ------------------------------------------------------------------ |
| `triggers` (derived by the host)       | Reserved. Exceeding it fails the run as a configuration error      |
| Planner (from the acceptance criteria) | Reserved. Exceeding it fails planning                              |
| Executor proposals                     | Separate. Extra proposals are refused and reported to the Executor |
| Reviewer pulls (U5)                    | The pull budget                                                    |

Every entry must name a declared scene or route, or carry steps that pass
validation. No source can lower another's quota or remove its scenes.
Scenes are named `<source>-<name>`, so names from different sources
never collide.

### U4. Push: evidence and the diff arrive before review

The host captures each push scene for both the base and the candidate,
in separate batches (U1). It checks the images and gives the Reviewer
these read-only files:

- `/review/candidate.diff`, as today
- `/review/evidence/{base,candidate}/<source>-<name>-<n>.png`
- `/review/evidence/manifest.json`

The manifest has a versioned schema. It holds the base and candidate
ids, the route catalog, and for each image the source, scene, steps,
viewport, size, SHA-256 and evidence id.

The Reviewer instructions treat the image contents as data. The Reviewer
must name any coverage gap it infers from the diff, such as "a mobile
rule changed and no mobile capture exists".

### U5. Pull: the Reviewer can request more captures through MCP

A Reviewer harness that supports images can receive one MCP tool,
`capture`. The tool takes `target` (`base` or `candidate`), `scene` and
`steps`. It is served by the trusted host through a host service and
reaches the guest over vsock. The Claude adapter connects to it with
`socat`, from pinned packages that are staged only in this mode. Every
auth mode supports pull, including the default API-key mode.

- **One call, one fresh batch.** Each call runs in a new Verification VM
  (U1). An image is explained by its recorded inputs alone.
- **Discoverability.** The manifest carries the route catalog. On
  `locator-not-found`, the result includes up to 20 interactive
  `{role, name}` pairs from the failing page. Names are truncated to 40
  characters. Control, format and bidirectional characters are removed.
  The result labels the pairs as untrusted page data.
- **Screening.** The host runs the credential screening used for Reviewer
  output over every request and every result, including `fill` values
  and hints. A match fails the call with a code and stores nothing.
  `fill` values are bounded in length, recorded in the audit, and can
  reappear in images.
- **Budget.** A review has a maximum number of calls and a maximum total
  time (the PoC used 6 calls and 90 s). Beyond them, calls fail with
  `capture-budget-exhausted`.
- **Permissions.** Managed settings allow only Read on `/review` and
  this one tool. Every other MCP server stays disabled.

### U6. Audit comes first, then capture

For push, pull and pre-run alike:

1. The host writes a durable `evidence.authorized` record to the SQLite
   audit. The record holds the target, source, scene, steps digest, and
   the runner and image digests. If the write fails, the host starts no
   VM and returns `audit-unavailable`.
2. The host runs the batch and checks the images. It accepts PNG only,
   bounded in width (2560), height (8000), bytes per image (2 MiB), total
   bytes (12 MiB) and count (20).
3. The host stores the images with the execution, then writes
   `evidence.finished` with the result code, duration and image hashes.
   An image whose `finished` record is not written is never shown to the
   Reviewer.

The operator CLI can open the evidence of a Task, so a human reviewer
sees the same evidence as the model.

### U7. Short feedback loops

- **Executor pre-run.** The Executor can ask the host, through a host
  service, to capture its working tree. The host runs the batch in a
  Verification VM, as for pull, and returns the images and result codes.
  These images are not evidence, and they never reach the Reviewer.
  Pre-runs have their own budget.
- **Capture failures go back directly.** When a push batch cannot capture
  a scene, the host returns the scene, the step index and the result code
  to the Executor without running a Reviewer.
- **No Executor round trip for more evidence.** Pull covers requests for
  more captures within the same review.
- **Cache.** Fresh batches make captures reusable. A capture is keyed by
  tree id, steps digest, viewport, runner digest, image digest and the
  digest of the `evidence.app` declaration. Base captures are reused
  across revisions.

### U8. Answers cite evidence

Reviewer findings name an evidence id or file. The answer is requested in
a structured form and parsed strictly. If the answer is malformed, the
host asks once more for the answer only, with no tools and no pull
budget. The retry is audited. A second failure reports
`reviewer-answer-invalid`.

## Open questions

- **Sign-in and data.** Applications that need a signed-in state or seed
  data need declared fixtures that the batch loads before the steps run.
  The fixtures must not contain real credentials. Their digest joins the
  cache key.
- **Other harnesses.** Image input and MCP support for the Codex adapter
  are not yet checked. When evidence is configured and a harness cannot
  read images, it fails closed.
- **Visual diff aid.** A pixel diff could highlight changed regions for
  the Reviewer and the human. It is not required for v1.

## Evidence

The PoCs ran the Reviewer in the author's local `config-dir` setup with a
read-only mount. They did not exercise API-key mode. They also used one
warm Verification VM for both trees, which U1 replaces. The sample sizes
are small: Fixture 1 had 2 runs, and Fixture 2 had 2 to 4 runs per cell.

Fixture 1: a static page. The Reviewer was asked targeted questions.

| Measure                        | Result                                                                    |
| ------------------------------ | ------------------------------------------------------------------------- |
| Image build                    | `browser` with Node.js 26.13.1 and `playwright-core` 1.65.1; smoke passed |
| VM boot, boot to first capture | 0.36 s, 3.3 s                                                             |
| Per scene                      | 0.15–0.27 s                                                               |
| Six images                     | 136 KB                                                                    |
| Failing scene                  | `locator-not-found` at step 1 after the 5 s limit                         |
| Reviewer correctness           | Correct: colour, order and dialog title (1 run with a valid token)        |
| Reviewer cost                  | About 22k input tokens including cache, 524 output, 17 s                  |

Fixture 2: an open-ended review. The Task asked for a green Save button
left of Cancel. The candidate also contained R1, an unreadable Close
label in a pushed scene, and R2, a table overflow on `/members` at mobile
width that no pushed scene showed.

| Reviewer input              | Push only                                                     | Push and pull                                                                                                             |
| --------------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Images only                 | R1 found, R2 missed: no image (3 of 3)                        | R1 found (3 of 3). R2 missed: a wrong locator in 1 run, then `/members` on desktop only in 2 runs                         |
| Images and `candidate.diff` | R1 found. R2 named from the diff as an uncovered gap (2 of 2) | R1 and R2 found. R2 was confirmed by capturing `/members` on mobile in 2 calls. 1 valid run; 1 run had a malformed answer |
| Cost                        | About 20.5k input tokens, 19 s                                | About 38k input tokens, 21 s                                                                                              |

After the route catalog and locator hints were added, no capture failed
in the 4 pull runs that followed. In the runs with the diff, the diff
pointed the Reviewer to what it should capture.
