import {
  digestPattern,
  GATEWAY_STOPS,
  lockMissing,
  type EnvironmentFailure,
  type GatewayStop,
  type EnvironmentOperation,
} from "./adapter.ts";
import {
  validPackage,
  validPackageName,
  validPackageVersion,
  type PackageDiff,
} from "./lock.ts";

export interface EnvironmentEvidence {
  readonly key: string;
  readonly operation: EnvironmentOperation;
  readonly durationMs: number;
  readonly size: number;
  readonly cacheHit: boolean;
  readonly destinationsReached: readonly string[];
  readonly packageDiff: PackageDiff;
  readonly warning?: typeof lockMissing;
  readonly failure?: EnvironmentFailure;
  readonly gatewayStopped?: GatewayStop;
}

export type EnvironmentEvent = EnvironmentEvidence & {
  readonly kind: "environment.started" | "environment.finished";
  readonly invocationId: string;
};

export const emptyPackageDiff: PackageDiff = {
  added: [],
  removed: [],
  changed: [],
};

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new TypeError("Invalid environment evidence");
  return value as Record<string, unknown>;
}

function strings(
  value: unknown,
  validate: (item: unknown) => boolean,
): value is string[] {
  return (
    Array.isArray(value) && value.length <= 100_000 && value.every(validate)
  );
}

function destination(value: unknown) {
  if (typeof value !== "string") return false;
  const match = /^([a-z0-9.-]{1,253}):([1-9][0-9]{0,4})$/.exec(value);
  return !!match && Number(match[2]) <= 65535;
}

function count(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export function parseEnvironmentEvidence(value: unknown): EnvironmentEvidence {
  const {
    key,
    operation,
    durationMs,
    size,
    cacheHit,
    destinationsReached,
    packageDiff,
    warning,
    failure,
    gatewayStopped,
  } = object(value);
  const { added, removed, changed } = object(packageDiff);
  if (
    typeof key !== "string" ||
    !digestPattern.test(key) ||
    (operation !== "build" &&
      operation !== "resolve" &&
      operation !== "update" &&
      operation !== "outdated") ||
    !count(durationMs) ||
    !count(size) ||
    typeof cacheHit !== "boolean" ||
    !strings(destinationsReached, destination) ||
    !strings(added, validPackage) ||
    !strings(removed, validPackage) ||
    !Array.isArray(changed) ||
    changed.length > 100_000 ||
    (warning !== undefined && warning !== lockMissing) ||
    (failure !== undefined &&
      failure !== "env-fetch-failed" &&
      failure !== "env-lock-mismatch" &&
      failure !== "env-build-failed") ||
    (gatewayStopped !== undefined &&
      (failure === undefined ||
        !GATEWAY_STOPS.includes(gatewayStopped as GatewayStop)))
  )
    throw new TypeError("Invalid environment evidence");
  return {
    key,
    operation,
    durationMs,
    size,
    cacheHit,
    destinationsReached: [...destinationsReached],
    packageDiff: {
      added: [...added],
      removed: [...removed],
      changed: changed.map((value: unknown) => {
        const { name, from, to } = object(value);
        if (
          !validPackageName(name) ||
          !strings(from, validPackageVersion) ||
          !strings(to, validPackageVersion)
        )
          throw new TypeError("Invalid environment evidence");
        return { name, from: [...from], to: [...to] };
      }),
    },
    ...(warning && { warning }),
    ...(failure && { failure }),
    ...(gatewayStopped !== undefined && {
      gatewayStopped: gatewayStopped as GatewayStop,
    }),
  };
}
