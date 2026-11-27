import { SandboxRuntimeError } from "./sandbox-runtime.ts";

export const PROFILE_NAMES = [
  "base",
  "db",
  "browser",
  "concierge",
  "bun",
] as const;
export type ProfileName = (typeof PROFILE_NAMES)[number];

export interface SandboxProfile {
  /** `name@sha256:<64 hex>` */
  readonly image: string;
  /** Integer 256..8192. Default: backend default. */
  readonly memoryMiB?: number;
  /** Integer 1..8. Default: backend default. */
  readonly cpus?: number;
}

export type ProfileRole =
  | "Coordinator"
  | "Planner"
  | "Worker"
  | "Reviewer"
  | "Verification"
  | "Concierge"
  | "Provisioner";

/** Which profiles each role may request. */
export const ROLE_PROFILES: Readonly<
  Record<ProfileRole, readonly ProfileName[]>
> = Object.freeze({
  Coordinator: Object.freeze(["base"] as const),
  Planner: Object.freeze(["base"] as const),
  Reviewer: Object.freeze(["base"] as const),
  Worker: Object.freeze(["base", "db", "browser", "bun"] as const),
  Verification: Object.freeze(["base", "db", "browser", "bun"] as const),
  Concierge: Object.freeze(["concierge"] as const),
  Provisioner: Object.freeze(["bun"] as const),
});

const IMAGE = /^[a-zA-Z0-9][a-zA-Z0-9._/:-]*@sha256:([a-f0-9]{64})$/;

function invalid(): never {
  throw new SandboxRuntimeError("invalid-input");
}

function isName(name: unknown): name is ProfileName {
  return (
    typeof name === "string" &&
    (PROFILE_NAMES as readonly string[]).includes(name)
  );
}

function ranged(value: unknown, min: number, max: number): void {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < min ||
    value > max
  )
    invalid();
}

export class ProfileCatalog {
  readonly #profiles: ReadonlyMap<ProfileName, Readonly<SandboxProfile>>;

  constructor(profiles: Partial<Record<ProfileName, SandboxProfile>>) {
    if (typeof profiles !== "object" || profiles === null) invalid();
    const entries = new Map<ProfileName, Readonly<SandboxProfile>>();
    for (const key of Object.keys(profiles)) {
      if (!isName(key)) invalid();
      const profile = profiles[key];
      if (typeof profile !== "object" || profile === null) invalid();
      for (const field of Object.keys(profile))
        if (field !== "image" && field !== "memoryMiB" && field !== "cpus")
          invalid();
      if (typeof profile.image !== "string" || !IMAGE.test(profile.image))
        invalid();
      if (profile.memoryMiB !== undefined) ranged(profile.memoryMiB, 256, 8192);
      if (profile.cpus !== undefined) ranged(profile.cpus, 1, 8);
      entries.set(
        key,
        Object.freeze({
          image: profile.image,
          ...(profile.memoryMiB !== undefined
            ? { memoryMiB: profile.memoryMiB }
            : {}),
          ...(profile.cpus !== undefined ? { cpus: profile.cpus } : {}),
        }),
      );
    }
    if (!entries.has("base")) invalid();
    this.#profiles = entries;
  }

  has(name: unknown): name is ProfileName {
    return isName(name) && this.#profiles.has(name);
  }

  get(name: ProfileName): SandboxProfile {
    const profile = this.#profiles.get(name);
    if (!profile) invalid();
    return profile;
  }

  /** The 64-hex image digest of a configured profile, for audit. */
  imageDigest(name: ProfileName): string {
    return this.get(name).image.slice(-64);
  }
}
