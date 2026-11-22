import type { AuditEvent } from "./audit.ts";
import type { CoordinatorTask } from "./coordinator.ts";

export interface TaskTrace {
  readonly coordinator: Awaited<ReturnType<CoordinatorTask["trace"]>>;
  /** The router's encoded action for each proposal, decoded as text, with
   * C1 and bidirectional control characters escaped. Untrusted data. `text`
   * is null when the proposal was too large to keep or is unreadable. */
  readonly proposals: readonly {
    readonly run: string;
    readonly hash: string;
    readonly text: string | null;
  }[];
  /** Host audit for every run, attempt and invocation the journal names. */
  readonly invocations: readonly {
    readonly id: string;
    readonly events: readonly AuditEvent[];
  }[];
}

function escapeControls(text: string): string {
  return text.replace(
    /[\u0080-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g,
    (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

/** One task's Coordinator journal joined with the host audit. Turn run IDs
 * are the Coordinator session invocation IDs, and delegation attempt IDs are
 * the delegated role invocation IDs. */
export async function taskTrace(
  task: CoordinatorTask,
  audit: { read(id: string): AuditEvent[] },
): Promise<TaskTrace> {
  const coordinator = await task.trace();
  const ids = new Set<string>();
  const proposals = [];
  for (const event of coordinator) {
    for (const key of ["run", "attempt", "invocation"] as const)
      if (key in event)
        ids.add((event as unknown as Record<typeof key, string>)[key]);
    if (event.kind === "turn.proposed") {
      // An unreadable proposal must not hide the rest of the trace.
      const bytes = await task.proposal(event.hash).catch(() => null);
      proposals.push({
        run: event.run,
        hash: event.hash,
        text: bytes
          ? escapeControls(Buffer.from(bytes).toString("utf8"))
          : null,
      });
    }
  }
  const invocations = [...ids]
    .map((id) => ({ id, events: audit.read(id) }))
    .filter((entry) => entry.events.length > 0);
  return { coordinator, proposals, invocations };
}
