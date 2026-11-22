import { PROFILE_RECIPES, recipeDigest, recipeFor } from "./image-recipes.ts";
import { ProfileCatalog, type ProfileName } from "./sandbox-profiles.ts";

export interface ProfileLockEntry {
  readonly image: string;
  readonly recipeDigest: string;
  readonly memoryMiB: number;
  readonly cpus: number;
}

export interface ProfileLock {
  readonly version: 1;
  readonly profiles: Readonly<Record<string, ProfileLockEntry>>;
}

export const PROFILE_LOCK_PATH = "images/profiles.lock.json";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: string[]): void {
  const actual = Object.keys(value).sort();
  if (actual.join() !== [...keys].sort().join())
    throw new Error("Profile lock has unexpected keys");
}

/** The lock entry for a freshly built image digest (64 hex). */
export function lockEntry(name: string, digest: string): ProfileLockEntry {
  if (!/^[0-9a-f]{64}$/.test(digest)) throw new Error("Bad image digest");
  const recipe = recipeFor(name);
  return {
    image: `localhost/agent-bootstrap/${name}@sha256:${digest}`,
    recipeDigest: recipeDigest(name),
    memoryMiB: recipe.memoryMiB,
    cpus: recipe.cpus,
  };
}

export function parseProfileLock(text: string): ProfileLock {
  const root: unknown = JSON.parse(text);
  if (!isRecord(root)) throw new Error("Profile lock is not an object");
  exactKeys(root, ["version", "profiles"]);
  if (root["version"] !== 1) throw new Error("Unsupported profile lock");
  const profiles = root["profiles"];
  if (!isRecord(profiles)) throw new Error("Profile lock has no profiles");
  const out: Record<string, ProfileLockEntry> = {};
  for (const [name, entry] of Object.entries(profiles)) {
    if (!Object.hasOwn(PROFILE_RECIPES, name))
      throw new Error(`Profile lock names unknown profile ${name}`);
    if (!isRecord(entry)) throw new Error(`Bad lock entry for ${name}`);
    exactKeys(entry, ["image", "recipeDigest", "memoryMiB", "cpus"]);
    const image = entry["image"];
    if (
      typeof image !== "string" ||
      !new RegExp(
        `^localhost/agent-bootstrap/${name}@sha256:[0-9a-f]{64}$`,
      ).test(image)
    )
      throw new Error(`Bad image reference for ${name}`);
    if (entry["recipeDigest"] !== recipeDigest(name))
      throw new Error(`Profile lock is stale for ${name}`);
    const recipe = recipeFor(name);
    if (
      entry["memoryMiB"] !== recipe.memoryMiB ||
      entry["cpus"] !== recipe.cpus
    )
      throw new Error(`Profile lock limits differ from recipe for ${name}`);
    out[name] = {
      image,
      recipeDigest: entry["recipeDigest"] as string,
      memoryMiB: recipe.memoryMiB,
      cpus: recipe.cpus,
    };
  }
  return { version: 1, profiles: out };
}

export function profileCatalog(
  baseImage: string,
  lock?: ProfileLock,
): ProfileCatalog {
  const profiles: Partial<
    Record<ProfileName, { image: string; memoryMiB?: number; cpus?: number }>
  > = { base: { image: baseImage } };
  for (const [name, e] of Object.entries(lock?.profiles ?? {}))
    profiles[name as ProfileName] = {
      image: e.image,
      memoryMiB: e.memoryMiB,
      cpus: e.cpus,
    };
  return new ProfileCatalog(profiles);
}
