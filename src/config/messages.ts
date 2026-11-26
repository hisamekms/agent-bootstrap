export interface ConfigFix {
  readonly label: string;
  readonly path: string;
  readonly next: string;
}

export class ConfigError extends Error {
  readonly next: string;
  constructor(key: string, reason: string, fix: string | ConfigFix) {
    const location =
      typeof fix === "string"
        ? "Invalid configuration"
        : `Invalid ${fix.label} (${fix.path})`;
    super(`${location}: ${key}. ${reason}`);
    this.next = typeof fix === "string" ? fix : fix.next;
  }

  doctorCheck() {
    return {
      id: "configuration",
      status: "wrong" as const,
      detail: this.message,
      fix: [this.next],
      needsHuman: true,
      needsNetwork: false,
    };
  }
}

export class ActorConfigError extends ConfigError {
  readonly code = "config-invalid" as const;
  readonly key: string;

  constructor(key: string, reason: string, fix: string | ConfigFix) {
    super(key, reason, fix);
    this.key = key;
  }

  override doctorCheck() {
    return { ...super.doctorCheck(), code: this.code, key: this.key };
  }
}

export function invalid(
  key: string,
  reason: string,
  next: string | ConfigFix,
): never {
  throw new ConfigError(key, reason, next);
}
