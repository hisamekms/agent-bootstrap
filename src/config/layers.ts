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
import { validateClaudeLayer } from "../local-orchestrator/claude-config.ts";
import { ConfigError, invalid, type ConfigFix } from "./messages.ts";

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
export interface VolumeSlot {
  image: string;
  keychainService: string;
  attach: "while-running";
}
export interface MountSlot {
  volume: string;
  dir: string;
  path: string;
  actors: readonly string[];
  mode?: "ro" | "rw";
  env?: string;
}
export interface Config {
  version: 1;
  verification?: VerificationConfig;
  claude?: Record<string, unknown>;
  profiles?: Profiles;
  egress?: Partial<Record<EgressActor, readonly string[]>>;
  mounts?: Record<string, MountSlot>;
  volumes?: Record<string, VolumeSlot>;
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
): Buffer | undefined {
  const directory = dirname(path);
  const fix = typeof next === "string" ? undefined : next;
  let fd: number;
  try {
    privateConfigDirectory(directory, root, false, fix);
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
    if (info.isFile() && info.nlink > 1) {
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

export function readPrivateConfig(
  path: string,
  root: string,
  key: string,
  next: string | ConfigFix,
  limit = 256 * 1024,
): unknown {
  const bytes = readPrivateBytes(path, root, key, next, limit);
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

export function parseConfig(
  value: unknown,
  layer: Layer,
  next = layerFix(layer),
): Config {
  const key = "$";
  const keys = ["version", "verification", "profiles", "egress"];
  if (layer !== "approved") keys.push("claude", "mounts");
  if (layer === "user") keys.push("volumes");
  const raw = record(value, key, next);
  for (const field of ["claude", "mounts", "volumes"])
    if (Object.hasOwn(raw, field) && !keys.includes(field))
      invalid(field, "This key is disallowed in this layer.", next);
  record(raw, key, next, keys);
  if (raw.version !== 1)
    invalid("version", "Expected configuration version 1.", next);
  if ("verification" in raw) {
    const verification = record(raw.verification, "verification", next, [
      "profile",
      "argv",
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
        destinations.some(
          (item) =>
            typeof item !== "string" || !/^[^\s\p{C}]+:[0-9]+$/u.test(item),
        )
      )
        invalid(
          `egress.${actor}`,
          "Expected a list of host and port strings.",
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
          typeof entry.keychainService !== "string" ||
          entry.attach !== "while-running"
        )
          invalid(
            keyPath,
            "Expected an image, Keychain service and attachment mode.",
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
        if (
          typeof entry.volume !== "string" ||
          typeof entry.dir !== "string" ||
          typeof entry.path !== "string" ||
          !Array.isArray(entry.actors) ||
          entry.actors.some((actor) => typeof actor !== "string") ||
          ("mode" in entry && entry.mode !== "ro" && entry.mode !== "rw") ||
          ("env" in entry && typeof entry.env !== "string")
        )
          invalid(
            keyPath,
            "Expected a volume, directory, path and actor list with optional mode and environment variable.",
            next,
          );
      }
    }
  }
  return raw as unknown as Config;
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

export function mergeConfig(
  user: Config,
  approved: Config | undefined,
  local: Config,
  env = process.env,
  directory?: string,
) {
  const config: Config = { version: 1 };
  const sources: Record<string, Layer | Layer[]> = Object.create(null);
  const layers = { user, approved, local };
  for (const layer of ["user", "approved", "local"] as const) {
    const current = layers[layer];
    if (!current) continue;
    if (current.verification) {
      config.verification = current.verification;
      sources.verification = layer;
    }
    for (const [role, value] of Object.entries(current.profiles ?? {})) {
      (config.profiles ??= {})[role as ProfileRole] = value;
      sources[`profiles.${role}`] = layer;
    }
    for (const [actor, values] of Object.entries(current.egress ?? {})) {
      const entries = ((config.egress ??= {})[actor as EgressActor] ??=
        []) as string[];
      const origins = (sources[`egress.${actor}`] ??= []) as Layer[];
      for (const destination of values) {
        if (entries.includes(destination)) continue;
        entries.push(destination);
        origins.push(layer);
      }
    }
    for (const key of ["mounts", "volumes"] as const) {
      for (const [name, entry] of Object.entries(current[key] ?? {})) {
        const path = `${key}.${name}`;
        if (Object.hasOwn(sources, path))
          invalid(
            path,
            "A named entry appears in more than one layer.",
            layerFile(layer, env, directory),
          );
        Object.defineProperty((config[key] ??= {}), name, {
          value: entry,
          enumerable: true,
        });
        sources[path] = layer;
      }
    }
    if (current.claude) {
      const claude = (config.claude ??= {});
      for (const [key, value] of Object.entries(current.claude)) {
        if (key === "apiKey" || key === "configDir") {
          const target = (claude[key] ??= {}) as Record<string, unknown>;
          for (const [field, entry] of Object.entries(
            value as Record<string, unknown>,
          )) {
            const path = `claude.${key}.${field}`;
            if (field === "volume" || field === "groups") {
              const named = (target[field] ??= {}) as Record<string, unknown>;
              for (const [name, item] of Object.entries(
                entry as Record<string, unknown>,
              )) {
                if (field === "groups" && Object.hasOwn(named, name))
                  invalid(
                    `${path}.${name}`,
                    "A named group appears in more than one layer.",
                    layerFile(layer, env, directory),
                  );
                named[name] = item;
                sources[`${path}.${name}`] = layer;
              }
            } else if (field === "leakPatterns") {
              const patterns = (target[field] ??= []) as string[];
              const origins = (sources[path] ??= []) as Layer[];
              for (const pattern of entry as string[]) {
                if (patterns.includes(pattern)) continue;
                patterns.push(pattern);
                origins.push(layer);
              }
            } else {
              target[field] = entry;
              sources[path] = layer;
            }
          }
        } else {
          claude[key] = value;
          sources[`claude.${key}`] = layer;
        }
      }
    }
  }
  return { config, sources };
}

export function loadConfig(env = process.env, directory?: string) {
  const user = readLayer("user", undefined, env);
  const local = directory
    ? readLayer("local", directory, env)
    : { version: 1 as const };
  const approved = directory ? readApproved(directory, env) : undefined;
  return {
    ...mergeConfig(user, approved?.config, local, env, directory),
    directory,
    user,
    local,
    approved,
  };
}
