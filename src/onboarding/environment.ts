import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { loadConfig } from "../config/layers.ts";
import { type Project } from "../config/projects.ts";
import { resolveMsbHome } from "../config/msb-home.ts";
import {
  EnvironmentError,
  identifyEnvironment,
  type EnvironmentTree,
} from "../environments/adapter.ts";
import { bunAdapter } from "../environments/bun.ts";
import {
  provisionEnvironment,
  type ProvisionerHost,
} from "../environments/provisioner.ts";
import { EnvironmentStore } from "../environments/store.ts";
import { LocalGitIntegration } from "../git-integration.ts";
import { resolveTarget } from "../local-orchestrator/target.ts";
import { MISE_MSB, offlineMiseEnv } from "../mise-tools.ts";
import { publishPrivateFile } from "../private-journal.ts";
import type { ProfileLockEntry } from "../profile-lock.ts";
import type { BootstrapIo } from "./cli.ts";
import { readLock, type Check, type Host } from "./prerequisites.ts";

type Target = { project: Project; env: NodeJS.ProcessEnv };

export interface EnvironmentStatus {
  readonly key: string;
  readonly state: "current" | "stale" | "missing";
  readonly hasLock: boolean;
  readonly size: number;
}

export const environmentResponsibilityNotice =
  "You are responsible for the packages and tools declared by the target, including install scripts. Agent-bootstrap isolates the build from host credentials, other targets, host paths and the audit record.";

const responsibilityRecord = "responsibility-shown";
export class EnvironmentBuildBusyError extends Error {
  readonly code = "environment-build-running";

  constructor() {
    super("Another environment build is running for this target.");
  }
}

type BuildTarget = Target & { configDirectory: string };
type BuildHost = Pick<Host, "env" | "actorHarnesses" | "command"> &
  Pick<ProvisionerHost, "openGateway">;

function integer(value: string | undefined) {
  if (!value || !/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)))
    throw new Error("usage");
  return Number(value);
}

export function parseEnvironmentArgs(args: readonly string[]) {
  const [command] = args;
  if (command !== "build" && command !== "status" && command !== "prune")
    throw new Error("usage");
  let target: string | undefined;
  let keep: number | undefined;
  let maxAgeMs: number | undefined;
  let allowNetwork = false;
  const seen = new Set<string>();
  for (let index = 1; index < args.length; index++) {
    const flag = args[index]!;
    if (seen.has(flag)) throw new Error("usage");
    seen.add(flag);
    switch (flag) {
      case "--target":
        target = args[++index];
        if (!target || target.startsWith("-") || target.includes("\0"))
          throw new Error("usage");
        break;
      case "--allow-network":
        if (command !== "build") throw new Error("usage");
        allowNetwork = true;
        break;
      case "--keep":
        if (command !== "prune") throw new Error("usage");
        keep = integer(args[++index]);
        break;
      case "--max-age-days":
        if (command !== "prune") throw new Error("usage");
        maxAgeMs = integer(args[++index]) * 86_400_000;
        if (!Number.isSafeInteger(maxAgeMs)) throw new Error("usage");
        break;
      default:
        throw new Error("usage");
    }
  }
  if (!target) throw new Error("usage");
  return {
    command,
    target,
    allowNetwork,
    prune: {
      ...(keep !== undefined && { keep }),
      ...(maxAgeMs !== undefined && { maxAgeMs }),
    },
  };
}

async function committedTree(target: Target) {
  return LocalGitIntegration.committedTree(target.project.identity);
}

export async function environmentStatus(
  target: Target,
  profile: ProfileLockEntry,
  store = new EnvironmentStore(target.project.id, target.env),
): Promise<EnvironmentStatus> {
  return (await inspectEnvironment(target, profile, store)).status;
}

export async function inspectEnvironment(
  target: Target,
  profile: ProfileLockEntry,
  store: EnvironmentStore,
) {
  const tree = await committedTree(target);
  return { tree, status: await statusForTree(tree, profile, store) };
}

async function statusForTree(
  tree: EnvironmentTree,
  profile: ProfileLockEntry,
  store: EnvironmentStore,
): Promise<EnvironmentStatus> {
  const { key, lock } = await identifyEnvironment(
    tree,
    profile.image.slice(-64),
    bunAdapter,
  );
  const current = store.get(key);
  const recent = current ?? store.list()[0];
  return {
    key,
    hasLock: lock !== undefined,
    state: current ? "current" : recent ? "stale" : "missing",
    size: recent?.size ?? 0,
  };
}

function showStatus({ key, state, hasLock, size }: EnvironmentStatus) {
  return `${state}  ${key}  lock ${hasLock ? "present" : "missing"}  ${size} bytes`;
}

export async function environmentDoctor(
  target: Target,
  profile: ProfileLockEntry,
  id = "environment",
): Promise<Check> {
  try {
    const tree = await committedTree(target);
    if (!tree.paths.includes("package.json"))
      return {
        id,
        status: "skipped",
        detail: "No package.json in the committed tree.",
        fix: [],
        needsNetwork: false,
        needsHuman: false,
      };
    const environment = await statusForTree(
      tree,
      profile,
      new EnvironmentStore(target.project.id, target.env),
    );
    return {
      id,
      status: environment.state === "current" ? "ok" : "missing",
      detail: showStatus(environment),
      fix: [],
      needsNetwork: false,
      needsHuman: false,
      environment,
    };
  } catch {
    return {
      id,
      status: "wrong",
      detail: "Could not inspect the committed Bun environment.",
      fix: [],
      needsNetwork: false,
      needsHuman: false,
    };
  }
}

export function environmentBuildConfig(target: BuildTarget, host: BuildHost) {
  return loadConfig(host.env, target.configDirectory, host.actorHarnesses)
    .config;
}

export async function environmentResponsibilityShown(store: EnvironmentStore) {
  let record;
  try {
    record = await lstat(join(store.directory, responsibilityRecord));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  if (
    !record.isFile() ||
    (record.mode & 0o777) !== 0o600 ||
    (process.getuid && record.uid !== process.getuid()) ||
    record.size !== 2
  )
    throw new EnvironmentError();
  return true;
}

export async function buildEnvironment(
  target: BuildTarget,
  profile: ProfileLockEntry,
  host: BuildHost,
  options: {
    store: EnvironmentStore;
    tree?: Awaited<ReturnType<typeof committedTree>>;
    config?: ReturnType<typeof environmentBuildConfig>;
    showResponsibility?: (notice: string) => void;
    signal?: AbortSignal;
  },
) {
  const { store, signal } = options;
  signal?.throwIfAborted();
  const config = options.config ?? environmentBuildConfig(target, host);
  const home = await resolveMsbHome(host.env, config);
  signal?.throwIfAborted();
  if (!("path" in home)) throw new EnvironmentError();
  store.prepare();
  try {
    await publishPrivateFile(store.directory, responsibilityRecord, "1\n");
    options.showResponsibility?.(environmentResponsibilityNotice);
  } catch (error) {
    if (
      (error as NodeJS.ErrnoException).code !== "EEXIST" ||
      !(await environmentResponsibilityShown(store))
    )
      throw error;
  }
  const result = await provisionEnvironment(
    {
      tree: options.tree ?? (await committedTree(target)),
      profile,
      operation: "build",
      allow: config.environment?.allow ?? [],
    },
    {
      env: host.env,
      store,
      ...(signal && { signal }),
      ...(host.openGateway && { openGateway: host.openGateway }),
      run(args, timeout, extra, signal) {
        return host.command(
          "mise",
          [...MISE_MSB, ...args],
          {
            ...offlineMiseEnv(host.env),
            MSB_HOME: home.path,
            ...extra,
          },
          timeout,
          signal,
        );
      },
    },
  );
  const { key, cacheHit, size, warning } = result;
  return { key, cacheHit, size, ...(warning && { warning }) };
}

export async function runEnvironmentCommand(
  options: ReturnType<typeof parseEnvironmentArgs>,
  root: string,
  host: Host,
  io: BootstrapIo,
  print: (value: unknown) => void,
  json: boolean,
) {
  const target = await resolveTarget(options.target, root, host.env);
  const store = new EnvironmentStore(target.project.id, host.env);
  if (options.command === "prune") {
    const removed = store.prune(options.prune);
    if (json) print({ removed });
    else io.stdout.write(`Removed ${removed.length} environment entries.\n`);
    return;
  }
  const profile = (await readLock(root)).profiles.bun;
  if (!profile) throw new EnvironmentError();
  if (options.command === "status") {
    const status = await environmentStatus(target, profile, store);
    if (json) print(status);
    else io.stdout.write(`${showStatus(status)}\n`);
    return;
  }
  if (!options.allowNetwork) throw new EnvironmentError();
  const release = store.tryLockBuild();
  if (!release) throw new EnvironmentBuildBusyError();
  const result = await buildEnvironment(target, profile, host, {
    store,
    showResponsibility: (notice) => io.stderr.write(`${notice}\n`),
  }).finally(release);
  const { key, cacheHit, size, warning } = result;
  if (json) print(result);
  else {
    io.stdout.write(
      `${key}  ${size} bytes  ${cacheHit ? "cached" : "built"}\n`,
    );
    if (warning)
      io.stderr.write(
        `${warning}  No committed bun.lock. Bun resolved dependencies inside the Provisioner.\n`,
      );
  }
}
