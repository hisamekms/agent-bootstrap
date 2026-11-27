import type {
  EnvironmentAdapter,
  EnvironmentLayout,
  EnvironmentTree,
} from "./adapter.ts";
import { EnvironmentError, lockMissing } from "./adapter.ts";

import { validPackageName } from "./lock.ts";

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

/** Bun can omit an empty lock for a project with no workspace or dependencies. */
export async function allowsEmptyLock(tree: EnvironmentTree, keyFiles: number) {
  if (keyFiles !== 2) return false;
  const root = await tree.read("package.json");
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
    const root = await tree.read("package.json");
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
      return new Bun.Glob(`${pattern.replace(/\/$/, "")}/package.json`);
    });
    const manifests = [
      ...new Set(
        tree.paths.filter(
          (path) =>
            path.endsWith("/package.json") &&
            environmentPath(path) &&
            !path.split("/").includes("node_modules") &&
            globs.some((glob) => glob.match(path)),
        ),
      ),
    ].sort();
    const outputs = [
      "node_modules",
      ...manifests.map((path) =>
        path.replace(/package\.json$/, "node_modules"),
      ),
    ];
    return {
      keyFiles: ["bun.lock", "package.json", ...manifests],
      outputs,
      linkTargets: manifests.map((path) =>
        path.replace(/\/package\.json$/, ""),
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
  lockPath: "bun.lock",
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
