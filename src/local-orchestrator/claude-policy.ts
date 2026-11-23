import { createHash, randomUUID } from "node:crypto";
import { renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { ClaudeHostPolicy } from "../trusted-host.ts";
import {
  type ClaudeActor,
  type EffectiveClaudeConfig,
} from "./claude-config.ts";
import {
  ClaudeRunError,
  ClaudeVolumeBusy,
  CredentialsVolume,
  privateDirectory,
} from "./credentials-volume.ts";

export const orchestratorMcp = {
  type: "stdio",
  command: "/usr/bin/socat",
  args: ["STDIO", "VSOCK-CONNECT:2:5000"],
} as const;

export function managedClaudeSettings(actor: ClaudeActor | "login") {
  const concierge = actor === "Concierge";
  const allow = concierge
    ? ["mcp__orchestrator"]
    : actor === "login"
      ? []
      : [
          "Read",
          "Glob",
          "Grep",
          ...(actor === "Executor" ? ["Edit", "Write"] : []),
        ];
  return {
    disableAllHooks: true,
    allowManagedMcpServersOnly: true,
    allowedMcpServers: concierge
      ? [{ serverCommand: [orchestratorMcp.command, ...orchestratorMcp.args] }]
      : [],
    allowManagedPermissionRulesOnly: true,
    permissions: {
      disableBypassPermissionsMode: "disable",
      allow,
      ...(concierge ? { deny: ["WebFetch", "Bash"] } : {}),
    },
  };
}

export function createClaudePolicy(
  effective: EffectiveClaudeConfig,
  state: string,
  note: (message: string) => void,
): ClaudeHostPolicy {
  const config = effective.configDir;
  const volume = config && new CredentialsVolume(config, state);
  return {
    managedSettings(actor) {
      const dir = join(state, "claude-policy");
      privateDirectory(dir);
      const content = JSON.stringify(managedClaudeSettings(actor));
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
    ...(volume && config
      ? {
          configDir: {
            egress: config.egress,
            loginEgress: config.loginEgress,
            errors: config.errors,
            groupFor(actor: ClaudeActor) {
              return (
                Object.entries(config.groups).find(([, { actors }]) =>
                  actors.includes(actor),
                )?.[0] ?? ""
              );
            },
            async begin(group: string, ensureAudit: () => void) {
              if (!Object.hasOwn(config.groups, group))
                throw new ClaudeRunError("config-invalid");
              const deadline = performance.now() + 30_000;
              let lease: ReturnType<CredentialsVolume["acquire"]>;
              for (;;) {
                ensureAudit();
                try {
                  lease = volume.acquire();
                  break;
                } catch (error) {
                  if (
                    !(error instanceof ClaudeVolumeBusy) ||
                    performance.now() >= deadline
                  )
                    throw error;
                  await delay(100);
                }
              }
              const { release, prepare, ready, quarantine } = lease;
              const close = () => {
                try {
                  release();
                } catch {
                  note(
                    "The configuration volume could not detach. Check agent-bootstrap credentials status.",
                  );
                  throw new ClaudeRunError("credentials-detached");
                }
              };
              try {
                volume.integrity(group, "before", note);
                const path = volume.groupPath(group);
                return {
                  path,
                  prepare,
                  ready,
                  quarantine,
                  finish(succeeded: boolean) {
                    try {
                      volume.integrity(group, "after", note, succeeded);
                    } catch (error) {
                      try {
                        close();
                      } catch {}
                      throw error;
                    }
                    close();
                  },
                };
              } catch (error) {
                try {
                  close();
                } catch {}
                throw error;
              }
            },
          },
        }
      : {}),
    note,
  };
}
