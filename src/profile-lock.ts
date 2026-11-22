import { PROFILE_RECIPES, recipeDigest, recipeFor } from "./image-recipes.ts";
import { ProfileCatalog, type ProfileName } from "./sandbox-profiles.ts";

export interface ProfileLockEntry {
  readonly image: string;
  readonly recipeDigest: string;
  readonly memoryMiB: number;
  readonly cpus: number;
  /** Debian profiles only: installed `name=version` pairs, sorted. */
  readonly packages?: readonly string[];
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
export function lockEntry(
  name: string,
  digest: string,
  packages?: readonly string[],
): ProfileLockEntry {
  if (!/^[0-9a-f]{64}$/.test(digest)) throw new Error("Bad image digest");
  const recipe = recipeFor(name);
  if (packages !== undefined) checkPackages(name, packages);
  return {
    image: `localhost/agent-bootstrap/${name}@sha256:${digest}`,
    recipeDigest: recipeDigest(name),
    memoryMiB: recipe.memoryMiB,
    cpus: recipe.cpus,
    ...(packages === undefined ? {} : { packages: [...packages] }),
  };
}

const PACKAGE_RE = /^[a-z0-9][a-z0-9+.-]*=[A-Za-z0-9.+~:-]+$/;
const MAX_PACKAGES = 2000;

/** `name=version` strings, strictly sorted (so unique); Debian recipes only. */
function checkPackages(
  name: string,
  value: unknown,
): asserts value is string[] {
  if (recipeFor(name).base.kind !== "debian-snapshot")
    throw new Error(`Packages are not allowed for ${name}`);
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > MAX_PACKAGES
  )
    throw new Error(`Bad package list for ${name}`);
  let previous: string | undefined;
  for (const item of value) {
    if (typeof item !== "string" || !PACKAGE_RE.test(item))
      throw new Error(`Bad package entry for ${name}`);
    if (previous !== undefined && !(previous < item))
      throw new Error(`Package list for ${name} is not sorted`);
    previous = item;
  }
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
    const hasPackages = Object.hasOwn(entry, "packages");
    exactKeys(
      entry,
      hasPackages
        ? ["image", "recipeDigest", "memoryMiB", "cpus", "packages"]
        : ["image", "recipeDigest", "memoryMiB", "cpus"],
    );
    if (hasPackages) checkPackages(name, entry["packages"]);
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
      ...(hasPackages ? { packages: entry["packages"] as string[] } : {}),
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
