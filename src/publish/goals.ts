import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { closeSync, constants, fstatSync, openSync } from "node:fs";
import { join } from "node:path";
import { GitIntegrationError } from "../git-integration.ts";
import { ClaudeRunError } from "../local-orchestrator/claude-errors.ts";
import {
  builtInCredentialScanner,
  type CredentialScanner,
} from "../local-orchestrator/credential-scan.ts";
import {
  OrchestratorStoreError,
  type OrchestratorStore,
} from "../local-orchestrator/store.ts";
import { previewGoalBranchExport } from "../local-orchestrator/tasks.ts";
import {
  publishView,
  remoteGoalBranch,
  type GoalPublishRecord,
  type PublishEventKind,
  type PublishAuthorization,
  type PublishMutation,
} from "./journal.ts";
import {
  publishDefaults,
  mergeMethods,
  type MergeMethod,
  PublishError,
  type AutoMerge,
  type PublishConfig,
  type PublishProvider,
  type PublishPullRequest,
} from "./port.ts";
import {
  goalPrConfirmation,
  type GoalPublishConfirmationPr,
} from "./protocol.ts";

interface LockDatabase {
  exec(sql: string): void;
  close(): void;
}
const { Database } = createRequire(import.meta.url)("bun:sqlite") as {
  Database: new (path: string, options: { create: false }) => LockDatabase;
};

type Goal = NonNullable<ReturnType<OrchestratorStore["getGoal"]>>;

function disarmPending(goal: Goal, record: GoalPublishRecord | null) {
  return (
    record?.pr?.state === "open" &&
    record.pr.autoMerge !== "off" &&
    (goal.status === "cancelled" ||
      record.pollFailure === "publish-remote-head-changed")
  );
}
const initialPollDelay = 2000;
const activeCycleDelay = 1000;
const idleCycleDelay = 30_000;
const hour = 60 * 60_000;
const longPollDelay = 10 * 60_000;
const transientFailures = new Set([
  "publish-audit-failed",
  "publish-busy",
  "publish-poll-failed",
  "publish-stale-head",
  "stale-confirmation",
  "auto-merge-disarm-failed",
]);

function oneLine(text: string) {
  return text
    .replace(/\s+/gu, " ")
    .replace(/[\p{Cc}\p{Cf}]/gu, "")
    .replace(/ +/g, " ")
    .trim();
}

function prTitle(title: string) {
  const line = oneLine(title)
    .replaceAll("`", "｀")
    .replace(
      /(?<![\\\p{L}\p{N}_])@[a-z0-9-]+\/[a-z0-9._-]+(?![\p{L}\p{N}_/.-])|@|#(?=[\p{L}\p{N}_])/gu,
      (value) => (value === "@" ? "＠" : value === "#" ? "＃" : `\`${value}\``),
    );
  const bounded = Array.from(line).slice(0, 200).join("").trimEnd();
  return bounded.split("`").length % 2 === 0
    ? bounded.slice(0, bounded.lastIndexOf("`")) +
        bounded.slice(bounded.lastIndexOf("`") + 1).replaceAll("@", "＠")
    : bounded;
}

const maxBodyBytes = 24 * 1024;
const maxBodyTasks = 180;

function resultIcon(passed: boolean | null) {
  return passed === null ? "–" : passed ? "✓" : "✕";
}

export function buildGoalPullRequest(
  store: Pick<OrchestratorStore, "listTasks" | "goalPublishEvidence">,
  goal: Goal,
  head: string,
) {
  const { title, description, acceptance } = goal.content;
  const tasks = store.listTasks(goal.id);
  const evidence = store.goalPublishEvidence(goal.id);
  const shown = tasks.slice(0, maxBodyTasks);
  const bytes = Buffer.byteLength;
  // Indent model text so Markdown, mentions and images are displayed as text.
  const intro = `## 目標

    ${oneLine(title)}

Goal ${goal.ref} · ${goal.id}

### 受け入れ条件

`;
  const taskHeading = "\n\n## Task 一覧\n\n";
  const omitted = tasks.length - shown.length;
  const summary = `${omitted ? `\n\nほか ${omitted} 件の Task を省略しました。` : ""}

## 検証とレビュー

結果は検証、レビューの順です。

${shown
  .map(({ id, ref }) => {
    const result = evidence.get(id);
    const revisions = result?.revisions ?? 0;
    const verification = resultIcon(result?.verification ?? null);
    const review = resultIcon(result?.review ?? null);
    return `    ${ref} ${verification} / ${review}${revisions ? `（やり直し ${revisions} 回）` : ""}`;
  })
  .join("\n")}

## 監査情報

書き出したコミット ${head}
`;
  const note = "\n一部の文章を短くしました。\n";
  const prefixes = shown.map(({ ref, status }) => {
    const result =
      status === "succeeded" ? true : status === "failed" ? false : null;
    return `    ${ref} ${resultIcon(result)} `;
  });
  const fixed = intro + taskHeading + prefixes.join("\n") + summary + note;
  const available = maxBodyBytes - bytes(fixed);
  const acceptanceLines = acceptance.map((item) => `    - ${oneLine(item)}`);
  const minimumAcceptance = acceptanceLines
    .map((line) => boundedText(line, 48))
    .join("\n");
  const titles = shown.map(({ content }) => oneLine(content.title));
  const totalTitleBytes = titles.reduce((sum, value) => sum + bytes(value), 0);
  const taskBudget = available - bytes(minimumAcceptance);
  const taskTitles =
    totalTitleBytes <= taskBudget
      ? titles
      : titles.map((value) =>
          boundedText(
            value,
            Math.max(0, Math.floor(taskBudget / shown.length)),
          ),
        );
  const acceptanceBudget = Math.max(
    0,
    available - taskTitles.reduce((sum, value) => sum + bytes(value), 0),
  );
  const acceptanceBody = acceptanceLines.join("\n");
  const acceptancePreview =
    bytes(acceptanceBody) <= acceptanceBudget
      ? acceptanceBody
      : bytes(minimumAcceptance) <= acceptanceBudget
        ? minimumAcceptance
        : boundedText(minimumAcceptance, acceptanceBudget);
  const shortened =
    acceptancePreview !== acceptanceBody ||
    taskTitles.some((value, index) => value !== titles[index]);
  const body =
    intro +
    acceptancePreview +
    taskHeading +
    prefixes.map((prefix, index) => prefix + taskTitles[index]).join("\n") +
    summary +
    (shortened ? note : "");
  // Screen the original Goal text and every Task title, including omitted text.
  const screened = [
    title,
    description,
    ...acceptance,
    ...tasks.map((task) => task.content.title),
  ];
  return { title: prTitle(title) || `Goal ${goal.ref}`, body, screened };
}

function boundedText(value: string, bytes: number) {
  if (Buffer.byteLength(value) <= bytes) return value;
  if (bytes < 3) return "";
  const prefix = Buffer.from(value)
    .subarray(0, bytes - 3)
    .toString("utf8")
    .replace(/\uFFFD$/, "");
  return `${prefix.trimEnd()}…`;
}

function lockPublisher(directory: string) {
  // This lock database has its own writer slot. It does not hold the Goal
  // journal's writer across subprocesses, and SQLite releases it on exit.
  const path = join(directory, "publish.lock.db");
  let lock: LockDatabase | undefined;
  try {
    const fd = openSync(
      path,
      constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      const file = fstatSync(fd);
      if (!file.isFile() || (file.mode & 0o077) !== 0) throw new Error();
    } finally {
      closeSync(fd);
    }
    lock = new Database(path, { create: false });
    lock.exec("PRAGMA busy_timeout=0; BEGIN IMMEDIATE");
    return () => lock!.close();
  } catch (error) {
    lock?.close();
    throw new PublishError(
      (error as { code?: string }).code === "SQLITE_BUSY"
        ? "publish-busy"
        : "publish-audit-failed",
    );
  }
}

export class GoalPublisher {
  readonly #store: OrchestratorStore;
  readonly #directory: string;
  readonly #checkout: string;
  readonly #provider: PublishProvider;
  readonly #config: PublishConfig;
  readonly #scan: CredentialScanner;
  readonly #polling = new Map<
    string,
    { next: number; delay: number; opened: number; disarmPending: boolean }
  >();
  readonly #retry = new Map<string, { next: number; delay: number }>();
  readonly #screenedHistory = new Map<string, string>();
  readonly #screenedText = new Map<string, string>();
  readonly #reconciledFailures = new Set<string>();
  #stopped = false;
  #cycle: Promise<void> | undefined;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #schedule: ((delay: number) => void) | undefined;
  #wakeRequested = false;
  #cycleDelay = activeCycleDelay;

  constructor(
    store: OrchestratorStore,
    directory: string,
    checkout: string,
    provider: PublishProvider,
    config?: Partial<PublishConfig>,
    scan?: CredentialScanner,
  ) {
    this.#store = store;
    this.#directory = directory;
    this.#checkout = checkout;
    this.#provider = provider;
    this.#config = { ...publishDefaults, ...config };
    this.#scan = scan ?? builtInCredentialScanner;
    store.configureGoalPublishing(config);
  }

  start(signal?: AbortSignal) {
    if (this.#schedule || this.#stopped || signal?.aborted) return;
    const schedule = (delay: number) => {
      if (this.#stopped || signal?.aborted) return;
      this.#timer = setTimeout(run, delay);
      this.#timer.unref();
    };
    const run = () => {
      this.#timer = undefined;
      if (this.#stopped || signal?.aborted) return;
      this.#wakeRequested = false;
      void this.tick()
        .catch(() => {})
        .finally(() => schedule(this.#wakeRequested ? 0 : this.#cycleDelay));
    };
    this.#schedule = schedule;
    run();
  }

  wake() {
    if (!this.#schedule || this.#stopped) return;
    if (this.#timer) {
      clearTimeout(this.#timer);
      this.#schedule(0);
    } else {
      this.#wakeRequested = true;
    }
  }

  async stop() {
    this.#stopped = true;
    clearTimeout(this.#timer);
    await this.#cycle?.catch(() => {});
  }

  tick(now = Date.now()): Promise<void> {
    if (this.#stopped) return Promise.resolve();
    this.#cycle ??= this.#runCycle(now).finally(() => {
      this.#cycle = undefined;
    });
    return this.#cycle;
  }

  async #runCycle(now: number) {
    const optIn = this.#store.goalPublishOptIn(this.#config.enabled);
    this.#cycleDelay = optIn === null ? idleCycleDelay : activeCycleDelay;
    for (const goal of this.#store.listGoals()) {
      if (this.#stopped) return;
      const { id } = goal;
      const record = this.#store.goalPublishRecord(id);
      const opening = record?.pendingMutation?.step === "open-pr";
      if (
        optIn === null &&
        record?.pr?.state !== "merged" &&
        record?.pr?.state !== "open" &&
        !opening
      )
        continue;
      try {
        if ((this.#retry.get(id)?.next ?? 0) > now) continue;
        if (record?.pr?.state === "merged") this.#store.reconcileMergedGoal(id);
        else if (
          opening &&
          (optIn === null || record.failure || goal.status === "cancelled")
        )
          await this.#reconcileFailedMutation(id, optIn === null);
        else await this.#cycleGoal(goal, record, optIn, now);
        this.#retry.delete(id);
      } catch (error) {
        if (
          (error instanceof PublishError ||
            error instanceof OrchestratorStoreError) &&
          transientFailures.has(error.code)
        ) {
          const delay = Math.min(
            (this.#retry.get(id)?.delay ?? activeCycleDelay) * 2,
            60_000,
          );
          this.#retry.set(id, { next: now + delay, delay });
        } else {
          this.#retry.delete(id);
        }
      } finally {
        if (
          optIn === null &&
          this.#store.goalPublishRecord(id)?.pr?.state === "open"
        )
          this.#cycleDelay = activeCycleDelay;
      }
    }
  }

  async #cycleGoal(
    goal: Goal,
    record: GoalPublishRecord | null,
    optIn: number | null,
    now: number,
  ) {
    const { id } = goal;
    if (
      !record?.pr &&
      !record?.manualStart &&
      (optIn === null || !this.#store.goalFinishedAfter(id, optIn))
    )
      return;

    if (record?.pr?.state === "open") {
      const schedule = this.#polling.get(id);
      const safetyCheck =
        disarmPending(goal, record) && !schedule?.disarmPending;
      if (safetyCheck || (schedule?.next ?? 0) <= now) {
        const opened =
          schedule?.opened ??
          Date.parse(
            record.prOpenedAt ?? this.#store.goalPublishOpenedAt(id) ?? "",
          );
        const start = Number.isFinite(opened) ? Math.min(opened, now) : now;
        let changed = false;
        try {
          changed = await this.#poll(goal, record, now, optIn !== null);
        } finally {
          const needsDisarm = disarmPending(
            goal,
            this.#store.goalPublishRecord(id),
          );
          const delay = needsDisarm
            ? Math.min(
                (safetyCheck
                  ? initialPollDelay
                  : (schedule?.delay ?? initialPollDelay)) * 2,
                60_000,
              )
            : now - start >= hour
              ? longPollDelay
              : changed
                ? initialPollDelay
                : Math.min((schedule?.delay ?? initialPollDelay) * 2, 60_000);
          this.#polling.set(id, {
            next: now + delay,
            delay,
            opened: start,
            disarmPending: needsDisarm,
          });
        }
      }
    } else {
      this.#polling.delete(id);
    }
    if (this.#stopped) return;

    const latest = this.#store.goalPublishRecord(id);
    if (latest?.prActionOutcome === "unknown") return;
    if (optIn === null) {
      const setting = this.#store.goalAutoMerge(id);
      if (
        latest?.pr?.state === "open" &&
        latest.pr.autoMerge !== "off" &&
        setting.source === "goal" &&
        setting.method === "off" &&
        latest.autoMergeRevision !== setting.revision
      ) {
        const release = lockPublisher(this.#directory);
        try {
          await this.#disableAutoMerge(
            id,
            latest,
            "setting-change",
            setting.revision,
          );
        } finally {
          release();
        }
      }
      return;
    }
    if (latest?.pr && latest.pr.state !== "open") return;
    if (latest?.pollFailure === "publish-remote-head-changed") return;
    if (
      latest?.failure &&
      latest.pendingMutation &&
      !this.#reconciledFailures.has(id)
    ) {
      try {
        await this.#reconcileFailedMutation(id);
      } catch (error) {
        if (
          (error instanceof PublishError ||
            error instanceof OrchestratorStoreError) &&
          transientFailures.has(error.code)
        )
          throw error;
        this.#reconciledFailures.add(id);
      }
      return;
    }
    if (!this.#eligible(goal, latest)) return;
    if (
      latest?.phase === "auto-merge" &&
      latest.pr &&
      latest.pr.head !== latest.pushedHead
    )
      return;
    const head = this.#store.goalIntegrationHead(id) ?? goal.baseCommit;
    if (!head) return;

    const setting = this.#store.goalAutoMerge(id);
    const changedSetting = this.#needsSettingSync(id, latest, setting);
    const canRetry =
      !latest?.failure ||
      (latest.failure === "auto-merge-unavailable" &&
        (changedSetting || latest.pushedHead !== head));
    if (
      canRetry &&
      (latest?.pushedHead !== head ||
        latest.phase !== "complete" ||
        changedSetting)
    )
      await this.#publish(goal, head, false);
  }

  #needsSettingSync(
    id: string,
    record: GoalPublishRecord | null,
    setting: ReturnType<OrchestratorStore["goalAutoMerge"]>,
  ) {
    return (
      record?.pr?.state === "open" &&
      record.autoMergeRevision !== setting.revision &&
      (setting.method === "off" ||
        record.pr.autoMerge !== "off" ||
        this.#store.goalIsPublishReady(id))
    );
  }

  #eligible(goal: Goal, record: GoalPublishRecord | null) {
    return (
      goal.status !== "cancelled" &&
      (record?.pr?.state === "open" || this.#store.goalIsPublishReady(goal.id))
    );
  }

  async publish(
    id: string,
    expectedHead: string,
    expectedPr?: GoalPublishConfirmationPr,
  ) {
    if (!this.#config.enabled) throw new PublishError("publish-disabled");
    const goal = this.#store.getGoal(id);
    if (!goal) throw new OrchestratorStoreError("not-found");
    await this.#publish(goal, expectedHead, true, expectedPr);
    return publishView(
      this.#config,
      remoteGoalBranch(goal),
      this.#store.goalPublishRecord(goal.id),
      this.#store.goalAutoMerge(goal.id),
      this.#store.goalIntegrationHead(goal.id) ??
        this.#store.getGoal(goal.id)?.baseCommit ??
        null,
    );
  }

  async actOnPullRequest(
    id: string,
    operation: MergeMethod | "close",
    confirm: string,
    origin: "cli" | "operator-ui",
    noChecks = false,
  ) {
    if (origin !== "cli" && origin !== "operator-ui")
      throw new OrchestratorStoreError("approval-forbidden");
    if (operation !== "close" && !mergeMethods.includes(operation))
      throw new OrchestratorStoreError("invalid-transition");
    if (this.#stopped) throw new PublishError("publish-disabled");
    const release = lockPublisher(this.#directory);
    let authorizedGoalId: string | undefined;
    try {
      const goal = this.#store.getGoal(id);
      if (!goal) throw new OrchestratorStoreError("not-found");
      const record = this.#store.goalPublishRecord(goal.id);
      const pr = record?.pr;
      if (!record || pr?.state !== "open" || goal.status === "cancelled")
        throw new OrchestratorStoreError("invalid-transition");
      if (record.prActionOutcome === "unknown")
        throw new PublishError("publish-busy");
      if (goalPrConfirmation(goal.ref, pr, operation) !== confirm)
        throw new OrchestratorStoreError("stale-confirmation");
      if (pr.head !== record.pushedHead)
        throw new PublishError("publish-remote-head-changed");
      const { destination } = record;
      const current = await this.#provider.readPullRequest(
        destination,
        pr.number,
      );
      if (current.number !== pr.number || current.state !== "open")
        throw new OrchestratorStoreError("invalid-transition");
      if (current.head !== record.pushedHead)
        throw new PublishError("publish-remote-head-changed");
      if (operation !== "close") {
        const checks = current.checks ?? "unknown";
        if (checks !== "none" && checks !== "passed")
          throw new PublishError(`publish-checks-${checks}`);
        if (goalPrConfirmation(goal.ref, current, operation) !== confirm)
          throw new OrchestratorStoreError("stale-confirmation");
        if (current.mergeable === "conflict" || current.mergeable === "blocked")
          throw new PublishError("publish-not-mergeable");
        if (checks === "none" && !noChecks)
          throw new PublishError("publish-no-checks");
      }
      if (this.#stopped) throw new PublishError("publish-disabled");
      this.#record(
        goal.id,
        "publish.authorized",
        null,
        {
          step: operation === "close" ? "close-pr" : "merge-pr",
          destination,
          prNumber: pr.number,
          head: pr.head,
          origin,
          ...(operation !== "close" && {
            method: operation,
            ...(current.checks && { checks: current.checks }),
          }),
        },
        {
          head: pr.head,
          requireFinished: operation !== "close",
          prNumber: pr.number,
        },
      );
      authorizedGoalId = goal.id;

      try {
        if (operation === "close")
          await this.#provider.closePullRequest(destination, pr.number);
        else
          await this.#provider.mergePullRequest(
            destination,
            pr.number,
            operation,
            pr.head,
          );
      } catch {
        const code =
          operation === "close"
            ? "publish-close-failed"
            : "publish-merge-failed";
        this.#record(
          goal.id,
          "publish.failed",
          {
            ...record,
            pr: current,
            prActionFailure: { code, at: new Date().toISOString() },
          },
          { code, prNumber: pr.number },
        );
        throw new PublishError(code);
      }

      // A successful merge command can enqueue the PR on a merge-queue base.
      // Only an observed merge may complete the Goal.
      let updated: PublishPullRequest | undefined;
      try {
        updated = await this.#provider.readPullRequest(destination, pr.number);
      } catch {
        // The mutation succeeded. Leave its disposition to the poller.
      }
      let next: GoalPublishRecord;
      if (updated) {
        const outcome =
          updated.state === "merged"
            ? "publish.pr-merged"
            : updated.state === "closed"
              ? "publish.pr-closed"
              : "publish.polled";
        next = await this.#observePr(
          goal.id,
          record,
          updated,
          Date.now(),
          true,
          outcome,
        );
      } else {
        next = {
          ...record,
          pr: current,
          failure: undefined,
          pollFailure: undefined,
          prActionFailure: undefined,
          prActionOutcome: "unknown",
        };
        this.#record(goal.id, "publish.polled", next, {
          outcome: "unknown",
          operation,
          prNumber: pr.number,
        });
      }
      const updatedGoal = this.#store.getGoal(goal.id);
      return {
        ...publishView(
          this.#config,
          remoteGoalBranch(goal),
          next,
          this.#store.goalAutoMerge(goal.id),
          this.#store.goalIntegrationHead(goal.id) ?? goal.baseCommit,
        ),
        ...(next.pr?.state === "merged" &&
          updatedGoal?.status === "done" && { goalCompleted: true as const }),
      };
    } finally {
      if (authorizedGoalId) this.#polling.delete(authorizedGoalId);
      release();
      this.wake();
    }
  }

  #record(
    id: string,
    kind: PublishEventKind,
    record: GoalPublishRecord | null,
    detail: object = {},
    authorization?: PublishAuthorization,
  ) {
    try {
      this.#store.recordGoalPublish(id, kind, record, detail, authorization);
    } catch (error) {
      if (error instanceof OrchestratorStoreError) {
        if (error.code === "export-head-mismatch")
          throw new PublishError("publish-stale-head");
        if (error.code === "stale-confirmation") throw error;
        if (authorization && error.code === "invalid-transition")
          throw new PublishError("publish-not-ready");
      }
      throw new PublishError("publish-audit-failed");
    }
  }

  async #publish(
    goal: Goal,
    head: string,
    manual: boolean,
    expectedPr?: GoalPublishConfirmationPr,
  ) {
    if (this.#stopped) throw new PublishError("publish-disabled");
    const release = lockPublisher(this.#directory);
    try {
      await this.#publishLocked(goal, head, manual, expectedPr);
    } finally {
      release();
    }
  }

  async #publishLocked(
    goal: Goal,
    head: string,
    manual: boolean,
    expectedPr?: GoalPublishConfirmationPr,
  ) {
    const { id } = goal;
    const current = this.#store.getGoal(id);
    let previous = this.#store.goalPublishRecord(id);
    if (
      expectedPr !== undefined &&
      (previous?.pr?.number !== expectedPr?.number ||
        previous?.pr?.state !== expectedPr?.state)
    )
      throw new OrchestratorStoreError("stale-confirmation");
    if (!current || !this.#eligible(current, previous))
      throw new PublishError("publish-not-ready");
    if ((this.#store.goalIntegrationHead(id) ?? current.baseCommit) !== head)
      throw new PublishError("publish-stale-head");
    if (manual && previous?.pr?.state === "closed") {
      const pr = await this.#provider
        .readPullRequest(previous.destination, previous.pr.number)
        .catch((error: unknown) => {
          const code =
            error instanceof PublishError ? error.code : "publish-pr-failed";
          this.#record(
            id,
            "publish.failed",
            { ...previous!, failure: code },
            { code, head },
          );
          throw new PublishError(code);
        });
      if (pr.state !== "closed") {
        previous = await this.#observePr(id, previous, pr, Date.now());
        if (expectedPr?.state === "closed")
          throw new OrchestratorStoreError("stale-confirmation");
        if (pr.state === "merged") return;
      }
    }
    const reopening =
      manual && previous?.pr?.state === "closed" ? previous.pr.number : null;
    if (previous?.pr && previous.pr.state !== "open" && !reopening)
      throw new PublishError("publish-not-ready");
    if (!manual && previous?.failure && previous.phase !== "complete") return;
    const setting = this.#store.goalAutoMerge(id);
    const branch = remoteGoalBranch(goal);
    let record: GoalPublishRecord = {
      ...(previous ?? {
        destination: {
          remote: this.#config.remote,
          base: this.#config.base,
          branch,
          repository: "",
        },
        head,
        phase: "push",
      }),
      ...(manual && { manualStart: true }),
    };
    if (reopening) {
      record = {
        destination: record.destination,
        head: record.head,
        phase: "pr",
        manualStart: true,
        afterPrNumber: reopening,
        ...(record.pushedHead && { pushedHead: record.pushedHead }),
      };
    }
    const save = (
      kind: PublishEventKind,
      changes: Partial<GoalPublishRecord>,
      detail: object = {},
    ) => {
      const next = { ...record, ...changes };
      this.#record(id, kind, next, detail);
      record = next;
    };
    const authorize = (
      mutation: PublishMutation,
      requireFinished: boolean,
      expectedRemoteHead?: string | null,
    ) => {
      const { step } = mutation;
      if (this.#stopped) throw new PublishError("publish-disabled");
      const pending = { ...record, pendingMutation: mutation };
      this.#record(
        id,
        "publish.authorized",
        pending,
        {
          step,
          head: record.head,
          destination: record.destination,
          ...(record.pr && { prNumber: record.pr.number }),
          ...(mutation.step === "auto-merge" && {
            autoMerge: mutation.method,
          }),
          ...(mutation.step === "push" && {
            expectedRemoteHead,
          }),
        },
        {
          head,
          requireFinished,
          ...(record.pr && { autoMergeRevision: setting.revision }),
        },
      );
      record = pending;
    };
    const setAutoMerge = async (method: AutoMerge) => {
      const pr = record.pr!;
      authorize(
        {
          step: "auto-merge",
          method,
          head: pr.head,
          revision: setting.revision,
        },
        method !== "off",
      );
      await this.#provider.setAutoMerge(
        record.destination,
        pr.number,
        method,
        pr.head,
      );
    };
    try {
      const changingSetting = this.#needsSettingSync(id, previous, setting);
      const needsPush = previous?.pushedHead !== head;
      const recovering =
        record.destination.repository && record.phase !== "complete";
      if (
        !needsPush &&
        previous?.phase === "complete" &&
        !changingSetting &&
        !reopening &&
        !(
          manual &&
          (previous.failure || previous.pollFailure || previous.disarmFailure)
        )
      )
        return;

      if (needsPush) {
        let exportPreview;
        try {
          exportPreview = await previewGoalBranchExport(
            this.#store,
            this.#checkout,
            this.#directory,
            id,
            this.#scan,
            (actual) => {
              if (head !== actual) throw new PublishError("publish-stale-head");
            },
            true,
            async (base, to, screen) => {
              const key = `${base}:${to}`;
              if (this.#screenedHistory.get(id) === key) return;
              await screen();
              this.#screenedHistory.set(id, key);
            },
          );
          await exportPreview.apply();
        } catch (error) {
          if (error instanceof PublishError) throw error;
          if (
            error instanceof ClaudeRunError &&
            error.code === "credential-leak"
          )
            throw new PublishError("publish-screen-blocked");
          if (
            error instanceof OrchestratorStoreError &&
            error.code === "integration-uncertain"
          )
            throw new PublishError("publish-busy");
          if (
            error instanceof OrchestratorStoreError &&
            ["write-failed", "goal-export-record-failed"].includes(error.code)
          )
            throw new PublishError("publish-audit-failed");
          if (
            (error instanceof OrchestratorStoreError ||
              error instanceof GitIntegrationError) &&
            ["stale-base", "export-head-mismatch"].includes(error.code)
          )
            throw new PublishError("publish-stale-head");
          if (
            error instanceof GitIntegrationError &&
            (error.code === "branch-checked-out" ||
              error.code === "non-fast-forward" ||
              error.code === "invalid-object" ||
              error.code === "unsafe-repository")
          )
            throw new PublishError(error.code);
          throw new PublishError("publish-export-failed");
        }
      }

      const text = !record.pr
        ? buildGoalPullRequest(this.#store, current, head)
        : undefined;
      if (text) {
        try {
          const key = createHash("sha256")
            .update(JSON.stringify(text))
            .digest("hex");
          if (this.#screenedText.get(id) !== key) {
            await this.#scan(text.title, text.body, ...text.screened);
            this.#screenedText.set(id, key);
          }
        } catch {
          throw new PublishError("publish-screen-blocked");
        }
      }
      const repository = await this.#provider.repository(this.#config.remote);
      const destination = {
        remote: this.#config.remote,
        base: this.#config.base,
        branch,
        repository,
      };
      if (
        record.destination.repository &&
        (repository !== record.destination.repository ||
          destination.remote !== record.destination.remote ||
          destination.base !== record.destination.base)
      )
        throw new PublishError("publish-destination-changed");

      const priorHead = record.head;
      record = { ...record, destination };
      let remoteHead: string | null | undefined;
      if (record.pr) {
        const pr = await this.#provider.readPullRequest(
          destination,
          record.pr.number,
        );
        record = await this.#observePr(id, record, pr, Date.now());
        if (pr.state !== "open") return;
        if (record.pollFailure === "publish-remote-head-changed") {
          if (manual && pr.head === record.pushedHead)
            remoteHead = await this.#provider.remoteHead(destination);
          if (
            !manual ||
            pr.head !== record.pushedHead ||
            remoteHead !== pr.head
          )
            throw new PublishError("publish-remote-head-changed");
          save("publish.polled", { pollFailure: undefined });
        }
      }

      if (remoteHead === undefined && (needsPush || recovering))
        remoteHead = await this.#provider.remoteHead(destination);
      if (recovering && !record.pr) {
        let pr = await this.#provider.findPullRequest(
          destination,
          priorHead,
          record.afterPrNumber,
        );
        if (!pr && manual && !reopening && record.afterPrNumber) {
          const original = await this.#provider.readPullRequest(
            destination,
            record.afterPrNumber,
          );
          if (original.state !== "closed") pr = original;
        }
        if (pr) {
          save("publish.pr-opened", {
            pr,
            ...(record.pendingMutation?.step === "open-pr" && {
              pendingMutation: undefined,
            }),
            prOpenedAt: new Date().toISOString(),
            lastCheckedAt: new Date().toISOString(),
          });
          record = await this.#observePr(id, record, pr, Date.now());
          if (pr.state !== "open") return;
        }
      }
      const pendingPush =
        record.pendingMutation?.step === "push"
          ? (record.pendingMutation.head ?? record.head)
          : undefined;
      if (pendingPush && remoteHead === pendingPush) {
        save(
          "publish.pushed",
          {
            head: pendingPush,
            pushedHead: pendingPush,
            pendingMutation: undefined,
            phase: record.pr ? "auto-merge" : "pr",
          },
          { recovered: true },
        );
      }
      record = {
        ...record,
        head,
        failure: undefined,
        autoMergeUnavailable: undefined,
      };

      const recreateBranch =
        !record.pr && record.afterPrNumber !== undefined && remoteHead === null;
      if (record.pushedHead !== head || recreateBranch) {
        const expected = recreateBranch ? null : (record.pushedHead ?? null);
        if (remoteHead !== expected) {
          if (record.pr && remoteHead)
            record = await this.#observePr(
              id,
              record,
              { ...record.pr, head: remoteHead },
              Date.now(),
            );
          throw new PublishError("publish-remote-head-changed");
        }
        if (expected && record.pr && record.pr.head !== expected) {
          this.#polling.delete(id);
          return;
        }

        record = { ...record, phase: "push" };
        record = await this.#disableAutoMerge(id, record, "before-push");

        authorize({ step: "push", head }, !record.pr, expected);
        await this.#provider.push(destination, head, expected);
        save("publish.pushed", {
          pushedHead: head,
          pendingMutation: undefined,
          phase: record.pr ? "auto-merge" : "pr",
        });
        if (record.pr) {
          const pr = await this.#provider.readPullRequest(
            destination,
            record.pr.number,
          );
          record = await this.#observePr(id, record, pr, Date.now());
          if (record.pollFailure === "publish-remote-head-changed")
            throw new PublishError("publish-remote-head-changed");
        }
      } else if (recovering && record.phase === "pr" && remoteHead !== head) {
        throw new PublishError(
          record.afterPrNumber
            ? "publish-remote-head-changed"
            : "publish-destination-changed",
        );
      }

      if (!record.pr) {
        let pr = await this.#provider.findPullRequest(
          destination,
          recovering ? head : undefined,
          record.afterPrNumber,
        );
        if (!pr) {
          record = { ...record, phase: "pr" };
          authorize({ step: "open-pr" }, true);
          await this.#provider.openPullRequest(
            destination,
            text!.title,
            text!.body,
          );
          pr = await this.#provider.findPullRequest(
            destination,
            head,
            record.afterPrNumber,
          );
          if (!pr) throw new PublishError("publish-pr-failed");
        }
        save("publish.pr-opened", {
          pr,
          pendingMutation: undefined,
          phase: "auto-merge",
          lastCheckedAt: new Date().toISOString(),
          prOpenedAt: new Date().toISOString(),
        });
      }

      const pr = record.pr!;
      if (pr.state !== "open") return;
      if (pr.head !== head) {
        record = await this.#observePr(id, record, pr, Date.now());
        if (record.pollFailure === "publish-remote-head-changed")
          throw new PublishError("publish-remote-head-changed");
        this.#polling.delete(id);
        return;
      }
      const ready = this.#store.goalIsPublishReady(id);
      const method =
        ready || pr.autoMerge === setting.method ? setting.method : "off";
      if (pr.autoMerge !== method) {
        record = { ...record, phase: "auto-merge" };
        if (pr.autoMerge !== "off")
          record = await this.#disableAutoMerge(id, record, "setting-change");
        if (method !== "off") await setAutoMerge(method);
      }
      if (record.phase !== "complete" || changingSetting || previous?.failure) {
        save(
          "publish.auto-merge-set",
          {
            pr: { ...pr, autoMerge: method },
            phase: "complete",
            pendingMutation: undefined,
            autoMergeRevision:
              method === setting.method ? setting.revision : undefined,
          },
          { method },
        );
      }
    } catch (error) {
      if (
        error instanceof OrchestratorStoreError &&
        error.code === "stale-confirmation"
      )
        throw error;
      const code =
        error instanceof PublishError ? error.code : "publish-pr-failed";
      if (code === "auto-merge-unavailable") {
        save(
          "publish.auto-merge-unavailable",
          {
            autoMergeUnavailable: true,
            pendingMutation: undefined,
            phase: "complete",
            autoMergeRevision: setting.revision,
          },
          { code, head },
        );
        return;
      }
      if (
        !transientFailures.has(code) &&
        !(
          code === "publish-remote-head-changed" && record.pollFailure === code
        ) &&
        code !== "publish-disabled" &&
        code !== "publish-not-ready"
      ) {
        save(
          "publish.failed",
          {
            failure: code,
            ...(reopening &&
              previous?.pr &&
              !record.pr &&
              (!record.pendingMutation ||
                code === "publish-non-fast-forward") && { pr: previous.pr }),
            ...(code === "publish-non-fast-forward" && {
              pendingMutation: undefined,
            }),
          },
          { code, head },
        );
      }
      throw new PublishError(code);
    }
  }

  /** A command can time out after GitHub accepted it. Probe once per launcher
   * before leaving a failed operation for a manual retry. */
  async #reconcileFailedMutation(id: string, readOnly = false) {
    const release = lockPublisher(this.#directory);
    try {
      const record = this.#store.goalPublishRecord(id);
      const pending = record?.pendingMutation;
      if (!record || !pending) return;
      const { destination, head } = record;
      if (pending.step === "open-pr") {
        let pr;
        try {
          pr = await this.#provider.findPullRequest(
            destination,
            head,
            record.afterPrNumber,
          );
          if (!pr && record.afterPrNumber) {
            const original = await this.#provider.readPullRequest(
              destination,
              record.afterPrNumber,
            );
            if (original.state !== "closed") pr = original;
          }
        } catch {
          throw new PublishError("publish-poll-failed");
        }
        const now = Date.now();
        const next: GoalPublishRecord = {
          ...record,
          pendingMutation: undefined,
        };
        if (pr) {
          const recovered: GoalPublishRecord = {
            ...next,
            failure: undefined,
            pr,
            phase: "auto-merge",
            prOpenedAt: new Date(now).toISOString(),
            lastCheckedAt: new Date(now).toISOString(),
          };
          this.#record(id, "publish.pr-opened", recovered, { recovered: true });
          await this.#observePr(id, recovered, pr, now, !readOnly);
        } else {
          this.#record(id, "publish.polled", next, { recovered: false });
        }
        return;
      }
      if (!record.failure || readOnly) return;
      const remoteHead = await this.#provider.remoteHead(destination);
      const pr = record.pr
        ? await this.#provider.readPullRequest(destination, record.pr.number)
        : await this.#provider.findPullRequest(
            destination,
            head,
            record.afterPrNumber,
          );
      const next = {
        ...record,
        failure: undefined,
        pendingMutation: undefined,
      };
      if (pending.step === "push" && remoteHead === (pending.head ?? head)) {
        this.#record(
          id,
          "publish.pushed",
          {
            ...next,
            head: pending.head ?? head,
            pushedHead: pending.head ?? head,
            phase: record.pr ? "auto-merge" : "pr",
          },
          { recovered: true },
        );
      }
      if (pending.step === "auto-merge" && pr && pr.head === pending.head) {
        if (pr.state !== "open") {
          this.#record(
            id,
            "publish.polled",
            {
              ...next,
              pr,
              phase: "complete",
              lastCheckedAt: new Date().toISOString(),
            },
            { recovered: true },
          );
        } else if (pr.autoMerge === pending.method) {
          const setting = this.#store.goalAutoMerge(id);
          this.#record(
            id,
            "publish.auto-merge-set",
            {
              ...next,
              pr,
              lastCheckedAt: new Date().toISOString(),
              phase: record.phase === "push" ? "push" : "auto-merge",
              ...(setting.method === pending.method && {
                autoMergeRevision: pending.revision,
              }),
            },
            { recovered: true, method: pending.method },
          );
        }
      }
      this.#reconciledFailures.add(id);
    } finally {
      release();
    }
  }

  async #disableAutoMerge(
    id: string,
    record: GoalPublishRecord,
    reason: string,
    revision?: number,
  ) {
    const { pr, destination } = record;
    if (!pr || pr.state !== "open" || pr.autoMerge === "off") return record;
    if (this.#stopped) throw new PublishError("publish-disabled");
    // Disabling on this exact recorded PR is safe even if the Goal was
    // cancelled, the local journal moved, or someone changed the remote head.
    this.#record(id, "publish.authorized", null, {
      step: "auto-merge",
      destination,
      prNumber: pr.number,
      head: pr.head,
      autoMerge: "off",
      reason,
    });
    try {
      await this.#provider.setAutoMerge(destination, pr.number, "off", pr.head);
    } catch {
      const code = "auto-merge-disarm-failed";
      if (!record.disarmFailure)
        this.#record(
          id,
          "publish.failed",
          { ...record, disarmFailure: code },
          { code, reason },
        );
      throw new PublishError(code);
    }
    const next = {
      ...record,
      pr: { ...pr, autoMerge: "off" as const },
      autoMergeRevision: revision,
      disarmFailure: undefined,
    };
    this.#record(id, "publish.auto-merge-set", next, { method: "off", reason });
    return next;
  }

  async #observePr(
    id: string,
    record: GoalPublishRecord,
    pr: PublishPullRequest,
    now: number,
    canDisarmForeign = true,
    manualOutcome?: PublishEventKind,
  ) {
    // During a push the PR view may still report the immediately preceding head.
    const foreign =
      pr.state === "open" &&
      record.pushedHead !== undefined &&
      pr.head !== record.pushedHead &&
      !(
        record.phase === "auto-merge" &&
        pr.head === this.#store.goalPreviousPushedHead(id)
      ) &&
      !(
        record.phase === "push" &&
        record.pendingMutation?.step === "push" &&
        pr.head === (record.pendingMutation.head ?? record.head)
      );
    // A confirmed manual publish clears the pause after both heads agree.
    const pollFailure =
      pr.state === "open" &&
      (foreign || record.pollFailure === "publish-remote-head-changed")
        ? ("publish-remote-head-changed" as const)
        : undefined;
    const failure =
      pr.state === "open" && !manualOutcome ? record.failure : undefined;
    const autoMergeUnavailable =
      pr.state === "open" && pr.autoMerge === "off"
        ? record.autoMergeUnavailable
        : undefined;
    const disarmFailure =
      pr.state === "open" && pr.autoMerge !== "off"
        ? record.disarmFailure
        : undefined;
    const previous = record.pr;
    let next = record;
    if (
      manualOutcome ||
      record.prActionFailure ||
      record.prActionOutcome ||
      pr.state !== previous?.state ||
      pr.head !== previous?.head ||
      pr.checks !== previous?.checks ||
      pr.mergeable !== previous?.mergeable ||
      pr.review !== previous?.review ||
      pr.additions !== previous?.additions ||
      pr.deletions !== previous?.deletions ||
      pr.changedFiles !== previous?.changedFiles ||
      JSON.stringify(pr.checkRuns) !== JSON.stringify(previous?.checkRuns) ||
      pr.checkCounts?.pass !== previous?.checkCounts?.pass ||
      pr.checkCounts?.pending !== previous?.checkCounts?.pending ||
      pr.checkCounts?.fail !== previous?.checkCounts?.fail ||
      pr.autoMerge !== previous?.autoMerge ||
      failure !== record.failure ||
      autoMergeUnavailable !== record.autoMergeUnavailable ||
      pollFailure !== record.pollFailure ||
      disarmFailure !== record.disarmFailure
    ) {
      next = {
        ...record,
        pr,
        prActionFailure: undefined,
        prActionOutcome: undefined,
        failure,
        autoMergeUnavailable,
        pollFailure,
        disarmFailure,
        ...(foreign && { autoMergeRevision: undefined }),
        lastCheckedAt: new Date(now).toISOString(),
      };
      this.#record(
        id,
        foreign ? "publish.failed" : (manualOutcome ?? "publish.polled"),
        next,
        foreign ? { code: pollFailure } : {},
      );
    }
    const cancelled = this.#store.getGoal(id)?.status === "cancelled";
    if ((pollFailure && canDisarmForeign) || cancelled)
      next = await this.#disableAutoMerge(
        id,
        next,
        cancelled ? "goal-cancelled" : "remote-head-changed",
      );
    return next;
  }

  async #poll(
    goal: Goal,
    record: GoalPublishRecord,
    now: number,
    canDisarmForeign: boolean,
  ) {
    const release = lockPublisher(this.#directory);
    try {
      const latest = this.#store.goalPublishRecord(goal.id);
      if (
        latest?.pr?.state !== "open" ||
        latest.pr.number !== record.pr?.number
      )
        return false;
      let pr;
      try {
        pr = await this.#provider.readPullRequest(
          latest.destination,
          latest.pr.number,
        );
      } catch {
        if (latest.pollFailure === undefined && !latest.prActionOutcome)
          this.#record(
            goal.id,
            "publish.failed",
            {
              ...latest,
              lastCheckedAt: new Date(now).toISOString(),
              pollFailure: "publish-poll-failed",
            },
            { code: "publish-poll-failed" },
          );
        return false;
      }
      try {
        return (
          (await this.#observePr(
            goal.id,
            latest,
            pr,
            now,
            canDisarmForeign,
          )) !== latest
        );
      } catch (error) {
        if (
          error instanceof PublishError &&
          error.code === "auto-merge-disarm-failed"
        )
          return false;
        throw error;
      }
    } finally {
      release();
    }
  }
}
