import type {
  AuditEvent,
  ExecutionAudit,
  NetworkEvent,
  SqliteAudit,
} from "./audit.ts";
import type { CoordinatorTask } from "./coordinator.ts";

type AuditReader = Pick<SqliteAudit, "read"> &
  Partial<Pick<SqliteAudit, "readExecution">>;
type DnsQuery = Extract<NetworkEvent, { phase: "dns" }>;
type ConnectionPhase = Exclude<NetworkEvent, DnsQuery>;
type ConnectionResult = Extract<
  ConnectionPhase,
  { phase: "finished" }
>["result"];

interface InvocationTrace {
  readonly id: string;
  readonly events: readonly AuditEvent[];
  readonly executionContexts: Readonly<ExecutionAudit["executionContexts"]>;
  readonly sandboxBindings: Readonly<ExecutionAudit["sandboxBindings"]>;
  readonly processResults: Readonly<ExecutionAudit["processResults"]>;
  readonly networkConnections: readonly {
    readonly connectionId: string;
    readonly sandboxId: string;
    readonly phases: readonly ConnectionPhase[];
    readonly outcome?: ConnectionResult | "unknown";
  }[];
  readonly dnsQueries: readonly DnsQuery[];
  readonly resourceEvents: Readonly<ExecutionAudit["resourceEvents"]>;
}

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
  readonly invocations: readonly InvocationTrace[];
}

export function escapeControls(text: string): string {
  return text.replace(
    /[\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g,
    (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

export function readInvocationTrace(
  audit: AuditReader,
  id: string,
): InvocationTrace | undefined {
  const execution = audit.readExecution?.(id);
  const events = execution?.auditEvents ?? audit.read(id);
  const groups = new Map<string, ConnectionPhase[]>();
  const dnsQueries: DnsQuery[] = [];
  for (const event of execution?.networkEvents ?? []) {
    if (event.phase === "dns") {
      dnsQueries.push(event);
    } else {
      // The audit identifies a connection within an invocation and sandbox.
      const key = `${event.sandboxId}/${event.connectionId}`;
      const phases = groups.get(key);
      if (phases) phases.push(event);
      else groups.set(key, [event]);
    }
  }
  const networkConnections = Array.from(groups.values(), (phases) => {
    const { sandboxId, connectionId } = phases[0]!;
    const finished = phases.find((event) => event.phase === "finished");
    const allowed = phases.some(
      (event) => event.phase === "decided" && event.decision === "allow",
    );
    const outcome =
      finished?.result ?? (allowed ? ("unknown" as const) : undefined);
    return {
      connectionId,
      sandboxId,
      phases,
      ...(outcome === undefined ? {} : { outcome }),
    };
  });
  const rows = {
    events,
    executionContexts: execution?.executionContexts ?? [],
    sandboxBindings: execution?.sandboxBindings ?? [],
    processResults: execution?.processResults ?? [],
    networkConnections,
    dnsQueries,
    resourceEvents: execution?.resourceEvents ?? [],
  };
  if (Object.values(rows).some((entries) => entries.length > 0))
    return { id, ...rows };
}

/** One task's Coordinator journal joined with the host audit. Turn run IDs
 * are the Coordinator session invocation IDs, and delegation attempt IDs are
 * the delegated role invocation IDs. */
export async function taskTrace(
  task: CoordinatorTask,
  audit: AuditReader,
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
  const invocations = [];
  for (const id of ids) {
    const invocation = readInvocationTrace(audit, id);
    if (invocation) invocations.push(invocation);
  }
  return { coordinator, proposals, invocations };
}
