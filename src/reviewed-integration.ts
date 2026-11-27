import { EnvironmentError } from "./environments/adapter.ts";
import { containsRoot, foldedPath } from "./environments/archive.ts";
import { bunAdapter } from "./environments/bun.ts";
import { createHash } from "node:crypto";
import type { HostService } from "./egress-policy.ts";
import type {
  LocalGitIntegration,
  PreparedWorkspace,
  TreeChange,
} from "./git-integration.ts";
import {
  IntegrationJournal,
  MAX_REVISIONS,
  NOTE_LIMIT_BYTES,
  type IntegrationEvent,
} from "./integration-journal.ts";
import type { ProfileName } from "./sandbox-profiles.ts";
import type {
  SandboxCommand,
  SandboxFile,
  SandboxEnvironment,
  SandboxSpec,
} from "./sandbox-runtime.ts";
import type {
  ReviewerRun,
  TrustedHost,
  TrustedHostRunOptions,
} from "./trusted-host.ts";
import {
  diffWorkspace,
  parseLsTree,
  workspaceFiles,
} from "./workspace-tree.ts";

type Review = "pass" | "revise" | "concern";
type Decision = "approve" | "reject";
export type DecisionOptions = {
  acknowledgeProtected?: readonly string[];
  approvalId?: string;
  answererKind?: "human" | "agent";
  delegated?: boolean;
};
type Event = Parameters<IntegrationJournal["append"]>[1];
type IntegrationGit = Pick<
  LocalGitIntegration,
  | "head"
  | "snapshot"
  | "createCandidate"
  | "diff"
  | "advance"
  | "targetId"
  | "prepareWorkspace"
  | "cleanupWorkspace"
  | "createCandidateTree"
  | "candidateMessage"
  | "listTree"
  | "protectedPaths"
>;

/** Extra sandbox inputs for model-driven roles. Verification gets none. */
type RoleSandbox = Pick<
  SandboxSpec,
  "tools" | "provider" | "hostTcpPort" | "profile" | "claude"
>;

export type Verification = {
  readonly command: SandboxCommand;
  readonly profile?: ProfileName;
  /** Host-pinned test files, delivered read-only under `suite/`. */
  readonly suite?: readonly SandboxFile[];
};

const SUITE_PREFIX = "suite/";
const SUITE_LIMIT = 32;
// Kept within the sandbox file limits, with room for the candidate files and
// review notes that share the same read-only mount.
const SUITE_FILE_BYTES = 256 * 1024;
const SUITE_TOTAL_BYTES = 512 * 1024;

/** Whole-repository mode. `scope` and `protectedPaths` use the workspace-tree
 * convention: a trailing `/` names a directory prefix, anything else one
 * exact file. Without `scope` the Worker may change any path. */
export type TreePlan = {
  readonly scope?: readonly string[];
  readonly protectedPaths?: readonly string[];
};

const SCOPE_LIMIT = 256;
const PROTECTED_LIMIT = 100;
const TREE_PATH_BYTES = 4096;
const CANDIDATE_MESSAGE_BYTES = 2048;

/** Exported for unit tests; candidates call it with the collected proposal. */
export function workerCommitMessage(
  run: string,
  proposal?: Uint8Array,
): string {
  const trailer = `\n\nAgent-Bootstrap-Worker-Run: ${run}\n`;
  const defaultSubject = `Candidate from Worker run ${run}`;
  let text = "";
  if (proposal) {
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(proposal);
    } catch {
      // An invalid UTF-8 proposal is treated as absent.
    }
  }
  const [subject = "", ...body] = text
    .replace(/[^\P{Cc}\n\t]/gu, "")
    .replace(/[\p{Cf}\p{Zl}\p{Zp}]/gu, "")
    .trim()
    .split("\n");
  const shortened = [
    /^Agent-Bootstrap-/i.test(subject)
      ? defaultSubject
      : [...subject].slice(0, 72).join(""),
    ...body.filter((line) => !/^Agent-Bootstrap-/i.test(line)),
  ].join("\n");
  const available = CANDIDATE_MESSAGE_BYTES - Buffer.byteLength(trailer);
  let end = 0;
  let size = 0;
  for (const character of shortened) {
    size += Buffer.byteLength(character);
    if (size > available) break;
    end += character.length;
  }
  const message = shortened.slice(0, end).trimEnd();
  return `${message || defaultSubject}${trailer}`;
}

function copyTreePaths(
  value: readonly string[] | undefined,
  limit: number,
): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length === 0 || value.length > limit)
    throw new Error("Invalid tree plan");
  const seen = new Set<string>();
  return value.map((entry) => {
    const name = typeof entry === "string" ? entry.replace(/\/$/, "") : "";
    if (
      typeof entry !== "string" ||
      !name ||
      Buffer.byteLength(entry) > TREE_PATH_BYTES ||
      /[\0\\]/.test(entry) ||
      name.startsWith("/") ||
      name.split("/").some((part) => !part || part === "." || part === "..") ||
      seen.has(entry)
    )
      throw new Error("Invalid tree plan");
    seen.add(entry);
    return entry;
  });
}

function copyTree(input: TreePlan): TreePlan {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new Error("Invalid tree plan");
  const scope = copyTreePaths(input.scope, SCOPE_LIMIT);
  const protectedPaths = copyTreePaths(input.protectedPaths, PROTECTED_LIMIT);
  return {
    ...(scope ? { scope } : {}),
    ...(protectedPaths ? { protectedPaths } : {}),
  };
}

export type EnsureTaskEnvironment = (input: {
  role: "Executor" | "Verification";
  commit: string;
  profile: ProfileName | undefined;
  executionId: string | undefined;
}) => Promise<{ environment: SandboxEnvironment; release(): void }>;

export const environmentLockMismatchNote =
  "The dependency declarations and bun.lock disagree. Make them consistent before Verification runs again.";
export const environmentOutputCollisionNote =
  "Remove generated dependency directories from the change before Verification runs again.";

type Plan = {
  readonly ensureEnvironment?: EnsureTaskEnvironment;
  /** Single-file mode: one top-level file. Exclusive with `tree`. */
  readonly path?: string;
  /** Tree mode: the Worker edits a whole repository workspace. */
  readonly tree?: TreePlan;
  readonly worker: SandboxCommand;
  readonly reviewer: SandboxCommand;
  readonly verification?: Verification | undefined;
  readonly allowUnverified?: true;
  readonly workerSandbox?: RoleSandbox;
  readonly reviewerSandbox?: RoleSandbox;
  readonly workerHostServices?: readonly HostService[];
  readonly scanCandidate?: (
    ...text: readonly (string | Uint8Array)[]
  ) => Promise<void>;
  readonly onWorkerStderr?: TrustedHostRunOptions["onWorkerStderr"];
  readonly reviewerHostServices?: readonly HostService[];
  /** Maps the Reviewer's raw stdout to the review JSON, for harnesses that
   * wrap their answer (for example a CLI result object). Verification output
   * is never transformed. */
  readonly reviewerOutput?: (
    response: Uint8Array | undefined,
  ) => Uint8Array | undefined;
};

const roleSandbox = (extra?: RoleSandbox): RoleSandbox => ({
  ...(extra?.tools ? { tools: extra.tools.map((tool) => ({ ...tool })) } : {}),
  ...(extra?.provider ? { provider: { ...extra.provider } } : {}),
  ...(extra?.claude ? { claude: true } : {}),
  ...(extra?.hostTcpPort !== undefined
    ? { hostTcpPort: extra.hostTcpPort }
    : {}),
  ...(extra?.profile !== undefined ? { profile: extra.profile } : {}),
});

function copyVerification(input: Verification): Verification {
  if (!input || typeof input !== "object" || !input.command)
    throw new Error("Invalid verification plan");
  const suite = input.suite ?? [];
  if (!Array.isArray(suite) || suite.length > SUITE_LIMIT)
    throw new Error("Invalid verification suite");
  const seen = new Set<string>();
  const files = suite.map((file) => {
    const path = file?.path;
    if (
      typeof path !== "string" ||
      !path ||
      path.startsWith("/") ||
      path.split("/").some((part) => !part || part === "." || part === "..") ||
      seen.has(path) ||
      !(file.bytes instanceof Uint8Array)
    )
      throw new Error("Invalid verification suite");
    seen.add(path);
    if (file.bytes.byteLength > SUITE_FILE_BYTES)
      throw new Error("Invalid verification suite");
    return { path, bytes: new Uint8Array(file.bytes) };
  });
  if (
    files.reduce((total, file) => total + file.bytes.byteLength, 0) >
    SUITE_TOTAL_BYTES
  )
    throw new Error("Invalid verification suite");
  return {
    command: { ...input.command, argv: [...input.command.argv] },
    ...(input.profile !== undefined ? { profile: input.profile } : {}),
    ...(files.length ? { suite: files } : {}),
  };
}

export type PinnedCandidate = {
  readonly base: string;
  readonly candidate: string;
  readonly digest: string;
};

const sha256 = (data: Uint8Array | string) =>
  createHash("sha256").update(data).digest("hex");

const NO_NOTES = sha256("");

type Tests = { passed: number; failed: number };

/** The verdict and `tests` are self-reported by a VM that also runs the
 * candidate code, which can print a forged pass. Verification catches honest
 * failures; Reviewer and human approval remain the integration gate.
 *
 * Verification accepts exactly `{"review": "pass" | "revise"}` in at most
 * 128 bytes, or that plus a bounded `tests` summary in at most 4096 bytes.
 * Anything else, or a pass with failing tests, is a concern. */
export function verificationResult(run: ReviewerRun): {
  review: Review;
  tests?: Tests;
} {
  const concern = { review: "concern" as Review };
  const bytes = run.response;
  if (run.outcome !== "ok" || !bytes || bytes.length > 4096) return concern;
  try {
    const result = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    );
    if (!result || Array.isArray(result) || typeof result !== "object")
      return concern;
    const keys = Object.keys(result);
    const review = result.review;
    if (review !== "pass" && review !== "revise") return concern;
    if (keys.length === 1) return bytes.length <= 128 ? { review } : concern;
    if (keys.length !== 2 || !Object.hasOwn(result, "tests")) return concern;
    const tests = result.tests;
    if (!tests || Array.isArray(tests) || typeof tests !== "object")
      return concern;
    const keyList = Object.keys(tests).sort().join(",");
    const { passed, failed, failures } = tests;
    const count = (value: unknown): value is number =>
      Number.isSafeInteger(value) &&
      (value as number) >= 0 &&
      (value as number) <= 100_000;
    if (
      keyList !== "failed,failures,passed" ||
      !count(passed) ||
      !count(failed) ||
      !Array.isArray(failures) ||
      failures.length > 20 ||
      failures.some(
        (failure) =>
          typeof failure !== "string" ||
          failure.length > 200 ||
          !/^[\x20-\x7e]*$/.test(failure),
      ) ||
      (review === "pass" && failed > 0)
    )
      return concern;
    return { review, tests: { passed, failed } };
  } catch {
    return concern;
  }
}

/** `{"review": "pass" | "revise"}`, optionally with bounded `notes` text for
 * the next Worker; blank notes mean none. Anything else is a concern without
 * notes. */
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
    // A structured-output schema may require `notes`; blank means none.
    if (keys.length === 2 && typeof notes === "string" && !notes.trim())
      return { review };
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

function preReviewVerification(
  events: IntegrationEvent[],
  pin: PinnedCandidate,
) {
  const [created, authorized, finished] = events.slice(-3);
  if (
    created?.kind === "candidate.created" &&
    created.candidate === pin.candidate &&
    created.digest === pin.digest &&
    authorized?.kind === "verification.authorized" &&
    samePin(authorized, pin) &&
    finished?.kind === "verification.finished" &&
    finished.digest === pin.digest
  )
    return finished;
  return undefined;
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
 * The caller of decide must enforce the host approval policy. */
export class ReviewedIntegration {
  readonly #git: IntegrationGit;
  readonly #host: Pick<
    TrustedHost,
    "runWorker" | "runReviewer" | "runVerification"
  >;
  readonly #journal: IntegrationJournal;
  readonly #plan: Plan;

  constructor(
    git: IntegrationGit,
    host: Pick<TrustedHost, "runWorker" | "runReviewer" | "runVerification">,
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
    const verification =
      plan.verification && copyVerification(plan.verification);
    if (!verification && plan.allowUnverified !== true)
      throw new Error("Verification is required");
    if ((plan.path === undefined) === (plan.tree === undefined))
      throw new Error("A plan needs exactly one of path and tree");
    this.#plan = {
      ...(plan.path !== undefined ? { path: plan.path } : {}),
      ...(plan.tree !== undefined ? { tree: copyTree(plan.tree) } : {}),
      ...(plan.ensureEnvironment
        ? { ensureEnvironment: plan.ensureEnvironment }
        : {}),
      worker: copy(plan.worker),
      reviewer: copy(plan.reviewer),
      verification,
      ...(plan.allowUnverified ? { allowUnverified: true } : {}),
      workerSandbox: roleSandbox(plan.workerSandbox),
      onWorkerStderr: plan.onWorkerStderr,
      ...(plan.scanCandidate ? { scanCandidate: plan.scanCandidate } : {}),
      reviewerSandbox: roleSandbox(plan.reviewerSandbox),
      ...(plan.workerHostServices
        ? {
            workerHostServices: plan.workerHostServices.map((service) => ({
              ...service,
            })),
          }
        : {}),
      ...(plan.reviewerHostServices
        ? {
            reviewerHostServices: plan.reviewerHostServices.map((service) => ({
              ...service,
            })),
          }
        : {}),
      ...(plan.reviewerOutput ? { reviewerOutput: plan.reviewerOutput } : {}),
    };
  }

  #workerOptions(): TrustedHostRunOptions | undefined {
    const { workerHostServices, onWorkerStderr } = this.#plan;
    if (!workerHostServices && !onWorkerStderr) return undefined;
    return {
      ...(workerHostServices ? { hostServices: workerHostServices } : {}),
      ...(onWorkerStderr ? { onWorkerStderr } : {}),
    };
  }

  async #target() {
    const { path, tree, verification } = this.#plan;
    const sorted = (list?: readonly string[]) =>
      list ? [...list].sort() : null;
    return sha256(
      JSON.stringify([
        await this.#git.targetId(),
        path ?? null,
        tree ? "tree" : "file",
        sorted(tree?.scope),
        sorted(tree?.protectedPaths),
        verification?.command.argv ?? null,
        verification?.command.timeoutMs ?? null,
        verification?.profile ?? "base",
        (verification?.suite ?? []).map((file) => [
          file.path,
          sha256(file.bytes),
        ]),
      ]),
    );
  }

  #writer(priorCount: number) {
    return async (event: Event) => {
      await this.#journal.append(priorCount, event);
      priorCount++;
    };
  }

  async #review(pin: PinnedCandidate, diff: Uint8Array, id?: string) {
    const files = await this.#candidateFiles(pin, diff);
    if (this.#plan.tree)
      files.push({
        path: "candidate.message",
        bytes: await this.candidateMessage(pin),
      });
    return this.#host.runReviewer(
      {
        sandbox: {
          ...this.#plan.reviewerSandbox,
          maxLifetimeMs: 300_000,
          readOnlyFiles: files,
        },
        command: this.#plan.reviewer,
      },
      id,
      undefined,
      this.#plan.reviewerHostServices
        ? { hostServices: this.#plan.reviewerHostServices }
        : undefined,
    );
  }

  async #candidateFiles(pin: PinnedCandidate, diff: Uint8Array) {
    if (this.#plan.tree) return [{ path: "candidate.diff", bytes: diff }];
    const bytes = await this.#git.snapshot(pin.candidate, this.#plan.path!);
    return [
      { path: "candidate.diff", bytes: diff },
      { path: "candidate.source", bytes },
    ];
  }

  #fileExpectation() {
    const { path } = this.#plan;
    return path === undefined ? undefined : { path };
  }

  #suiteFiles(): SandboxFile[] {
    return (this.#plan.verification?.suite ?? []).map((file) => ({
      path: SUITE_PREFIX + file.path,
      bytes: new Uint8Array(file.bytes),
    }));
  }

  async prepare(): Promise<PinnedCandidate & { review: Review }> {
    await this.prepareCandidate();
    return this.reviewCandidate();
  }

  async prepareCandidate(id?: string): Promise<PinnedCandidate> {
    if ((await this.#journal.read()).length)
      throw new Error("Integration already exists");
    const append = this.#writer(0);
    const base = await this.#git.head();
    await append({ kind: "requested", target: await this.#target(), base });
    if (this.#plan.tree)
      return this.#produceTree(append, base, undefined, [], id);
    const source = await this.#git.snapshot(base, this.#plan.path!);
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
    const path = this.#plan.path!;
    const profile =
      this.#plan.workerSandbox?.profile ?? this.#plan.verification?.profile;
    const allReadOnly = [...readOnlyFiles, ...this.#suiteFiles()];
    const worker = await this.#host.runWorker(
      {
        sandbox: {
          ...this.#plan.workerSandbox,
          ...(profile !== undefined ? { profile } : {}),
          maxLifetimeMs: 300_000,
          files: [{ path, bytes: source }],
          ...(allReadOnly.length ? { readOnlyFiles: allReadOnly } : {}),
        },
        command: this.#plan.worker,
        collectPaths: [path],
      },
      id,
      undefined,
      this.#workerOptions(),
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
      diff = await this.#git.diff(base, candidate, { path });
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

  /** Tree mode: place the base (or the previous candidate) in a host-prepared
   * workspace, run Worker, then compute the changes against `base` from the
   * collected workspace tar and create the candidate commit on the host. The
   * candidate is always a single-parent commit on `base`. */
  async #produceTree(
    append: (event: Event) => Promise<void>,
    base: string,
    previous: string | undefined,
    readOnlyFiles: SandboxFile[],
    id?: string,
  ): Promise<PinnedCandidate> {
    const { scope, protectedPaths } = this.#plan.tree!;
    const profile =
      this.#plan.workerSandbox?.profile ?? this.#plan.verification?.profile;
    const allReadOnly = [...readOnlyFiles, ...this.#suiteFiles()];
    const prepared = await this.#git.prepareWorkspace({
      base,
      ...(previous !== undefined ? { previous } : {}),
      ...(scope ? { sparsePaths: scope.map((p) => p.replace(/\/$/, "")) } : {}),
    });
    let held: Awaited<ReturnType<EnsureTaskEnvironment>> | undefined;
    const readChanges = async (tree: Uint8Array) => {
      const baseOutputs = held?.environment.outputs;
      const workspace = workspaceFiles(tree, baseOutputs);
      const baseFiles = parseLsTree(await this.#git.listTree(base));
      if (baseOutputs) {
        // A revision must be able to unpack the same base environment over
        // the candidate, including on case-insensitive filesystems.
        const delivered = new Set(baseOutputs.map(foldedPath));
        for (const path of workspace.keys())
          if (containsRoot(delivered, foldedPath(path))) workspace.delete(path);
        // A candidate with unreadable declarations (broken package.json, a
        // symlinked manifest, an unsupported workspace pattern) keeps only
        // the base exclusion; Verification then reports the identify failure
        // instead of the change disappearing as "no eligible change".
        const layout = await bunAdapter
          .layout({
            paths: [...workspace.keys()],
            async read(path) {
              const file = workspace.get(path);
              if (file?.mode === "120000") throw new EnvironmentError();
              return file?.bytes;
            },
          })
          .catch((error: unknown) => {
            if (error instanceof EnvironmentError) return undefined;
            throw error;
          });
        // The delivered roots were excluded while reading the tar.
        const outputs = new Set(layout?.outputs ?? []);
        for (const path of workspace.keys()) {
          if (!containsRoot(outputs, path)) continue;
          workspace.delete(path);
          // Ignoring a generated path must not delete a tracked file that
          // was still present in the collected tree.
          baseFiles.delete(path);
        }
      }
      const result = diffWorkspace({
        base: baseFiles,
        workspace,
        ...(scope ? { scope } : {}),
        ...(protectedPaths ? { protectedPaths } : {}),
      });
      const changes: TreeChange[] = [
        ...result.changes,
        ...result.deletions.map((path) => ({ path, deleted: true as const })),
      ];
      return { changes, flagged: result.protected.length };
    };
    const changeSources = (changes: TreeChange[]) =>
      changes.flatMap((change) =>
        "deleted" in change ? [change.path] : [change.path, change.bytes],
      );
    let inspected: Awaited<ReturnType<typeof readChanges>> | undefined;
    const scan = this.#plan.scanCandidate;
    const options = scan
      ? {
          ...this.#workerOptions(),
          async inspectWorkerTree(tree: Uint8Array) {
            const result = await readChanges(tree);
            await scan(...changeSources(result.changes));
            inspected = result;
          },
        }
      : this.#workerOptions();
    try {
      // Revisions edit the previous candidate with the original base's environment.
      held = await this.#plan.ensureEnvironment?.({
        role: "Executor",
        commit: base,
        profile,
        executionId: id,
      });
      const worker = await this.#host.runWorker(
        {
          sandbox: {
            ...this.#plan.workerSandbox,
            ...(profile !== undefined ? { profile } : {}),
            maxLifetimeMs: 300_000,
            repository: { gitDir: prepared.gitDir, tree: prepared.tree },
            ...(held ? { environment: held.environment } : {}),
            ...(allReadOnly.length ? { readOnlyFiles: allReadOnly } : {}),
          },
          command: this.#plan.worker,
          collectPaths: [],
          collectTree: true,
        },
        id,
        undefined,
        options,
      );
      let changes: TreeChange[] = [];
      let flagged = 0;
      if (worker.outcome === "ok" && worker.artifacts?.tree) {
        if (held)
          await append({
            kind: "environment.outputs-excluded",
            run: worker.id,
          });
        try {
          ({ changes, flagged } =
            inspected ?? (await readChanges(worker.artifacts.tree)));
        } catch {
          changes = [];
        }
      }
      if (!changes.length) {
        await append({ kind: "denied", reason: "worker" });
        throw new Error("Worker did not produce an eligible change");
      }
      const message = workerCommitMessage(worker.id, worker.artifacts?.message);
      await this.#plan.scanCandidate?.(
        worker.artifacts?.message ?? "",
        message,
        ...(inspected ? [] : changeSources(changes)),
      );
      await append({
        kind: "candidate.authorized",
        run: worker.id,
        digest: sha256(
          JSON.stringify(
            changes.map((change) =>
              "deleted" in change
                ? [change.path, "deleted"]
                : [change.path, change.mode, sha256(change.bytes)],
            ),
          ),
        ),
      });
      let candidate: string;
      let diff: Uint8Array;
      try {
        candidate = await this.#git.createCandidateTree(base, changes, message);
        diff = await this.#git.diff(base, candidate);
      } catch (error) {
        const cleanup = (error as { cleanupFailed?: boolean } | null)
          ?.cleanupFailed
          ? "unknown"
          : "complete";
        await append({ kind: "candidate.failed", cleanup });
        throw new Error("Could not create a review candidate");
      }
      await this.#plan.scanCandidate?.(diff);
      const pin = { base, candidate, digest: sha256(diff) };
      await append({
        kind: "candidate.created",
        candidate,
        digest: pin.digest,
        protectedCount: flagged,
        messageDigest: sha256(message),
      });
      return pin;
    } finally {
      try {
        held?.release();
      } finally {
        await this.#cleanup(prepared);
      }
    }
  }

  async #cleanup(prepared: PreparedWorkspace): Promise<void> {
    try {
      await this.#git.cleanupWorkspace(prepared.directory);
    } catch {
      // A leftover private directory must not mask the run's own outcome.
    }
  }

  /** Start a revised candidate after the current one was reviewed as
   * `revise` or `concern`. Worker gets the current candidate's file and the
   * review notes, read-only, in a new VM. The new candidate starts from the
   * original base, so it gets a new commit, diff and digest, and needs its own
   * review and human decision. */
  async revise(id?: string): Promise<PinnedCandidate> {
    const events = await this.#journal.read();
    const target = await this.#target();
    const last = events.at(-1);
    const rejected = last?.kind === "candidate.rejected";
    const pin = candidatePin(events, target);
    const verification = preReviewVerification(events, pin);
    if (verification?.failure === "env-missing")
      throw new EnvironmentError("env-missing");
    const verificationFailed =
      verification !== undefined && verification.review !== "pass";
    const review =
      rejected || verificationFailed ? undefined : latestPin(events, target);
    if (rejected && last.digest !== pin.digest)
      throw new Error("Candidate evidence does not match its durable pin");
    const rounds = events.filter(
      (event) => event.kind === "revision.requested",
    ).length;
    if (
      !rejected &&
      !verificationFailed &&
      (last?.kind !== "review.submitted" || review?.review === "pass")
    )
      throw new Error(
        "Only a candidate reviewed as needing changes can be revised",
      );
    if (rounds >= MAX_REVISIONS) throw new Error("Revision limit reached");
    // Notes count only when recorded immediately before this review.
    const noted = events.at(-2);
    const notes = rejected
      ? last.notes
      : verificationFailed
        ? await this.#journal.saveNote(
            verification.failure === "env-lock-mismatch"
              ? environmentLockMismatchNote
              : verification.failure === "env-output-collision"
                ? environmentOutputCollisionNote
                : "The host verification suite failed for the previous candidate. Revise the candidate before verification is run again.",
          )
        : noted?.kind === "review.noted" && noted.run === review?.run
          ? noted.notes
          : NO_NOTES;
    const append = this.#writer(events.length);
    // This sequence CAS wins before any snapshot or Worker VM.
    await append({
      kind: "revision.requested",
      round: String(rounds + 1),
      from: pin.digest,
      notes,
    });
    const readOnly =
      notes === NO_NOTES
        ? []
        : [
            {
              path: "review-notes.txt",
              bytes: await this.#journal.readNote(notes),
            },
          ];
    if (this.#plan.tree)
      return this.#produceTree(append, pin.base, pin.candidate, readOnly, id);
    const source = await this.#git.snapshot(pin.candidate, this.#plan.path!);
    return this.#produce(append, pin.base, source, readOnly, id);
  }

  /** Record a host path rejection before allowing another Worker attempt. */
  async rejectCandidate(candidate: PinnedCandidate): Promise<void> {
    const events = await this.#journal.read();
    const pin = candidatePin(events, await this.#target());
    if (events.at(-1)?.kind !== "candidate.created" || !samePin(candidate, pin))
      throw new Error("Candidate cannot be rejected");
    const notes = await this.#journal.saveNote(
      "The host rejected the previous candidate for changing paths outside the Task. Restore all out-of-scope paths to the base and keep changes within the Task's allowed paths.",
    );
    await this.#writer(events.length)({
      kind: "candidate.rejected",
      digest: pin.digest,
      notes,
    });
  }

  /** Verify the pinned candidate before review when a host suite is configured. */
  async verifyCandidate(id?: string): Promise<boolean> {
    const events = await this.#journal.read();
    const pin = candidatePin(events, await this.#target());
    if (events.at(-1)?.kind !== "candidate.created")
      throw new Error("Candidate cannot be verified");
    const diff = await this.#git.diff(
      pin.base,
      pin.candidate,
      this.#fileExpectation(),
    );
    if (sha256(diff) !== pin.digest)
      throw new Error("Candidate evidence does not match its durable pin");
    return this.#verify(pin, diff, this.#writer(events.length), id);
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
    const last = events.at(-1);
    if (
      last?.kind !== "candidate.created" &&
      preReviewVerification(events, pin)?.review !== "pass"
    )
      throw new Error("Candidate review has already been attempted");
    const diff = await this.#git.diff(
      pin.base,
      pin.candidate,
      this.#fileExpectation(),
    );
    if (sha256(diff) !== pin.digest)
      throw new Error("Candidate evidence does not match its durable pin");
    const append = this.#writer(events.length);
    // This sequence CAS wins before snapshot import or Reviewer VM creation.
    // An authorized review without a result remains uncertain after a crash.
    await append({ kind: "review.authorized", ...pin });
    const reviewer = await this.#review(pin, diff, id);
    const transformed = this.#plan.reviewerOutput
      ? this.#plan.reviewerOutput(reviewer.response)
      : reviewer.response;
    const { review, notes } = reviewResult({
      id: reviewer.id,
      outcome: reviewer.outcome,
      ...(transformed ? { response: transformed } : {}),
    });
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

  #protectedPaths(pin: PinnedCandidate): Promise<string[]> {
    return this.#git.protectedPaths(
      pin.base,
      pin.candidate,
      this.#plan.tree?.protectedPaths ?? [],
    );
  }

  /** Return the protected paths of the current pinned tree candidate. */
  async protectedPaths(pin: PinnedCandidate): Promise<string[]> {
    if (!this.#plan.tree) return [];
    const expected = candidatePin(
      await this.#journal.read(),
      await this.#target(),
    );
    if (!samePin(pin, expected))
      throw new Error("Candidate evidence does not match its durable pin");
    return this.#protectedPaths(expected);
  }

  /** Read the final message of the current pinned tree candidate. */
  async candidateMessage(pin: PinnedCandidate): Promise<Uint8Array> {
    const events = await this.#journal.read();
    const expected = candidatePin(events, await this.#target());
    if (!this.#plan.tree || !samePin(pin, expected))
      throw new Error("Candidate evidence does not match its durable pin");
    const message = await this.#git.candidateMessage(expected.candidate);
    const created = events.findLast(
      (event) => event.kind === "candidate.created",
    );
    if (
      created?.messageDigest !== undefined &&
      sha256(message) !== created.messageDigest
    )
      throw new Error("Candidate evidence does not match its durable pin");
    return message;
  }

  async decide(
    pin: PinnedCandidate,
    decision: Decision,
    options?: DecisionOptions,
  ): Promise<void> {
    const events = await this.#journal.read();
    const expected = latestPin(events, await this.#target());
    if (
      events.at(-1)?.kind !== "review.submitted" ||
      !samePin(pin, expected.pin) ||
      (decision !== "approve" && decision !== "reject") ||
      (decision === "approve" && expected.review !== "pass")
    )
      throw new Error("Human decision does not match an eligible review");
    let protectedDigest: string | undefined;
    if (decision === "approve" && this.#plan.tree) {
      const paths = await this.#protectedPaths(expected.pin);
      if (paths.length) {
        const acknowledged = options?.acknowledgeProtected;
        if (
          !Array.isArray(acknowledged) ||
          acknowledged.some((path) => typeof path !== "string")
        )
          throw new Error("Human decision does not match an eligible review");
        const sorted = [...new Set(acknowledged)].sort();
        if (
          sorted.length !== paths.length ||
          paths.some((path, i) => path !== sorted[i])
        )
          throw new Error("Human decision does not match an eligible review");
        protectedDigest = sha256(JSON.stringify(paths));
      }
    }
    await this.#journal.append(events.length, {
      kind: "human.decided",
      ...expected.pin,
      decision,
      answererKind: options?.answererKind ?? "human",
      delegated: options?.delegated ?? false,
      ...(protectedDigest ? { protectedDigest } : {}),
      ...(options?.approvalId ? { approvalId: options.approvalId } : {}),
    });
  }

  async integrate(
    id?: string,
    options?: {
      allowUnverified?: true;
      verificationObserver?: {
        begin(): string;
        finish(
          id: string,
          passed: boolean | null,
          failure?: "env-missing",
        ): void;
      };
    },
  ): Promise<"completed" | "denied" | "uncertain"> {
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
    if (this.#plan.tree) {
      const paths = await this.#protectedPaths(pin);
      if (
        paths.length &&
        last.protectedDigest !== sha256(JSON.stringify(paths))
      ) {
        await append({ kind: "denied", reason: "no-approval" });
        return "denied";
      }
    }
    const diff = await this.#git.diff(
      pin.base,
      pin.candidate,
      this.#fileExpectation(),
    );
    if (sha256(diff) !== pin.digest) {
      await append({ kind: "denied", reason: "evidence" });
      return "denied";
    }
    const skipVerification =
      !this.#plan.verification &&
      this.#plan.allowUnverified &&
      options?.allowUnverified;
    if (!skipVerification) {
      const observer = options?.verificationObserver;
      const verificationId = observer?.begin() ?? id;
      let passed: boolean | null = null;
      let missingEnvironment: EnvironmentError | undefined;
      try {
        passed = await this.#verify(pin, diff, append, verificationId);
      } catch (error) {
        if (
          !verificationId ||
          !(error instanceof EnvironmentError) ||
          error.code !== "env-missing"
        )
          throw error;
        missingEnvironment = error;
      } finally {
        observer?.finish(
          verificationId!,
          passed,
          missingEnvironment ? "env-missing" : undefined,
        );
      }
      if (!passed) {
        await append({ kind: "denied", reason: "verification" });
        if (missingEnvironment) throw missingEnvironment;
        return "denied";
      }
    }
    await append({ kind: "integration.authorized", ...pin });
    try {
      await this.#git.advance(pin.base, pin.candidate, this.#fileExpectation());
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

  async #verify(
    pin: PinnedCandidate,
    diff: Uint8Array,
    append: (event: Event) => Promise<void>,
    id?: string,
  ): Promise<boolean> {
    const plan = this.#plan.verification;
    if (!plan) throw new Error("Verification is not configured");
    await append({ kind: "verification.authorized", ...pin });
    const { profile } = plan;
    const files = [
      ...(await this.#candidateFiles(pin, diff)),
      ...this.#suiteFiles(),
    ];
    // Tree mode: the whole candidate tree, not sparse, so tests see the repo.
    const prepared = this.#plan.tree
      ? await this.#git.prepareWorkspace({ base: pin.candidate })
      : undefined;
    let verification: ReviewerRun;
    let held: Awaited<ReturnType<EnsureTaskEnvironment>> | undefined;
    try {
      held = await this.#plan.ensureEnvironment?.({
        role: "Verification",
        commit: pin.candidate,
        profile,
        executionId: id,
      });
      verification = await this.#host.runVerification(
        {
          sandbox: {
            maxLifetimeMs: 300_000,
            readOnlyFiles: files,
            ...(profile !== undefined ? { profile } : {}),
            ...(held ? { environment: held.environment } : {}),
            ...(prepared
              ? { repository: { gitDir: prepared.gitDir, tree: prepared.tree } }
              : {}),
          },
          command: plan.command,
        },
        id,
      );
    } catch (error) {
      if (
        !id ||
        !(error instanceof EnvironmentError) ||
        (error.code !== "env-lock-mismatch" &&
          error.code !== "env-output-collision" &&
          error.code !== "env-missing")
      )
        throw error;
      await append({
        kind: "verification.finished",
        run: id,
        digest: pin.digest,
        review: error.code === "env-missing" ? "failed" : "revise",
        failure: error.code,
      });
      if (error.code === "env-missing") throw error;
      return false;
    } finally {
      try {
        held?.release();
      } finally {
        if (prepared) await this.#cleanup(prepared);
      }
    }
    const { review: verified, tests } = verificationResult(verification);
    await append({
      kind: "verification.finished",
      run: verification.id,
      digest: pin.digest,
      review: verified,
      ...(tests ? { tests } : {}),
    });
    return verified === "pass";
  }
}
