import { lstat, realpath } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  checkDirectory as checkAncestors,
  missing,
  privatePath,
  projectConfigDirectory,
  projectStateDirectory,
  userStateDirectory,
} from "../config/layers.ts";
import { ConfigError } from "../config/messages.ts";
import {
  assertExternalPaths,
  listProjects,
  projectMissing,
  repository,
} from "../config/projects.ts";
import { localMainCommit } from "./tasks.ts";

export const bootstrapCheckout = fileURLToPath(
  new URL("../../", import.meta.url),
);
export const legacyStateDirectory = (checkout: string) =>
  join(checkout, ".local", "local-orchestrator");
export class TargetError extends ConfigError {}

export async function hasLegacyState(checkout: string) {
  try {
    await lstat(legacyStateDirectory(checkout));
  } catch (error) {
    if (missing(error)) return false;
    throw error;
  }
  return true;
}

export async function rejectLegacyState(checkout: string) {
  if (!(await hasLegacyState(checkout))) return;
  throw new TargetError(
    "state",
    "Legacy local orchestrator state requires migration.",
    "agent-bootstrap migrate",
  );
}

export async function resolveTarget(
  path?: string,
  checkout = bootstrapCheckout,
  env = process.env,
) {
  const bootstrapRoot = await realpath(checkout);
  await rejectLegacyState(bootstrapRoot);
  const projects = listProjects(env);
  // Detect a moved repository addressed by its previous path.
  const requested = resolve(path ?? bootstrapRoot);
  let found: ReturnType<typeof repository>;
  try {
    found = repository(requested);
    assertExternalPaths(found, env);
  } catch (error) {
    const missingProject = projects.some(
      (project) =>
        dirname(project.identity) === resolve(requested) &&
        projectMissing(project),
    );
    if (missingProject)
      throw new TargetError(
        "project.identity",
        "The registered Git directory is missing.",
        "Run agent-bootstrap project move <name> <path>.",
      );
    throw error;
  }
  const { repoRoot } = found;
  const isDefault = repoRoot === bootstrapRoot;
  // The bootstrap checkout may itself be a linked worktree under .local.
  if (
    !isDefault &&
    [requested, repoRoot].some((entry) =>
      entry.split(sep).some((part) => part.toLowerCase() === ".local"),
    )
  )
    throw new TargetError(
      "target",
      "Target repositories must be outside .local.",
      "Choose a worktree outside .local.",
    );
  const project = projects.find(({ identity }) => identity === found.identity);
  if (!project)
    throw new TargetError(
      "project.identity",
      "The target is not registered.",
      "agent-bootstrap project add <path>",
    );
  const base = await localMainCommit(repoRoot, true).catch(() => undefined);
  if (base?.length !== 40)
    throw new TargetError(
      "target",
      "Target integration requires a local SHA-1 main commit.",
      "Create or restore local main and run agent-bootstrap doctor.",
    );
  const directory = projectStateDirectory(project.name, env);
  try {
    privatePath(directory, userStateDirectory(env));
  } catch (error) {
    if (!missing(error)) throw error;
  }
  return {
    bootstrapRoot,
    repoRoot,
    isDefault,
    slug: project.name,
    project,
    env,
    configDirectory: projectConfigDirectory(project.name, env),
    directory,
    // Concierge volume names are limited to 66 characters.
    volume: `lo-concierge-${project.name.slice(0, 40)}-${project.id}`,
  };
}

export async function discoverAnalysisTargets(
  target: Awaited<ReturnType<typeof resolveTarget>>,
) {
  return listProjects(target.env).map(({ name }) => ({
    slug: name,
    directory: projectStateDirectory(name, target.env),
    configDirectory: projectConfigDirectory(name, target.env),
  }));
}

/** User configuration can be used before registering the default checkout. */
export async function resolveConfigTarget(
  path: string | undefined,
  checkout: string,
  env: NodeJS.ProcessEnv,
) {
  if (path !== undefined) return resolveTarget(path, checkout, env);
  const projects = listProjects(env);
  if (!projects.length) return;
  let identity: string;
  try {
    ({ identity } = repository(checkout));
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    return;
  }
  if (projects.some((project) => project.identity === identity))
    return resolveTarget(undefined, checkout, env);
}

export async function checkDirectory(path: string): Promise<void> {
  checkAncestors(path);
}

export async function prepareTargetDirectory(
  checkout: string,
  directory?: string,
  env = process.env,
): Promise<string> {
  const state =
    directory ?? (await resolveTarget(undefined, checkout, env)).directory;
  privatePath(state, userStateDirectory(env), true);
  return state;
}
