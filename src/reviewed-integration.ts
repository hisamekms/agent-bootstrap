import { createHash } from "node:crypto";
import type { LocalGitIntegration } from "./git-integration.ts";
import {
  IntegrationJournal,
  MAX_REVISIONS,
  NOTE_LIMIT_BYTES,
  type IntegrationEvent,
} from "./integration-journal.ts";
import type { SandboxCommand, SandboxFile } from "./sandbox-runtime.ts";
import type { ReviewerRun, TrustedHost } from "./trusted-host.ts";

type Review = "pass" | "revise" | "concern";
type Decision = "approve" | "reject";
type Event = Parameters<IntegrationJournal["append"]>[1];
type IntegrationGit = Pick<
  LocalGitIntegration,
  "head" | "snapshot" | "createCandidate" | "diff" | "advance" | "targetId"
>;

type Plan = {
  readonly path: string;
  readonly worker: SandboxCommand;
  readonly reviewer: SandboxCommand;
  readonly verification: SandboxCommand;
};

export type PinnedCandidate = {
  readonly base: string;
  readonly candidate: string;
  readonly digest: string;
};

const sha256 = (data: Uint8Array | string) =>
  createHash("sha256").update(data).digest("hex");

const NO_NOTES = sha256("");

/** `{"review": "pass" | "revise"}`, optionally with bounded `notes` text for
 * the next Worker. Anything else is a concern without notes. */
function reviewResult(run: ReviewerRun): { review: Review; notes?: string } {
  const bytes = run.response;
  if (run.outcome !== "ok" || !bytes || bytes.length > 4096)
    return { review: "concern" };
  try {
    const result = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    );
    if (!result || Array.isArray(result) || typeof result !== "object")
      return { review: "concern" };
    const keys = Object.keys(result);
    const review = result.review;
    if (review !== "pass" && review !== "revise") return { review: "concern" };
    if (keys.length === 1) return { review };
    const notes = result.notes;
    if (
      keys.length === 2 &&
      typeof notes === "string" &&
      notes.trim().length > 0 &&
      Buffer.byteLength(notes) <= NOTE_LIMIT_BYTES &&
      !notes.includes("\0")
    )
      return { review, notes };
  } catch {
    return { review: "concern" };
  }
  return { review: "concern" };
}

function samePin(a: PinnedCandidate, b: PinnedCandidate): boolean {
  return (
    a.base === b.base && a.candidate === b.candidate && a.digest === b.digest
  );
}

/** The current candidate is the most recent one. Earlier candidates and any
 * decisions about them never qualify for review, approval or integration. */
function candidatePin(
  events: IntegrationEvent[],
  target: string,
): PinnedCandidate {
  const requested = events[0];
  const candidate = events.findLast(
    (event) => event.kind === "candidate.created",
  );
  if (
    !requested ||
    requested.kind !== "requested" ||
    requested.target !== target ||
    !candidate
  )
    throw new Error("Integration evidence is incomplete");
  return {
    base: requested.base,
    candidate: candidate.candidate,
    digest: candidate.digest,
  };
}

function latestPin(events: IntegrationEvent[], target: string) {
  const pin = candidatePin(events, target);
  const created = events.findLastIndex(
    (event) => event.kind === "candidate.created",
  );
  const index = events.findLastIndex(
    (event) => event.kind === "review.submitted",
  );
  const review = events[index];
  if (
    index < created ||
    review?.kind !== "review.submitted" ||
    review.digest !== pin.digest
  )
    throw new Error("Integration evidence is incomplete");
  return { pin, review: review.review, run: review.run };
}

/** Host-only authority. Worker, Reviewer and verification get separate VMs.
 * The caller of decide must be the authenticated local operator entry point. */
export class ReviewedIntegration {
  readonly #git: IntegrationGit;
  readonly #host: TrustedHost;
  readonly #journal: IntegrationJournal;
  readonly #plan: Plan;

  constructor(
    git: IntegrationGit,
    host: TrustedHost,
    journal: IntegrationJournal,
    plan: Plan,
  ) {
    this.#git = git;
    this.#host = host;
    this.#journal = journal;
    const copy = (command: SandboxCommand) => ({
      ...command,
      argv: [...command.argv],
    });
    this.#plan = {
      path: plan.path,
      worker: copy(plan.worker),
      reviewer: copy(plan.reviewer),
      verification: copy(plan.verification),
    };
  }

  async #target() {
    const { path, verification } = this.#plan;
    return sha256(
      JSON.stringify([
        await this.#git.targetId(),
        path,
        verification.argv,
        verification.timeoutMs,
      ]),
    );
  }

  #writer(priorCount: number) {
    return async (event: Event) => {
      await this.#journal.append(priorCount, event);
      priorCount++;
    };
  }

  async #review(
    pin: PinnedCandidate,
    diff: Uint8Array,
    command: SandboxCommand,
    id?: string,
  ) {
    const bytes = await this.#git.snapshot(pin.candidate, this.#plan.path);
    return this.#host.runReviewer(
      {
        sandbox: {
          maxLifetimeMs: 30_000,
          readOnlyFiles: [
            { path: "candidate.diff", bytes: diff },
            { path: "candidate.source", bytes },
          ],
        },
        command,
      },
      id,
    );
  }

  async prepare(): Promise<PinnedCandidate & { review: Review }> {
    await this.prepareCandidate();
    return this.reviewCandidate();
  }

  async prepareCandidate(id?: string): Promise<PinnedCandidate> {
    if ((await this.#journal.read()).length)
      throw new Error("Integration already exists");
    const append = this.#writer(0);
    const { path } = this.#plan;
    const base = await this.#git.head();
    await append({ kind: "requested", target: await this.#target(), base });
    const source = await this.#git.snapshot(base, path);
    return this.#produce(append, base, source, [], id);
  }

  /** Run Worker on `source`, then create and pin a single-parent candidate on
   * `base`. Each candidate has its own commit and diff digest. */
  async #produce(
    append: (event: Event) => Promise<void>,
    base: string,
    source: Uint8Array,
    readOnlyFiles: SandboxFile[],
    id?: string,
  ): Promise<PinnedCandidate> {
    const { path } = this.#plan;
    const worker = await this.#host.runWorker(
      {
        sandbox: {
          maxLifetimeMs: 30_000,
          files: [{ path, bytes: source }],
          ...(readOnlyFiles.length ? { readOnlyFiles } : {}),
        },
        command: this.#plan.worker,
        collectPaths: [path],
      },
      id,
    );
    const changed = worker.artifacts?.files[0];
    if (
      worker.outcome !== "ok" ||
      changed?.path !== path ||
      worker.artifacts?.files.length !== 1
    ) {
      await append({ kind: "denied", reason: "worker" });
      throw new Error("Worker did not produce an eligible change");
    }
    const workerBytes = new Uint8Array(changed.bytes);
    await append({
      kind: "candidate.authorized",
      run: worker.id,
      digest: sha256(workerBytes),
    });
    let candidate: string;
    let diff: Uint8Array;
    try {
      candidate = await this.#git.createCandidate(base, path, workerBytes);
      diff = await this.#git.diff(base, candidate);
    } catch (error) {
      const cleanup = (error as { cleanupFailed?: boolean } | null)
        ?.cleanupFailed
        ? "unknown"
        : "complete";
      await append({ kind: "candidate.failed", cleanup });
      throw new Error("Could not create a review candidate");
    }
    const pin = { base, candidate, digest: sha256(diff) };
    await append({ kind: "candidate.created", candidate, digest: pin.digest });
    return pin;
  }

  /** Start a revised candidate after the current one was reviewed as
   * `revise` or `concern`. Worker gets the current candidate's file and the
   * review notes, read-only, in a new VM. The new candidate starts from the
   * original base, so it gets a new commit, diff and digest, and needs its own
   * review and human decision. */
  async revise(id?: string): Promise<PinnedCandidate> {
    const events = await this.#journal.read();
    const { pin, review, run } = latestPin(events, await this.#target());
    const rounds = events.filter(
      (event) => event.kind === "revision.requested",
    ).length;
    if (events.at(-1)?.kind !== "review.submitted" || review === "pass")
      throw new Error(
        "Only a candidate reviewed as needing changes can be revised",
      );
    if (rounds >= MAX_REVISIONS) throw new Error("Revision limit reached");
    const noted = events.findLast(
      (event) => event.kind === "review.noted" && event.run === run,
    );
    const notes = noted?.kind === "review.noted" ? noted.notes : NO_NOTES;
    const append = this.#writer(events.length);
    // This sequence CAS wins before any snapshot or Worker VM.
    await append({
      kind: "revision.requested",
      round: String(rounds + 1),
      from: pin.digest,
      notes,
    });
    const source = await this.#git.snapshot(pin.candidate, this.#plan.path);
    const readOnly =
      notes === NO_NOTES
        ? []
        : [
            {
              path: "review-notes.txt",
              bytes: await this.#journal.readNote(notes),
            },
          ];
    return this.#produce(append, pin.base, source, readOnly, id);
  }

  /** The current candidate when its latest review passed, else null. */
  async reviewedPin(): Promise<PinnedCandidate | null> {
    const events = await this.#journal.read();
    try {
      const { pin, review } = latestPin(events, await this.#target());
      return review === "pass" ? pin : null;
    } catch {
      return null;
    }
  }

  async reviewCandidate(
    id?: string,
  ): Promise<PinnedCandidate & { review: Review }> {
    const events = await this.#journal.read();
    const pin = candidatePin(events, await this.#target());
    if (events.at(-1)?.kind !== "candidate.created")
      throw new Error("Candidate review has already been attempted");
    const diff = await this.#git.diff(pin.base, pin.candidate);
    if (sha256(diff) !== pin.digest)
      throw new Error("Candidate evidence does not match its durable pin");
    const append = this.#writer(events.length);
    // This sequence CAS wins before snapshot import or Reviewer VM creation.
    // An authorized review without a result remains uncertain after a crash.
    await append({ kind: "review.authorized", ...pin });
    const reviewer = await this.#review(pin, diff, this.#plan.reviewer, id);
    const { review, notes } = reviewResult(reviewer);
    if (notes !== undefined)
      await append({
        kind: "review.noted",
        run: reviewer.id,
        notes: await this.#journal.saveNote(notes),
      });
    await append({
      kind: "review.submitted",
      run: reviewer.id,
      digest: pin.digest,
      review,
    });
    return { ...pin, review };
  }

  async decide(pin: PinnedCandidate, decision: Decision): Promise<void> {
    const events = await this.#journal.read();
    const expected = latestPin(events, await this.#target());
    if (
      events.at(-1)?.kind !== "review.submitted" ||
      !samePin(pin, expected.pin) ||
      (decision !== "approve" && decision !== "reject") ||
      (decision === "approve" && expected.review !== "pass")
    )
      throw new Error("Human decision does not match an eligible review");
    await this.#journal.append(events.length, {
      kind: "human.decided",
      ...expected.pin,
      decision,
    });
  }

  async integrate(id?: string): Promise<"completed" | "denied" | "uncertain"> {
    const events = await this.#journal.read();
    const { pin, review } = latestPin(events, await this.#target());
    const last = events.at(-1);
    if (last?.kind !== "human.decided" && last?.kind !== "review.submitted")
      throw new Error("Integration has already been attempted");
    const append = this.#writer(events.length);
    if (
      last.kind !== "human.decided" ||
      last.decision !== "approve" ||
      review !== "pass" ||
      !samePin(last, pin)
    ) {
      await append({ kind: "denied", reason: "no-approval" });
      return "denied";
    }
    if ((await this.#git.head()) !== pin.base) {
      await append({ kind: "denied", reason: "stale-base" });
      return "denied";
    }
    const diff = await this.#git.diff(pin.base, pin.candidate);
    if (sha256(diff) !== pin.digest) {
      await append({ kind: "denied", reason: "evidence" });
      return "denied";
    }
    await append({ kind: "verification.authorized", ...pin });
    const verification = await this.#review(
      pin,
      diff,
      this.#plan.verification,
      id,
    );
    const verified = reviewResult(verification).review;
    await append({
      kind: "verification.finished",
      run: verification.id,
      digest: pin.digest,
      review: verified,
    });
    if (verified !== "pass") {
      await append({ kind: "denied", reason: "verification" });
      return "denied";
    }
    await append({ kind: "integration.authorized", ...pin });
    try {
      await this.#git.advance(pin.base, pin.candidate);
    } catch (error) {
      if ((error as { code?: string } | null)?.code === "stale-base") {
        await append({ kind: "denied", reason: "stale-base" });
        return "denied";
      }
      await append({ kind: "integration.uncertain", candidate: pin.candidate });
      return "uncertain";
    }
    await append({ kind: "integration.completed", candidate: pin.candidate });
    return "completed";
  }
}
