# Stage 3 integration and branch export

The Concierge launcher checks SQLite once per second for operator decisions.
The scheduler takes the current approved integration proposal for an active
Goal and processes one integration at a time in the actor slot. Approval
rejections fail the Task. Successful integration releases its dependents.

Before writing an M5 decision, the host recomputes the proposal digest,
checks it against the stored approval, checks that the Task is still
awaiting integration, and compares the branch, base, candidate and diff
digest against the latest passing pin in that Task attempt's journal. It
recomputes the changed paths and diff from the pinned commit. The Goal
branch must still point to the proposal base. A stale base fails the Task
with `stale-base`. Use an operator retry to prepare a fresh candidate.
Integration uses the existing Git compare-and-swap.

A verification suite configured in the launcher runs before review and
again during M5 integration. New proposals record `verified: false` when
there is no suite. Those proposals require a human answer even under an
agent policy. Older proposals with no verification field, and proposals
with symlink changes or missing symlink evidence, also require a human
answer. Delegated terminal answers count as human. The suite and its
configuration are part of the M5 target identity. Keep the same plan
between candidate review and integration.

The host records the start in SQLite before calling
`ReviewedIntegration.decide`. Its M5 `human.decided` event carries the
SQLite approval ID as `approvalId`, even for a permitted agent decision.
The ID joins to `proposal.decided` and the stored approval row, which holds
the answerer kind, the Reviewer execution ID and model for agent answers,
or the delegated session and authorization for delegated human answers.
M5 also records the digest of any protected paths acknowledged by a human.

On success, SQLite records `task.integrated` with the branch, base and
new head and marks the Task succeeded in the same transaction. The next
Task starts at that audited head. The Goal's original `baseCommit` stays
available for planning. M5 denials fail the Task with the journal's reason.

An uncertain Git result leaves the Task running with
`integration-uncertain`. An abrupt stop can leave
`integration-in-progress`. Both pause scheduling for that Goal. After the
launcher stops, `reconcile` compares the private ref with the candidate and
base. A candidate head with a matching M5 authorization is recorded as
integrated. An unchanged base fails the Task with `integration-interrupted`.
Other heads require operator investigation. Reconciliation performs no Git
updates or replay.

Run `export-goal-branch <goalId>` in a host terminal to fetch the private
Goal head into the operator checkout as the same local branch. Review the
destination and the old and new heads and confirm with the displayed
phrase. The command allows branch creation or a fast-forward and refuses
to update a branch checked out in any linked worktree. SQLite records
`goal.export-authorized` before the transfer and `goal.exported` after
the local branch update. See [the operator guide](running.md#approve-and-export-a-goal-branch)
for the checkout option and manual PR steps.

Stage 3 is covered by local Git and SQLite tests with fake actor and
verification runs. An operator live run of the integrated cycle remains
to be recorded. Stage 4 adds Researcher and replanning.
