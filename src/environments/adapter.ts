import { createHash } from "node:crypto";
import type { QuarantineReason } from "../egress-gateway.ts";
import type { HostPort } from "../egress-policy.ts";

export type EnvironmentOperation = "build" | "resolve" | "update" | "outdated";
export type EnvironmentFailure =
  "env-fetch-failed" | "env-lock-mismatch" | "env-build-failed";
export const lockMissing = "env-lock-missing";

/** Why the egress gateway stopped every flow of a Provisioner run. */
export const GATEWAY_STOPS = [
  "rate-limited",
  "network-row-limit",
  "audit-failure",
  "listener-error",
] as const;
export type GatewayStop = (typeof GATEWAY_STOPS)[number];
// A new gateway reason must be added here too (checked both ways).
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const _sameStops: Same<GatewayStop, QuarantineReason> = true;
void _sameStops;

export class EnvironmentError extends Error {
  readonly code: EnvironmentFailure;
  readonly gatewayStopped?: GatewayStop;

  constructor(
    code: EnvironmentFailure = "env-build-failed",
    gatewayStopped?: GatewayStop,
  ) {
    super(code);
    this.code = code;
    if (gatewayStopped) this.gatewayStopped = gatewayStopped;
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
