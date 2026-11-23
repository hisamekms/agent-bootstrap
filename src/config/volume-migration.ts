import { CLAUDE_MOUNT_ENV } from "../claude-code.ts";
import {
  CLAUDE_ACTORS,
  type ClaudeActor,
} from "../local-orchestrator/claude-config.ts";
import { parseConfig, record, type Config } from "./layers.ts";
import { invalid, type ConfigFix } from "./messages.ts";

function splitLegacyConfig(
  value: unknown,
  layer: "user" | "local",
  fix: ConfigFix,
) {
  const raw = record(value, "$", fix);
  const claude =
    raw.claude === undefined ? {} : record(raw.claude, "claude", fix);
  const { configDir, ...options } = claude;
  const active = options.auth === "config-dir";
  if (active) delete options.auth;
  const legacy =
    configDir === undefined
      ? {}
      : record(configDir, "claude.configDir", fix, [
          "volume",
          "groups",
          "egress",
          "loginEgress",
          "errors",
          "leakPatterns",
        ]);
  const converted = active || "configDir" in claude;
  const { claude: _claude, ...base } = raw;
  const config = parseConfig(
    converted
      ? { ...base, ...(Object.keys(options).length ? { claude: options } : {}) }
      : raw,
    layer,
    fix,
  );
  return { config, legacy, active, converted };
}

function destinations(value: unknown, field: string, fix: ConfigFix) {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string"))
    invalid(field, "Expected a list of HTTPS destinations.", fix);
  return value.map((entry: string) => entry.toLowerCase());
}

export function convertUserVolumeConfig(value: unknown, fix: ConfigFix) {
  const user = splitLegacyConfig(value, "user", fix);
  const { config, legacy } = user;
  if (legacy.volume !== undefined) {
    if (
      Object.hasOwn(config.volumes ?? {}, "private") &&
      JSON.stringify(config.volumes!.private) !== JSON.stringify(legacy.volume)
    )
      invalid(
        "volumes.private",
        "The converted volume conflicts with an existing definition.",
        fix,
      );
    config.volumes = parseConfig(
      { version: 1, volumes: { ...config.volumes, private: legacy.volume } },
      "user",
      fix,
    ).volumes!;
  }
  if (legacy.loginEgress !== undefined) {
    const shell = destinations(
      legacy.loginEgress,
      "claude.configDir.loginEgress",
      fix,
    );
    config.egress = {
      ...config.egress,
      shell: [...new Set([...(config.egress?.shell ?? []), ...shell])],
    };
  }
  return { ...user, config: parseConfig(config, "user", fix) };
}

export function convertProjectVolumeConfig(
  value: unknown,
  fix: ConfigFix,
  user: ReturnType<typeof convertUserVolumeConfig>,
) {
  const local = splitLegacyConfig(value, "local", fix);
  const previous = local.config;
  const mounts: NonNullable<Config["mounts"]> = Object.create(null);
  if (local.legacy.volume !== undefined)
    invalid(
      "claude.configDir.volume",
      "The legacy volume must be defined in the user config.",
      fix,
    );
  if (!local.active && (!user.active || previous.claude?.auth !== undefined))
    return { config: previous, previous, converted: local.converted, mounts };

  const config = { ...previous };
  const { legacy } = local;
  const inherited = user.legacy;
  const groupsOf = (value: unknown) =>
    value === undefined ? {} : record(value, "claude.configDir.groups", fix);
  const userGroups = groupsOf(inherited.groups);
  const localGroups = groupsOf(legacy.groups);
  for (const name of Object.keys(localGroups))
    if (Object.hasOwn(userGroups, name))
      invalid(
        `claude.configDir.groups.${name}`,
        "A named group appears in more than one layer.",
        fix,
      );
  const groups = { ...userGroups, ...localGroups };
  const mountedActors = new Set<ClaudeActor>();
  for (const [name, group] of Object.entries(groups)) {
    const { actors } = record(group, "claude.configDir.groups", fix, [
      "actors",
    ]);
    if (
      !Array.isArray(actors) ||
      actors.some(
        (actor) =>
          !CLAUDE_ACTORS.includes(actor) &&
          !["Researcher", "Verification", "verification"].includes(actor),
      )
    )
      invalid(
        "claude.configDir.groups",
        "A legacy actor list is invalid.",
        fix,
      );
    const entry = {
      volume: "private",
      dir: name,
      path: `/mnt/${name}`,
      actors: [
        ...new Set(
          actors.filter((actor): actor is ClaudeActor =>
            CLAUDE_ACTORS.includes(actor),
          ),
        ),
      ],
      mode: "ro" as const,
      env: CLAUDE_MOUNT_ENV[0],
    };
    if (!entry.actors.length) continue;
    if (
      Object.hasOwn(config.mounts ?? {}, name) &&
      JSON.stringify(config.mounts![name]) !== JSON.stringify(entry)
    )
      invalid("mounts", "A converted mount conflicts with a local mount.", fix);
    mounts[name] = entry;
    for (const actor of entry.actors) mountedActors.add(actor);
  }
  if (Object.keys(mounts).length)
    config.mounts = { ...config.mounts, ...mounts };

  const egress = legacy.egress === undefined ? inherited.egress : legacy.egress;
  const hosts =
    egress === undefined
      ? undefined
      : destinations(egress, "claude.configDir.egress", fix);
  if (hosts && mountedActors.size) {
    config.egress = { ...config.egress };
    for (const actor of mountedActors)
      config.egress[actor] = [
        ...new Set([...(config.egress[actor] ?? []), ...hosts]),
      ];
  }
  const claude: Record<string, unknown> = {
    ...config.claude,
    auth: "external",
  };
  const errors = legacy.errors === undefined ? inherited.errors : legacy.errors;
  if (errors !== undefined) {
    if (claude.errors !== undefined)
      invalid("claude.errors", "Legacy and current settings conflict.", fix);
    claude.errors = errors;
  }
  const leakPatterns = [inherited.leakPatterns, legacy.leakPatterns].filter(
    (patterns) => patterns !== undefined,
  );
  if (leakPatterns.length) {
    if (claude.leakPatterns !== undefined)
      invalid(
        "claude.leakPatterns",
        "Legacy and current settings conflict.",
        fix,
      );
    if (leakPatterns.some((patterns) => !Array.isArray(patterns)))
      invalid(
        "claude.leakPatterns",
        "Expected a list of screening patterns.",
        fix,
      );
    claude.leakPatterns = [...new Set(leakPatterns.flat())];
  }
  config.claude = claude;
  return {
    config: parseConfig(config, "local", fix),
    previous,
    converted: true,
    mounts,
  };
}
