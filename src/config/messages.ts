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

export function invalid(
  key: string,
  reason: string,
  next: string | ConfigFix,
): never {
  throw new ConfigError(key, reason, next);
}
