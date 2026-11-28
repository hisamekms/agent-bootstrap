import {
  autoMergeMethods,
  mergeMethods,
  validPublishRef,
  validPublishRemote,
  type PublishConfig,
} from "../publish/port.ts";
import { codexExecutorOptions } from "../local-orchestrator/codex-executor.ts";
import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve, basename } from "node:path";
import {
  ROLE_PROFILES,
  type ProfileName,
  type ProfileRole,
} from "../sandbox-profiles.ts";
import {
  parseVerificationConfig,
  type VerificationConfig,
} from "../local-orchestrator/verification.ts";
import {
  parseHostChecks,
  validateHostCheckHomes,
  type HostCheckDeclaration,
} from "../local-orchestrator/host-checks.ts";
import { msbHomeCandidate } from "./msb-home.ts";
import { listProjects } from "./projects.ts";
import {
  localActorHarnesses,
  type Harness,
  type LocalActorHarnesses,
} from "../actors.ts";
import { validCodexModel } from "../codex-exec.ts";
import { EgressPolicy, type HostPort } from "../egress-policy.ts";
import { CLAUDE_MOUNT_ENV } from "../claude-code.ts";
import {
  isSafeCredentialVariable,
  VERIFICATION_TIMEOUT_LIMIT_MS,
} from "../sandbox-runtime.ts";
import {
  CLAUDE_ACTORS,
  validClaudeHostname,
  validService,
  validateClaudeLayer,
} from "../local-orchestrator/claude-config.ts";
import {
  ActorConfigError,
  ConfigError,
  invalid,
  type ConfigFix,
} from "./messages.ts";

export type Layer = "user" | "approved" | "local";
export const projectName = /^[a-z][a-z0-9-]{0,47}$/;
const egressActors = [
  "Concierge",
  "Planner",
  "Researcher",
  "Executor",
  "Reviewer",
  "Coordinator",
  "shell",
] as const;
export type EgressActor = (typeof egressActors)[number];
type Profiles = Partial<Record<ProfileRole, ProfileName>>;
export interface VolumeDefinition {
  image: string;
  keychainService: string;
  attach: "while-running";
}
export const mountSegment = /^[a-z0-9][a-z0-9._-]{0,63}$/;
export const mountPath = /^\/mnt\/[a-z0-9][a-z0-9._-]{0,63}$/;
export interface MountDeclaration {
  volume: string;
  dir: string;
  path: string;
  actors: readonly string[];
  mode?: "ro" | "rw";
  env?: string;
}
export interface SecretDefinition {
  readonly keychainService: string;
}
const secretActors = ["Planner", "Executor", "Reviewer"] as const;
export type SecretActor = (typeof secretActors)[number];
export interface SecretEnvGrant {
  readonly secret: string;
  readonly actors: readonly SecretActor[];
}
export interface Config {
  version: 1;
  actors?: { Executor?: Harness };
  codex?: { model: string; auth: "siwc" };
  microsandbox?: { home: string };
  repositories?: { root: string };
  verification?: VerificationConfig;
  hostChecks?: readonly HostCheckDeclaration[];
  claude?: Record<string, unknown>;
  profiles?: Profiles;
  egress?: Partial<Record<EgressActor, readonly string[]>>;
  publish?: Partial<PublishConfig>;
  environment?: {
    enabled?: boolean;
    autoBuild?: boolean;
    allow?: readonly string[];
  };
  mounts?: Record<string, MountDeclaration>;
  volumes?: Record<string, VolumeDefinition>;
  secrets?: Record<string, SecretDefinition>;
  secretEnv?: Record<string, SecretEnvGrant>;
}

export interface ApprovedConfig {
  version: 1;
  commit: string;
  blob: string;
  config: Config;
}

export const oid = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
export const missing = (error: unknown) =>
  (error as NodeJS.ErrnoException)?.code === "ENOENT";
const xdg = (value: string | undefined, fallback: string) =>
  value && isAbsolute(value) ? resolve(value) : resolve(fallback);
export const configRoot = (env = process.env) =>
  join(
    xdg(env.XDG_CONFIG_HOME, join(env.HOME || homedir(), ".config")),
    "agent-bootstrap",
  );
export const userConfigPath = (env = process.env) =>
  join(configRoot(env), "config.json");
export const userStateDirectory = (env = process.env) =>
  join(
    xdg(env.XDG_STATE_HOME, join(env.HOME || homedir(), ".local/state")),
    "agent-bootstrap",
  );
export const projectsRoot = (env = process.env) =>
  join(configRoot(env), "projects");
export const projectConfigDirectory = (name: string, env = process.env) => {
  if (!projectName.test(name))
    invalid(
      "project.name",
      "Use a lowercase project name with up to 48 letters, digits or hyphens.",
      "Run agent-bootstrap project list.",
    );
  return join(projectsRoot(env), name);
};
export const projectStateDirectory = (name: string, env = process.env) =>
  join(userStateDirectory(env), "projects", name);

export function layerFix(
  layer: Layer | "declaration",
  {
    env,
    path = layer === "user"
      ? env
        ? userConfigPath(env)
        : "config.json"
      : `${layer}.json`,
    name,
  }: { env?: NodeJS.ProcessEnv; path?: string; name?: string } = {},
): ConfigFix {
  const parent = basename(dirname(path));
  name ??= projectName.test(parent) ? parent : "<name>";
  const next =
    layer === "approved" || layer === "declaration"
      ? `Review .agent-bootstrap/project.json on main and run agent-bootstrap project approve ${name}.`
      : `Run agent-bootstrap config edit${layer === "local" ? ` --project ${name}` : ""} and correct the indicated key.`;
  return {
    label:
      layer === "declaration"
        ? "project declaration"
        : `${layer} configuration`,
    path,
    next,
  };
}

export const layerFile = (
  layer: Layer,
  env = process.env,
  directory?: string,
) =>
  layer !== "user" && directory
    ? layerFix(layer, { path: join(directory, `${layer}.json`) })
    : layerFix(layer, { env });

export function checkDirectory(
  path: string,
  privateMode = false,
  create = false,
  fix?: ConfigFix,
): void {
  const parent = dirname(path);
  if (parent !== path) checkDirectory(parent, false, create, fix);
  if (create) {
    try {
      mkdirSync(path, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  const info = lstatSync(path);
  const uid = process.getuid?.();
  const mode = info.mode & 0o7777;
  if (
    !info.isDirectory() ||
    (privateMode
      ? info.uid !== uid || mode !== 0o700
      : (info.uid !== uid && info.uid !== 0) ||
        ((mode & 0o022) !== 0 && !(info.uid === 0 && mode === 0o1777)))
  ) {
    const next = `Check the owner, permissions and links at ${path}.`;
    invalid(
      path,
      "Use safe directories without links and check their owner and permissions.",
      fix ? { ...fix, next: `${next} ${fix.next}` } : next,
    );
  }
}

/** Check every application-owned directory, including when a file is absent. */
export function privatePath(
  path: string,
  root: string,
  create = false,
  fix?: ConfigFix,
): void {
  const parent = dirname(path);
  if (path !== root) {
    if (parent === path)
      invalid(
        path,
        "The path is outside the configuration or state root.",
        fix ?? "Check the XDG paths.",
      );
    privatePath(parent, root, create, fix);
  }
  checkDirectory(path, true, create, fix);
}

function unlinkIfPresent(path: string): boolean {
  try {
    unlinkSync(path);
    return true;
  } catch (error) {
    if (missing(error)) return false;
    throw error;
  }
}

export function privateConfigDirectory(
  path: string,
  root: string,
  create = false,
  fix?: ConfigFix,
): void {
  privatePath(path, root, create, fix);
  let removed = false;
  for (const name of readdirSync(path)) {
    if (!name.startsWith(".config-")) continue;
    const entry = join(path, name);
    if (lstatSync(entry, { throwIfNoEntry: false })?.isFile())
      removed = unlinkIfPresent(entry) || removed;
  }
  if (removed) syncDirectory(path);
}

function readPrivateBytes(
  path: string,
  root: string,
  key: string,
  next: string | ConfigFix,
  limit: number | undefined,
  cleanupTemporaryFiles = true,
): Buffer | undefined {
  const directory = dirname(path);
  const fix = typeof next === "string" ? undefined : next;
  let fd: number;
  try {
    if (cleanupTemporaryFiles)
      privateConfigDirectory(directory, root, false, fix);
    else privatePath(directory, root, false, fix);
    fd = openSync(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } catch (error) {
    if (missing(error)) return undefined;
    if (error instanceof ConfigError) throw error;
    if (
      (error as NodeJS.ErrnoException).code === "ELOOP" &&
      typeof next !== "string"
    )
      return invalid(key, "Use a regular configuration file without links.", {
        ...next,
        next: `Replace the symbolic link at ${path} with a private regular file. ${next.next}`,
      });
    return invalid(
      key,
      "Use a private directory and a regular file without links.",
      next,
    );
  }
  try {
    let info = fstatSync(fd);
    // A writer may have published a hard link since the first cleanup.
    if (cleanupTemporaryFiles && info.isFile() && info.nlink > 1) {
      privateConfigDirectory(directory, root, false, fix);
      info = fstatSync(fd);
    }
    if (!info.isFile() || info.nlink !== 1)
      return invalid(
        key,
        "Use a regular configuration file with no links.",
        typeof next === "string"
          ? next
          : {
              ...next,
              next: `Replace ${path} with a regular file that has no other links. ${next.next}`,
            },
      );
    if (info.uid !== process.getuid?.())
      return invalid(
        key,
        "The configuration file must be owned by the current user.",
        typeof next === "string"
          ? next
          : {
              ...next,
              next: `Restore current-user ownership of ${path}. ${next.next}`,
            },
      );
    if ((info.mode & 0o7777) !== 0o600) {
      const shellPath = /^[\w./-]+$/.test(path)
        ? path
        : "'" + path.replaceAll("'", "'\"'\"'") + "'";
      return invalid(
        key,
        "The configuration file must have mode 0600.",
        typeof next === "string"
          ? next
          : { ...next, next: `Run chmod 600 ${shellPath}. ${next.next}` },
      );
    }
    if (limit === undefined) return Buffer.alloc(0);
    if (info.size > limit)
      return invalid(
        key,
        "The configuration file exceeds its size limit.",
        next,
      );
    const bytes = Buffer.alloc(info.size + 1);
    const count = readSync(fd, bytes);
    if (count !== info.size)
      return invalid(
        key,
        "The configuration file changed while being read.",
        next,
      );
    return bytes.subarray(0, count);
  } finally {
    closeSync(fd);
  }
}

export const maxConfigBytes = 256 * 1024;

export function readPrivateConfig(
  path: string,
  root: string,
  key: string,
  next: string | ConfigFix,
  limit = maxConfigBytes,
  options: { cleanupTemporaryFiles?: boolean } = {},
): unknown {
  const bytes = readPrivateBytes(
    path,
    root,
    key,
    next,
    limit,
    options.cleanupTemporaryFiles,
  );
  return bytes === undefined ? undefined : parseJson(bytes, key, next);
}

export function hasEditableConfig(
  path: string,
  root: string,
  layer: "user" | "local",
) {
  const fix = layerFix(layer, { path });
  return readPrivateBytes(path, root, "$", fix, undefined) !== undefined;
}

export function syncDirectory(path: string) {
  const dir = openSync(
    path,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    fsyncSync(dir);
  } finally {
    closeSync(dir);
  }
}

export function writePrivateConfig(
  path: string,
  root: string,
  value: unknown,
  exclusive = false,
) {
  const directory = dirname(path);
  privateConfigDirectory(directory, root, true);
  const bytes = JSON.stringify(value, null, 2) + "\n";
  for (;;) {
    const temp = join(directory, `.config-${randomUUID()}`);
    const fd = openSync(temp, "wx", 0o600);
    try {
      try {
        writeFileSync(fd, bytes);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      try {
        if (exclusive) linkSync(temp, path);
        else renameSync(temp, path);
      } catch (error) {
        // A concurrent config access can remove the temp before publication.
        if (missing(error)) continue;
        throw error;
      }
    } finally {
      unlinkIfPresent(temp);
    }
    syncDirectory(directory);
    return;
  }
}

export function parseJson(
  bytes: Uint8Array,
  key: string,
  next: string | ConfigFix,
): unknown {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return invalid(key, "Provide valid UTF-8 JSON.", next);
  }
}

export function declarationBounds(
  value: unknown,
  key: string,
  next: string | ConfigFix,
  depth = 1,
): void {
  if (value === null || typeof value !== "object") return;
  if (depth > 8)
    invalid(
      key,
      "JSON may contain at most eight levels of objects and lists.",
      next,
    );
  if (Array.isArray(value) && value.length > 64)
    invalid(key, "A list may contain at most 64 entries.", next);
  for (const entry of Object.values(value))
    declarationBounds(entry, key, next, depth + 1);
}

export function record(
  value: unknown,
  key: string,
  next: string | ConfigFix,
  keys?: readonly string[],
): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return invalid(key, "Expected an object.", next);
  const result = value as Record<string, unknown>;
  if (keys && Object.keys(result).some((name) => !keys.includes(name)))
    invalid(key, "An unknown or disallowed key is present.", next);
  return result;
}

function validateActorConfig(
  raw: Record<string, unknown>,
  allowed: boolean,
  fix: ConfigFix,
) {
  for (const key of ["actors", "codex"] as const) {
    if (!Object.hasOwn(raw, key)) continue;
    if (!allowed)
      throw new ActorConfigError(
        key,
        "This key is allowed only in user configuration or private local.json.",
        {
          ...fix,
          next: `Remove ${key} from the project declaration and re-approve it. Use agent-bootstrap config edit to set it privately.`,
        },
      );
    const value = raw[key];
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new ActorConfigError(key, "Expected an object.", fix);
    const entry = value as Record<string, unknown>;
    if (key === "actors") {
      if (Object.keys(entry).some((actor) => actor !== "Executor"))
        throw new ActorConfigError(
          key,
          "Only Executor can select a harness.",
          fix,
        );
      if (
        "Executor" in entry &&
        entry.Executor !== "codex" &&
        entry.Executor !== "claude"
      )
        throw new ActorConfigError(
          "actors.Executor",
          "Choose codex or claude.",
          fix,
        );
    } else {
      if (
        Object.keys(entry).some(
          (field) => field !== "model" && field !== "auth",
        )
      )
        throw new ActorConfigError(
          key,
          "Only model and auth are supported.",
          fix,
        );
      if (!validCodexModel(entry.model))
        throw new ActorConfigError(
          "codex.model",
          "Provide a valid Codex model ID.",
          fix,
        );
      if (entry.auth !== "siwc")
        throw new ActorConfigError("codex.auth", "Choose siwc.", fix);
    }
  }
}

export function environmentDestination(value: unknown): HostPort {
  const match =
    typeof value === "string" && /^([^:]+):([1-9][0-9]{0,4})$/.exec(value);
  if (!match || !validClaudeHostname(match[1]!) || Number(match[2]) > 65535)
    throw new TypeError("Invalid environment destination");
  return new EgressPolicy({
    allow: [{ hostname: match[1]!, port: Number(match[2]) }],
  }).allow[0]!;
}

export function parseConfig(
  value: unknown,
  layer: Layer,
  next = layerFix(layer),
): Config {
  const key = "$";
  const keys = ["version", "verification", "profiles", "egress"];
  if (layer !== "approved")
    keys.push(
      "claude",
      "mounts",
      "secretEnv",
      "actors",
      "codex",
      "environment",
      "publish",
    );
  if (layer === "user")
    keys.push("volumes", "secrets", "microsandbox", "repositories");
  if (layer === "local") keys.push("hostChecks");
  const raw = record(value, key, next);
  if (Object.hasOwn(raw, "hostChecks") && layer !== "local")
    invalid("hostChecks", "Allowed only in private local.json.", next);
  validateActorConfig(raw, layer !== "approved", next);
  if (Object.hasOwn(raw, "microsandbox") && layer !== "user")
    invalid(
      "microsandbox",
      "The Microsandbox home holds images, volumes and VM state for the whole machine and is a trusted input allowed only in user configuration.",
      next,
    );
  for (const field of [
    "claude",
    "mounts",
    "volumes",
    "secrets",
    "secretEnv",
    "repositories",
    "environment",
    "publish",
  ])
    if (Object.hasOwn(raw, field) && !keys.includes(field))
      invalid(field, "This key is disallowed in this layer.", next);
  record(raw, key, next, keys);
  if (raw.version !== 1)
    invalid("version", "Expected configuration version 1.", next);
  if ("microsandbox" in raw) {
    const { home } = record(raw.microsandbox, "microsandbox", next, ["home"]);
    if (typeof home !== "string" || !isAbsolute(home))
      invalid("microsandbox.home", "Expected an absolute path string.", next);
  }
  if ("repositories" in raw) {
    const { root } = record(raw.repositories, "repositories", next, ["root"]);
    if (typeof root !== "string" || !isAbsolute(root) || root.includes("\0"))
      invalid(
        "repositories.root",
        "Expected an absolute directory path.",
        next,
      );
  }
  if ("verification" in raw) {
    const verification = record(raw.verification, "verification", next, [
      "profile",
      "argv",
      "timeoutMs",
    ]);
    if (
      !ROLE_PROFILES.Verification.some(
        (profile) => profile === verification.profile,
      )
    )
      invalid(
        "verification.profile",
        "The profile is outside the Verification allowlist.",
        next,
      );
    const { timeoutMs } = verification;
    if (
      Object.hasOwn(verification, "timeoutMs") &&
      (typeof timeoutMs !== "number" ||
        !Number.isSafeInteger(timeoutMs) ||
        timeoutMs < 1 ||
        timeoutMs > VERIFICATION_TIMEOUT_LIMIT_MS)
    )
      invalid(
        "verification.timeoutMs",
        `Provide an integer between 1 and ${VERIFICATION_TIMEOUT_LIMIT_MS} milliseconds.`,
        next,
      );
    try {
      parseVerificationConfig(verification);
    } catch {
      invalid(
        "verification.argv",
        "Provide a nonempty command and valid argument list.",
        next,
      );
    }
  }
  if ("claude" in raw) validateClaudeLayer(raw.claude, layer, next);
  if ("profiles" in raw) {
    const profiles = record(
      raw.profiles,
      "profiles",
      next,
      Object.keys(ROLE_PROFILES),
    );
    for (const [role, profile] of Object.entries(profiles)) {
      if (!ROLE_PROFILES[role as ProfileRole].some((name) => name === profile))
        invalid(
          `profiles.${role}`,
          "The profile is outside the role allowlist.",
          next,
        );
    }
  }
  if ("egress" in raw) {
    const egress = record(raw.egress, "egress", next, [
      ...egressActors,
      "Verification",
    ]);
    for (const [actor, destinations] of Object.entries(egress)) {
      if (actor === "Verification")
        invalid(
          "egress.Verification",
          "Verification runs tests against unreviewed changes and always stays offline.",
          next,
        );
      if (
        layer === "approved" &&
        (actor === "Coordinator" || actor === "shell")
      )
        invalid(
          `egress.${actor}`,
          "This actor cannot receive egress from a project declaration.",
          next,
        );
      if (
        !Array.isArray(destinations) ||
        destinations.length > 64 ||
        destinations.some(
          (item) =>
            typeof item !== "string" ||
            !item.endsWith(":443") ||
            !validClaudeHostname(item.slice(0, -4)),
        )
      )
        invalid(
          `egress.${actor}`,
          "Expected a list of DNS hostnames with HTTPS port 443.",
          next,
        );
    }
  }
  if ("publish" in raw) {
    const publish = record(raw.publish, "publish", next, [
      "enabled",
      "remote",
      "base",
      "autoMerge",
      "mergeMethod",
    ]);
    if (Object.hasOwn(publish, "enabled")) {
      if (layer !== "local")
        invalid("publish.enabled", "Allowed only in private local.json.", next);
      if (typeof publish.enabled !== "boolean")
        invalid("publish.enabled", "Expected a boolean.", next);
    }
    if (Object.hasOwn(publish, "remote") && !validPublishRemote(publish.remote))
      invalid("publish.remote", "Expected a Git remote name.", next);
    if (Object.hasOwn(publish, "base") && !validPublishRef(publish.base))
      invalid("publish.base", "Expected a Git ref name.", next);
    if (
      Object.hasOwn(publish, "autoMerge") &&
      !autoMergeMethods.some((method) => method === publish.autoMerge)
    )
      invalid(
        "publish.autoMerge",
        "Expected off, squash, merge or rebase.",
        next,
      );
    if (
      Object.hasOwn(publish, "mergeMethod") &&
      !mergeMethods.some((method) => method === publish.mergeMethod)
    )
      invalid("publish.mergeMethod", "Expected squash, merge or rebase.", next);
  }
  if ("environment" in raw) {
    const environment = record(raw.environment, "environment", next, [
      "allow",
      "enabled",
      "autoBuild",
    ]);
    for (const key of ["enabled", "autoBuild"] as const)
      if (
        Object.hasOwn(environment, key) &&
        typeof environment[key] !== "boolean"
      )
        invalid(`environment.${key}`, "Expected a boolean.", next);
    try {
      if (Object.hasOwn(environment, "allow")) {
        const { allow } = environment;
        if (!Array.isArray(allow) || allow.length > 64) throw new TypeError();
        allow.forEach(environmentDestination);
      }
    } catch {
      invalid(
        "environment.allow",
        "Expected a list of DNS hostnames with ports.",
        next,
      );
    }
  }
  for (const slot of ["mounts", "volumes"] as const) {
    if (!(slot in raw)) continue;
    for (const [name, value] of Object.entries(record(raw[slot], slot, next))) {
      if (!projectName.test(name))
        invalid(slot, "Expected a valid entry name.", next);
      const keyPath = `${slot}.${name}`;
      if (slot === "volumes") {
        const entry = record(value, keyPath, next, [
          "image",
          "keychainService",
          "attach",
        ]);
        if (
          typeof entry.image !== "string" ||
          !isAbsolute(entry.image) ||
          resolve(entry.image) !== entry.image ||
          !entry.image.endsWith(".sparseimage") ||
          /[\0\r\n:=,]/.test(entry.image)
        )
          invalid(
            `${keyPath}.image`,
            "Expected a canonical absolute sparse image path.",
            next,
          );
        if (!validService(entry.keychainService))
          invalid(
            `${keyPath}.keychainService`,
            "Expected a valid Keychain service name.",
            next,
          );
        if (entry.attach !== "while-running")
          invalid(
            `${keyPath}.attach`,
            "Expected the while-running attachment mode.",
            next,
          );
      } else {
        const entry = record(value, keyPath, next, [
          "volume",
          "dir",
          "actors",
          "path",
          "mode",
          "env",
        ]);
        if (typeof entry.volume !== "string" || !projectName.test(entry.volume))
          invalid(`${keyPath}.volume`, "Expected a volume name.", next);
        if (typeof entry.dir !== "string" || !mountSegment.test(entry.dir))
          invalid(`${keyPath}.dir`, "Expected a single directory name.", next);
        if (typeof entry.path !== "string" || !mountPath.test(entry.path))
          invalid(
            `${keyPath}.path`,
            "Expected a single directory below /mnt.",
            next,
          );
        if (
          !Array.isArray(entry.actors) ||
          !entry.actors.length ||
          new Set(entry.actors).size !== entry.actors.length
        )
          invalid(
            `${keyPath}.actors`,
            "Expected a nonempty list of distinct actors.",
            next,
          );
        if (entry.actors.includes("Verification"))
          invalid(
            `${keyPath}.actors`,
            "Verification cannot receive mounts.",
            next,
          );
        if (
          !entry.actors.every((actor) =>
            CLAUDE_ACTORS.some((supported) => supported === actor),
          )
        )
          invalid(
            `${keyPath}.actors`,
            "An actor has no adapter that can enforce mount restrictions.",
            next,
          );
        if ("mode" in entry && entry.mode !== "ro" && entry.mode !== "rw")
          invalid(
            `${keyPath}.mode`,
            "Expected a read-only or read-write mount mode.",
            next,
          );
        if (entry.mode === "rw" && layer !== "local")
          invalid(
            `${keyPath}.mode`,
            "Read-write mounts are restricted to local.json.",
            next,
          );
        if (entry.mode === "rw" && entry.actors.length !== 1)
          invalid(
            `${keyPath}.actors`,
            "A read-write mount must have exactly one actor.",
            next,
          );
        if (
          "env" in entry &&
          !CLAUDE_MOUNT_ENV.some((name) => name === entry.env)
        )
          invalid(
            `${keyPath}.env`,
            "The variable is outside the adapter's mount allowlist.",
            next,
          );
      }
    }
  }
  if ("secrets" in raw) {
    for (const [name, value] of Object.entries(
      record(raw.secrets, "secrets", next),
    )) {
      if (!projectName.test(name))
        invalid("secrets", "Expected a valid entry name.", next);
      const path = `secrets.${name}`;
      const entry = record(value, path, next, ["keychainService"]);
      if (!validService(entry.keychainService))
        invalid(
          `${path}.keychainService`,
          "Expected a valid Keychain service name.",
          next,
        );
    }
  }
  if ("secretEnv" in raw) {
    for (const [variable, value] of Object.entries(
      record(raw.secretEnv, "secretEnv", next),
    )) {
      if (!isSafeCredentialVariable(variable))
        invalid("secretEnv", "Expected a safe credential variable name.", next);
      const path = `secretEnv.${variable}`;
      if (variable === "ANTHROPIC_API_KEY")
        invalid(
          path,
          "The adapter reserves this variable for header substitution.",
          next,
        );
      const entry = record(value, path, next, ["secret", "actors"]);
      if (typeof entry.secret !== "string" || !projectName.test(entry.secret))
        invalid(`${path}.secret`, "Expected a valid secret source name.", next);
      if (
        !Array.isArray(entry.actors) ||
        !entry.actors.length ||
        new Set(entry.actors).size !== entry.actors.length ||
        !entry.actors.every((actor) =>
          secretActors.some((name) => name === actor),
        )
      )
        invalid(
          `${path}.actors`,
          "Expected a nonempty list of distinct Planner, Executor or Reviewer actors.",
          next,
        );
    }
  }
  const config = raw as unknown as Config;
  return Object.hasOwn(raw, "hostChecks")
    ? { ...config, hostChecks: parseHostChecks(raw.hostChecks, next) }
    : config;
}

export function readLayer(
  layer: "user" | "local",
  directory?: string,
  env = process.env,
  required = false,
): Config {
  const fix = layerFile(layer, env, directory);
  const value = readPrivateConfig(fix.path, configRoot(env), "$", fix);
  if (value === undefined && required)
    invalid(
      "$",
      "The editor must leave a configuration file at this path.",
      fix,
    );
  return value === undefined ? { version: 1 } : parseConfig(value, layer, fix);
}

export function readApproved(
  directory: string,
  env = process.env,
): ApprovedConfig | undefined {
  const next = layerFile("approved", env, directory);
  const value = readPrivateConfig(next.path, configRoot(env), "$", next);
  if (value === undefined) return undefined;
  const raw = record(value, "$", next, ["version", "commit", "blob", "config"]);
  if (raw.version !== 1)
    invalid("version", "Expected configuration version 1.", next);
  if (typeof raw.commit !== "string" || !oid.test(raw.commit))
    invalid("commit", "Expected a valid Git commit object ID.", next);
  if (
    typeof raw.blob !== "string" ||
    !oid.test(raw.blob) ||
    raw.commit.length !== raw.blob.length
  )
    invalid(
      "blob",
      "Expected a Git blob object ID matching the commit format.",
      next,
    );
  declarationBounds(raw.config, "config", next);
  return {
    version: 1,
    commit: raw.commit,
    blob: raw.blob,
    config: parseConfig(raw.config, "approved", next),
  };
}

export function validateLocalHostChecks(
  checks: readonly HostCheckDeclaration[],
  user: Config,
  env: NodeJS.ProcessEnv,
  directory?: string,
) {
  validateHostCheckHomes(
    checks,
    msbHomeCandidate(env, user).candidate,
    layerFile("local", env, directory),
  );
}

export function mergeConfig(
  user: Config,
  approved: Config | undefined,
  local: Config,
  env = process.env,
  directory?: string,
  harnesses = localActorHarnesses,
) {
  const config: Config = { version: 1 };
  const sources: Record<string, Layer | Layer[]> = Object.create(null);
  if (user.microsandbox) {
    config.microsandbox = user.microsandbox;
    sources["microsandbox.home"] = "user";
  }
  if (user.repositories) {
    config.repositories = user.repositories;
    sources["repositories.root"] = "user";
  }
  if (local.hostChecks) {
    validateLocalHostChecks(local.hostChecks, user, env, directory);
    config.hostChecks = local.hostChecks;
    sources.hostChecks = "local";
  }
  const layers = { user, approved, local };
  if (approved)
    validateActorConfig(
      approved as unknown as Record<string, unknown>,
      false,
      layerFile("approved", env, directory),
    );
  for (const layer of ["user", "approved", "local"] as const) {
    const current = layers[layer];
    if (!current) continue;
    if (current.actors?.Executor) {
      config.actors = { Executor: current.actors.Executor };
      sources["actors.Executor"] = layer;
    }
    if (current.codex) {
      config.codex = current.codex;
      sources["codex.model"] = layer;
      sources["codex.auth"] = layer;
    }
    if (current.verification) {
      config.verification = current.verification;
      sources.verification = layer;
    }
    for (const [role, value] of Object.entries(current.profiles ?? {})) {
      (config.profiles ??= {})[role as ProfileRole] = value;
      sources[`profiles.${role}`] = layer;
    }
    for (const [actor, values] of Object.entries(current.egress ?? {})) {
      if (actor === "shell" && directory !== undefined) continue;
      const entries = ((config.egress ??= {})[actor as EgressActor] ??=
        []) as string[];
      const origins = (sources[`egress.${actor}`] ??= []) as Layer[];
      for (const destination of values) {
        if (entries.includes(destination)) continue;
        entries.push(destination);
        origins.push(layer);
      }
    }
    if (layer === "approved" && Object.hasOwn(current, "publish"))
      invalid(
        "publish",
        "This key is disallowed in this layer.",
        layerFile(layer, env, directory),
      );
    if (
      layer === "user" &&
      current.publish &&
      Object.hasOwn(current.publish, "enabled")
    )
      invalid(
        "publish.enabled",
        "Allowed only in private local.json.",
        layerFile(layer, env),
      );
    if (current.publish) {
      config.publish = { ...config.publish, ...current.publish };
      for (const key of Object.keys(current.publish))
        sources[`publish.${key}`] = layer;
    }
    if (layer === "approved" && current.environment)
      invalid(
        "environment",
        "This key is disallowed in this layer.",
        layerFile(layer, env, directory),
      );
    if (current.environment) {
      const environment = (config.environment ??= {});
      if (current.environment.enabled !== undefined) {
        environment.enabled = current.environment.enabled;
        sources["environment.enabled"] = layer;
      }
      if (current.environment.autoBuild !== undefined) {
        environment.autoBuild = current.environment.autoBuild;
        sources["environment.autoBuild"] = layer;
      }
      if (current.environment.allow !== undefined) {
        const entries = (environment.allow ??= []) as string[];
        const origins = (sources["environment.allow"] ??= []) as Layer[];
        for (const destination of current.environment.allow) {
          if (entries.includes(destination)) continue;
          entries.push(destination);
          origins.push(layer);
        }
      }
    }
    for (const key of ["mounts", "volumes", "secrets", "secretEnv"] as const) {
      for (const [name, entry] of Object.entries(current[key] ?? {})) {
        const path = `${key}.${name}`;
        if (Object.hasOwn(sources, path))
          invalid(
            path,
            "A named entry appears in more than one layer.",
            layerFile(layer, env, directory),
          );
        Object.defineProperty((config[key] ??= {}), name, {
          value:
            key === "mounts"
              ? {
                  ...(entry as MountDeclaration),
                  mode: (entry as MountDeclaration).mode ?? "ro",
                }
              : entry,
          enumerable: true,
        });
        sources[path] = layer;
      }
    }
    if (current.claude) {
      const claude = (config.claude ??= {});
      for (const [key, value] of Object.entries(current.claude)) {
        if (key === "apiKey") {
          const target = (claude[key] ??= {}) as Record<string, unknown>;
          for (const [field, entry] of Object.entries(
            value as Record<string, unknown>,
          )) {
            target[field] = entry;
            sources[`claude.apiKey.${field}`] = layer;
          }
        } else if (key === "leakPatterns" || key === "errors") {
          const entries = (claude[key] ??= []) as unknown[];
          const origins = (sources[`claude.${key}`] ??= []) as Layer[];
          for (const entry of value as unknown[]) {
            if (
              entries.some(
                (previous) =>
                  JSON.stringify(previous) === JSON.stringify(entry),
              )
            )
              continue;
            entries.push(entry);
            origins.push(layer);
          }
        } else {
          claude[key] = value;
          sources[`claude.${key}`] = layer;
        }
      }
    }
  }
  const images = new Set<string>();
  const services = new Set<string>();
  for (const [name, volume] of Object.entries(config.volumes ?? {})) {
    if (images.has(volume.image) || services.has(volume.keychainService))
      invalid(
        `volumes.${name}`,
        "Volume definitions must have distinct images and Keychain services.",
        layerFile("user", env),
      );
    images.add(volume.image);
    services.add(volume.keychainService);
  }
  const actorHarnesses: LocalActorHarnesses = {
    ...harnesses,
    ...config.actors,
  };
  codexExecutorOptions(config);
  const entries = Object.entries(config.mounts ?? {});
  for (const [index, [name, mount]] of entries.entries()) {
    const path = `mounts.${name}`;
    const fix = layerFile(sources[path] as Layer, env, directory);
    if (
      mount.actors.some(
        (actor) =>
          actorHarnesses[actor as keyof LocalActorHarnesses] !== "claude",
      )
    )
      invalid(
        `${path}.actors`,
        "A mounted actor must use the Claude adapter.",
        fix,
      );
    if (!Object.hasOwn(config.volumes ?? {}, mount.volume))
      invalid(`${path}.volume`, "The referenced volume is undefined.", fix);
    for (const [, previous] of entries.slice(0, index)) {
      if (previous.path === mount.path)
        invalid(`${path}.path`, "Two mounts share a guest path.", fix);
      if (
        mount.env &&
        previous.env === mount.env &&
        previous.actors.some((actor) => mount.actors.includes(actor))
      )
        invalid(
          `${path}.env`,
          "An actor receives the same variable from two mounts.",
          fix,
        );
      if (conflictingClaims(previous, mount))
        invalid(
          `${path}.dir`,
          "A writable directory must belong to a single mount.",
          fix,
        );
    }
  }
  validateSecretGrants(config, sources, actorHarnesses, env, directory);
  return { config, sources, actorHarnesses };
}

function validateSecretGrants(
  config: Config,
  sources: Record<string, Layer | Layer[]>,
  harnesses: LocalActorHarnesses,
  env: NodeJS.ProcessEnv,
  directory?: string,
) {
  const grantedActors = new Set<SecretActor>();
  const mountedActors = new Set(
    Object.values(config.mounts ?? {}).flatMap((mount) => mount.actors),
  );
  for (const [variable, grant] of Object.entries(config.secretEnv ?? {})) {
    const path = `secretEnv.${variable}`;
    const fix = layerFile(sources[path] as Layer, env, directory);
    if (!Object.hasOwn(config.secrets ?? {}, grant.secret))
      invalid(`${path}.secret`, "The referenced secret source is undefined.", {
        ...fix,
        next: "Use agent-bootstrap config edit to define the source in the user configuration, or correct the grant.",
      });
    if (config.claude?.auth !== "external") {
      const authFix = layerFile(
        (sources["claude.auth"] ?? sources[path]) as Layer,
        env,
        directory,
      );
      invalid(
        "claude.auth",
        "Secret grants require claude.auth set to external.",
        {
          ...authFix,
          next: `Set claude.auth to external or remove the grant. ${authFix.next}`,
        },
      );
    }
    for (const actor of grant.actors) {
      const actorPath = `${path}.actors`;
      if (grantedActors.has(actor))
        invalid(
          actorPath,
          `${actor} can receive one secret variable per run.`,
          fix,
        );
      if (harnesses[actor] !== "claude")
        invalid(
          actorPath,
          `${actor} must use the Claude adapter for secret grants.`,
          fix,
        );
      const role = actor === "Executor" ? "Worker" : actor;
      const profile = config.profiles?.[role] ?? "base";
      if (profile !== "base") {
        const profilePath = `profiles.${role}`;
        invalid(
          profilePath,
          `${actor} requires the base Alpine profile for secret grants.`,
          layerFile(sources[profilePath] as Layer, env, directory),
        );
      }
      if (mountedActors.has(actor))
        invalid(
          actorPath,
          `${actor} has a mount and cannot receive a secret grant.`,
          fix,
        );
      if (config.egress?.[actor]?.length) {
        const egressPath = `egress.${actor}`;
        invalid(
          egressPath,
          `${actor} cannot receive added egress with a secret grant.`,
          layerFile((sources[egressPath] as Layer[])[0]!, env, directory),
        );
      }
      grantedActors.add(actor);
    }
  }
}

export function conflictingClaims(
  left: MountDeclaration,
  right: MountDeclaration,
) {
  return (
    left.volume === right.volume &&
    left.dir === right.dir &&
    (left.mode === "rw" || right.mode === "rw")
  );
}

function localMountClaims(directory: string, env: NodeJS.ProcessEnv) {
  const fix = layerFile("local", env, directory);
  let mounts: Record<string, unknown>;
  try {
    const raw = readPrivateConfig(fix.path, configRoot(env), "$", fix);
    if (raw === undefined) return [];
    const value = record(raw, "$", fix).mounts;
    if (value === undefined) return [];
    mounts = record(value, "mounts", fix);
  } catch (error) {
    if (error instanceof ConfigError) return [];
    throw error;
  }
  return Object.entries(mounts).flatMap(([name, mount]) => {
    try {
      const local = parseConfig(
        { version: 1, mounts: { [name]: mount } },
        "local",
        fix,
      );
      return Object.values(local.mounts ?? {});
    } catch (error) {
      if (error instanceof ConfigError) return [];
      throw error;
    }
  });
}

export function loadConfig(
  env = process.env,
  directory?: string,
  harnesses = localActorHarnesses,
) {
  const user = readLayer("user", undefined, env);
  const local = directory
    ? readLayer("local", directory, env)
    : { version: 1 as const };
  const approved = directory ? readApproved(directory, env) : undefined;
  const merged = mergeConfig(
    user,
    approved?.config,
    local,
    env,
    directory,
    harnesses,
  );
  if (directory && Object.keys(merged.config.mounts ?? {}).length) {
    for (const project of listProjects(env)) {
      const other = projectConfigDirectory(project.name, env);
      if (other === directory) continue;
      const claims = localMountClaims(other, env);
      for (const [name, mount] of Object.entries(merged.config.mounts ?? {})) {
        if (claims.some((claim) => conflictingClaims(claim, mount)))
          invalid(
            `mounts.${name}.dir`,
            "A directory with a write grant is also claimed by another project.",
            `Resolve the directory claim in project ${project.name}, then run agent-bootstrap doctor.`,
          );
      }
    }
  }
  return {
    ...merged,
    directory,
    user,
    local,
    approved,
  };
}
