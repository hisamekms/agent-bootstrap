import { realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import { readLayer } from "../config/layers.ts";
import { requireMsbHome } from "../config/msb-home.ts";
import { EgressPolicy, type HostPort } from "../egress-policy.ts";
import { ALPINE_3_23 } from "../image-recipes.ts";
import { userStateDirectory } from "../local-orchestrator/claude-config.ts";
import { privateDirectory } from "../volumes/volume.ts";
import { MISE_FLAGS, MSB_TOOL, offlineMiseEnv } from "../mise-tools.ts";
import { createObservedHost } from "../observed-host.ts";
import { profileCatalog } from "../profile-lock.ts";
import { PROFILE_NAMES, type ProfileName } from "../sandbox-profiles.ts";
import {
  DEBUG_SHELL_LIFETIME_MS,
  isDebugMount,
  type DebugMount,
  type TerminalCommand,
} from "../sandbox-runtime.ts";
import { readLock, type Host } from "./prerequisites.ts";

export function parseSandboxShell(args: readonly string[]) {
  if (args[0] !== "shell") throw new Error("usage");
  let run = false;
  let profile: ProfileName | undefined;
  const allow: HostPort[] = [];
  const mounts: DebugMount[] = [];
  for (let i = 1; i < args.length; i++) {
    switch (args[i]) {
      case "--run":
        if (run) throw new Error("usage");
        run = true;
        break;
      case "--profile": {
        const value = args[++i] as ProfileName;
        if (profile || !PROFILE_NAMES.includes(value)) throw new Error("usage");
        profile = value;
        break;
      }
      case "--allow": {
        const match = /^([a-z0-9.-]+):(80|443)(?![\s\S])/i.exec(
          args[++i] ?? "",
        );
        if (!match || allow.length >= 64) throw new Error("usage");
        allow.push({ hostname: match[1]!, port: Number(match[2]) });
        break;
      }
      case "--mount-dir": {
        const [host, guest, mode, ...extra] = (args[++i] ?? "").split(":");
        const mount = {
          host: host ?? "",
          guest: guest ?? "",
          readOnly: mode === "ro",
        };
        if (
          extra.length ||
          (mode !== undefined && mode !== "ro") ||
          mounts.length >= 16 ||
          !isDebugMount(mount) ||
          mounts.some((other) => overlaps(other.guest, mount.guest))
        )
          throw new Error("usage");
        mounts.push(mount);
        break;
      }
      default:
        throw new Error("usage");
    }
  }
  return {
    run,
    profile: profile ?? "base",
    allow: new EgressPolicy({ allow }).allow,
    mounts,
  };
}

function contains(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return (
    path === "" ||
    (path !== ".." && !path.startsWith("../") && !isAbsolute(path))
  );
}

function overlaps(first: string, second: string): boolean {
  return contains(first, second) || contains(second, first);
}

export async function sandboxShellPlan(
  root: string,
  env: NodeJS.ProcessEnv,
  options: ReturnType<typeof parseSandboxShell>,
) {
  const profiles = profileCatalog(ALPINE_3_23.reference, await readLock(root));
  const { profile, allow, mounts } = options;
  const directory = join(userStateDirectory(env), "sandbox-shell");
  return {
    profiles,
    directory,
    plan: {
      profile,
      image: profiles.get(profile).image,
      allow,
      mounts,
      egress: "gateway",
      maxLifetimeMs: DEBUG_SHELL_LIFETIME_MS,
      auditPath: join(directory, "audit.sqlite"),
    },
  };
}

export async function runSandboxShell(
  host: Host,
  { plan, directory, profiles }: Awaited<ReturnType<typeof sandboxShellPlan>>,
  command?: TerminalCommand,
) {
  const home = await requireMsbHome(
    host.env,
    readLayer("user", undefined, host.env),
  );
  const tool = await host.command(
    "mise",
    [...MISE_FLAGS, "where", MSB_TOOL],
    offlineMiseEnv(host.env),
  );
  if (tool.code !== 0 || !isAbsolute(tool.stdout.trim()))
    throw new Error("Pinned Microsandbox is unavailable");
  const binary = await realpath(join(tool.stdout.trim(), "msb"));
  const state = userStateDirectory(host.env);
  privateDirectory(state);
  const mounts = await Promise.all(
    plan.mounts.map(async (mount) => {
      const path = await realpath(mount.host);
      if (
        !isDebugMount({ ...mount, host: path }) ||
        !(await stat(path)).isDirectory() ||
        [state, home, binary].some((protectedPath) =>
          overlaps(protectedPath, path),
        )
      )
        throw new Error("Invalid sandbox shell mount directory");
      return { ...mount, host: path };
    }),
  );
  privateDirectory(directory);
  const observed = await createObservedHost({
    config: {
      directory: join(directory, "observability"),
      audit: { mode: "required" },
      telemetry: { enabled: false },
    },
    auditPath: plan.auditPath,
    msb: { binary, home, stagingRoot: join(directory, "sandboxes") },
    profiles,
  });
  try {
    return await observed.host.runSandboxShell(
      plan.profile,
      plan.allow,
      mounts,
      undefined,
      command,
    );
  } finally {
    await observed.close();
  }
}
