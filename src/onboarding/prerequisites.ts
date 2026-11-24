import type { LocalActorHarnesses } from "../actors.ts";
import { execFile, spawn } from "node:child_process";
import { readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { userInfo } from "node:os";
import {
  ClaudeConfigError,
  loadClaudeConfig,
  userStateDirectory,
  validService,
  type ClaudeAuthMode,
} from "../local-orchestrator/claude-config.ts";
import { Volume, VolumeError } from "../volumes/volume.ts";
import { loadConfig, missing, privatePath } from "../config/layers.ts";
import { ConfigError } from "../config/messages.ts";
import { hasSecretTestPass } from "../local-orchestrator/secret-test-record.ts";
import { CLAUDE_CODE } from "../claude-code.ts";
import {
  driftWarning,
  listProjects,
  projectMissing,
  repository,
} from "../config/projects.ts";
import { ALPINE_3_23, BUN_VERSION } from "../image-recipes.ts";
import {
  hasLegacyState,
  rejectLegacyState,
  resolveTarget,
} from "../local-orchestrator/target.ts";
import {
  MISE_DUCKDB,
  MISE_FLAGS,
  MISE_MSB,
  MSB_TOOL,
  offlineMiseEnv,
} from "../mise-tools.ts";
import {
  parseProfileLock,
  PROFILE_LOCK_PATH,
  type ProfileLock,
} from "../profile-lock.ts";
import {
  allProfiles,
  artifactStatus,
  artifacts,
  defaultProfiles,
} from "./artifacts.ts";

export type Status = "ok" | "missing" | "wrong" | "skipped";

export interface Check {
  effective?: Pick<ReturnType<typeof loadConfig>, "sources">;
  id: string;
  status: Status;
  detail: string;
  fix: string[];
  needsNetwork: boolean;
  needsHuman: boolean;
}

interface CommandResult {
  code: number | null;
  stdout: string;
  stderr?: string;
}

export interface Host {
  platform: string;
  arch: string;
  bun: string;
  env: NodeJS.ProcessEnv;
  actorHarnesses?: LocalActorHarnesses;
  command(
    file: string,
    args: readonly string[],
    env?: NodeJS.ProcessEnv,
    timeout?: number,
  ): Promise<CommandResult>;
  fetch: typeof fetch;
}

export const systemHost: Host = {
  platform: process.platform,
  arch: process.arch,
  bun: process.versions.bun ?? "",
  env: process.env,
  command(file, args, env, timeout = 15_000) {
    // Always discard Keychain metadata too. Never request the password.
    if (file === "/usr/bin/security") {
      return new Promise((resolve) => {
        const probe = spawn(file, args, {
          env,
          stdio: "ignore",
          timeout,
          killSignal: "SIGKILL",
        });
        probe.once("error", () => resolve({ code: null, stdout: "" }));
        probe.once("close", (code) => resolve({ code, stdout: "" }));
      });
    }
    return new Promise((resolve) => {
      execFile(
        file,
        args,
        { env, timeout, killSignal: "SIGKILL", maxBuffer: 1024 * 1024 },
        (error, stdout, stderr) =>
          resolve({
            code: error
              ? typeof error.code === "number"
                ? error.code
                : null
              : 0,
            stdout,
            stderr,
          }),
      );
    });
  },
  fetch: globalThis.fetch,
};

export const install = "bun install --frozen-lockfile --ignore-scripts";
export const provisionKeychain =
  'security add-generic-password -s agent-bootstrap-claude -a "$(id -un)" -w';
export const configureClaude = ["agent-bootstrap config edit"];
const setup = "agent-bootstrap setup --allow-network";
const msbHomeFix = ['mkdir -p "$HOME/.msb"', 'export MSB_HOME="$HOME/.msb"'];

export function check(
  id: string,
  status: Status,
  detail: string,
  fix: string[] = [],
  needsNetwork = false,
  needsHuman = false,
): Check {
  return {
    id,
    status,
    detail,
    fix: status === "ok" ? [] : fix,
    needsNetwork: status !== "ok" && needsNetwork,
    needsHuman: status !== "ok" && needsHuman,
  };
}

export function readLock(root: string): Promise<ProfileLock> {
  return readFile(join(root, PROFILE_LOCK_PATH), "utf8").then(parseProfileLock);
}

export async function imageStatus(
  host: Host,
  home: string,
  reference: string,
): Promise<Status> {
  const result = await msb(host, home, [
    "image",
    "inspect",
    "--format",
    "json",
    reference,
  ]);
  if (result.code === null) return "skipped";
  if (result.code !== 0)
    return result.stderr?.includes(`error: image not found: ${reference}`)
      ? "missing"
      : "skipped";
  try {
    return JSON.parse(result.stdout)?.digest ===
      reference.slice(reference.lastIndexOf("@") + 1)
      ? "ok"
      : "wrong";
  } catch {
    return "wrong";
  }
}

export function msb(
  host: Host,
  home: string,
  args: string[],
  timeout?: number,
) {
  return host.command(
    "mise",
    [...MISE_MSB, ...args],
    { ...offlineMiseEnv(host.env), MSB_HOME: home },
    timeout,
  );
}

export async function hostChecks(root: string, host: Host) {
  const { env } = host;
  const checks: Check[] = [];
  checks.push(
    host.platform === "darwin" && host.arch === "arm64"
      ? check("platform", "ok", "macOS arm64")
      : check(
          "platform",
          "wrong",
          "Run the local orchestrator on an Apple silicon Mac.",
          [],
          false,
          true,
        ),
  );
  checks.push(
    check(
      "bun",
      host.bun === BUN_VERSION ? "ok" : "wrong",
      `Required Bun ${BUN_VERSION}.`,
      [`mise install bun@${BUN_VERSION}`],
      true,
      true,
    ),
  );

  const miseEnv = offlineMiseEnv(env);
  const mise = await host.command("mise", ["--version"], miseEnv);
  checks.push(
    check(
      "mise",
      mise.code === 0 ? "ok" : "missing",
      mise.code === 0
        ? "mise is available."
        : "mise is required to run the pinned Microsandbox.",
      ["brew install mise"],
      true,
      true,
    ),
  );

  const installPath =
    mise.code === 0
      ? await host.command("mise", [...MISE_FLAGS, "where", MSB_TOOL], miseEnv)
      : undefined;
  const expectedVersion = MSB_TOOL.split("@")[1];
  const version =
    installPath?.code === 0 && isAbsolute(installPath.stdout.trim())
      ? await host.command("mise", [...MISE_MSB, "--version"], miseEnv)
      : undefined;
  checks.push(
    check(
      "microsandbox",
      !installPath
        ? "skipped"
        : !version
          ? "missing"
          : version.code === 0 &&
              version.stdout.trim() === `msb ${expectedVersion}`
            ? "ok"
            : "wrong",
      !installPath
        ? "Install mise before checking Microsandbox."
        : `Required local Microsandbox ${expectedVersion}.`,
      [`mise --no-config --no-env --no-hooks install ${MSB_TOOL}`],
      true,
      true,
    ),
  );

  const candidate = env.MSB_HOME;
  const realHome =
    candidate && isAbsolute(candidate)
      ? await realpath(candidate).catch(() => undefined)
      : undefined;
  const home =
    realHome &&
    Buffer.byteLength(realHome) <= 40 &&
    (await stat(realHome).catch(() => undefined))?.isDirectory()
      ? realHome
      : undefined;
  checks.push(
    check(
      "msb-home",
      !candidate ? "missing" : home ? "ok" : "wrong",
      home
        ? "MSB_HOME is an accessible absolute directory within 40 bytes."
        : "Set MSB_HOME to an existing absolute directory at most 40 bytes after realpath.",
      msbHomeFix,
      false,
      true,
    ),
  );

  const manifest = JSON.parse(
    await readFile(join(root, "package.json"), "utf8"),
  ) as {
    dependencies: Record<string, string>;
    devDependencies: Record<string, string>;
  };
  const dependencyStatuses = await Promise.all(
    Object.keys({ ...manifest.dependencies, ...manifest.devDependencies }).map(
      async (name) =>
        (
          await stat(join(root, "node_modules", name, "package.json")).catch(
            () => undefined,
          )
        )?.isFile(),
    ),
  );
  const installed = dependencyStatuses.every(Boolean);
  checks.push(
    check(
      "dependencies",
      installed ? "ok" : "missing",
      installed
        ? "Checkout dependencies are installed."
        : "Install the checkout dependencies from bun.lock.",
      [install],
      true,
      true,
    ),
  );
  return { checks, home };
}

export async function doctor(
  root: string,
  host: Host,
  path?: string,
  concierge = false,
  override?: ClaudeAuthMode,
) {
  const { checks, home } = await hostChecks(root, host);
  const required = new Set(checks.map(({ id }) => id));
  function add(item: Check, isRequired = true) {
    checks.push(item);
    if (isRequired) required.add(item.id);
  }

  const profiles = concierge ? ["concierge"] : allProfiles;
  const lock = await readLock(root).catch(() => undefined);
  const hasProfiles =
    !!lock &&
    defaultProfiles.every((name) => lock.profiles[name] !== undefined);
  add(
    check(
      "profile-lock",
      hasProfiles ? "ok" : "wrong",
      hasProfiles
        ? "The checked-in lock validates against the pinned recipes."
        : "Restore the checked-in profile lock and matching recipes.",
      [],
      false,
      true,
    ),
  );

  let verifyProfile: string | undefined;
  let layers: ReturnType<typeof loadConfig> | undefined;
  let configurationError = false;
  try {
    const legacyRecovery =
      !concierge && path === undefined && (await hasLegacyState(root));
    // Report pending migration while inspecting the user-owned volume.
    if (legacyRecovery) {
      add(
        check(
          "migration",
          "wrong",
          "Legacy local orchestrator state requires migration.",
          ["agent-bootstrap migrate"],
        ),
      );
    } else await rejectLegacyState(root);
    const state = userStateDirectory(host.env);
    try {
      privatePath(state, state);
    } catch (error) {
      if (!missing(error)) throw error;
    }
    const projects = legacyRecovery ? [] : listProjects(host.env);
    for (const project of projects) {
      if (projectMissing(project))
        add(
          check(
            `project-${project.name}`,
            "wrong",
            "The registered Git directory is missing.",
            [`agent-bootstrap project move ${project.name} <path>`],
            false,
            true,
          ),
          !concierge,
        );
    }
    let defaultRegistered = false;
    if (path === undefined && !concierge && projects.length) {
      try {
        const { identity } = repository(root);
        defaultRegistered = projects.some(
          (project) => project.identity === identity,
        );
      } catch (error) {
        if (!(error instanceof ConfigError)) throw error;
      }
    }
    const target =
      path !== undefined || concierge || defaultRegistered
        ? await resolveTarget(path, root, host.env)
        : undefined;
    layers = loadConfig(host.env, target?.configDirectory, host.actorHarnesses);
    if (target) {
      add(
        check(
          "target",
          "ok",
          "Registered Git worktree root has a local SHA-1 main commit.",
        ),
      );
      const drift = driftWarning(target.project, layers.approved);
      if (drift) add(check("configuration-drift", "skipped", drift), false);
      if (!concierge && path !== undefined) {
        const { sources } = layers;
        add(
          {
            ...check(
              "effective-configuration",
              "ok",
              "Effective configuration with its layer sources.",
            ),
            effective: { sources },
          },
          false,
        );
      }
      verifyProfile = layers.config.verification?.profile;
      const valid =
        !verifyProfile ||
        verifyProfile === "base" ||
        !!lock?.profiles[verifyProfile];
      add(
        check(
          "verification",
          !valid ? "wrong" : verifyProfile ? "ok" : "skipped",
          !valid
            ? "The configured Verification profile is not locked."
            : verifyProfile
              ? "Target verification configuration is valid."
              : "Target has no verification configuration.",
          ["agent-bootstrap help targets"],
          false,
          true,
        ),
        !valid,
      );
    }
  } catch (error) {
    configurationError = true;
    add(
      error instanceof ConfigError
        ? error.doctorCheck()
        : check(
            "configuration",
            "wrong",
            "Configuration could not be inspected.",
            ["agent-bootstrap help targets"],
            false,
            true,
          ),
    );
  }

  const alternate = host.env.LO_CLAUDE_BINARY;
  const requiredProfiles = new Set<string>(
    concierge ? ["concierge"] : defaultProfiles,
  );
  if (verifyProfile && verifyProfile !== "base")
    requiredProfiles.add(verifyProfile);
  const includeSecrets = Object.keys(layers?.config.secretEnv ?? {}).length > 0;
  const inputs = artifacts(profiles, alternate, includeSecrets);
  const mainInputs = new Set(
    artifacts(
      concierge ? ["concierge"] : defaultProfiles,
      alternate,
      includeSecrets,
    ).map(({ path }) => path),
  );
  for (const item of inputs) {
    const custom = alternate !== undefined && item.path === alternate;
    const status =
      custom && !isAbsolute(item.path)
        ? "wrong"
        : await artifactStatus(
            isAbsolute(item.path) ? item.path : join(root, item.path),
            item.sha256,
          );
    const fix = custom
      ? ["unset LO_CLAUDE_BINARY"]
      : [
          status === "wrong"
            ? "agent-bootstrap setup --json"
            : mainInputs.has(item.path)
              ? setup
              : `${setup} --profiles`,
        ];
    add(
      check(
        `artifact:${custom ? "LO_CLAUDE_BINARY" : item.path}`,
        status,
        status === "ok"
          ? "SHA-256 matches."
          : status === "missing"
            ? "Pinned file is missing."
            : "Pinned file is unsafe, unreadable, or has the wrong SHA-256. Inspect it against the setup plan before replacing it.",
        fix,
        status === "missing" && !custom,
        custom || status === "wrong",
      ),
      mainInputs.has(item.path),
    );
  }

  const images = {
    base: ALPINE_3_23.reference,
    ...Object.fromEntries(
      Object.entries(lock?.profiles ?? {}).map(([name, profile]) => [
        name,
        profile.image,
      ]),
    ),
  };
  const canInspect =
    !!home &&
    checks.some(({ id, status }) => id === "microsandbox" && status === "ok");
  for (const [name, reference] of Object.entries(images)) {
    const isRequired = name === "base" || requiredProfiles.has(name);
    if (concierge && !isRequired) continue;
    const status = canInspect
      ? await imageStatus(host, home, reference)
      : "skipped";
    add(
      check(
        `image:${name}`,
        status,
        status === "ok"
          ? "Local image digest matches."
          : status === "skipped"
            ? "Local image inspection requires pinned Microsandbox and a valid MSB_HOME."
            : status === "missing"
              ? "Pinned reference could not be inspected in MSB_HOME."
              : "Local image did not report the locked digest.",
        [
          name === "base" || defaultProfiles.some((profile) => profile === name)
            ? setup
            : `${setup} --profiles`,
        ],
        status === "missing",
        status === "wrong",
      ),
      isRequired,
    );
  }

  try {
    if (configurationError) throw new Error("configuration");
    const effective = loadClaudeConfig(host.env, undefined, override, layers);
    add(
      check(
        "claude-auth",
        "ok",
        `Claude authentication configuration is valid (source: ${effective.source}).`,
      ),
    );
    for (const [index, warning] of effective.warnings.entries())
      add(
        check(`claude-config-warning-${index + 1}`, "skipped", warning),
        false,
      );
    for (const [variable, { actors }] of Object.entries(
      effective.config.secretEnv ?? {},
    )) {
      const passed = hasSecretTestPass(userStateDirectory(host.env), variable);
      add(
        check(
          `secretEnv.${variable}`,
          passed ? "ok" : "missing",
          `${actors.join(", ")}. Self-test for CLI ${CLAUDE_CODE.version} ${passed ? "passed" : "required"}.`,
          passed
            ? []
            : [
                `Run agent-bootstrap secrets test ${variable} with the same target.`,
              ],
          false,
          !passed,
        ),
        !concierge,
      );
    }

    const service = effective.keychainService;
    const account = host === systemHost ? userInfo().username : host.env.USER;
    const configured = validService(account) && validService(service);
    const keychain =
      configured && host.platform === "darwin"
        ? await host.command(
            "/usr/bin/security",
            ["find-generic-password", "-s", service, "-a", account],
            { PATH: "/usr/bin:/bin" },
          )
        : undefined;
    const status = !configured
      ? "missing"
      : !keychain || keychain.code === null
        ? "skipped"
        : keychain.code === 0
          ? "ok"
          : keychain.code === 44
            ? "missing"
            : "wrong";
    if (effective.auth === "api-key")
      add(
        check(
          "keychain",
          status,
          status === "ok"
            ? "The configured Keychain item exists."
            : status === "skipped"
              ? "Keychain presence could not be checked on this host."
              : "Keychain did not confirm the configured service and account.",
          service
            ? ["Provision the configured API key service in Keychain."]
            : [...configureClaude, provisionKeychain],
          false,
          true,
        ),
      );

    const mountedActors = new Set(
      Object.values(effective.config.mounts ?? {}).flatMap(
        ({ actors }) => actors,
      ),
    );
    for (const actor of mountedActors) {
      add(
        check(
          `mount-tools-${actor}`,
          "skipped",
          `${actor} loses shell tools when a mount is present.`,
        ),
        false,
      );
      if (
        effective.config.egress?.[
          actor as keyof NonNullable<typeof effective.config.egress>
        ]?.length
      )
        add(
          check(
            `mount-egress-${actor}`,
            "skipped",
            `Warning: ${actor} has a mount and added egress.`,
          ),
          false,
        );
    }
    if (host === systemHost && host.platform === "darwin") {
      for (const [name, definition] of Object.entries(
        effective.config.volumes ?? {},
      )) {
        try {
          const image = await stat(definition.image).catch(() => undefined);
          const volume = new Volume(
            definition,
            userStateDirectory(host.env),
            undefined,
            { volume: name },
          );
          const status = volume.status();
          add(
            check(
              `volumes.${name}`,
              status.stale ? "wrong" : image?.isFile() ? "ok" : "missing",
              status.stale
                ? "The volume has a stale attachment or lease."
                : status.mounted
                  ? "The volume is attached."
                  : image?.isFile()
                    ? "The volume attaches while a lease exists."
                    : "The image is missing.",
              status.stale
                ? [
                    `Confirm no VM is running, then use agent-bootstrap volume detach ${name} --force.`,
                  ]
                : image?.isFile()
                  ? []
                  : [`Run agent-bootstrap volume init ${name}.`],
            ),
          );
        } catch (error) {
          add(
            check(
              `volumes.${name}`,
              "wrong",
              error instanceof VolumeError
                ? error.message
                : "Volume status could not be checked.",
              [
                error instanceof VolumeError
                  ? error.next
                  : `Run agent-bootstrap volume status ${name}.`,
              ],
            ),
          );
        }
      }
    }
  } catch (error) {
    if (!configurationError)
      add(
        error instanceof ConfigError
          ? error.doctorCheck()
          : check(
              "claude-auth",
              "wrong",
              error instanceof ClaudeConfigError
                ? error.message
                : "Invalid configuration: claude.",
              configureClaude,
              false,
              true,
            ),
      );
  }
  if (!concierge) {
    const duck = miseAvailable(checks)
      ? await host.command(
          "mise",
          [...MISE_DUCKDB, "-version"],
          offlineMiseEnv(host.env),
        )
      : undefined;
    add(
      check(
        "duckdb",
        !duck
          ? "skipped"
          : duck.code !== 0
            ? "missing"
            : /\bv?1\.5\.6\b/.test(duck.stdout)
              ? "ok"
              : "wrong",
        "DuckDB 1.5.6 is optional for live analysis queries.",
        ["mise --no-config --no-env --no-hooks install duckdb@1.5.6"],
        true,
        true,
      ),
      false,
    );
  }
  const first = checks.find(
    ({ id, status }) => status !== "ok" && required.has(id),
  );
  return { checks, first };
}

function miseAvailable(checks: Check[]): boolean {
  return checks.some(({ id, status }) => id === "mise" && status === "ok");
}
