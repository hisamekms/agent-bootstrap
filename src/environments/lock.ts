import { createHash } from "node:crypto";
import { EnvironmentError } from "./adapter.ts";

declare const Bun: { JSONC: { parse(value: string): unknown } };

export const maxEnvironmentPackages = 32_768;

export interface PackageChange {
  readonly name: string;
  readonly from: readonly string[];
  readonly to: readonly string[];
}

export interface PackageDiff {
  readonly added: readonly string[];
  readonly removed: readonly string[];
  readonly changed: readonly PackageChange[];
}

const packageName = /^(?:@[a-z0-9_.-]+\/)?[a-z0-9_][a-z0-9_.-]*$/i;
const publicVersion = /^\d+\.\d+\.\d+(?:-[\da-z.-]+)?(?:\+[\da-z.-]+)?$/i;
const privateResolution =
  /^(?:workspace:|file:|link:|https?:|git(?:\+[^:]+)?:|github:|bitbucket:|gitlab:).*$/;
const resolutionDigest = /^(?:workspace|source):sha256:[a-f0-9]{64}$/;

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function resolution(value: string) {
  if (publicVersion.test(value)) return value;
  if (!privateResolution.test(value))
    throw new EnvironmentError("env-lock-mismatch");
  // Source locators can contain private paths or credentials.
  const kind = value.startsWith("workspace:") ? "workspace" : "source";
  return `${kind}:sha256:${createHash("sha256").update(value).digest("hex")}`;
}

export function validPackageName(value: unknown): value is string {
  return (
    typeof value === "string" && value.length <= 214 && packageName.test(value)
  );
}

export function validPackageVersion(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= 256 &&
    (publicVersion.test(value) || resolutionDigest.test(value))
  );
}

export function validPackage(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const at = value.lastIndexOf("@");
  return (
    at > 0 &&
    validPackageName(value.slice(0, at)) &&
    validPackageVersion(value.slice(at + 1))
  );
}

export function parseBunLock(bytes: Uint8Array | string): string[] {
  try {
    if (bytes.length > 16 * 1024 * 1024) throw new EnvironmentError();
    const source =
      typeof bytes === "string"
        ? bytes
        : new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const root: unknown = Bun.JSONC.parse(source);
    if (
      !object(root) ||
      ![0, 1, 2].includes(Number(root.lockfileVersion)) ||
      typeof root.lockfileVersion !== "number" ||
      (root.packages !== undefined && !object(root.packages)) ||
      (root.workspaces !== undefined && !object(root.workspaces)) ||
      (root.packages === undefined && root.workspaces === undefined)
    )
      throw new EnvironmentError();
    const entries = Object.values(root.packages ?? {});
    if (
      entries.length > maxEnvironmentPackages ||
      Object.values(root.workspaces ?? {}).some(
        (workspace) => !object(workspace),
      )
    )
      throw new EnvironmentError();
    const packages = new Set<string>();
    for (const tuple of entries) {
      if (!Array.isArray(tuple) || typeof tuple[0] !== "string")
        throw new EnvironmentError();
      const at = tuple[0].indexOf("@", 1);
      const name = tuple[0].slice(0, at);
      const version = tuple[0].slice(at + 1);
      if (at < 1 || !validPackageName(name) || version.length > 4096)
        throw new EnvironmentError();
      const display = resolution(version);
      if (!validPackageVersion(display)) throw new EnvironmentError();
      packages.add(`${name}@${display}`);
    }
    return [...packages].sort();
  } catch {
    throw new EnvironmentError("env-lock-mismatch");
  }
}

function versions(packages: readonly string[]) {
  const byName = new Map<string, string[]>();
  for (const item of packages) {
    const at = item.lastIndexOf("@");
    const name = item.slice(0, at);
    const version = item.slice(at + 1);
    const list = byName.get(name) ?? [];
    list.push(version);
    byName.set(name, list);
  }
  return byName;
}

export function diffPackages(
  before: readonly string[],
  after: readonly string[],
): PackageDiff {
  const added: string[] = [];
  const removed: string[] = [];
  const changed: PackageChange[] = [];
  const previous = versions(before);
  const next = versions(after);
  for (const name of [
    ...new Set([...previous.keys(), ...next.keys()]),
  ].sort()) {
    const from = previous.get(name) ?? [];
    const to = next.get(name) ?? [];
    if (!from.length) {
      for (const version of to) added.push(`${name}@${version}`);
    } else if (!to.length) {
      for (const version of from) removed.push(`${name}@${version}`);
    } else if (from.join() !== to.join()) changed.push({ name, from, to });
  }
  return { added, removed, changed };
}

export function diffBunLocks(
  before: Uint8Array | string,
  after: Uint8Array | string,
): PackageDiff {
  return diffPackages(parseBunLock(before), parseBunLock(after));
}
