import type { AuditEvent } from "./audit.ts";
import type { CoordinatorTask } from "./coordinator.ts";

export interface TaskTrace {
  readonly coordinator: Awaited<ReturnType<CoordinatorTask["trace"]>>;
  /** Raw model proposals, decoded as text. Untrusted data. */
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
      const bytes = await task.proposal(event.hash);
      proposals.push({
        run: event.run,
        hash: event.hash,
        text: bytes ? Buffer.from(bytes).toString("utf8") : null,
      });
    }
  }
  const invocations = [...ids]
    .map((id) => ({ id, events: audit.read(id) }))
    .filter((entry) => entry.events.length > 0);
  return { coordinator, proposals, invocations };
}
