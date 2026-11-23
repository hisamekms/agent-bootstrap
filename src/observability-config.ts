import { lstatSync, realpathSync, statSync } from "node:fs";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { types } from "node:util";
import type { SandboxSpec } from "./sandbox-runtime.ts";

export const DEFAULT_TELEMETRY_MAX_TOTAL_BYTES = 1024 ** 3;
export const DEFAULT_GATEWAY_LIMITS = Object.freeze({
  attemptBurst: 32,
  attemptsPerSecond: 16,
  maxNetworkRows: 4096,
  maxRelays: 64,
});

type NetworkLimits = {
  readonly [K in keyof typeof DEFAULT_GATEWAY_LIMITS]: number;
};

export interface ObservabilityConfig {
  readonly directory: string;
  readonly audit: {
    readonly mode: "required" | "disabled";
    readonly network?: NetworkLimits;
  };
  readonly telemetry: {
    readonly enabled: boolean;
    readonly resourceSamplingIntervalMs: number;
    readonly traceSamplingRatio: number;
    readonly maxTotalBytes?: number;
  };
}

export interface ObservabilityRoots {
  /** The effective MSB_HOME used by the runtime. */
  readonly msbHome: string;
  readonly stagingRoot: string;
}

function invalid(field: string): never {
  throw new TypeError(`Invalid observability config: ${field}`);
}

function dataRecord(
  value: unknown,
  field: string,
  allowed: readonly string[],
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || types.isProxy(value))
    return invalid(field);
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== null && prototype !== Object.prototype)
    return invalid(field);

  const descriptors = Object.getOwnPropertyDescriptors(value);
  const result: Record<string, unknown> = Object.create(null);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== "string" || !allowed.includes(key))
      return invalid(field);
    const descriptor = descriptors[key];
    if (!descriptor || !Object.hasOwn(descriptor, "value"))
      return invalid(field);
    result[key] = descriptor.value;
  }
  return result;
}

function absoluteDirectory(value: unknown, field: string): string {
  // A '..' after a symlink can resolve differently from lexical normalization.
  if (
    typeof value !== "string" ||
    !isAbsolute(value) ||
    value.includes("\0") ||
    value.split(sep).includes("..")
  )
    return invalid(field);
  return resolve(value);
}

function canonicalDirectory(path: string, field: string): string {
  // A directory may not exist yet. Resolve its deepest existing ancestor
  // and carry the missing suffix forward. A dangling link fails validation.
  const missing: string[] = [];
  try {
    while (!lstatSync(path, { throwIfNoEntry: false })) {
      missing.push(basename(path));
      const parent = dirname(path);
      if (parent === path) return invalid(field);
      path = parent;
    }
    const canonical = realpathSync(path);
    if (statSync(canonical).isDirectory())
      return join(canonical, ...missing.reverse());
  } catch {
    return invalid(field);
  }
  return invalid(field);
}

function within(root: string, directory: string): boolean {
  // macOS volumes may fold case and Unicode even for paths not yet created.
  if (process.platform === "darwin") {
    root = root.normalize("NFD").toLowerCase();
    directory = directory.normalize("NFD").toLowerCase();
  }
  const suffix = relative(root, directory);
  return (
    suffix !== ".." && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix)
  );
}

function bounded(
  value: unknown,
  min: number,
  max: number,
  field: string,
): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < min ||
    value > max
  )
    return invalid(field);
  return value;
}

function integerLimit(value: unknown, max: number, field: string): number {
  const number = bounded(value, 1, max, field);
  if (!Number.isSafeInteger(number)) return invalid(field);
  return number;
}

/** Parse host config without creating directories or reading environment variables. */
export function parseObservabilityConfig(
  value: unknown,
  roots: ObservabilityRoots,
) {
  const input = dataRecord(value, "config", [
    "directory",
    "audit",
    "telemetry",
  ]);
  const audit = dataRecord(
    Object.hasOwn(input, "audit") ? input.audit : {},
    "audit",
    ["mode", "network"],
  );
  const telemetry = dataRecord(
    Object.hasOwn(input, "telemetry") ? input.telemetry : {},
    "telemetry",
    [
      "enabled",
      "resourceSamplingIntervalMs",
      "traceSamplingRatio",
      "maxTotalBytes",
    ],
  );
  const network = dataRecord(
    Object.hasOwn(audit, "network") ? audit.network : {},
    "audit.network",
    Object.keys(DEFAULT_GATEWAY_LIMITS),
  );
  const {
    attemptBurst = DEFAULT_GATEWAY_LIMITS.attemptBurst,
    attemptsPerSecond = DEFAULT_GATEWAY_LIMITS.attemptsPerSecond,
    maxNetworkRows = DEFAULT_GATEWAY_LIMITS.maxNetworkRows,
    maxRelays = DEFAULT_GATEWAY_LIMITS.maxRelays,
  } = network;
  const { mode = "required" } = audit;
  if (mode !== "required" && mode !== "disabled") return invalid("audit.mode");
  const {
    enabled = true,
    resourceSamplingIntervalMs = 1000,
    traceSamplingRatio = 1,
    maxTotalBytes = DEFAULT_TELEMETRY_MAX_TOTAL_BYTES,
  } = telemetry;
  if (typeof enabled !== "boolean") return invalid("telemetry.enabled");

  const requested = absoluteDirectory(input.directory, "directory");
  const directory = canonicalDirectory(requested, "directory");
  for (const field of ["msbHome", "stagingRoot"] as const) {
    const root = absoluteDirectory(roots[field], field);
    if (
      within(root, requested) ||
      within(canonicalDirectory(root, field), directory)
    )
      return invalid("directory overlaps a protected root");
  }

  return Object.freeze({
    directory,
    audit: Object.freeze({
      mode,
      network: Object.freeze({
        attemptBurst: integerLimit(
          attemptBurst,
          4096,
          "audit.network.attemptBurst",
        ),
        attemptsPerSecond: integerLimit(
          attemptsPerSecond,
          4096,
          "audit.network.attemptsPerSecond",
        ),
        maxNetworkRows: integerLimit(
          maxNetworkRows,
          1_000_000,
          "audit.network.maxNetworkRows",
        ),
        maxRelays: integerLimit(maxRelays, 1024, "audit.network.maxRelays"),
      }),
    }),
    telemetry: Object.freeze({
      enabled,
      maxTotalBytes: integerLimit(
        maxTotalBytes,
        1024 ** 4,
        "telemetry.maxTotalBytes",
      ),
      resourceSamplingIntervalMs: bounded(
        resourceSamplingIntervalMs,
        250,
        60000,
        "telemetry.resourceSamplingIntervalMs",
      ),
      traceSamplingRatio: bounded(
        traceSamplingRatio,
        0,
        1,
        "telemetry.traceSamplingRatio",
      ),
    }),
  } satisfies ObservabilityConfig);
}

/** Disabled audit permits only offline fixture-style runs. */
export function requireAudited(
  spec: SandboxSpec,
  config: Pick<ObservabilityConfig, "audit">,
): void {
  if (config.audit.mode !== "disabled") return;
  if (types.isProxy(spec)) throw new TypeError("Invalid sandbox spec");
  if (
    "provider" in spec ||
    "tools" in spec ||
    "repository" in spec ||
    "hostTcpPort" in spec
  )
    throw new Error("Agent runs require durable audit");
}
