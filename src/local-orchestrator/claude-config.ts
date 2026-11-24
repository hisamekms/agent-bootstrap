import { constants, closeSync, fstatSync, openSync, readSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { layerFile, loadConfig, type Layer } from "../config/layers.ts";
import { ConfigError, type ConfigFix } from "../config/messages.ts";

export { userConfigPath, userStateDirectory } from "../config/layers.ts";

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

function parseConfig(
  value: unknown,
  warnings: Set<string>,
  layer: Layer,
  fix: ConfigFix,
) {
  const validate = <T>(key: string, reason: string, parse: () => T): T => {
    try {
      return parse();
    } catch (error) {
      if (!(error instanceof ClaudeConfigError)) throw error;
      throw new ConfigError(key, reason, fix);
    }
  };
  const claude =
    value === undefined
      ? {}
      : validate(
          "claude",
          "Expected an object with supported Claude settings.",
          () =>
            object(value, ["auth", "model", "apiKey", "configDir", "gateway"]),
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
  const dir =
    "configDir" in claude
      ? validate(
          "claude.configDir",
          "Expected an object with supported configuration directory settings.",
          () =>
            object(claude.configDir, [
              "volume",
              "groups",
              "egress",
              "loginEgress",
              "errors",
              "leakPatterns",
            ]),
        )
      : {};
  if (layer === "local" && "volume" in dir)
    throw new ConfigError(
      "claude.configDir.volume",
      "Only the user layer can define the Claude configuration volume.",
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
    volume:
      "volume" in dir
        ? validate(
            "claude.configDir.volume",
            "The volume definition has an invalid field.",
            () => volume(dir.volume),
          )
        : {},
    groups:
      "groups" in dir
        ? validate(
            "claude.configDir.groups",
            "The actor group definitions have an invalid field.",
            () => groups(dir.groups, warnings),
          )
        : {},
    egress:
      "egress" in dir
        ? validate(
            "claude.configDir.egress",
            "Expected a list of HTTPS destinations.",
            () => hosts(dir.egress),
          )
        : undefined,
    loginEgress:
      "loginEgress" in dir
        ? validate(
            "claude.configDir.loginEgress",
            "Expected a list of HTTPS destinations.",
            () => hosts(dir.loginEgress),
          )
        : undefined,
    errors:
      "errors" in dir
        ? validate(
            "claude.configDir.errors",
            "Expected supported failure codes and bounded match patterns.",
            () => patterns(dir.errors),
          )
        : undefined,
    leakPatterns:
      "leakPatterns" in dir
        ? validate(
            "claude.configDir.leakPatterns",
            "Expected a list of bounded match patterns.",
            () => leakPatterns(dir.leakPatterns),
          )
        : undefined,
  };
}

export function validateClaudeLayer(
  value: unknown,
  layer: Layer,
  fix: ConfigFix,
) {
  parseConfig(value, new Set(), layer, fix);
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
  readonly configDir?: ClaudeDirectoryConfig;
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
  const user = parseConfig(layers.user.claude, warnings, "user", userFix);
  const target = parseConfig(layers.local.claude, warnings, "local", localFix);
  const model = env.LO_CLAUDE_MODEL ?? target.model ?? user.model;
  const auth = override ?? target.auth ?? user.auth ?? "api-key";
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
      ...(model === undefined ? {} : { model }),
      ...(gatewayHosts ? { gatewayHosts } : {}),
      ...(outgoingPatterns.length ? { leakPatterns: outgoingPatterns } : {}),
      ...(keychainService ? { keychainService } : {}),
      warnings: [...warnings],
    };
  }

  const { image, keychainService, attach } = user.volume;
  if (!image || !keychainService || attach !== "while-running")
    throw new ConfigError(
      "claude.configDir.volume",
      "The volume definition is incomplete.",
      userFix,
    );
  const actorGroups = { ...user.groups, ...target.groups };
  const actors = Object.values(actorGroups).flatMap((group) => group.actors);
  if (
    actors.length !== CLAUDE_ACTORS.length ||
    new Set(actors).size !== actors.length
  )
    throw new ConfigError(
      "claude.configDir.groups",
      "Each supported actor must appear in exactly one group.",
      Object.keys(target.groups).length ? localFix : userFix,
    );
  return {
    auth,
    source,
    ...(model === undefined ? {} : { model }),
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
