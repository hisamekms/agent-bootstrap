# Operator UI: answering and delegating decisions

- Status: proposed
- Date: 2026-11-25
- Builds on: [ADR 0001](adr-0001-operator-ui.md),
  [phase 2](phase-2-design.md) (#43 to #47)
- Amends: ADR D5 and phase 2 P4 (see "What this changes")

Phase 2 put the Concierge terminal and a read-only host panel in one
browser window. The operator tried it with a real Concierge and asked for
the panel to become the place where work is followed and decided. This
document records what the operator needs, the layout chosen from three
previews, and the host changes that layout needs.

Run `bun spike/operator-ui/preview.ts [--port <n>]` and open the printed
URL to try Workplace with in-memory examples.

## What the operator needs

In the operator's order of priority:

1. **Answer decisions quickly from the panel.** Approve or reject. When a
   proposal offers alternatives, pick one. When the AI recommends one,
   the panel shows which and why.
2. **Start work by talking to the Concierge.** The operator often does
   not know whether a request is a Goal or a Task, or whether similar
   work exists. The Concierge looks first and proposes the right shape.
   The panel has no creation form.
3. **See how far each Goal is.** Tasks done out of the total, and roughly
   how long until the Goal can close.
4. **See where each Task is.** Its stage, and roughly how long until it
   closes.
5. **See problems.** Failures, out-of-scope changes and budget overruns.
6. **Choose what the AI may decide.** Per gate, by rules over the kind
   and size of the work, per Goal, and for integration per Task.

A rough estimate is acceptable for 3 and 4 for now.

## Layout

The panel has four tabs. Selecting an item opens its detail in the same
panel, with a breadcrumb back.

| Tab        | Content                                                                                 |
| ---------- | --------------------------------------------------------------------------------------- |
| Decisions  | Waiting decisions, with batch approval. Below them, the decisions the AI made recently. |
| Problems   | Failed Tasks, out-of-scope changes, budget overruns, and actions for the affected work. |
| Goals      | Goals with a progress bar, done out of total and an estimate. Detail lists the Tasks.   |
| Delegation | The default per gate, the rules, and the invariants that no setting changes.            |

- **Goal detail:** title, status, progress, estimate, scope, budget,
  private branch, this Goal's delegation overrides, and its Tasks with
  stage and estimate.
- **Task detail:** title, actor, the category the Planner gave (labeled
  as the Planner's claim), a five-stage track (registered, running,
  review, awaiting integration, done), attempt, elapsed time, tokens,
  diff size, this Task's integration setting with the effective result
  and why, the problem with its log when it failed, acceptance criteria,
  and recent events.

Tabs were chosen over one long feed and over a summary strip because they
keep each list short and the terminal full height. The badge on each tab
carries the count, so a new decision is still visible from other tabs.

## Decisions

### Q1. The panel answers gates

- New operator API method `proposal.answer` with `{id, digest, decision,
choice?}` and `proposal.answerMany` with a list of the same. The bridge
  relays both. Each answer names the pinned digest; the host refuses a
  stale one, as the CLI does.
- The panel asks once before each answer and displays the proposal details.
  A batch asks once for the whole list.
- The host records the answer as the operator's, with origin
  `operator-ui`, the digest and the chosen alternative.
- The regular panel actions answer decisions reserved to a human,
  including decisions held for a human by an invariant under an
  inherited agent policy. For a pending gate the AI may answer, the
  secondary action 「自分で答える」 opens the proposal and asks the
  operator to confirm approval or rejection in the AI's place. The
  single answer sends `takeover: true` with the pinned digest. This
  records a human answer without changing the gate's policy or the AI's
  permissions. The first valid answer recorded by the host closes the
  proposal, as with a human CLI answer racing the AI. Batch approval uses
  the regular panel actions. On-behalf answers remain CLI-only.
- No extra presence check for now. A loopback page that holds the
  per-launch token can answer. On one operator's machine this matches the
  TTY CLI: any process running as the operator can already drive the CLI
  confirmation. A presence check (WebAuthn with Touch ID, or the desktop
  shell's LocalAuthentication) only adds protection against software that
  operates the operator's own browser or screen. Revisit it when the
  operator starts using computer-use agents or extensions that can read
  and click every site.

### Q2. Proposals can carry alternatives and a recommendation

- Goal-registration and Task-registration proposals may carry
  `alternatives` (two to four, each with a label, a summary and the full
  content it would register), `recommended` (one alternative's id) and
  `reason`.
- The digest covers every alternative. Approving names one alternative;
  the host registers exactly that alternative's content.
- `recommended` and `reason` are model text. The panel labels them as the
  AI's and shows them as plain text.
- Integration proposals have no alternatives.

### Q3. Read methods for Goals, Tasks, problems and AI decisions

- New read-only methods: `goal.list` (filter by status), `goal.get`,
  `task.list` (by Goal), `task.get`, `problem.list` and
  `decision.history` (answers by the AI, with the setting that allowed
  them). The bridge relays them. Replies pass the credential scan before
  they are sent, as `proposal.get` does.
- Problems are derived from records that already exist: failed Tasks,
  out-of-scope path violations, and executions over budget.

### Activity and in-place decisions

The header pill and decision tab badge share the human decision count.
The pill also summarizes running and queued work. The decision queue,
popover, and Goal overview put human decisions first and show AI-pending
decisions in a collapsed section.
The Goal list offers inline answers for human decisions and folds finished Goals.
The popover has a problem section with one compact row per problem Task.
The inbox refresh updates all copies after the host records an answer.
Every view uses Goal and Task refs. Inside a Goal detail, its Task refs
use the shorter `#m` form.

The Goal list groups rows by who can act next. A Goal detail shows its
turn, running work, decisions and failures above the Task list in 「概要」.
「任せ方」 holds delegation settings, 「履歴」 shows recent activity, and
「詳細」 holds scope and acceptance. An approved
Goal proposal becomes a tracking card until a decision for that Goal arrives
or the operator closes it. The plan and consultation buttons paste drafts
into Concierge and transfer focus to its terminal.

Problems allow retrying the same Task or confirming a Goal discard. Retry
submits the displayed retry count. Opening the discard confirmation reads
the current branch head. A stale head requires another confirmation with a
fresh read. Export from Goal detail reads the current commit range for
the launch target and opens a separate confirmation. The host screens
the changes before writing the local branch. If the Goal changes, the
panel refreshes the detail before another confirmation. The host
contract is documented in [Activity and actions](activity-api.md).

### Proposal details and connection

Rendering a decision card fetches and caches `proposal.get` for its summary
and warnings. 「詳細」 opens the evidence. 「実行の条件」 holds origin, policy,
human decision requirements, budgets, and execution limits. The description,
acceptance criteria and Reviewer findings are plain text. The card's 「…」 disclosure holds the CLI
copy action. When fields are withheld, the command is visible on the card.
The queue links to a separate view for decisions already answered by AI.

The approve button in an open detail submits the digest for the evidence
already shown. The button on a closed card opens a one-line confirmation.
Approval and batch selection stay disabled until the preview loads.
Withheld fields hide both controls.
Closed and batch approvals read the pinned proposal before enabling
submission. Workplace keeps the digest
internal. If the host reports a stale digest, the panel refreshes the
inbox, reopens the affected card and fetches its details again. For integration, the Git diff has its own digest. The
creation event names the successful, candidate-pinned Reviewer execution.
The execution is immutable, and the proposal digest also covers the
findings saved in the proposal row.

The host screens each field before escaping terminal controls. It uses the
configured scanner when available and the built-in scanner otherwise. Only
`description`, `acceptance`, `findings`, and `diffStat` can display the
`［伏せ字］` marker. Each match expands to the surrounding run of
non-whitespace characters, stopping at the enclosing quote in a JSON string
value. For the built-in token triple, each span covers the entire JSON value.
Project `leakPatterns` only need to detect the secret. The host expands each
match to the whole token, merges overlaps, and screens the result again.

A span containing whitespace after expansion causes the whole field to be
withheld. A match in `paths`, `changedPaths`, `pathViolations`, `ruleId`,
`ruleName`, or any other scope or policy field withholds the affected
evidence and blocks Workplace approval. Withheld changed paths also
withhold the diff stat because Git can quote or abbreviate paths. The
host withholds evidence when it cannot locate a match safely, including
when a match crosses fields, a scanner lacks span support, a scan times out
or fails, text is invalid, a field needs more than 32 replacements, or a
re-scan still finds a match.

The card shows 「伏せ字あり」 for masked fields and names them in the details.
The confirmation strip calls out masking in single and batch approvals.
Proposals with only masked fields can be approved in Workplace. The
proposal digest still covers the stored proposal. The card names withheld
fields and shows the CLI command. Rejection remains available. CLI `show`
uses its existing host-terminal path.

The host enforces these approval rules for single and batch requests,
including takeover. Configured candidate diff and commit-message
screening still applies. Masked display values exist only in the host
read path and its response. They do not replace stored proposal content.
Other Workplace reads that repeat those values still screen them before
sending them to the browser.

The connection settings show the project and its repository path
relative to the configured repository root. The page keeps the bridge
token in memory for reconnect. Reconnect uses it to open a fresh browser
socket and subscribes to the inbox again.

### Q4. Estimates

- **Goal:** done Tasks over all Tasks. Remaining time is the remaining
  Tasks multiplied by the mean wall time of finished Tasks in this
  target, shown as "about N minutes, with the current plan". Before any
  Task has finished, no time is shown.
- **Task:** its stage, attempt and elapsed time against its time limit.
  Remaining time is the mean time of the remaining stages in this target.
- A Planner that adds Tasks raises the total. The panel says the
  estimate follows the current plan.

### Q5. Delegation: what the AI may decide

The three gates stay: Goal registration, Task registration and
integration. "AI" means the Reviewer answers, as delegated answers work
today. The effective answerer of a gate is decided in this order:

1. **Invariants.** No setting changes these:
   - an unverified integration, or one with symbolic links, needs a
     human;
   - the Concierge cannot answer its own proposals;
   - registering a Task outside its Goal's scope needs a human answer;
   - a model's request to widen delegation needs a human;
   - discarding a Goal and exporting a branch are operator commands,
     not gates.
2. **The operator's setting for this Task** (integration only): follow
   the rules, a human decides, or the AI decides.
3. **The operator's setting for this Goal** (Task registration and
   integration): follow the default, human, or AI.
4. **Rules**, in order; the first rule whose conditions all hold decides.
5. **The default for the gate**: human or AI.

Operator settings are host records written by the operator. They are
separate from the `policies` a model writes into proposal content and
take precedence over them. The existing rule that a model's loosening
needs human approval stays.

When a store migrates to schema 6, legacy defaults keep their existing
precedence. The new default takes precedence over proposal policies for
its gate once an operator sets it through the new API or CLI.

**Rule conditions**

| Condition                                     | Task registration | Integration     |
| --------------------------------------------- | ----------------- | --------------- |
| Paths within allowed globs                    | the planned scope | the actual diff |
| No path in an excluded list                   | the planned scope | the actual diff |
| Planner's planned token budget (advisory) ≤ N | yes               | no              |
| Changed lines at most N, files at most N      | no                | yes             |
| Verification and review passed                | no                | always required |
| Category the Planner gave is one of a list    | narrows only      | narrows only    |

Path exclusions are case-insensitive and compare NFC-normalized
patterns and paths. Allowed globs compare paths exactly.

A category is the Planner's claim. A rule may use it to narrow
delegation and must also include at least one other condition.

**Panel:**

- The Delegation tab sets the default per gate and edits, orders and
  removes rules. Each rule shows how often it matched in the last seven
  days.
- Widening delegation (human to AI, or a new rule) asks once. Narrowing
  applies at once. Every change is recorded with origin `operator-ui`.
- Goal and Task details show their overrides and, for a Task, the
  effective answerer for integration and which setting decided it.
- "Decisions the AI made" lists each AI answer, its result, the setting
  that allowed it and the AI's reason as model text.

### Q6. The Concierge looks before it proposes

- The Concierge's host API gets a read-only search over Goals and Tasks:
  titles, descriptions, status and scope.
- Before proposing a Goal, the Concierge searches. When similar work
  exists, the proposal carries alternatives (Q2), for example "register
  a new Goal" and "add a Task to Goal X", with its recommendation.
- Choosing "add a Task to Goal X" asks that Goal's Planner for the Task.
  This depends on replanning, stage 4 of the local orchestrator, and
  lands with it.

## Order of work

Each step ships with tests, an independent review, and a manual check in
a browser.

1. **Read side.** Q3 and Q4 with the tabbed panel: Goals, Tasks,
   problems and their details.
2. **Answers from the panel.** Q1 for single and batch answers on
   proposals without alternatives.
3. **Delegation.** Q5: the defaults, Goal and Task overrides, rules,
   and the AI decision history.
4. **Alternatives and search.** Q2 and Q6.

## What this changes

- **ADR D5** said an answer needs operator presence and, without the
  desktop shell, is given with the TTY CLI. The development bridge now
  answers with the per-launch token and one confirmation (Q1). The
  presence check moves to the deferred list with its trigger.
- **Phase 2 P4** refused any gate-answer method on the bridge. The
  bridge now relays `proposal.answer` and `proposal.answerMany`.

## Deferred

- A presence check per answer or per session, when the trigger in Q1
  occurs.
- Full diffs in the panel. Step 2 shows the diff size; full diffs need a
  size and escaping design of their own.
- Answering from another device.
