import { randomUUID } from "node:crypto";
import { setTimeout } from "node:timers/promises";
import {
  EnvironmentError,
  identifyEnvironment,
} from "../environments/adapter.ts";
import {
  checkEnvironmentTree,
  validateEnvironmentArchive,
} from "../environments/archive.ts";
import { bunAdapter } from "../environments/bun.ts";
import {
  provisionEnvironment,
  type ProvisionerHost,
} from "../environments/provisioner.ts";
import { LocalGitIntegration } from "../git-integration.ts";
import type { ProfileLockEntry } from "../profile-lock.ts";
import type { EnsureTaskEnvironment } from "../reviewed-integration.ts";
import type { OrchestratorStore } from "./store.ts";

const buildWaitMs = 5 * 60 * 1000;

export type TaskEnvironmentOptions = {
  readonly profile: ProfileLockEntry | undefined;
  readonly autoBuild?: boolean;
  readonly allow: readonly string[];
  readonly host: ProvisionerHost;
  readonly requireAudit: (executionId: string) => void;
};

export function taskEnvironment(
  options: TaskEnvironmentOptions,
  journal: Pick<OrchestratorStore, "recordTaskEnvironment">,
  repository: string,
): EnsureTaskEnvironment {
  return async ({ commit, profile, executionId }) => {
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
        const deadline = performance.now() + buildWaitMs;
        let unlock = host.store.tryLockBuild();
        while (!unlock) {
          const remaining = deadline - performance.now();
          if (remaining <= 0 || host.signal?.aborted)
            throw new EnvironmentError();
          await setTimeout(Math.min(100, remaining), undefined, {
            signal: host.signal,
          }).catch(() => {
            throw new EnvironmentError();
          });
          if (performance.now() >= deadline) throw new EnvironmentError();
          unlock = host.store.tryLockBuild();
        }
        try {
          holdCached();
          if (!cacheHit) {
            options.requireAudit(executionId);
            const result = await provisionEnvironment(
              {
                tree,
                profile: options.profile,
                operation: "build",
                allow: options.allow,
              },
              { ...host, invocationId },
            );
            if (result.key !== key || !result.manifest)
              throw new EnvironmentError();
            cacheHit = result.cacheHit;
            release = host.store.hold(key);
          }
        } finally {
          unlock();
        }
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
}
