import { createHmac, randomBytes } from "node:crypto";
import {
  EnvironmentError,
  type EnvironmentFailure,
  type GatewayStop,
  type lockMissing,
} from "../environments/adapter.ts";
import { provisionerPolicy } from "../environments/provisioner.ts";
import { EnvironmentStore } from "../environments/store.ts";
import {
  buildEnvironment,
  environmentBuildConfig,
  environmentResponsibilityNotice,
  environmentResponsibilityShown,
  environmentStatus,
  inspectEnvironment,
  type EnvironmentStatus,
} from "../onboarding/environment.ts";
import type { ProfileLockEntry } from "../profile-lock.ts";
import type { OrchestratorStore } from "./store.ts";

export type WorkplaceEnvironmentBuild =
  | { state: "running"; key: string }
  | {
      state: "succeeded";
      key: string;
      cacheHit: boolean;
      size: number;
      warning?: typeof lockMissing;
    }
  | {
      state: "failed";
      key: string;
      failure: EnvironmentFailure;
      gatewayStopped?: GatewayStop;
    };

type WorkplaceEnvironmentErrorCode =
  | "environment-unavailable"
  | "environment-current"
  | "environment-build-running"
  | "confirmation-mismatch"
  | "write-failed";

export class WorkplaceEnvironmentError extends Error {
  readonly code: WorkplaceEnvironmentErrorCode;

  constructor(code: WorkplaceEnvironmentErrorCode) {
    super(code);
    this.code = code;
  }
}

export type WorkplaceEnvironment = ReturnType<
  typeof createWorkplaceEnvironment
>;

export function createWorkplaceEnvironment({
  target,
  profile,
  host,
  journal,
  signal,
}: {
  target: Parameters<typeof buildEnvironment>[0];
  profile: ProfileLockEntry | undefined;
  host: Parameters<typeof buildEnvironment>[2];
  journal: Pick<OrchestratorStore, "recordWorkplaceEnvironmentBuild">;
  signal?: AbortSignal;
}) {
  const store = new EnvironmentStore(target.project.id, host.env);
  const secret = randomBytes(32);
  const closing = new AbortController();
  const buildSignal = signal
    ? AbortSignal.any([closing.signal, signal])
    : closing.signal;
  let build: WorkplaceEnvironmentBuild | null = null;
  let starting = false;
  let generation = 0;
  let running: Promise<void> | undefined;

  async function prepareBuild() {
    if (!profile || buildSignal.aborted)
      throw new WorkplaceEnvironmentError("environment-unavailable");
    try {
      const { tree, status } = await inspectEnvironment(target, profile, store);
      if (status.state === "current")
        throw new WorkplaceEnvironmentError("environment-current");
      const config = environmentBuildConfig(target, host);
      const destinations = provisionerPolicy(
        config.environment?.allow ?? [],
      ).allow.map(({ hostname, port }) => `${hostname}:${port}`);
      const responsibilityNotice = (await environmentResponsibilityShown(store))
        ? null
        : environmentResponsibilityNotice;
      if (buildSignal.aborted)
        throw new WorkplaceEnvironmentError("environment-unavailable");
      const { key } = status;
      // Install scripts can change without changing the environment cache key.
      const confirmation = createHmac("sha256", secret)
        .update(
          JSON.stringify([
            generation,
            tree.commit,
            key,
            destinations,
            responsibilityNotice,
          ]),
        )
        .digest("hex");
      return {
        tree,
        config,
        profile,
        preview: { confirmation, key, destinations, responsibilityNotice },
      };
    } catch (error) {
      throw error instanceof WorkplaceEnvironmentError
        ? error
        : new WorkplaceEnvironmentError("environment-unavailable");
    }
  }

  function requireIdle() {
    if (starting || running)
      throw new WorkplaceEnvironmentError("environment-build-running");
  }

  async function runBuild(
    {
      tree,
      config,
      profile: buildProfile,
      preview: { key },
    }: Awaited<ReturnType<typeof prepareBuild>>,
    unlock: () => void,
  ) {
    try {
      const result = await buildEnvironment(target, buildProfile, host, {
        store,
        tree,
        config,
        signal: buildSignal,
      }).finally(unlock);
      build = { state: "succeeded", ...result };
    } catch (error) {
      const failure =
        error instanceof EnvironmentError ? error : new EnvironmentError();
      build = {
        state: "failed",
        key,
        failure: failure.code,
        ...(failure.gatewayStopped && {
          gatewayStopped: failure.gatewayStopped,
        }),
      };
    } finally {
      running = undefined;
    }
  }

  return {
    async status(): Promise<{
      status: EnvironmentStatus | null;
      build: WorkplaceEnvironmentBuild | null;
    }> {
      const status = profile
        ? await environmentStatus(target, profile, store).catch(() => null)
        : null;
      return { status, build };
    },
    async preview() {
      requireIdle();
      const { preview } = await prepareBuild();
      requireIdle();
      return preview;
    },
    async start(confirmation: string) {
      requireIdle();
      starting = true;
      let unlock: (() => void) | undefined;
      try {
        unlock = store.tryLockBuild();
        if (!unlock)
          throw new WorkplaceEnvironmentError("environment-build-running");
        const prepared = await prepareBuild();
        if (confirmation !== prepared.preview.confirmation)
          throw new WorkplaceEnvironmentError("confirmation-mismatch");
        if (buildSignal.aborted)
          throw new WorkplaceEnvironmentError("environment-unavailable");
        try {
          journal.recordWorkplaceEnvironmentBuild({
            commit: prepared.tree.commit,
            key: prepared.preview.key,
            destinations: prepared.preview.destinations,
            noticeShown: prepared.preview.responsibilityNotice !== null,
          });
        } catch {
          throw new WorkplaceEnvironmentError("write-failed");
        }
        generation++;
        build = { state: "running", key: prepared.preview.key };
        running = runBuild(prepared, unlock);
        unlock = undefined;
        return build;
      } finally {
        starting = false;
        unlock?.();
      }
    },
    async close() {
      closing.abort();
      await running;
    },
  };
}
