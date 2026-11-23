import { createHash } from "node:crypto";
import {
  closeSync,
  cpSync,
  fsyncSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
} from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, join } from "node:path";
import {
  ClaudeConfigError,
  readLegacyPrivateFile,
} from "../local-orchestrator/claude-config.ts";
import { assertDetachedImages } from "../volumes/volume.ts";
import {
  convertProjectVolumeConfig,
  convertUserVolumeConfig,
} from "./volume-migration.ts";
import { legacyStateDirectory } from "../local-orchestrator/target.ts";
import {
  configRoot,
  conflictingClaims,
  layerFix,
  missing,
  mergeConfig,
  maxConfigBytes,
  layerFile,
  type Config,
  type EgressActor,
  privatePath,
  projectConfigDirectory,
  projectStateDirectory,
  readPrivateConfig,
  record,
  syncDirectory,
  userStateDirectory,
  writePrivateConfig,
} from "./layers.ts";
import { ConfigError, invalid } from "./messages.ts";
import {
  addProject,
  defaultProjectName,
  assertExternalPaths,
  listProjects,
  projectMissing,
  repository,
  worktrees,
} from "./projects.ts";

const { Database } = createRequire(import.meta.url)("bun:sqlite") as {
  Database: new (
    path: string,
    options: { readonly: boolean },
  ) => {
    query(sql: string): { get(...args: string[]): unknown };
    close(): void;
  };
};

const retry =
  "Stop the launcher, release any leases, then run agent-bootstrap migrate.";
const leaseRecovery =
  "Stop active runs and use the volume recovery command for the installed version before retrying migration.";
const locate =
  "Run agent-bootstrap migrate with the original target worktree paths.";
const markerName = ".layout-migration.json";
const maxJournalBytes = 2 * 1024 * 1024;

function exists(path: string) {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (missing(error)) return false;
    throw error;
  }
}

function checkDatabase(
  path: string,
  queries: readonly [string, string][],
  next = retry,
) {
  if (!exists(path)) return;
  try {
    const info = lstatSync(path);
    if (
      !info.isFile() ||
      info.nlink !== 1 ||
      info.uid !== process.getuid?.() ||
      (info.mode & 0o077) !== 0
    )
      throw new Error();
    const db = new Database(path, { readonly: true });
    try {
      for (const [table, condition] of queries) {
        if (
          db
            .query("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?")
            .get(table) &&
          db.query(`SELECT 1 FROM ${table} WHERE ${condition} LIMIT 1`).get()
        )
          invalid("migration", "A lease or run is active.", next);
      }
    } finally {
      db.close();
    }
  } catch (error) {
    if (error instanceof ConfigError) throw error;
    invalid("migration", "Legacy activity could not be checked safely.", next);
  }
}

function oldSlug(repoRoot: string) {
  const name =
    basename(repoRoot)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .slice(0, 32)
      .replace(/^-|-$/g, "") || "repository";
  const hash = createHash("sha256").update(repoRoot).digest("hex");
  return `${name}-${hash.slice(0, 12)}`;
}

function legacyConfig(
  directory: string,
  name: string,
  convert: (value: unknown, fix: ReturnType<typeof layerFix>) => Config,
) {
  const path = join(directory, "config.json");
  if (!exists(path)) return undefined;
  const fix = {
    ...layerFix("local", { path, name }),
    next: `Correct the legacy configuration for ${name} at ${path}, then run agent-bootstrap migrate.`,
  };
  let value: unknown;
  try {
    value = readLegacyPrivateFile(path, maxConfigBytes, true);
  } catch (error) {
    if (!(error instanceof ClaudeConfigError)) throw error;
    invalid("$", "The target configuration is invalid or unsafe to read.", fix);
  }
  const raw = record(value, "$", fix, ["profile", "argv", "claude"]);
  const config = convert(
    {
      version: 1,
      ...(raw.profile !== undefined || raw.argv !== undefined
        ? { verification: { profile: raw.profile, argv: raw.argv } }
        : {}),
      ...(raw.claude === undefined ? {} : { claude: raw.claude }),
    },
    fix,
  );
  checkConfigSize(config, maxConfigBytes, fix);
  return config;
}

function syncState(path: string) {
  const info = lstatSync(path);
  if (info.isSymbolicLink()) return;
  if (info.isDirectory()) {
    for (const entry of readdirSync(path)) syncState(join(path, entry));
    syncDirectory(path);
  } else if (info.isFile()) {
    const fd = openSync(path, "r");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } else
    invalid(
      "migration.state",
      "Legacy state contains an unsupported file type.",
      retry,
    );
}

function checkConfigSize(
  value: unknown,
  limit: number,
  fix: ReturnType<typeof layerFix>,
) {
  if (Buffer.byteLength(JSON.stringify(value, null, 2)) + 1 > limit)
    invalid(
      "migration",
      "The converted configuration exceeds the file size limit.",
      fix,
    );
}

function checkRuns(directory: string) {
  checkDatabase(join(directory, "state.db"), [
    ["actor_sessions", "status = 'active'"],
    ["tasks", "status = 'running'"],
    ["executions", "status IN ('queued', 'running')"],
  ]);
}

function checkLeases(stateRoot: string) {
  for (const subdirectory of ["credentials", "volumes"]) {
    const root = join(stateRoot, subdirectory);
    if (!exists(root)) continue;
    privatePath(root, stateRoot);
    for (const entry of readdirSync(root)) {
      const directory = join(root, entry);
      privatePath(directory, stateRoot);
      checkDatabase(
        join(directory, "lock.sqlite"),
        [["lease", "1"]],
        leaseRecovery,
      );
    }
  }
}

export function migrate(
  checkout: string,
  paths: readonly string[] = [],
  env = process.env,
  checkAttachments = assertDetachedImages,
) {
  const bootstrapRoot = realpathSync(checkout);
  const root = legacyStateDirectory(bootstrapRoot);
  const oldDefaultVolume = `lo-concierge-${createHash("sha256").update(bootstrapRoot).digest("hex").slice(0, 16)}`;
  const cleanup = root + ".migrated";
  const registered = listProjects(env);
  const stateRoot = userStateDirectory(env);
  const userFix = layerFile("user", env);
  const currentUser = readPrivateConfig(
    userFix.path,
    configRoot(env),
    "$",
    userFix,
  );
  const journalPath = join(configRoot(env), ".volume-migration.json");
  const rawJournal = readPrivateConfig(
    journalPath,
    configRoot(env),
    "migration",
    retry,
    maxJournalBytes,
  );
  const journal =
    rawJournal === undefined
      ? undefined
      : record(rawJournal, "migration", userFix, [
          "version",
          "before",
          "after",
          "legacyRoot",
          "projects",
        ]);
  const sameConfig = (left: unknown, right: unknown) =>
    JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
  if (
    journal &&
    (journal.version !== 1 ||
      (!sameConfig(currentUser, journal.before) &&
        !sameConfig(currentUser, journal.after)))
  )
    invalid(
      "migration",
      "The user configuration changed during an incomplete migration.",
      retry,
    );
  if (journal && journal.legacyRoot !== null && journal.legacyRoot !== root)
    invalid(
      "migration",
      "The pending legacy state belongs to a different checkout.",
      "Rerun agent-bootstrap migrate from the original bootstrap checkout.",
    );
  const rawUser = journal ? (journal.before ?? undefined) : currentUser;
  const userConfig =
    rawUser === undefined ? { version: 1 } : record(rawUser, "$", userFix);
  const user = convertUserVolumeConfig({ version: 1, ...userConfig }, userFix);
  const journalProjects = journal
    ? record(journal.projects, "migration.projects", userFix)
    : undefined;
  const projectDigest = (identity: string, config: Config) =>
    createHash("sha256")
      .update(JSON.stringify([identity, config]))
      .digest("hex");
  const convertLocal = (
    name: string,
    identity: string,
    id: string | undefined,
    value: unknown,
    fix: ReturnType<typeof layerFix>,
  ) => {
    const pending =
      journalProjects && Object.hasOwn(journalProjects, name)
        ? record(journalProjects[name], "migration.projects", userFix, [
            "id",
            "digest",
          ])
        : undefined;
    const plan = convertProjectVolumeConfig(
      value,
      fix,
      journalProjects && !pending
        ? { ...user, active: false, legacy: {} }
        : user,
    );
    if (
      journalProjects &&
      (pending
        ? (pending.id !== null && pending.id !== id) ||
          pending.digest !== projectDigest(identity, plan.config)
        : plan.converted)
    )
      invalid(
        "migration",
        "The project configuration changed during an incomplete migration.",
        fix,
      );
    return { ...plan, identity, id };
  };
  const legacyLocalPlans = new Map<string, ReturnType<typeof convertLocal>>();
  const localPlans = () =>
    registered.flatMap(({ name, identity, id }) => {
      const directory = projectConfigDirectory(name, env);
      const fix = layerFile("local", env, directory);
      const value = readPrivateConfig(fix.path, configRoot(env), "$", fix);
      if (value === undefined && legacyLocalPlans.has(name)) return [];
      return [
        {
          name,
          fix,
          create: value === undefined,
          ...convertLocal(name, identity, id, value ?? { version: 1 }, fix),
        },
      ];
    });
  const userPlan = () => {
    const { config } = user;
    mergeConfig(config, undefined, { version: 1 }, env);
    checkConfigSize(config, maxConfigBytes, userFix);
    const locals = localPlans();
    const projects = new Map(legacyLocalPlans);
    for (const plan of locals) {
      const legacy = legacyLocalPlans.get(plan.name);
      if (
        (user.converted || journal) &&
        legacy &&
        !sameConfig(plan.config, legacy.config)
      )
        invalid(
          "$",
          "A different local configuration already exists.",
          plan.fix,
        );
      projects.set(plan.name, plan);
      checkConfigSize(plan.config, maxConfigBytes, plan.fix);
    }
    const claims = new Map<
      string,
      { project: string; mount: NonNullable<Config["mounts"]>[string] }[]
    >();
    for (const [project, { config: local }] of projects) {
      const directory = projectConfigDirectory(project, env);
      mergeConfig(config, undefined, local, env, directory);
      for (const [name, mount] of Object.entries(local.mounts ?? {})) {
        const key = `${mount.volume}/${mount.dir}`;
        const entries = claims.get(key) ?? [];
        if (
          entries.some(
            (other) =>
              other.project !== project &&
              conflictingClaims(other.mount, mount),
          )
        )
          invalid(
            `mounts.${name}.dir`,
            "A directory with a write grant is also claimed by another project.",
            layerFile("local", env, directory),
          );
        entries.push({ project, mount });
        claims.set(key, entries);
      }
    }
    return {
      config,
      changed:
        user.converted ||
        (rawUser !== undefined && !Object.hasOwn(userConfig, "version")),
      locals,
      projects,
    };
  };

  const applyVolumes = ({
    config,
    changed,
    locals,
    projects,
  }: ReturnType<typeof userPlan>) => {
    checkLeases(stateRoot);
    for (const project of registered) {
      const directory = projectStateDirectory(project.name, env);
      if (exists(directory)) {
        privatePath(directory, stateRoot);
        checkRuns(directory);
      }
    }
    try {
      checkAttachments(
        Object.values(config.volumes ?? {}).map(({ image }) => image),
      );
    } catch {
      invalid(
        "volumes",
        "Volumes must be detached before migration.",
        leaseRecovery,
      );
    }
    if (journal && !sameConfig(config, journal.after))
      invalid(
        "migration",
        "The planned user configuration changed during migration.",
        retry,
      );
    if (!journal && changed) {
      // Resume with the original defaults only for the projects in this plan.
      const entry = {
        version: 1,
        before: rawUser ?? null,
        after: config,
        legacyRoot: exists(root) ? root : null,
        projects: Object.fromEntries(
          [...projects].map(([name, plan]) => [
            name,
            {
              id: plan.id ?? null,
              digest: projectDigest(plan.identity, plan.config),
            },
          ]),
        ),
      };
      checkConfigSize(entry, maxJournalBytes, userFix);
      writePrivateConfig(journalPath, configRoot(env), entry, true);
    }
    if (changed && !sameConfig(currentUser, config))
      writePrivateConfig(userFix.path, configRoot(env), config);
    for (const { fix, config: local, converted, create } of locals) {
      if (converted)
        writePrivateConfig(fix.path, configRoot(env), local, create);
    }
    if (!changed && ![...projects.values()].some(({ converted }) => converted))
      return undefined;
    const actors = [
      ...new Set(
        [...projects.values()].flatMap(({ mounts }) =>
          Object.values(mounts).flatMap(({ actors }) => actors),
        ),
      ),
    ];
    return {
      actorsLosingWriteAccess: actors,
      actorsLosingShellTools: actors,
      projects: [...projects].map(([project, plan]) => {
        const previousMounts = { ...config.mounts, ...plan.previous.mounts };
        const addedMounts = Object.entries(plan.mounts)
          .filter(([name]) => !Object.hasOwn(previousMounts, name))
          .map(([, mount]) => mount);
        const mountedActors = new Set(
          Object.values(previousMounts).flatMap(({ actors }) => actors),
        );
        const addedEgress: Partial<Record<EgressActor, number>> = {};
        for (const actor of Object.keys(
          plan.config.egress ?? {},
        ) as EgressActor[]) {
          if (actor === "shell") continue;
          const previous = new Set([
            ...(config.egress?.[actor] ?? []),
            ...(plan.previous.egress?.[actor] ?? []),
          ]);
          const count = new Set(
            (plan.config.egress?.[actor] ?? []).filter(
              (entry) => !previous.has(entry),
            ),
          ).size;
          if (count) addedEgress[actor] = count;
        }
        return {
          project,
          addedEgress,
          addedMounts: addedMounts.length,
          actorsLosingShellTools: [
            ...new Set(addedMounts.flatMap(({ actors }) => actors)),
          ].filter((actor) => !mountedActors.has(actor)),
        };
      }),
      localJsonMountExample: {
        mounts: {
          "new-mount": {
            volume: "<volume>",
            dir: "new-directory",
            actors: ["<actor>"],
            path: "/mnt/new-directory",
            mode: "rw",
          },
        },
      },
      next: [
        'Add a uniquely named mount in the project local.json with a dedicated dir and path, mode "rw" and exactly one actor.',
        "If replacing an existing mount environment variable, remove the duplicate assignment from the read-only mount first.",
        "Run agent-bootstrap volume shell <mount> --target <path> to create its directory. Exit the shell before launching the actor.",
      ],
    };
  };

  const finishVolumeMigration = () => {
    if (exists(journalPath)) {
      rmSync(journalPath);
      syncDirectory(configRoot(env));
    }
  };

  if (!exists(root)) {
    const volumeMigration = applyVolumes(userPlan());
    const orphanedVolumes: string[] = [];
    if (exists(cleanup)) {
      privatePath(cleanup, cleanup);
      orphanedVolumes.push(oldDefaultVolume);
      const targets = join(cleanup, "targets");
      if (exists(targets)) {
        privatePath(targets, cleanup);
        for (const name of readdirSync(targets).sort())
          if (/^[a-z0-9-]{1,32}-[a-f0-9]{12}$/.test(name))
            orphanedVolumes.push(`lo-concierge-${name}`);
      }
      rmSync(cleanup, { recursive: true });
    }
    finishVolumeMigration();
    return {
      projects: [],
      orphanedVolumes,
      ...(volumeMigration ? { volumeMigration } : {}),
    };
  }
  if (exists(cleanup))
    invalid(
      "migration",
      "A previous migration cleanup is pending.",
      "Inspect the legacy state directories before retrying.",
    );
  privatePath(root, root);
  const targets = join(root, "targets");
  if (exists(targets)) privatePath(targets, root);
  const bootstrap = repository(checkout);
  const supplied = [bootstrap, ...paths.map(repository)];
  const identities = new Set([
    ...supplied.map((repo) => repo.identity),
    ...registered
      .filter((project) => !projectMissing(project))
      .map((project) => project.identity),
  ]);
  for (const identity of identities) {
    for (const path of worktrees(identity)) {
      if (!exists(path)) continue;
      try {
        const candidate = repository(path);
        if (candidate.identity === identity) supplied.push(candidate);
      } catch (error) {
        if (!(error instanceof ConfigError)) throw error;
      }
    }
  }
  const jobs = [{ directory: root, repo: bootstrap }];
  const orphanedVolumes = [oldDefaultVolume];
  for (const slug of exists(targets) ? readdirSync(targets).sort() : []) {
    const directory = join(targets, slug);
    privatePath(directory, root);
    const repo = supplied.find(({ repoRoot }) => slug === oldSlug(repoRoot));
    if (!repo)
      invalid(
        "migration.targets",
        "An original target worktree cannot be identified from its legacy directory.",
        locate,
      );
    jobs.push({ directory, repo });
    orphanedVolumes.push(`lo-concierge-${slug}`);
  }
  if (new Set(jobs.map(({ repo }) => repo.identity)).size !== jobs.length)
    invalid(
      "migration.targets",
      "Several legacy targets share one project identity and their state conflicts.",
      "Archive the conflicting legacy state before retrying.",
    );

  const projectNames = new Map(
    registered.map(({ name, identity }) => [name, identity]),
  );
  const plans = jobs.map(({ directory, repo }) => {
    assertExternalPaths(repo, env);
    checkRuns(directory);
    const project = registered.find(
      ({ identity }) => identity === repo.identity,
    );
    const name =
      project?.name ??
      defaultProjectName(
        basename(repo.identity) === ".git"
          ? dirname(repo.identity)
          : repo.repoRoot,
      );
    if (projectNames.has(name) && projectNames.get(name) !== repo.identity)
      invalid(
        "migration.targets",
        "Legacy targets conflict on a project name.",
        locate,
      );
    projectNames.set(name, repo.identity);
    const convert = (value: unknown, fix: ReturnType<typeof layerFix>) => {
      const plan = convertLocal(name, repo.identity, project?.id, value, fix);
      legacyLocalPlans.set(name, plan);
      return plan.config;
    };
    let config = legacyConfig(directory, name, convert);
    if (!config && !project) {
      const fix = layerFile("local", env, projectConfigDirectory(name, env));
      const plan = convertLocal(
        name,
        repo.identity,
        undefined,
        { version: 1 },
        fix,
      );
      if (plan.converted) {
        legacyLocalPlans.set(name, plan);
        config = plan.config;
      }
    }
    return { directory, repo, config };
  });

  const volumeMigration = applyVolumes(userPlan());
  const names: string[] = [];
  for (const { directory, repo, config } of plans) {
    const project =
      registered.find(({ identity }) => identity === repo.identity) ??
      addProject(repo.repoRoot, undefined, env);
    names.push(project.name);
    const destination = projectStateDirectory(project.name, env);
    const configDirectory = projectConfigDirectory(project.name, env);
    const marker = { version: 1, source: directory };
    if (exists(destination)) {
      const previous = readPrivateConfig(
        join(destination, markerName),
        stateRoot,
        "migration",
        retry,
      );
      if (JSON.stringify(previous) !== JSON.stringify(marker))
        invalid(
          "migration.state",
          "The destination already contains project state.",
          "Archive the existing project state before retrying.",
        );
    }
    const local = join(configDirectory, "local.json");
    if (config) {
      const fix = layerFix("local", { path: local, name: project.name });
      const previous = readPrivateConfig(local, configRoot(env), "$", fix);
      if (previous === undefined)
        writePrivateConfig(local, configRoot(env), config, true);
      else if (JSON.stringify(previous) !== JSON.stringify(config))
        invalid("$", "A different local configuration already exists.", {
          ...fix,
          next: `Resolve the configuration conflict for ${project.name} at ${local}, then rerun agent-bootstrap migrate.`,
        });
    }
    if (exists(destination)) continue;
    const parent = dirname(destination);
    privatePath(parent, stateRoot, true);
    const temp = mkdtempSync(join(parent, ".migration-"));
    try {
      for (const entry of readdirSync(directory)) {
        if (
          entry === "config.json" ||
          (directory === root && entry === "targets")
        )
          continue;
        cpSync(join(directory, entry), join(temp, entry), {
          recursive: true,
          verbatimSymlinks: true,
        });
      }
      writePrivateConfig(join(temp, markerName), stateRoot, marker);
      syncState(temp);
      renameSync(temp, destination);
      syncDirectory(parent);
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  }
  renameSync(root, cleanup);
  syncDirectory(dirname(root));
  rmSync(cleanup, { recursive: true });
  syncDirectory(dirname(root));
  finishVolumeMigration();
  return {
    projects: names,
    orphanedVolumes,
    ...(volumeMigration ? { volumeMigration } : {}),
  };
}
