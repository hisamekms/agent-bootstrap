import { createHash } from "node:crypto";
import { lstat, mkdir, realpath } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { checkPrivateDirectory } from "../private-journal.ts";
import { localMainCommit } from "./tasks.ts";

export const bootstrapCheckout = fileURLToPath(
  new URL("../../", import.meta.url),
);

export class TargetError extends Error {}

export async function resolveTarget(
  path?: string,
  checkout = bootstrapCheckout,
) {
  const bootstrapRoot = await realpath(checkout);
  const requested = resolve(path ?? bootstrapRoot);
  const repoRoot = await realpath(requested).catch(() => {
    throw new TargetError("Target path is inaccessible.");
  });
  const isDefault = repoRoot === bootstrapRoot;
  // The bootstrap checkout can itself be a linked worktree under .local.
  if (
    !isDefault &&
    [requested, repoRoot].some((entry) =>
      entry.split(sep).some((part) => part.toLowerCase() === ".local"),
    )
  )
    throw new TargetError("Target repositories must be outside .local.");
  if (path !== undefined) {
    const base = await localMainCommit(repoRoot, true).catch(() => {
      throw new TargetError(
        "Target must be a Git worktree root with a local main commit.",
      );
    });
    if (base.length !== 40)
      throw new TargetError(
        "Target integration requires a SHA-1 Git repository.",
      );
  }
  const hash = createHash("sha256").update(repoRoot).digest("hex");
  const name =
    basename(repoRoot)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .slice(0, 32)
      .replace(/^-|-$/g, "") || "repository";
  const slug = `${name}-${hash.slice(0, 12)}`;
  const baseDirectory = join(bootstrapRoot, ".local", "local-orchestrator");
  return {
    bootstrapRoot,
    repoRoot,
    isDefault,
    directory: isDefault ? baseDirectory : join(baseDirectory, "targets", slug),
    volume: `lo-concierge-${isDefault ? hash.slice(0, 16) : slug}`,
  };
}

export async function checkDirectory(path: string): Promise<void> {
  const parent = dirname(path);
  if (parent !== path) await checkDirectory(parent);
  const info = await lstat(path);
  const mode = info.mode & 0o7777;
  if (
    !info.isDirectory() ||
    (info.uid !== process.getuid?.() && info.uid !== 0) ||
    ((mode & 0o022) !== 0 && !(info.uid === 0 && mode === 0o1777))
  )
    throw new Error("Unsafe local orchestrator directory");
}

export async function prepareTargetDirectory(
  bootstrapRoot: string,
  directory = join(bootstrapRoot, ".local", "local-orchestrator"),
): Promise<string> {
  const subpath = relative(bootstrapRoot, directory);
  const statePath = join(".local", "local-orchestrator");
  if (subpath !== statePath && !subpath.startsWith(statePath + sep))
    throw new Error("Unsafe local orchestrator directory");
  await checkDirectory(bootstrapRoot);
  let dir = bootstrapRoot;
  for (const name of subpath.split(sep)) {
    dir = join(dir, name);
    await mkdir(dir, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") throw error;
    });
    await checkDirectory(dir);
  }
  await checkPrivateDirectory(dir);
  return dir;
}
