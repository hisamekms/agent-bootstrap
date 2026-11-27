import { createHash } from "node:crypto";
import type { HostPort } from "../egress-policy.ts";

export type EnvironmentOperation = "build" | "resolve" | "update" | "outdated";
export type EnvironmentFailure =
  "env-fetch-failed" | "env-lock-mismatch" | "env-build-failed";
export const lockMissing = "env-lock-missing";

export class EnvironmentError extends Error {
  readonly code: EnvironmentFailure;

  constructor(code: EnvironmentFailure = "env-build-failed") {
    super(code);
    this.code = code;
    this.name = "EnvironmentError";
  }
}

export interface EnvironmentTree {
  readonly paths: readonly string[];
  read(path: string): Promise<Uint8Array | undefined>;
}

export interface EnvironmentLayout {
  readonly keyFiles: readonly string[];
  readonly outputs: readonly string[];
  /** Source-tree directories that output symlinks may name exactly, such
   * as Bun workspace packages. Links may not resolve beneath them. */
  readonly linkTargets: readonly string[];
  readonly pathEntries: readonly string[];
}

export interface EnvironmentStep {
  readonly argv: readonly string[];
  readonly archive: boolean;
  readonly writesLock: boolean;
  readonly reportsOutdated: boolean;
  readonly warning?: typeof lockMissing;
}

export interface EnvironmentAdapter {
  readonly name: string;
  readonly recipeVersion: number;
  readonly lockPath: string;
  readonly defaultEgress: readonly HostPort[];
  layout(tree: EnvironmentTree): Promise<EnvironmentLayout>;
  command(
    operation: EnvironmentOperation,
    hasLock: boolean,
    names?: readonly string[],
  ): EnvironmentStep | undefined;
}

export const digestPattern = /^[a-f0-9]{64}$/;

export async function identifyEnvironment(
  tree: EnvironmentTree,
  profileDigest: string,
  adapter: EnvironmentAdapter,
) {
  if (!digestPattern.test(profileDigest)) throw new EnvironmentError();
  const layout = await adapter.layout(tree);
  const hash = createHash("sha256");
  hash.update(
    JSON.stringify([profileDigest, adapter.name, adapter.recipeVersion]),
  );
  let lock: Uint8Array | undefined;
  for (const path of [...new Set(layout.keyFiles)].sort()) {
    const bytes = await tree.read(path);
    if (path === adapter.lockPath) lock = bytes;
    hash.update(JSON.stringify([path, bytes?.length ?? null]));
    if (bytes) hash.update(bytes);
  }
  return { key: hash.digest("hex"), layout, lock, profileDigest };
}
