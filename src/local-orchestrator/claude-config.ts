import { validKeychainService as validService } from "../credentials.ts";
export { validService };
import { constants, closeSync, fstatSync, openSync, readSync } from "node:fs";
import {
  layerFile,
  loadConfig,
  type Layer,
  type Config,
} from "../config/layers.ts";
import { ConfigError, type ConfigFix } from "../config/messages.ts";

export { userConfigPath, userStateDirectory } from "../config/layers.ts";

export const CLAUDE_ACTORS = [
  "Concierge",
  "Planner",
  "Executor",
  "Reviewer",
] as const;
export type ClaudeActor = (typeof CLAUDE_ACTORS)[number];
export type ClaudeAuthMode = "api-key" | "external";
const CLAUDE_PATTERN_CODES = [
  "auth-required",
  "rate-limited",
  "config-invalid",
] as const;
export const CLAUDE_FAILURE_CODES = [
  ...CLAUDE_PATTERN_CODES,
  "volume-detached",
  "mount-busy",
  "shell-disabled",
  "credential-leak",
] as const;
export type ClaudePatternCode = (typeof CLAUDE_PATTERN_CODES)[number];
export type ClaudeFailureCode = (typeof CLAUDE_FAILURE_CODES)[number];
export interface ClaudeErrorPattern {
  readonly match: string;
  readonly code: ClaudePatternCode;
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
  if (value === "api-key" || value === "external") return value;
  return reject();
}

const looksLikeSecret = (value: string) =>
  /sk-[a-zA-Z0-9_-]{12,}|bearer\s+\S+/i.test(value);

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

function patterns(value: unknown, limit = 16): ClaudeErrorPattern[] {
  if (!Array.isArray(value) || value.length > limit) reject();
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

function leakPatterns(value: unknown, layer: Layer): string[] {
  // Migration can combine two legacy lists into one project-local list.
  if (!Array.isArray(value) || value.length > (layer === "local" ? 32 : 16))
    reject();
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

function parseConfig(value: unknown, layer: Layer, fix: ConfigFix) {
  const validate = <T>(key: string, reason: string, parse: () => T): T => {
    try {
      return parse();
    } catch (error) {
      if (!(error instanceof ClaudeConfigError)) throw error;
      throw new ConfigError(key, reason, fix);
    }
  };
  if (
    value &&
    typeof value === "object" &&
    (Object.hasOwn(value, "configDir") ||
      Reflect.get(value, "auth") === "config-dir")
  )
    throw new ConfigError(
      "claude",
      "Legacy volume configuration requires migration.",
      "Run agent-bootstrap migrate.",
    );
  const claude =
    value === undefined
      ? {}
      : validate(
          "claude",
          "Expected an object with supported Claude settings.",
          () =>
            object(value, [
              "auth",
              "model",
              "apiKey",
              "gateway",
              "errors",
              "leakPatterns",
            ]),
        );
  if (
    "model" in claude &&
    (typeof claude.model !== "string" ||
      !/^[a-z0-9][a-z0-9.-]{0,80}$/.test(claude.model) ||
      looksLikeSecret(claude.model))
  )
    throw new ConfigError(
      "claude.model",
      "Expected a valid model identifier.",
      fix,
    );
  if (layer === "local" && "gateway" in claude)
    throw new ConfigError(
      "claude.gateway",
      "Only the user layer can configure the Claude gateway.",
      fix,
    );
  const api =
    "apiKey" in claude
      ? validate(
          "claude.apiKey",
          "Expected an object with supported API key settings.",
          () => object(claude.apiKey, ["keychainService", "variable"]),
        )
      : {};
  if ("keychainService" in api && !validService(api.keychainService))
    throw new ConfigError(
      "claude.apiKey.keychainService",
      "Expected a valid Keychain service name.",
      fix,
    );
  if ("variable" in api && api.variable !== "ANTHROPIC_API_KEY")
    throw new ConfigError(
      "claude.apiKey.variable",
      "Only the supported API key variable is allowed.",
      fix,
    );
  return {
    model: claude.model as string | undefined,
    gatewayHosts:
      "gateway" in claude
        ? validate(
            "claude.gateway",
            "Expected a list of HTTPS destinations.",
            () => hosts(claude.gateway),
          )
        : undefined,
    auth:
      "auth" in claude
        ? validate(
            "claude.auth",
            "Expected a supported authentication mode.",
            () => parseClaudeAuthMode(claude.auth),
          )
        : undefined,
    service: api.keychainService as string | undefined,
    errors:
      "errors" in claude
        ? validate(
            "claude.errors",
            "Expected supported failure codes and bounded match patterns.",
            () => patterns(claude.errors),
          )
        : undefined,
    leakPatterns:
      "leakPatterns" in claude
        ? validate(
            "claude.leakPatterns",
            "Expected a list of bounded match patterns.",
            () => leakPatterns(claude.leakPatterns, layer),
          )
        : undefined,
  };
}

export function validateClaudeLayer(
  value: unknown,
  layer: Layer,
  fix: ConfigFix,
) {
  parseConfig(value, layer, fix);
}

export function readLegacyPrivateFile(
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
  readonly model?: string;
  readonly keychainService?: string;
  readonly gatewayHosts?: readonly string[];
  readonly config: Config;
  readonly errors: readonly ClaudeErrorPattern[];
  readonly warnings: readonly string[];
  readonly leakPatterns?: readonly string[];
}

export function loadClaudeConfig(
  env: NodeJS.ProcessEnv,
  targetDirectory?: string,
  override?: ClaudeAuthMode,
  layers = loadConfig(env, targetDirectory),
): EffectiveClaudeConfig {
  const warnings = new Set<string>();
  const userFix = layerFile("user", env);
  const localFix = layerFile("local", env, layers.directory);
  const user = parseConfig(layers.user.claude, "user", userFix);
  const target = parseConfig(layers.local.claude, "local", localFix);
  const model = env.LO_CLAUDE_MODEL ?? target.model ?? user.model;
  const auth = override ?? target.auth ?? user.auth ?? "api-key";
  if (auth !== "external" && Object.keys(layers.config.secretEnv ?? {}).length)
    throw new ConfigError(
      "secretEnv",
      "Secret grants require claude.auth to be external.",
      "Select external mode or remove the grants and retry.",
    );
  const source = override
    ? "flag"
    : target.auth
      ? "target"
      : user.auth
        ? "user"
        : "default";
  const gatewayHosts = user.gatewayHosts;
  const outgoingPatterns = [
    ...(user.leakPatterns ?? []),
    ...(target.leakPatterns ?? []),
  ];
  let keychainService =
    auth === "api-key" ? (target.service ?? user.service) : undefined;
  if (
    auth === "api-key" &&
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
    ...(model === undefined ? {} : { model }),
    ...(gatewayHosts ? { gatewayHosts } : {}),
    ...(keychainService ? { keychainService } : {}),
    config: layers.config,
    errors: patterns(layers.config.claude?.errors ?? [], 32),
    leakPatterns: [...new Set(outgoingPatterns)],
    warnings: [...warnings],
  };
}
