import { PrivateJournal, uuidPattern } from "./private-journal.ts";

const fields = {
  target: /^[a-f0-9]{64}$/,
  base: /^[a-f0-9]{40}$/,
  candidate: /^[a-f0-9]{40}$/,
  digest: /^[a-f0-9]{64}$/,
  run: uuidPattern,
  review: /^(pass|revise|concern)$/,
  cleanup: /^(complete|unknown)$/,
  decision: /^(approve|reject)$/,
  reason: /^(worker|no-approval|stale-base|evidence|verification)$/,
} as const;

const eventFields = {
  requested: ["target", "base"],
  "candidate.authorized": ["run", "digest"],
  "candidate.created": ["candidate", "digest"],
  "candidate.failed": ["cleanup"],
  "review.authorized": ["base", "candidate", "digest"],
  "review.submitted": ["run", "digest", "review"],
  "human.decided": ["base", "candidate", "digest", "decision"],
  "verification.authorized": ["base", "candidate", "digest"],
  "verification.finished": ["run", "digest", "review"],
  "integration.authorized": ["base", "candidate", "digest"],
  "integration.completed": ["candidate"],
  "integration.uncertain": ["candidate"],
  denied: ["reason"],
} as const;

type Kind = keyof typeof eventFields;
type Event = {
  [K in Kind]: { readonly kind: K } & {
    readonly [F in (typeof eventFields)[K][number]]: string;
  };
}[Kind];

export type IntegrationEvent = Event & { readonly at: string };

function decode(value: unknown): IntegrationEvent {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid integration event");
  const data = value as Record<string, unknown>;
  const kind = data.kind;
  if (typeof kind !== "string" || !Object.hasOwn(eventFields, kind))
    throw new Error("Invalid integration event kind");
  const expected = eventFields[kind as Kind];
  if (
    Object.keys(data).length !== expected.length + 2 ||
    typeof data.at !== "string" ||
    new Date(data.at).toISOString() !== data.at ||
    expected.some((field) => {
      const content = data[field];
      return typeof content !== "string" || !fields[field].test(content);
    })
  )
    throw new Error("Invalid integration event fields");
  return value as IntegrationEvent;
}

export class IntegrationJournal {
  readonly #journal: PrivateJournal<IntegrationEvent>;
  readonly id: string;

  constructor(root: string, id: string) {
    this.#journal = new PrivateJournal(root, id, decode, 15);
    this.id = id;
  }

  read(): Promise<IntegrationEvent[]> {
    return this.#journal.read();
  }

  append(priorCount: number, event: Event): Promise<void> {
    return this.#journal.append(priorCount, {
      ...event,
      at: new Date().toISOString(),
    });
  }
}
