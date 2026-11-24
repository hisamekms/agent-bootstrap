import {
  configRoot,
  layerFile,
  loadConfig,
  missing,
  privatePath,
  projectConfigDirectory,
  projectName,
  projectsRoot,
} from "../config/layers.ts";
import { invalid } from "../config/messages.ts";
import { requireProject, type Project } from "../config/projects.ts";
import { createHash, randomUUID } from "node:crypto";
import {
  lstatSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { ClaudeHostPolicy } from "../trusted-host.ts";
import type { ClaudeActor, EffectiveClaudeConfig } from "./claude-config.ts";
import { VolumeError, Volume, privateDirectory } from "../volumes/volume.ts";

import { SECRET_TOOL_DIRS } from "../secret-file.ts";
import { createCredentialScanner } from "./credential-scan.ts";

export const orchestratorMcp = {
  type: "stdio",
  command: "/usr/bin/socat",
  args: ["STDIO", "VSOCK-CONNECT:2:5000"],
} as const;

export function managedClaudeSettings(
  actor: ClaudeActor,
  shell = false,
  mounts: readonly string[] = [],
  auth?: "secret-file",
) {
  const concierge = actor === "Concierge";
  const secretFile = auth === "secret-file";
  const toolDirs = Object.values(SECRET_TOOL_DIRS);
  const gitPaths = ["/workspace/.git/config", "/workspace/.git/hooks"];
  const scope = actor === "Executor" ? "/workspace" : "/review";
  const fileTools = ["Read", "Glob", "Grep", "Edit", "Write"];
  const allow = concierge
    ? ["mcp__orchestrator"]
    : [
        ...fileTools
          .slice(0, actor === "Executor" ? 5 : 3)
          .map((tool) => `${tool}(/${scope}/**)`),
        ...(actor === "Executor" && shell && !mounts.length ? ["Bash"] : []),
      ];
  return {
    disableAllHooks: true,
    allowManagedMcpServersOnly: true,
    allowedMcpServers: concierge
      ? [{ serverCommand: [orchestratorMcp.command, ...orchestratorMcp.args] }]
      : [],
    allowManagedPermissionRulesOnly: true,
    ...(secretFile
      ? {
          sandbox: {
            enabled: true,
            failIfUnavailable: true,
            allowUnsandboxedCommands: false,
            network: { allowManagedDomainsOnly: true, allowedDomains: [] },
            filesystem: {
              // The CLI talks to sandboxed commands through its temporary directory.
              denyRead: [
                "/run/secrets",
                "/etc/claude-code",
                SECRET_TOOL_DIRS.home,
                SECRET_TOOL_DIRS.config,
              ],
              allowWrite: [SECRET_TOOL_DIRS.tmp],
              denyWrite: gitPaths,
            },
          },
        }
      : {}),
    permissions: {
      disableBypassPermissionsMode: "disable",
      allow,
      deny: [
        ...[
          "/etc/claude-code",
          ...(secretFile
            ? ["/run/secrets", "/proc", "/sys", "/dev", ...toolDirs]
            : []),
          ...mounts,
        ].flatMap((path) =>
          fileTools.flatMap((tool) => [
            `${tool}(/${path})`,
            `${tool}(/${path}/**)`,
          ]),
        ),
        ...(secretFile
          ? gitPaths.flatMap((path) =>
              ["Write", "Edit"].flatMap((tool) => [
                `${tool}(/${path})`,
                `${tool}(/${path}/**)`,
              ]),
            )
          : []),
        ...(concierge || mounts.length
          ? ["Bash", "WebFetch", "WebSearch", "Agent", "Skill"]
          : secretFile
            ? ["WebFetch", "WebSearch", "Agent", "Skill"]
            : []),
      ],
    },
  };
}

export function createClaudePolicy(
  effective: EffectiveClaudeConfig,
  state: string,
  note: (message: string) => void,
  project?: Pick<Project, "id" | "identity" | "name">,
  env = process.env,
): ClaudeHostPolicy {
  const config = structuredClone(effective.config);
  return {
    auth: effective.auth,
    mounts: config.mounts,
    egress: config.egress,
    scan: createCredentialScanner(effective, state, note),
    errors: effective.errors,
    managedSettings(actor, shell, mounts, auth) {
      const dir = join(state, "claude-policy");
      privateDirectory(dir);
      const content = JSON.stringify(
        managedClaudeSettings(actor, shell, mounts, auth),
      );
      const digest = createHash("sha256").update(content).digest("hex");
      const path = join(dir, `managed-${digest}.json`);
      // Publish only a complete file; concurrent runs may share the same policy.
      const temp = join(dir, randomUUID());
      writeFileSync(temp, content, { mode: 0o600, flag: "wx" });
      try {
        renameSync(temp, path);
      } finally {
        rmSync(temp, { force: true });
      }
      return path;
    },
    async beginMount(mount, holder, ensureAudit, deadline) {
      const definition = config.volumes?.[mount.volume];
      if (!definition)
        throw new VolumeError(
          "config-invalid",
          `Mount "${mount.name}"`,
          "The mount's volume is undefined.",
          "Define the volume or update the mount declaration, then restart the launcher.",
        );
      const changed = (): never =>
        invalid(
          `mounts.${mount.name}`,
          "The registered project or mount grant changed before launch.",
          "Restart the launcher to load the current configuration.",
        );
      let ensureOwnership: (() => void) | undefined;
      if (project) {
        const directory = projectConfigDirectory(project.name, env);
        const root = projectsRoot(env);
        const version = (path: string) => {
          const info = lstatSync(path, { bigint: true, throwIfNoEntry: false });
          return info
            ? `${info.dev}:${info.ino}:${info.ctimeNs}:${info.mtimeNs}:${info.size}`
            : undefined;
        };
        const registryVersion = version(root);
        let names: string[];
        try {
          privatePath(root, configRoot(env));
          names = readdirSync(root).filter((name) => projectName.test(name));
        } catch (error) {
          if (!missing(error)) throw error;
          names = [];
        }
        const paths = [
          layerFile("user", env).path,
          ...names.flatMap((name) => {
            const projectDirectory = projectConfigDirectory(name, env);
            return [
              join(projectDirectory, "project.json"),
              layerFile("local", env, projectDirectory).path,
            ];
          }),
        ];
        // Include other projects' claim files in the snapshot. While a
        // lease waits, another project can claim the same directory.
        const versions = paths.map(version);
        const current = loadConfig(env, directory).config;
        const declaration = current.mounts?.[mount.name];
        const currentVolume = current.volumes?.[mount.volume];
        if (
          !declaration ||
          !currentVolume ||
          declaration.volume !== mount.volume ||
          declaration.dir !== mount.dir ||
          declaration.path !== mount.path ||
          declaration.env !== mount.env ||
          (holder !== "operator shell" &&
            (declaration.mode !== mount.mode ||
              !declaration.actors.includes(holder))) ||
          currentVolume.image !== definition.image ||
          currentVolume.keychainService !== definition.keychainService
        )
          changed();
        ensureOwnership = () => {
          const registered = requireProject(project.name, env);
          if (
            registered.id !== project.id ||
            registered.identity !== project.identity ||
            version(root) !== registryVersion ||
            paths.some((path, index) => version(path) !== versions[index])
          )
            changed();
        };
        ensureOwnership();
      }
      const volume = new Volume(definition, state, undefined, {
        volume: mount.volume,
        mount: mount.name,
      });
      const lease = await volume.acquire(
        mount.dir,
        mount.mode ?? "ro",
        holder,
        ensureAudit,
        deadline,
        ensureOwnership,
      );
      return {
        directory: () => {
          ensureAudit();
          ensureOwnership?.();
          return volume.directory(mount.dir, holder === "operator shell");
        },
        prepare: lease.prepare,
        ready: lease.ready,
        finish: lease.release,
        quarantine: lease.quarantine,
      };
    },
    note,
  };
}
