# Stage 2–3 live runs

These operator-authorized runs took place on 2026-11-23 and continued the
[Stage 1 Concierge live runs](stage1-live.md).

## Run 4

The Concierge resumed with `--continue` and called `wait_execution` once.
The call returned successfully after 25.1 s. The Concierge reported that
the Planner succeeded and that goal proposal
`3517be65-1416-43c7-b5c3-d845c0322f26` was pending at the human
`goal-registration` gate.

## Delegated gate answers

The operator authorized Claude in chat to approve goal proposals
`240e037e-dfdf-4727-94bf-178110f51093` and
`3517be65-1416-43c7-b5c3-d845c0322f26`, and later authorized approval of
integration proposal `c4b48af3-2b27-46f5-99b5-551ff5cb2924` in run 9.
The approvals recorded `delegate` with `claude-code` and session ID
`session_01Dmcfy6PpkLatavGnh1nQGY`. The corresponding audit events recorded
`delegated: true`.

## Run 5

The Planner decomposed Goal `c910026a-866d-4f7c-a589-2c790822a26c` in one
attempt. Task `aa2dcdfb-6723-4851-837e-bf21607551bc` auto-registered because
it was in scope.

## Run 6

The Stage 2 scheduler picked up the Task automatically and the Executor
produced a candidate. The Reviewer returned an unparseable answer, so the
Task failed with `review-concern`. Commit `76916c4` separated the Reviewer
prompt from the Worker prompt, accepted fenced JSON, retained the raw answer
for review concerns, and added `retry-task`.

## Run 7

After `retry-task`, the Reviewer returned `revise` with substantive notes.
The candidate read like a PoC log, and the Task referenced Stage 1 docs
that were absent from the Goal branch base. The revision stopped with
`budget-exceeded`. The Planner snapshot and Goal branch used different bases,
and the budget counted cache reads at their raw token count.

Commit `65da0e8` aligned the Planner and Executor on the same local `main`
base and counted cache reads at one tenth of their raw token count. Following
the operator's decision, `39c013a` made token budgets advisory.

## Run 8

Stage 1 merged into `main` in PR #18 at `0993c5a`. After `31c89b3` added
support for legacy Goals with a `NULL` base, `update-goal-base` moved the
untouched Goal branch to `0993c5a`. The operator ran `retry-task` for the
second time.

The Executor succeeded using 24,370 budgeted tokens. Raw usage included
19,360 cache creation tokens, 32,526 cache read tokens, and 1,751 output
tokens. The Reviewer returned `pass` using 5,171 budgeted tokens. The Task
moved to `awaiting-integration` with proposal
`c4b48af3-2b27-46f5-99b5-551ff5cb2924` pending at the human gate because
the candidate was unverified.

## Run 9

At Stage 3 commit `a1ecc13`, Claude recorded the delegated human approval.
The scheduler advanced `lo/goal-c910026a` from `0993c5a` to `13bb642` and
marked the Task succeeded. `export-goal-branch` created the local branch
in the operator checkout and left `main`, `HEAD`, and the working tree
untouched. At the operator's request, Claude pushed the exported branch
and opened PR #19.

## Known issues

- The candidate's README line “The combined interactive path still needs
  real-VM verification” was stale. The operator chose to integrate the
  candidate and fix the line in a later PR.
- The onboarding screens ignore Ctrl-C. An Enter sent just after a long
  paste may be dropped.

## Follow-ups

- Researcher and replanning in Stage 4.
- A verification suite for code Tasks.
- The terminal-escape relay, guest credential pass-through at egress, live
  resize, and secret rotation.
- The distributed-test profile.
