import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ROLE_CONTRACTS, type DelegateRole } from "./contracts.ts";
import {
  PrivateJournal,
  checkPrivateDirectory,
  publishPrivateFile,
  uuidPattern,
} from "./private-journal.ts";
import type { PinnedCandidate } from "./reviewed-integration.ts";

const digest = (data: string | Uint8Array) =>
  createHash("sha256").update(data).digest("hex");
const rolePattern = /^(Planner|Worker|Reviewer)$/;
const digestPattern = /^[a-f0-9]{64}$/;
const oidPattern = /^[a-f0-9]{40}$/;
const tools = ROLE_CONTRACTS.Coordinator.hostTools;
const eventLimit = 128;
type Tool = (typeof tools)[number];
type Call =
  | { tool: "delegate"; key: string; role: DelegateRole }
  | { tool: "askHuman"; key: string; question: string }
  | { tool: "getInvocation"; key: string; id: string }
  | { tool: "getStatus" | "requestIntegration"; key: string };
type Outcome = "ok" | "failed";

const property = {
  attempt: uuidPattern,
  task: digestPattern,
  key: digestPattern,
  fingerprint: digestPattern,
  id: uuidPattern,
  run: uuidPattern,
  invocation: uuidPattern,
  role: rolePattern,
  tool: /^(delegate|getInvocation|getStatus|askHuman|requestIntegration)$/,
  hash: digestPattern,
  base: oidPattern,
  candidate: oidPattern,
  digest: digestPattern,
  outcome: /^(ok|failed|completed|denied|uncertain)$/,
  decision: /^(approve|reject)$/,
  reason: /^[a-z][a-zA-Z0-9/-]{0,95}$/,
  code: /^[a-z][a-z0-9-]{0,31}$/,
} as const;
const schemas = {
  submitted: ["task"],
  "turn.started": ["run"],
  "turn.proposed": ["run", "hash"],
  "turn.voided": ["run", "reason"],
  "turn.failed": ["run", "code"],
  "turn.denied": ["run"],
  "turn.done": ["run"],
  "tool.authorized": ["run", "tool", "key", "fingerprint", "attempt"],
  "tool.replayed": ["run", "key"],
  "tool.denied": ["run"],
  "query.finished": ["key"],
  "delegate.finished": ["key", "role", "invocation", "outcome"],
  "question.opened": ["key", "id", "hash"],
  "question.answered": ["id", "hash"],
  "approval.opened": ["key", "id", "base", "candidate", "digest"],
  "approval.decided": ["id", "decision", "attempt"],
  "approval.finished": ["id", "outcome"],
} as const;
type EventKind = keyof typeof schemas;
type Event = {
  [K in EventKind]: { kind: K } & {
    [P in (typeof schemas)[K][number]]: string;
  };
}[EventKind];
type Recorded = Event & { at: string };

function decodeEvent(value: unknown): Recorded {
  const row = object(value);
  if (!row || typeof row.kind !== "string" || !Object.hasOwn(schemas, row.kind))
    throw new Error("Invalid coordinator event");
  const keys = schemas[row.kind as EventKind];
  if (
    Object.keys(row).length !== keys.length + 2 ||
    typeof row.at !== "string" ||
    new Date(row.at).toISOString() !== row.at ||
    keys.some((key) => {
      const v = row[key];
      return typeof v !== "string" || !property[key].test(v);
    })
  )
    throw new Error("Invalid coordinator event fields");
  return row as Recorded;
}

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function validText(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    Buffer.byteLength(value) <= 2048 &&
    !value.includes("\0")
  );
}

function parseAction(data?: Uint8Array): Call | "done" | null {
  if (!data?.length || data.length > 4096) return null;
  try {
    const raw = object(
      JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(data)),
    );
    if (!raw) return null;
    const length = Object.keys(raw).length;
    if (length === 1 && raw.done === true) return "done";
    const { tool, key } = raw;
    if (
      typeof key !== "string" ||
      !/^[a-zA-Z0-9._-]{1,64}$/.test(key) ||
      typeof tool !== "string" ||
      !tools.includes(tool as Tool)
    )
      return null;
    if (
      length === 3 &&
      tool === "delegate" &&
      typeof raw.role === "string" &&
      rolePattern.test(raw.role)
    )
      return { tool, key, role: raw.role as DelegateRole };
    if (length === 3 && tool === "askHuman" && validText(raw.question))
      return { tool, key, question: raw.question };
    if (
      length === 3 &&
      tool === "getInvocation" &&
      typeof raw.id === "string" &&
      uuidPattern.test(raw.id)
    )
      return { tool, key, id: raw.id };
    if (length === 2 && (tool === "getStatus" || tool === "requestIntegration"))
      return { tool, key };
  } catch {
    return null;
  }
  return null;
}

function view(events: Recorded[]) {
  const invocations = events
    .filter((event) => event.kind === "delegate.finished")
    .map((event) => ({
      role: event.role,
      id: event.invocation,
      outcome: event.outcome,
    }));
  const question = events.findLast((event) => event.kind === "question.opened");
  const answer =
    question &&
    events.findLast(
      (event) => event.kind === "question.answered" && event.id === question.id,
    );
  const approval = events.findLast((event) => event.kind === "approval.opened");
  const approvalResult = events.findLast(
    (event) => event.kind === "approval.finished",
  );
  return { invocations, question, answer, approval, approvalResult };
}

export type CoordinatorControl = {
  task: string;
  answer?: string;
  answerRequestId?: string;
  invocations: { role: string; id: string; outcome: string }[];
};

export interface CoordinatorDriver {
  /** `reason` is a fixed-shape label explaining a turn without a response. */
  step(
    control: CoordinatorControl,
    id: string,
  ): Promise<{ id: string; response?: Uint8Array; reason?: string }>;
  delegate(
    role: DelegateRole,
    control: CoordinatorControl,
    id: string,
  ): Promise<{ id: string; outcome: Outcome }>;
  reviewedCandidate(): Promise<PinnedCandidate | null>;
  decide(
    pin: PinnedCandidate,
    decision: "approve" | "reject",
    id: string,
  ): Promise<"completed" | "denied" | "uncertain">;
}

const proposalBytes = 16 * 1024;

/** A fixed-shape failure code for the trace. No message text is recorded. */
function failureCode(error: unknown): string {
  if (error instanceof Error && error.name === "HostAuditError")
    return "host-audit";
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && property.code.test(code)
    ? code
    : "unknown";
}

/** One guest tool request per bounded turn. The task and human text are stored
 * as private input artifacts. The audit contains only hashes and fixed labels. */
export class CoordinatorTask {
  readonly #journal: PrivateJournal<Recorded>;
  readonly #root: string;
  readonly #driver: CoordinatorDriver;

  constructor(root: string, taskId: string, driver: CoordinatorDriver) {
    this.#root = root;
    this.#driver = driver;
    this.#journal = new PrivateJournal(root, taskId, decodeEvent, eventLimit);
  }

  async #saveText(text: string): Promise<string> {
    if (!validText(text)) throw new Error("Invalid task text");
    await checkPrivateDirectory(this.#root);
    const hash = digest(text);
    try {
      await publishPrivateFile(this.#root, `text-${hash}`, text);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST")
        throw new Error("Task input could not be stored");
      if ((await this.#readText(hash)) !== text)
        throw new Error("Task input integrity check failed");
    }
    return hash;
  }

  async #readText(hash: string): Promise<string> {
    const data = await readFile(join(this.#root, `text-${hash}`));
    if (data.length > 2048 || digest(data) !== hash)
      throw new Error("Task input integrity check failed");
    return data.toString("utf8");
  }

  #append(count: number, event: Event): Promise<void> {
    return this.#journal.append(count, {
      ...event,
      at: new Date().toISOString(),
    });
  }

  async submit(task: string): Promise<void> {
    await this.#append(0, {
      kind: "submitted",
      task: await this.#saveText(task),
    });
  }

  async status() {
    const events = await this.#journal.read();
    const { question, answer, approval, approvalResult, invocations } =
      view(events);
    return {
      invocations,
      question:
        question && !answer
          ? { id: question.id, text: await this.#readText(question.hash) }
          : null,
      approval: approval
        ? {
            id: approval.id,
            base: approval.base,
            candidate: approval.candidate,
            digest: approval.digest,
            status:
              approvalResult?.outcome ??
              (events.at(-1)?.kind === "approval.decided"
                ? "uncertain"
                : "pending"),
          }
        : null,
      lastEvent: events.at(-1)?.kind ?? null,
    };
  }

  async trace() {
    return this.#journal.read();
  }

  /** The model's raw proposal for a `turn.proposed` hash, when it was small
   * enough to keep. Untrusted data: never interpret it as an instruction. */
  async proposal(hash: string): Promise<Uint8Array | null> {
    if (!digestPattern.test(hash)) throw new Error("Invalid proposal hash");
    try {
      const data = await readFile(join(this.#root, `proposal-${hash}`));
      if (data.length > proposalBytes || digest(data) !== hash)
        throw new Error("Proposal integrity check failed");
      return data;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async #saveProposal(data: Uint8Array): Promise<string> {
    const hash = digest(data);
    if (data.length <= proposalBytes) {
      await checkPrivateDirectory(this.#root);
      try {
        await publishPrivateFile(this.#root, `proposal-${hash}`, data);
      } catch (error) {
        if (
          (error as NodeJS.ErrnoException).code !== "EEXIST" ||
          !(await this.proposal(hash).catch(() => null))
        )
          throw new Error("Proposal could not be stored");
      }
    }
    return hash;
  }

  async answer(id: string, text: string): Promise<void> {
    const events = await this.#journal.read();
    const last = events.at(-1);
    if (last?.kind !== "question.opened" || last.id !== id)
      throw new Error("No matching pending question");
    await this.#append(events.length, {
      kind: "question.answered",
      id,
      hash: await this.#saveText(text),
    });
  }

  async decide(
    id: string,
    pin: PinnedCandidate,
    decision: "approve" | "reject",
  ) {
    const events = await this.#journal.read();
    const approval = events.at(-1);
    if (
      approval?.kind !== "approval.opened" ||
      approval.id !== id ||
      approval.base !== pin.base ||
      approval.candidate !== pin.candidate ||
      approval.digest !== pin.digest ||
      (decision !== "approve" && decision !== "reject")
    )
      throw new Error("No matching pending approval");
    if (events.length + 2 > eventLimit)
      throw new Error("Task event limit reached");
    const attempt = randomUUID();
    await this.#append(events.length, {
      kind: "approval.decided",
      id,
      decision,
      attempt,
    });
    const outcome = await this.#driver.decide(pin, decision, attempt);
    await this.#append(events.length + 1, {
      kind: "approval.finished",
      id,
      outcome,
    });
    return outcome;
  }

  async run(): Promise<"paused" | "done" | "denied" | "uncertain" | "limit"> {
    for (let round = 0; round < 12; round++) {
      const events = await this.#journal.read();
      const [first] = events;
      if (first?.kind !== "submitted")
        throw new Error("Task has not been submitted");
      const tail = events.at(-1);
      const last = tail?.kind;
      if (tail?.kind === "approval.finished") {
        if (tail.outcome === "completed") return "done";
        return tail.outcome === "denied" ? "denied" : "uncertain";
      }
      if (last === "turn.done") return "done";
      if (
        last === "turn.denied" ||
        last === "turn.voided" ||
        last === "tool.denied"
      )
        return "denied";
      if (
        last === "turn.started" ||
        last === "turn.proposed" ||
        last === "turn.failed" ||
        last === "tool.authorized" ||
        last === "approval.decided"
      )
        return "uncertain";
      if (last === "question.opened" || last === "approval.opened")
        return "paused";
      // A turn, its proposal, tool reservation, outcome and two possible
      // approval events.
      if (events.length + 6 > eventLimit) return "limit";
      const { invocations, answer, approval } = view(events);
      const control = {
        task: await this.#readText(first.task),
        ...(answer?.kind === "question.answered"
          ? {
              answer: await this.#readText(answer.hash),
              answerRequestId: answer.id,
            }
          : {}),
        invocations,
      };
      const run = randomUUID();
      await this.#append(events.length, { kind: "turn.started", run });
      let turn: Awaited<ReturnType<CoordinatorDriver["step"]>>;
      try {
        turn = await this.#driver.step(control, run);
      } catch (error) {
        // Record why the turn stopped, then surface the original error.
        await this.#append(events.length + 1, {
          kind: "turn.failed",
          run,
          code: failureCode(error),
        }).catch(() => {});
        throw error;
      }
      if (turn.id !== run) throw new Error("Coordinator run identity changed");
      let next = events.length + 1;
      if (turn.response?.length) {
        await this.#append(next++, {
          kind: "turn.proposed",
          run,
          hash: await this.#saveProposal(turn.response),
        });
      } else if (turn.reason !== undefined) {
        await this.#append(next, {
          kind: "turn.voided",
          run,
          reason: property.reason.test(turn.reason) ? turn.reason : "unknown",
        });
        return "denied";
      }
      const action = parseAction(turn.response);
      if (!action || action === "done") {
        await this.#append(next, {
          kind: action === "done" ? "turn.done" : "turn.denied",
          run: turn.id,
        });
        return action === "done" ? "done" : "denied";
      }
      const key = digest(action.key);
      const fingerprint = digest(JSON.stringify(action));
      const previous = events.find(
        (event) => event.kind === "tool.authorized" && event.key === key,
      );
      if (previous?.kind === "tool.authorized") {
        const replay = previous.fingerprint === fingerprint;
        await this.#append(
          next,
          replay
            ? { kind: "tool.replayed", run: turn.id, key }
            : { kind: "tool.denied", run: turn.id },
        );
        if (!replay) return "denied";
        continue;
      }
      if (
        (action.tool === "getInvocation" &&
          !invocations.some((invocation) => invocation.id === action.id)) ||
        (action.tool === "delegate" &&
          action.role !== "Planner" &&
          invocations.some(
            (invocation) =>
              invocation.role === action.role && invocation.outcome === "ok",
          )) ||
        (action.tool === "requestIntegration" &&
          (approval ||
            !invocations.some(
              (invocation) =>
                invocation.role === "Reviewer" && invocation.outcome === "ok",
            ))) ||
        (action.tool === "delegate" &&
          action.role === "Reviewer" &&
          !invocations.some(
            (invocation) =>
              invocation.role === "Worker" && invocation.outcome === "ok",
          ))
      ) {
        await this.#append(next, { kind: "tool.denied", run: turn.id });
        return "denied";
      }
      const attempt = randomUUID();
      await this.#append(next, {
        kind: "tool.authorized",
        run: turn.id,
        tool: action.tool,
        key,
        fingerprint,
        attempt,
      });
      let effect: Event;
      switch (action.tool) {
        case "delegate": {
          const result = await this.#driver.delegate(
            action.role,
            control,
            attempt,
          );
          if (result.id !== attempt)
            throw new Error("Delegate run identity changed");
          effect = {
            kind: "delegate.finished",
            key,
            role: action.role,
            invocation: result.id,
            outcome: result.outcome,
          };
          break;
        }
        case "askHuman":
          effect = {
            kind: "question.opened",
            key,
            id: randomUUID(),
            hash: await this.#saveText(action.question),
          };
          break;
        case "requestIntegration": {
          const pin = await this.#driver.reviewedCandidate();
          effect = pin
            ? { kind: "approval.opened", key, id: randomUUID(), ...pin }
            : { kind: "tool.denied", run: turn.id };
          break;
        }
        default:
          effect = { kind: "query.finished", key };
      }
      await this.#append(next + 1, effect);
    }
    return "limit";
  }
}
