# Activity, refs, and operator actions

Goal and Task responses include `ref` such as `G12` or `G12-3`. The
operator's Goal and Task lookups and mutations accept a UUID or a
case-insensitive ref. Returned refs use uppercase. Inbox subjects, problems,
and decision history expose the matching `goalRef` and `taskRef` where
available. The `ref` on a Task proposal identifies its parent Goal. On
an integration proposal it identifies the Task. A Goal proposal acquires a
ref on approval.

## Activity

Send `activity.get` with empty params. A response can look like this.

```json
{
  "running": [
    {
      "id": "f47b61f7-0bd6-4d23-a739-d14e0772784a",
      "status": "running",
      "actor": "Executor",
      "mode": "task",
      "goalId": "9b80ddc3-9ac4-44f1-a8f0-007f86925f33",
      "goalRef": "G12",
      "goalTitle": "Prepare release notes",
      "taskId": "f59767ea-c19b-405b-8b1a-6b237eb114cd",
      "taskRef": "G12-3",
      "taskTitle": "Review the changelog",
      "startedAt": "2026-11-26T04:00:00.000Z"
    }
  ],
  "queued": [],
  "queuedCount": 0,
  "yourTurn": 1
}
```

`running` includes every running execution. Each row can have null Goal
and Task fields when the execution has no corresponding subject.
`queued` lists queued executions in creation order, followed by registered
Tasks in active Goals in registration order. A Task with a queued or
running execution appears only as that execution. Dependency and runtime
availability still affect when a registered Task can start. Waiting rows
have a null `startedAt`. Their `status` is `queued` or `registered`, and
their `id` identifies the corresponding execution or Task.

`yourTurn` counts unresolved inbox actions. A proposal counts when an
operator can answer it. An inbox mark records that an item was seen and
does not resolve it.

Send `activity.subscribe` with empty params before the first
`activity.get`. The host acknowledges with `{"subscribed":true}` and
sends `{"method":"activity.changed","params":{}}` when it sees a newer
activity-relevant audit event or a change in the pending self-test count. This includes execution queue, start, and
finish events and Goal or Task registration and status changes. Fetch
`activity.get` again on notification and resubscribe after reconnecting.
Several transitions can share one notification. The inbox watcher still sends
its item-level changes.

## Goal turn

Goal summaries and details include a structured `turn` object such as
`{"owner":"human","reason":{"kind":"approvals","count":2}}`. Evaluate
the following rules from top to bottom.

| Owner     | Reason                                                                 | Condition                                                                                                                      |
| --------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `human`   | `approvals` with `count`                                               | An unresolved proposal for the Goal accepts an operator answer.                                                                |
| `stopped` | `cancelled` or `failed` with `taskRef` and `code`                      | The Goal is cancelled or a Task has failed. The first failed Task in registration order supplies the reason.                   |
| `ai`      | `planning`, `running` with `actor` and nullable `taskRef`, or `queued` | First running execution, then a running Task between executions, then queued work or a Task awaiting integration.              |
| `idle`    | `not-planned`                                                          | An active Goal has no Tasks and no queued, running, or successful Planner execution.                                           |
| `done`    | `exportable` or `completed`                                            | The Goal is complete or all its registered Tasks have succeeded. A recorded base or integrated head makes the Goal exportable. |
| `idle`    | `idle`                                                                 | The Goal has no current work or earlier condition.                                                                             |

Even while other Tasks run, a failed Task makes the Goal turn `stopped`
when no approval takes precedence. A human must act on the failure.
`turn` is derived from store state and does not write a Goal status.

## Problems actions

Each request uses the existing operator socket and bridge permissions.

| Method            | Example params                                     | Success result                                                    |
| ----------------- | -------------------------------------------------- | ----------------------------------------------------------------- |
| `task.retry`      | `{"id":"g12-3","expectedRetries":1}`               | `{"id":"<uuid>","ref":"G12-3","status":"registered","retries":2}` |
| `goal.discard`    | `{"id":"g12","confirm":"G12","expectedHead":null}` | `{"id":"<uuid>","ref":"G12","status":"cancelled"}`                |
| `concierge.draft` | `{"text":"Review the failed check"}`               | `{"characters":23}`                                               |

Retry requires a failed Task in a Goal that has not been cancelled, with
the retry count provided by the current Problem or Task detail. It records
`task.retried` with the operator channel (`cli` or `operator-ui`) and resets
the budget window in the same transaction. A changed count returns
`task-retry-changed`.

Discard requires the exact uppercase Goal ref and the `head` from
`goal.get` when the operator previewed the action. The `head` is the
current private branch commit, or `null` if the branch is absent. Discard
applies the CLI eligibility checks and returns `goal-busy` for a busy Goal
or `stale-base` when the expected head differs from the current head. The
host writes `goal.discard-authorized` before deleting the branch with a
Git compare-and-swap, then records the resulting cancellation.

Draft requires a ready terminal and the client's input ownership. It strips
controls, format characters, and Unicode line separators, then takes up to
2,000 Unicode code points. An empty sanitized draft returns
`invalid-params`. The host commits `concierge.draft-authorized` with
the operator origin, sanitized character count, and SHA-256 digest of the
sanitized UTF-8 text. It then sends the sanitized text inside a
host-generated bracketed paste, without a line break or Enter.
