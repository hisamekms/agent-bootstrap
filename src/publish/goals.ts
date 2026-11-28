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
  PublishError,
  type AutoMerge,
  type PublishConfig,
  type PublishProvider,
  type PublishPullRequest,
} from "./port.ts";

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
  "publish-stale-head",
  "stale-confirmation",
  "auto-merge-disarm-failed",
]);

function prTitle(title: string) {
  const line = title
    .replace(/\s+/gu, " ")
    .replace(/[\p{Cc}\p{Cf}]/gu, "")
    .replace(/ +/g, " ")
    .trim()
    .replace(
      /(^|[^\p{L}\p{N}_])([@#])(?=[\p{L}\p{N}_])/gu,
      (_, prefix, marker) => prefix + (marker === "@" ? "＠" : "＃"),
    );
  return Array.from(line).slice(0, 200).join("").trimEnd();
}
const maxBodyBytes = 24 * 1024;

function prText(store: OrchestratorStore, goal: Goal, head: string) {
  const { title, description, acceptance } = goal.content;
  const evidence = store.goalPublishEvidence(goal.id);
  // Indent model text so Markdown, mentions and images are displayed as text.
  const block = (value: string) => value.replace(/^/gm, "    ");
  const tasks = store.listTasks(goal.id);
  const summary = `

## Verification and review

Verification: ${evidence.verificationPassed} passed, ${evidence.verificationFailed} failed.
Review: ${evidence.reviewPassed} passed, ${evidence.reviewRevised} requested revision.

## Audit references

Goal: ${goal.id}
Export head: ${head}
`;
  const note = "\n\nSome text was shortened to fit.";
  const descriptionPreview = boundedText(block(description), 6000);
  const acceptancePreviews = acceptance.map((item) =>
    boundedText(block(`- ${item}`), 300),
  );
  const intro = `## Goal

${descriptionPreview}

## Acceptance

${acceptancePreviews.join("\n")}

## Tasks

`;
  let truncated =
    descriptionPreview !== block(description) ||
    acceptancePreviews.some(
      (item, index) => item !== block(`- ${acceptance[index]}`),
    );
  let bytes = Buffer.byteLength(intro + summary + note);
  // Screen the full Goal text and every Task title, including shortened text.
  const screened = [title, description, ...acceptance];
  const lines: string[] = [];
  for (const task of tasks) {
    const line = block(`${task.ref} ${task.content.title} (${task.status})`);
    screened.push(line);
    if (bytes + Buffer.byteLength(line) + 1 > maxBodyBytes) {
      truncated = true;
      continue;
    }
    bytes += Buffer.byteLength(line) + 1;
    lines.push(line);
  }
  const body =
    intro +
    (lines.length ? lines.join("\n") : "No integrated Tasks listed.") +
    (truncated ? note : "") +
    summary;
  return { title: prTitle(title) || `Goal ${goal.ref}`, body, screened };
}

function boundedText(value: string, bytes: number) {
  if (Buffer.byteLength(value) <= bytes) return value;
  // Drop a partial trailing UTF-8 character.
  return Buffer.from(value)
    .subarray(0, bytes)
    .toString("utf8")
    .replace(/\uFFFD$/, "");
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
      if (optIn === null && !disarmPending(goal, record)) continue;
      try {
        if ((this.#retry.get(id)?.next ?? 0) > now) continue;
        await this.#cycleGoal(goal, record, optIn, now);
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
          disarmPending(goal, this.#store.goalPublishRecord(id))
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
          changed = await this.#poll(goal, record, now);
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
    if (this.#stopped || optIn === null) return;

    const latest = this.#store.goalPublishRecord(id);
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

  async publish(id: string, expectedHead: string) {
    if (!this.#config.enabled) throw new PublishError("publish-disabled");
    const goal = this.#store.getGoal(id);
    if (!goal) throw new OrchestratorStoreError("not-found");
    await this.#publish(goal, expectedHead, true);
    return publishView(
      true,
      remoteGoalBranch(goal),
      this.#store.goalPublishRecord(goal.id),
      this.#store.goalAutoMerge(goal.id),
      this.#store.goalIntegrationHead(goal.id) ??
        this.#store.getGoal(goal.id)?.baseCommit ??
        null,
    );
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

  async #publish(goal: Goal, head: string, manual: boolean) {
    if (this.#stopped) throw new PublishError("publish-disabled");
    const release = lockPublisher(this.#directory);
    try {
      await this.#publishLocked(goal, head, manual);
    } finally {
      release();
    }
  }

  async #publishLocked(goal: Goal, head: string, manual: boolean) {
    const { id } = goal;
    const current = this.#store.getGoal(id);
    const previous = this.#store.goalPublishRecord(id);
    if (!current || !this.#eligible(current, previous))
      throw new PublishError("publish-not-ready");
    if ((this.#store.goalIntegrationHead(id) ?? current.baseCommit) !== head)
      throw new PublishError("publish-stale-head");
    if (previous?.pr && previous.pr.state !== "open") return;
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
    const save = (
      kind: PublishEventKind,
      changes: Partial<GoalPublishRecord>,
      detail: object = {},
    ) => {
      const next = { ...record, ...changes };
      this.#record(id, kind, next, detail);
      record = next;
    };
    const authorize = (mutation: PublishMutation, requireFinished: boolean) => {
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
            expectedRemoteHead: record.pushedHead ?? null,
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
        previous?.destination.repository && previous.phase !== "complete";
      if (
        !needsPush &&
        previous?.phase === "complete" &&
        !changingSetting &&
        !(
          manual &&
          (previous.failure ||
            previous.pollFailure === "publish-remote-head-changed")
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

      const text = !record.pr ? prText(this.#store, current, head) : undefined;
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
        const pr = await this.#provider.findPullRequest(destination, priorHead);
        if (pr) {
          save("publish.pr-opened", {
            pr,
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
      record = { ...record, head, failure: undefined };

      if (record.pushedHead !== head) {
        const expected = record.pushedHead ?? null;
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

        authorize({ step: "push", head }, !record.pr);
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
        throw new PublishError("publish-destination-changed");
      }

      if (!record.pr) {
        let pr = await this.#provider.findPullRequest(
          destination,
          recovering ? head : undefined,
        );
        if (!pr) {
          record = { ...record, phase: "pr" };
          authorize({ step: "open-pr" }, true);
          await this.#provider.openPullRequest(
            destination,
            text!.title,
            text!.body,
          );
          pr = await this.#provider.findPullRequest(destination, head);
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
      if (record.phase !== "complete" || changingSetting || record.failure) {
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
            ...((code === "auto-merge-unavailable" ||
              code === "publish-non-fast-forward") && {
              pendingMutation: undefined,
            }),
            ...(code === "auto-merge-unavailable" && {
              phase: "complete" as const,
              autoMergeRevision: setting.revision,
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
  async #reconcileFailedMutation(id: string) {
    const release = lockPublisher(this.#directory);
    try {
      const record = this.#store.goalPublishRecord(id);
      const pending = record?.pendingMutation;
      if (!record?.failure || !pending) return;
      const { destination, head } = record;
      const remoteHead = await this.#provider.remoteHead(destination);
      const pr = record.pr
        ? await this.#provider.readPullRequest(destination, record.pr.number)
        : await this.#provider.findPullRequest(destination, head);
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
      if (pending.step === "open-pr" && pr?.head === head) {
        this.#record(
          id,
          "publish.pr-opened",
          {
            ...next,
            pr,
            phase: "auto-merge",
            prOpenedAt: new Date().toISOString(),
            lastCheckedAt: new Date().toISOString(),
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
      autoMergeRevision: undefined,
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
      foreign || record.pollFailure === "publish-remote-head-changed"
        ? ("publish-remote-head-changed" as const)
        : undefined;
    const disarmFailure =
      pr.state === "open" && pr.autoMerge !== "off"
        ? record.disarmFailure
        : undefined;
    const previous = record.pr;
    let next = record;
    if (
      pr.state !== previous?.state ||
      pr.head !== previous?.head ||
      pr.checks !== previous?.checks ||
      pr.autoMerge !== previous?.autoMerge ||
      pollFailure !== record.pollFailure ||
      disarmFailure !== record.disarmFailure
    ) {
      next = {
        ...record,
        pr,
        pollFailure,
        disarmFailure,
        ...(foreign && { autoMergeRevision: undefined }),
        lastCheckedAt: new Date(now).toISOString(),
      };
      this.#record(
        id,
        foreign ? "publish.failed" : "publish.polled",
        next,
        foreign ? { code: pollFailure } : {},
      );
    }
    const cancelled = this.#store.getGoal(id)?.status === "cancelled";
    if (pollFailure || cancelled)
      next = await this.#disableAutoMerge(
        id,
        next,
        cancelled ? "goal-cancelled" : "remote-head-changed",
      );
    return next;
  }

  async #poll(goal: Goal, record: GoalPublishRecord, now: number) {
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
        if (latest.pollFailure === undefined)
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
        return (await this.#observePr(goal.id, latest, pr, now)) !== latest;
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
