import type {
  EnvironmentAdapter,
  EnvironmentLayout,
  EnvironmentTree,
} from "./adapter.ts";
import { EnvironmentError, lockMissing } from "./adapter.ts";

import { validPackageName } from "./lock.ts";

const lockPath = "bun.lock";
const manifestPath = "package.json";
const outputDirectory = "node_modules";

/** The diff alone cannot identify workspaces on either side of the change. */
export function matchesBunEnvironmentPath(foldedPath: string): boolean {
  const segments = foldedPath.split("/");
  const name = segments.at(-1);
  return (
    name === lockPath ||
    name === manifestPath ||
    segments.includes(outputDirectory)
  );
}

declare const Bun: {
  Glob: new (pattern: string) => { match(path: string): boolean };
};

export function unsafePathCharacters(path: string): boolean {
  return (
    path.includes("\\") ||
    path.includes(":") ||
    Array.from(path).some(
      (char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127,
    )
  );
}

export function environmentPath(path: string): boolean {
  return (
    path.length > 0 &&
    !unsafePathCharacters(path) &&
    path
      .split("/")
      .every(
        (segment) =>
          segment !== "" &&
          segment !== "." &&
          segment !== ".." &&
          segment.toLowerCase() !== ".git",
      )
  );
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function hasBunLayout(tree: EnvironmentTree): boolean {
  return tree.paths.includes(manifestPath);
}

/** Bun can omit an empty lock for a project with no workspace or dependencies. */
export async function allowsEmptyLock(tree: EnvironmentTree, keyFiles: number) {
  if (keyFiles !== 2) return false;
  const root = await tree.read(manifestPath);
  if (!root) return false;
  const manifest: unknown = JSON.parse(
    new TextDecoder("utf-8", { fatal: true }).decode(root),
  );
  return (
    record(manifest) &&
    [
      "dependencies",
      "devDependencies",
      "optionalDependencies",
      "peerDependencies",
    ].every(
      (field) =>
        !Object.hasOwn(manifest, field) ||
        (record(manifest[field]) && Object.keys(manifest[field]).length === 0),
    )
  );
}

async function layout(tree: EnvironmentTree): Promise<EnvironmentLayout> {
  try {
    const root = await tree.read(manifestPath);
    const manifest: unknown = root
      ? JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(root))
      : {};
    if (!record(manifest)) throw new EnvironmentError();
    const workspaces = record(manifest.workspaces)
      ? manifest.workspaces.packages
      : manifest.workspaces;
    const patterns = manifest.workspaces === undefined ? [] : workspaces;
    if (!Array.isArray(patterns) || patterns.length > 256)
      throw new EnvironmentError();
    const globs = patterns.map((pattern: unknown) => {
      if (
        typeof pattern !== "string" ||
        pattern.length > 1024 ||
        !environmentPath(pattern.replace(/\/$/, "")) ||
        pattern.startsWith("!")
      )
        throw new EnvironmentError();
      return new Bun.Glob(`${pattern.replace(/\/$/, "")}/${manifestPath}`);
    });
    const manifests = [
      ...new Set(
        tree.paths.filter(
          (path) =>
            path.endsWith(`/${manifestPath}`) &&
            environmentPath(path) &&
            !path.split("/").includes(outputDirectory) &&
            globs.some((glob) => glob.match(path)),
        ),
      ),
    ].sort();
    const outputs = [
      outputDirectory,
      ...manifests.map(
        (path) => path.slice(0, -manifestPath.length) + outputDirectory,
      ),
    ];
    return {
      keyFiles: [lockPath, manifestPath, ...manifests],
      outputs,
      linkTargets: manifests.map((path) =>
        path.slice(0, -(manifestPath.length + 1)),
      ),
      pathEntries: outputs.map((path) => `${path}/.bin`),
    };
  } catch {
    throw new EnvironmentError();
  }
}

// Bun opens up to 64 requests at once by default. Keep it well inside the
// Provisioner gateway's attempt burst (provisioner.ts).
const networkConcurrency = "--network-concurrency=16";

export const bunAdapter: EnvironmentAdapter = {
  name: "bun",
  recipeVersion: 2,
  lockPath,
  defaultEgress: [{ hostname: "registry.npmjs.org", port: 443 }],
  layout,
  command(operation, hasLock, names = [], allowMajor = false) {
    if (
      (!names.length && allowMajor) ||
      (names.length > 0 && operation !== "update") ||
      names.some((name) => !validPackageName(name))
    )
      throw new EnvironmentError();
    switch (operation) {
      case "build":
        return {
          argv: hasLock
            ? ["bun", "install", "--frozen-lockfile", networkConcurrency]
            : ["bun", "install", networkConcurrency],
          archive: true,
          writesLock: !hasLock,
          reportsOutdated: false,
          ...(!hasLock && { warning: lockMissing }),
        };
      case "resolve":
        return {
          argv: ["bun", "install", networkConcurrency],
          archive: true,
          writesLock: true,
          reportsOutdated: false,
        };
      case "update":
        return {
          argv: [
            "bun",
            "update",
            networkConcurrency,
            ...(allowMajor ? ["--latest"] : []),
            ...(names.length ? ["--", ...names] : []),
          ],
          writesDeclarations: true,
          archive: true,
          writesLock: true,
          reportsOutdated: false,
        };
      case "outdated":
        return {
          argv: ["bun", "outdated"],
          archive: false,
          writesLock: false,
          reportsOutdated: true,
        };
    }
  },
};
