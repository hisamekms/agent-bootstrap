import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  PrivateJournal,
  checkPrivateDirectory,
  publishPrivateFile,
  uuidPattern,
} from "./private-journal.ts";

/** Review notes are untrusted text; only their digest enters the journal. */
export const NOTE_LIMIT_BYTES = 2048;
/** Revised candidates allowed after the first one. */
export const MAX_REVISIONS = 3;
const sha256 = (data: Uint8Array | string) =>
  createHash("sha256").update(data).digest("hex");

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
  round: /^[1-9][0-9]?$/,
  from: /^[a-f0-9]{64}$/,
  notes: /^[a-f0-9]{64}$/,
} as const;

const eventFields = {
  requested: ["target", "base"],
  "candidate.authorized": ["run", "digest"],
  "candidate.created": ["candidate", "digest"],
  "candidate.failed": ["cleanup"],
  "review.authorized": ["base", "candidate", "digest"],
  "review.noted": ["run", "notes"],
  "review.submitted": ["run", "digest", "review"],
  "revision.requested": ["round", "from", "notes"],
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

// The first candidate and integration take up to 13 events; each revision
// adds up to 6.
const eventLimit = 13 + 6 * MAX_REVISIONS;

export class IntegrationJournal {
  readonly #journal: PrivateJournal<IntegrationEvent>;
  readonly #root: string;
  readonly id: string;

  constructor(root: string, id: string) {
    this.#journal = new PrivateJournal(root, id, decode, eventLimit);
    this.#root = root;
    this.id = id;
  }

  /** Store review notes as a private, content-addressed file. */
  async saveNote(text: string): Promise<string> {
    const bytes = Buffer.from(text, "utf8");
    if (!bytes.length || bytes.length > NOTE_LIMIT_BYTES || text.includes("\0"))
      throw new Error("Invalid review notes");
    await checkPrivateDirectory(this.#root);
    const hash = sha256(bytes);
    try {
      await publishPrivateFile(this.#root, `note-${hash}`, bytes);
    } catch (error) {
      if (
        (error as NodeJS.ErrnoException).code !== "EEXIST" ||
        sha256(await this.readNote(hash)) !== hash
      )
        throw new Error("Review notes could not be stored");
    }
    return hash;
  }

  async readNote(hash: string): Promise<Uint8Array> {
    if (!fields.notes.test(hash)) throw new Error("Invalid notes digest");
    const path = join(this.#root, `note-${hash}`);
    const info = await lstat(path);
    if (!info.isFile() || info.size > NOTE_LIMIT_BYTES)
      throw new Error("Review notes integrity check failed");
    const data = await readFile(path);
    if (data.length > NOTE_LIMIT_BYTES || sha256(data) !== hash)
      throw new Error("Review notes integrity check failed");
    return data;
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
