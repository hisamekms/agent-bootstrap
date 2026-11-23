import { constants, closeSync, fstatSync, openSync, readSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

export const CLAUDE_ACTORS = [
  "Concierge",
  "Planner",
  "Executor",
  "Reviewer",
] as const;
export type ClaudeActor = (typeof CLAUDE_ACTORS)[number];
export type ClaudeAuthMode = "api-key" | "config-dir";
const CLAUDE_PATTERN_CODES = [
  "auth-required",
  "rate-limited",
  "config-invalid",
] as const;
export const CLAUDE_FAILURE_CODES = [
  ...CLAUDE_PATTERN_CODES,
  "credentials-detached",
  "config-tampered",
  "shell-disabled",
  "credential-leak",
] as const;
export type ClaudePatternCode = (typeof CLAUDE_PATTERN_CODES)[number];
export type ClaudeFailureCode = (typeof CLAUDE_FAILURE_CODES)[number];
export interface ClaudeErrorPattern {
  readonly match: string;
  readonly code: ClaudePatternCode;
}
export interface ClaudeDirectoryConfig {
  readonly volume: {
    image: string;
    keychainService: string;
    attach: "while-running";
  };
  readonly groups: Readonly<
    Record<string, { readonly actors: readonly ClaudeActor[] }>
  >;
  readonly egress: readonly string[];
  readonly loginEgress: readonly string[];
  readonly leakPatterns?: readonly string[];
  readonly errors: readonly ClaudeErrorPattern[];
}

const invalid = "Invalid Claude configuration.";
const unsafe =
  "Claude configuration must be a user-owned regular file with mode 0600.";
const maxBytes = 32768;

export class ClaudeConfigError extends Error {}

function reject(): never {
  throw new ClaudeConfigError(invalid);
}

function object(
  value: unknown,
  keys?: readonly string[],
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) reject();
  if (keys && Object.keys(value).some((key) => !keys.includes(key))) reject();
  return value as Record<string, unknown>;
}

export function parseClaudeAuthMode(value: unknown): ClaudeAuthMode {
  if (value === "api-key" || value === "config-dir") return value;
  return reject();
}

const looksLikeSecret = (value: string) =>
  /sk-[a-zA-Z0-9_-]{12,}|bearer\s+\S+/i.test(value);

export function validService(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(value) &&
    !looksLikeSecret(value)
  );
}

export function validGroup(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[a-z][a-z0-9-]{0,47}$/.test(value) &&
    !looksLikeSecret(value)
  );
}

export function validClaudeHostname(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= 253 &&
    !looksLikeSecret(value) &&
    /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(
      value,
    )
  );
}

function hosts(value: unknown) {
  if (!Array.isArray(value) || value.length > 32) reject();
  const parsed = value.map((item) => {
    if (typeof item !== "string" || !item.endsWith(":443")) reject();
    const hostname = item.slice(0, -4).toLowerCase();
    if (!validClaudeHostname(hostname)) reject();
    return hostname;
  });
  return [...new Set(parsed)];
}

function patterns(value: unknown): ClaudeErrorPattern[] {
  if (!Array.isArray(value) || value.length > 16) reject();
  return value.map((item) => {
    const { match, code } = object(item, ["match", "code"]);
    if (
      typeof match !== "string" ||
      match.length < 1 ||
      match.length > 160 ||
      looksLikeSecret(match) ||
      (code !== "auth-required" &&
        code !== "rate-limited" &&
        code !== "config-invalid")
    )
      reject();
    try {
      new RegExp(match, "i");
    } catch {
      reject();
    }
    return { match, code };
  });
}

function leakPatterns(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 16) reject();
  return value.map((pattern) => {
    if (
      typeof pattern !== "string" ||
      !pattern.length ||
      pattern.length > 160 ||
      looksLikeSecret(pattern)
    )
      reject();
    try {
      new RegExp(pattern, "i");
    } catch {
      reject();
    }
    return pattern;
  });
}

function groups(value: unknown, warnings: Set<string>) {
  const parsed = Object.create(null) as Record<
    string,
    { actors: ClaudeActor[] }
  >;
  for (const [name, group] of Object.entries(object(value))) {
    if (!validGroup(name)) reject();
    const { actors } = object(group, ["actors"]);
    if (!Array.isArray(actors) || actors.length > 8) reject();
    parsed[name] = {
      actors: actors.flatMap((actor) => {
        if (
          actor === "Researcher" ||
          actor === "verification" ||
          actor === "Verification"
        ) {
          warnings.add(
            "Researcher and verification are ignored in Claude actor groups.",
          );
          return [];
        }
        if (!CLAUDE_ACTORS.includes(actor)) reject();
        return [actor as ClaudeActor];
      }),
    };
  }
  return parsed;
}

function volume(value: unknown): Partial<ClaudeDirectoryConfig["volume"]> {
  const entry = object(value, ["image", "keychainService", "attach"]);
  const { image, keychainService, attach } = entry;
  if (
    "image" in entry &&
    (typeof image !== "string" ||
      !isAbsolute(image) ||
      resolve(image) !== image ||
      !image.endsWith(".sparseimage") ||
      /[\0\r\n]/.test(image) ||
      looksLikeSecret(image))
  )
    reject();
  if ("keychainService" in entry && !validService(keychainService)) reject();
  if ("attach" in entry && attach !== "while-running") reject();
  return entry as Partial<ClaudeDirectoryConfig["volume"]>;
}

function parseConfig(value: unknown, warnings: Set<string>, target = false) {
  const root = object(
    value,
    target ? ["claude", "profile", "argv"] : ["claude"],
  );
  if (target && ("profile" in root || "argv" in root)) {
    if (
      typeof root.profile !== "string" ||
      !Array.isArray(root.argv) ||
      root.argv.some(
        (entry) => typeof entry !== "string" || looksLikeSecret(entry),
      )
    )
      reject();
  }
  const claude =
    "claude" in root
      ? object(root.claude, ["auth", "apiKey", "configDir", "gateway"])
      : {};
  const api =
    "apiKey" in claude
      ? object(claude.apiKey, ["keychainService", "variable"])
      : {};
  if ("keychainService" in api && !validService(api.keychainService)) reject();
  if ("variable" in api && api.variable !== "ANTHROPIC_API_KEY") reject();
  const dir =
    "configDir" in claude
      ? object(claude.configDir, [
          "volume",
          "groups",
          "egress",
          "loginEgress",
          "errors",
          "leakPatterns",
        ])
      : {};
  return {
    gatewayHosts: "gateway" in claude ? hosts(claude.gateway) : undefined,
    auth: "auth" in claude ? parseClaudeAuthMode(claude.auth) : undefined,
    service: api.keychainService as string | undefined,
    volume: "volume" in dir ? volume(dir.volume) : {},
    groups: "groups" in dir ? groups(dir.groups, warnings) : {},
    egress: "egress" in dir ? hosts(dir.egress) : undefined,
    loginEgress: "loginEgress" in dir ? hosts(dir.loginEgress) : undefined,
    errors: "errors" in dir ? patterns(dir.errors) : undefined,
    leakPatterns:
      "leakPatterns" in dir ? leakPatterns(dir.leakPatterns) : undefined,
  };
}

export function userConfigPath(env: NodeJS.ProcessEnv) {
  return join(
    env.XDG_CONFIG_HOME || join(env.HOME || homedir(), ".config"),
    "agent-bootstrap",
    "config.json",
  );
}

export function userStateDirectory(env: NodeJS.ProcessEnv) {
  return join(
    env.XDG_STATE_HOME || join(env.HOME || homedir(), ".local", "state"),
    "agent-bootstrap",
  );
}

export function readPrivateConfig(
  path: string,
  limit = maxBytes,
  target = false,
): unknown {
  let fd: number;
  try {
    fd = openSync(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new ClaudeConfigError(unsafe);
  }
  try {
    const info = fstatSync(fd);
    if (
      !info.isFile() ||
      info.uid !== process.getuid?.() ||
      (target ? (info.mode & 0o077) !== 0 : (info.mode & 0o7777) !== 0o600) ||
      info.nlink !== 1
    )
      throw new ClaudeConfigError(unsafe);
    if (info.size > limit) reject();
    const bytes = Buffer.alloc(info.size + 1);
    const count = readSync(fd, bytes);
    if (count !== info.size) reject();
    try {
      return JSON.parse(bytes.toString("utf8", 0, count));
    } catch {
      return reject();
    }
  } finally {
    closeSync(fd);
  }
}

export interface EffectiveClaudeConfig {
  readonly auth: ClaudeAuthMode;
  readonly source: "flag" | "target" | "user" | "default";
  readonly keychainService?: string;
  readonly gatewayHosts?: readonly string[];
  readonly configDir?: ClaudeDirectoryConfig;
  readonly warnings: readonly string[];
  readonly leakPatterns?: readonly string[];
}

export function loadClaudeConfig(
  env: NodeJS.ProcessEnv,
  targetDirectory?: string,
  override?: ClaudeAuthMode,
): EffectiveClaudeConfig {
  const warnings = new Set<string>();
  const user = parseConfig(readPrivateConfig(userConfigPath(env)), warnings);
  const target = parseConfig(
    targetDirectory
      ? readPrivateConfig(
          join(targetDirectory, "config.json"),
          256 * 1024,
          true,
        )
      : {},
    warnings,
    true,
  );
  const auth = override ?? target.auth ?? user.auth ?? "api-key";
  const source = override
    ? "flag"
    : target.auth
      ? "target"
      : user.auth
        ? "user"
        : "default";
  if (target.gatewayHosts !== undefined) reject();
  const gatewayHosts = user.gatewayHosts;
  const outgoingPatterns = [
    ...(user.leakPatterns ?? []),
    ...(target.leakPatterns ?? []),
  ];
  if (auth === "api-key") {
    let keychainService = target.service ?? user.service;
    if (
      !keychainService &&
      (env.LO_CLAUDE_KEYCHAIN !== undefined || env.LO_CLAUDE_AUTH !== undefined)
    ) {
      warnings.add(
        "LO_CLAUDE_AUTH and LO_CLAUDE_KEYCHAIN are deprecated. Set claude.apiKey in config.json.",
      );
      if (
        (env.LO_CLAUDE_AUTH !== undefined &&
          env.LO_CLAUDE_AUTH !== "operator:ANTHROPIC_API_KEY:x-api-key") ||
        (env.LO_CLAUDE_KEYCHAIN !== undefined &&
          !validService(env.LO_CLAUDE_KEYCHAIN))
      )
        reject();
      keychainService = env.LO_CLAUDE_KEYCHAIN;
    }
    return {
      auth,
      source,
      ...(gatewayHosts ? { gatewayHosts } : {}),
      ...(outgoingPatterns.length ? { leakPatterns: outgoingPatterns } : {}),
      ...(keychainService ? { keychainService } : {}),
      warnings: [...warnings],
    };
  }

  const { image, keychainService, attach } = {
    ...user.volume,
    ...target.volume,
  };
  if (!image || !keychainService || attach !== "while-running") reject();
  const actorGroups = { ...user.groups, ...target.groups };
  const actors = Object.values(actorGroups).flatMap((group) => group.actors);
  if (
    actors.length !== CLAUDE_ACTORS.length ||
    new Set(actors).size !== actors.length
  )
    reject();
  return {
    auth,
    source,
    warnings: [...warnings],
    configDir: {
      volume: { image, keychainService, attach },
      groups: actorGroups,
      egress: target.egress ?? user.egress ?? [],
      loginEgress: target.loginEgress ?? user.loginEgress ?? [],
      errors: target.errors ?? user.errors ?? [],
      leakPatterns: outgoingPatterns,
    },
  };
}
