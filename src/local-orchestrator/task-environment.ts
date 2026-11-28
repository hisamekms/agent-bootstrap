import { diffPackages, parseBunLock } from "../environments/lock.ts";
import { emptyPackageDiff } from "../environments/events.ts";
import {
  foldTreePath,
  parseLsTree,
  type TreeEntry,
} from "../workspace-tree.ts";
import type { CredentialScanner } from "./credential-scan.ts";
import { DeclarationError } from "../environments/declarations.ts";
import type { ProfileName } from "../sandbox-profiles.ts";
import { randomUUID } from "node:crypto";
import { setTimeout } from "node:timers/promises";
import {
  EnvironmentError,
  identifyEnvironment,
  type EnvironmentOperation,
} from "../environments/adapter.ts";
import {
  checkEnvironmentTree,
  validateEnvironmentArchive,
} from "../environments/archive.ts";
import {
  allowsEmptyLock,
  bunAdapter,
  hasBunLayout,
} from "../environments/bun.ts";
import {
  provisionEnvironment,
  type ProvisionerHost,
} from "../environments/provisioner.ts";
import {
  GitIntegrationError,
  LocalGitIntegration,
  type TreeChange,
} from "../git-integration.ts";
import type { ProfileLockEntry } from "../profile-lock.ts";
import type {
  EnsureTaskEnvironment,
  PinnedCandidate,
} from "../reviewed-integration.ts";
import { allowsPath, type DeclaredEnvironmentUpdate } from "./model.ts";
import type { OrchestratorStore } from "./store.ts";

const buildWaitMs = 5 * 60 * 1000;

export type TaskEnvironmentOptions = {
  readonly profile: ProfileLockEntry | undefined;
  readonly autoBuild?: boolean;
  readonly allow: readonly string[];
  readonly host: ProvisionerHost;
  readonly requireAudit: (executionId: string) => void;
};

/** Read the candidate cache entry selected by Verification without provisioning it. */
export async function hostCheckArchiveDigest(
  options: TaskEnvironmentOptions | undefined,
  repository: string,
  candidate: string,
  verificationProfile: ProfileName | undefined,
): Promise<string | null> {
  if (!options || verificationProfile !== "bun") return null;
  const tree = await LocalGitIntegration.committedTree(repository, candidate);
  if (!hasBunLayout(tree)) return null;
  if (!options.profile) throw new EnvironmentError("env-missing");
  const { key } = await identifyEnvironment(
    tree,
    options.profile.image.slice(-64),
    bunAdapter,
  );
  return options.host.store.archiveDigest(key);
}

async function withBuildSlot<T>(host: ProvisionerHost, run: () => Promise<T>) {
  const deadline = performance.now() + buildWaitMs;
  let unlock = host.store.tryLockBuild();
  while (!unlock) {
    const remaining = deadline - performance.now();
    if (remaining <= 0 || host.signal?.aborted) throw new EnvironmentError();
    await setTimeout(Math.min(100, remaining), undefined, {
      signal: host.signal,
    }).catch(() => {
      throw new EnvironmentError();
    });
    if (performance.now() >= deadline) throw new EnvironmentError();
    unlock = host.store.tryLockBuild();
  }
  try {
    return await run();
  } finally {
    unlock();
  }
}

export function taskEnvironment(
  options: TaskEnvironmentOptions,
  journal: Pick<OrchestratorStore, "recordTaskEnvironment">,
  repository: string,
) {
  const ensure: EnsureTaskEnvironment = async ({
    commit,
    profile,
    executionId,
  }) => {
    if (!executionId) throw new EnvironmentError();
    const { host } = options;
    options.requireAudit(executionId);
    const invocationId = randomUUID();
    const started = performance.now();
    let key: string | undefined;
    let cacheHit = false;
    let release: (() => void) | undefined;
    let recordedStart = false;
    try {
      if (profile !== "bun" || !options.profile) throw new EnvironmentError();
      const tree = await LocalGitIntegration.committedTree(repository, commit);
      const identity = await identifyEnvironment(
        tree,
        options.profile.image.slice(-64),
        bunAdapter,
      );
      key = identity.key;
      const { outputs, linkTargets, pathEntries } = identity.layout;
      const checkTree = () =>
        checkEnvironmentTree(
          outputs,
          tree.paths.map((path) => ({ path, directory: false })),
        );
      const holdCached = () => {
        if (!host.store.get(identity.key)) return;
        try {
          release = host.store.hold(identity.key);
          cacheHit = true;
        } catch (error) {
          // Pruning can remove the entry between the lookup and the hold.
          if (host.store.get(identity.key)) throw error;
        }
      };
      holdCached();
      journal.recordTaskEnvironment(executionId, {
        kind: "environment.started",
        invocationId,
        key,
        cacheHit,
      });
      recordedStart = true;
      if (!cacheHit) {
        if (options.autoBuild !== true)
          throw new EnvironmentError("env-missing");
        checkTree();
        await withBuildSlot(host, async () => {
          holdCached();
          if (!cacheHit) {
            options.requireAudit(executionId);
            const result = await provisionEnvironment(
              {
                tree,
                profile: options.profile!,
                operation: "build",
                allow: options.allow,
              },
              { ...host, invocationId },
            );
            if (result.key !== identity.key || !result.manifest)
              throw new EnvironmentError();
            cacheHit = result.cacheHit;
            release = host.store.hold(identity.key);
          }
        });
      }
      release ??= host.store.hold(key);
      const archive = validateEnvironmentArchive(
        host.store.readArchive(key),
        outputs,
        undefined,
        linkTargets,
      );
      checkTree();
      options.requireAudit(executionId);
      journal.recordTaskEnvironment(executionId, {
        kind: "environment.finished",
        invocationId,
        key,
        cacheHit,
        durationMs: Math.round(performance.now() - started),
        size: archive.byteLength,
      });
      return {
        environment: { archive, outputs, linkTargets, pathEntries },
        release,
      };
    } catch (error) {
      release?.();
      const failure =
        error instanceof EnvironmentError ? error.code : "env-build-failed";
      if (!recordedStart)
        journal.recordTaskEnvironment(executionId, {
          kind: "environment.started",
          invocationId,
          ...(key ? { key } : {}),
          cacheHit,
        });
      journal.recordTaskEnvironment(executionId, {
        kind: "environment.finished",
        invocationId,
        ...(key ? { key } : {}),
        cacheHit,
        durationMs: Math.round(performance.now() - started),
        size: 0,
        failure,
      });
      if (!key && !(error instanceof EnvironmentError))
        throw new EnvironmentError(failure);
      throw error;
    }
  };

  async function mutate(
    commit: string,
    executionId: string,
    operation: Extract<EnvironmentOperation, "resolve" | "update">,
    update?: DeclaredEnvironmentUpdate,
  ) {
    if (options.autoBuild !== true)
      throw new EnvironmentError(
        operation === "update" ? "env-update-disabled" : "env-missing",
      );
    const { host, profile } = options;
    options.requireAudit(executionId);
    if (!profile) throw new EnvironmentError();
    const tree = await LocalGitIntegration.committedTree(repository, commit);
    const { key } = await identifyEnvironment(
      tree,
      profile.image.slice(-64),
      bunAdapter,
    );
    const invocationId = randomUUID();
    const started = performance.now();
    journal.recordTaskEnvironment(executionId, {
      kind: "environment.started",
      invocationId,
      key,
      operation,
      cacheHit: false,
    });
    let failure: EnvironmentError | undefined;
    let result: Awaited<ReturnType<typeof provisionEnvironment>> | undefined;
    try {
      result = await withBuildSlot(host, () => {
        options.requireAudit(executionId);
        return provisionEnvironment(
          {
            tree,
            profile,
            operation,
            allow: options.allow,
            ...(update && {
              names: update.packages === "all" ? [] : update.packages,
              allowMajor: update.allowMajor,
            }),
          },
          { ...host, invocationId },
        );
      });
      options.requireAudit(executionId);
    } catch (error) {
      failure =
        error instanceof EnvironmentError ? error : new EnvironmentError();
    }
    journal.recordTaskEnvironment(executionId, {
      kind: "environment.finished",
      invocationId,
      key,
      operation,
      cacheHit: false,
      durationMs: Math.round(performance.now() - started),
      size: result?.size ?? 0,
      ...(failure
        ? { failure: failure.code }
        : {
            ...(operation === "update" && { packageDiff: result!.packageDiff }),
          }),
    });
    if (failure) throw failure;
    return { ...result!, invocationId };
  }

  return Object.assign(ensure, { mutate });
}

async function treeEntries(git: LocalGitIntegration, commit: string) {
  return parseLsTree(await git.listTree(commit));
}

function sameEntry(a: TreeEntry | undefined, b: TreeEntry | undefined) {
  return a?.oid === b?.oid && a?.mode === b?.mode;
}

/** Detect path conflicts without running a merge driver or interpreting a lock as text. */
async function replayPlan(
  git: LocalGitIntegration,
  pin: Pick<PinnedCandidate, "base" | "candidate">,
  head: string,
) {
  const [old, next, current] = await Promise.all([
    treeEntries(git, pin.base),
    treeEntries(git, pin.candidate),
    treeEntries(git, head),
  ]);
  const changedUpstream = [
    ...new Set([...old.keys(), ...current.keys()]),
  ].filter((path) => !sameEntry(old.get(path), current.get(path)));
  const upstream = new Set(changedUpstream.map(foldTreePath));
  const parentPaths = (path: string) => {
    const parents: string[] = [];
    for (
      let end = path.indexOf("/");
      end !== -1;
      end = path.indexOf("/", end + 1)
    )
      parents.push(path.slice(0, end));
    return parents;
  };
  const changedDirectories = new Set([...upstream].flatMap(parentPaths));
  const paths = [...new Set([...old.keys(), ...next.keys()])].filter(
    (path) =>
      !sameEntry(old.get(path), next.get(path)) &&
      !sameEntry(next.get(path), current.get(path)),
  );
  const conflicts = paths.filter((path) => {
    const folded = foldTreePath(path);
    return (
      upstream.has(folded) ||
      changedDirectories.has(folded) ||
      parentPaths(folded).some((parent) => upstream.has(parent))
    );
  });
  const lock = bunAdapter.lockPath;
  return {
    paths,
    conflicts,
    next,
    derivedLockConflict:
      conflicts.length === 1 &&
      conflicts[0] === lock &&
      changedUpstream.includes(lock) &&
      !changedDirectories.has(foldTreePath(lock)),
  };
}

async function replayChanges(
  git: LocalGitIntegration,
  plan: Awaited<ReturnType<typeof replayPlan>>,
  excluded?: string,
) {
  const changes: TreeChange[] = [];
  let remaining = 256 * 1024 * 1024;
  for (const path of plan.paths) {
    if (path === excluded) continue;
    const entry = plan.next.get(path);
    if (!entry) changes.push({ path, deleted: true });
    else {
      const bytes = await git.treeBlob(entry.oid, Math.max(1, remaining));
      remaining -= bytes.byteLength;
      if (remaining < 0) throw new EnvironmentError();
      changes.push({ path, mode: entry.mode, bytes });
    }
  }
  return changes;
}

export async function hasDerivedLockConflict(
  git: LocalGitIntegration,
  pin: Pick<PinnedCandidate, "base" | "candidate">,
  head: string,
) {
  return (await replayPlan(git, pin, head)).derivedLockConflict;
}

export function taskEnvironmentPlan({
  options: envOptions,
  repository,
  git,
  task,
  store,
  verificationProfile,
  scan,
}: {
  options: TaskEnvironmentOptions | undefined;
  repository: string;
  git: LocalGitIntegration;
  task: NonNullable<ReturnType<OrchestratorStore["claimTask"]>>;
  store: OrchestratorStore;
  verificationProfile: ProfileName | undefined;
  scan: CredentialScanner | undefined;
}) {
  const { paths, environment: declaration } = task.content;
  const environment =
    envOptions && taskEnvironment(envOptions, store, repository);
  const autoBuild = envOptions?.autoBuild === true;
  const stale =
    autoBuild && environment && task.retries > 0
      ? store.taskLockConflict(task.id, task.retries)
      : undefined;
  const assertAllowed = (changed: readonly string[]) => {
    if (changed.some((path) => !allowsPath(paths, path)))
      throw new EnvironmentError("env-lock-mismatch");
  };
  const requireEnvironment = () => {
    if (!environment || !autoBuild)
      throw new EnvironmentError("env-update-disabled");
    return environment;
  };
  const writeEnvironment = async (
    base: string,
    startingTree: string,
    result: Awaited<ReturnType<NonNullable<typeof environment>["mutate"]>>,
    message: string,
  ) => {
    const changed = result.changedPaths ?? [];
    if (!changed.length) return startingTree;
    assertAllowed(changed);
    const entries = await treeEntries(git, startingTree);
    const changes: TreeChange[] = changed.map((path) => {
      const bytes =
        path === bunAdapter.lockPath
          ? result.lock
          : result.declarations?.get(path);
      return bytes
        ? {
            path,
            bytes,
            mode: entries.get(path)?.mode === "100755" ? "100755" : "100644",
          }
        : { path, deleted: true };
    });
    await scan?.(
      ...changes.flatMap((change) =>
        "deleted" in change ? [change.path] : [change.path, change.bytes],
      ),
    );
    const details = `Agent-Bootstrap-Provisioner-Paths: ${JSON.stringify(changed)}
Agent-Bootstrap-Provisioner-Run: ${result.invocationId}
`;
    const separator = message.endsWith("\n") ? "" : "\n\n";
    return git.createCandidateTree(
      base,
      changes,
      message + separator + details,
      startingTree,
      "environment",
    );
  };
  const candidateMessage = async (commit: string) =>
    Buffer.from(await git.candidateMessage(commit)).toString("utf8");
  const readTree = (commit: string) =>
    LocalGitIntegration.committedTree(repository, commit);
  const profileDigest = envOptions?.profile?.image.slice(-64);
  const validateUpdatePaths = async (commit: string) => {
    const { keyFiles } = await bunAdapter.layout(await readTree(commit));
    assertAllowed(keyFiles);
  };
  return {
    ...(environment && { ensureEnvironment: environment }),
    ...(declaration && {
      async prepareEnvironmentUpdate(
        base: string,
        id: string,
        previous?: { candidate: string; changedPaths: readonly string[] },
      ) {
        const env = requireEnvironment();
        envOptions!.requireAudit(id);
        await validateUpdatePaths(base);
        if (previous) {
          assertAllowed(previous.changedPaths);
          return previous;
        }
        const result = await env.mutate(base, id, "update", declaration.update);
        const candidate = await writeEnvironment(
          base,
          base,
          result,
          "Environment prepared by Provisioner",
        );
        return { candidate, changedPaths: result.changedPaths ?? [] };
      },
    }),
    ...(environment &&
      profileDigest &&
      task.content.profile === "bun" &&
      (autoBuild || verificationProfile !== "bun") && {
        async resolveCandidate(
          pin: PinnedCandidate,
          executorBase: string,
          id: string,
          authorize: (paths: readonly string[]) => Promise<void>,
        ) {
          const [candidate, source] = await Promise.all([
            readTree(pin.candidate),
            readTree(executorBase),
          ]);
          const [next, previous] = await Promise.all([
            identifyEnvironment(candidate, profileDigest, bunAdapter),
            identifyEnvironment(source, profileDigest, bunAdapter),
          ]);
          if (next.key === previous.key) return { candidate: pin.candidate };
          if (
            next.lock ||
            (await allowsEmptyLock(candidate, next.layout.keyFiles.length))
          ) {
            try {
              const held = await environment({
                role: "Verification",
                profile: "bun",
                commit: pin.candidate,
                executionId: id,
              });
              if (verificationProfile === "bun")
                return { candidate: pin.candidate, held };
              held.release();
              return { candidate: pin.candidate };
            } catch (error) {
              if (
                !(error instanceof EnvironmentError) ||
                error.code !== "env-lock-mismatch"
              )
                throw error;
            }
          }
          if (!autoBuild) throw new EnvironmentError("env-missing");
          assertAllowed([bunAdapter.lockPath]);
          await authorize([bunAdapter.lockPath]);
          try {
            const result = await environment.mutate(
              pin.candidate,
              id,
              "resolve",
            );
            const resolved = await writeEnvironment(
              pin.base,
              pin.candidate,
              result,
              await candidateMessage(pin.candidate),
            );
            if (
              resolved === pin.candidate ||
              !(
                await replayPlan(
                  git,
                  { base: pin.base, candidate: resolved },
                  pin.base,
                )
              ).paths.length
            )
              throw new EnvironmentError("env-lock-mismatch");
            if (verificationProfile !== "bun") {
              const held = await environment({
                role: "Verification",
                profile: "bun",
                commit: resolved,
                executionId: id,
              });
              held.release();
            }
            return { candidate: resolved };
          } catch (error) {
            if (
              error instanceof EnvironmentError &&
              !(error instanceof DeclarationError)
            )
              throw new EnvironmentError("env-lock-mismatch");
            throw error;
          }
        },
      }),
    ...(stale &&
      environment && {
        async rebaseEnvironment(base: string, id: string) {
          envOptions!.requireAudit(id);
          const plan = await replayPlan(git, stale, base);
          if (!plan.derivedLockConflict)
            throw new GitIntegrationError("stale-base");
          assertAllowed([bunAdapter.lockPath]);
          const changes = await replayChanges(git, plan, bunAdapter.lockPath);
          const message = await candidateMessage(stale.candidate);
          const startingTree = changes.length
            ? await git.createCandidateTree(
                base,
                changes,
                message,
                base,
                "environment",
              )
            : base;
          if (declaration) await validateUpdatePaths(startingTree);
          const result = await environment.mutate(
            startingTree,
            id,
            declaration ? "update" : "resolve",
            declaration?.update,
          );
          const candidate = await writeEnvironment(
            base,
            startingTree,
            result,
            message,
          );
          if (candidate === base) throw new GitIntegrationError("stale-base");
          // Also prepare the rebased environment when no Verification suite is configured.
          const held = await environment({
            role: "Executor",
            profile: "bun",
            commit: candidate,
            executionId: id,
          });
          held.release();
          return { candidate, changedPaths: result.changedPaths ?? [] };
        },
      }),
    ...(task.content.profile === "bun" && {
      async packageDiff(pin: PinnedCandidate, id: string, record: boolean) {
        const diff = await candidatePackageDiff(pin, readTree);
        if (
          record &&
          (diff.added.length ||
            diff.removed.length ||
            diff.changed.length ||
            store.taskPackageDiff(task.id))
        )
          store.recordTaskPackageDiff(id, diff);
        return diff;
      },
    }),
  };
}

async function candidatePackageDiff(
  pin: PinnedCandidate,
  tree: (
    commit: string,
  ) => ReturnType<typeof LocalGitIntegration.committedTree>,
) {
  try {
    const [before, after] = await Promise.all([
      tree(pin.base),
      tree(pin.candidate),
    ]);
    const [oldLock, newLock] = await Promise.all([
      before.read(bunAdapter.lockPath),
      after.read(bunAdapter.lockPath),
    ]);
    if (
      (!oldLock && !newLock) ||
      (oldLock && newLock && oldLock.equals(newLock))
    )
      return emptyPackageDiff;
    return diffPackages(
      oldLock ? parseBunLock(oldLock) : [],
      newLock ? parseBunLock(newLock) : [],
    );
  } catch (error) {
    // A Task without environment delivery may still change a lock the
    // display parser cannot summarize. Its normal review remains available.
    if (
      (error instanceof EnvironmentError &&
        error.code === "env-lock-mismatch") ||
      (error instanceof GitIntegrationError &&
        (error.code === "unsupported-entry" || error.code === "output-limit"))
    )
      return emptyPackageDiff;
    throw error;
  }
}
