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
import { legacyStateDirectory } from "../local-orchestrator/target.ts";
import {
  configRoot,
  layerFix,
  missing,
  parseConfig,
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
  "Stop the launcher and run agent-bootstrap doctor --claude-auth config-dir. After confirming no VM is running, clear stale or quarantined leases with agent-bootstrap credentials detach --force --claude-auth config-dir, then rerun agent-bootstrap migrate.";
const locate =
  "Run agent-bootstrap migrate with the original target worktree paths.";
const markerName = ".layout-migration.json";

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

function legacyConfig(directory: string, name: string) {
  const path = join(directory, "config.json");
  if (!exists(path)) return undefined;
  const fix = {
    ...layerFix("local", { path, name }),
    next: `Correct the legacy configuration for ${name} at ${path}, then run agent-bootstrap migrate.`,
  };
  let value: unknown;
  try {
    value = readLegacyPrivateFile(path, 256 * 1024, true);
  } catch (error) {
    if (!(error instanceof ClaudeConfigError)) throw error;
    invalid("$", "The target configuration is invalid or unsafe to read.", fix);
  }
  const raw = record(value, "$", fix, ["profile", "argv", "claude"]);
  return parseConfig(
    {
      version: 1,
      ...(raw.profile !== undefined || raw.argv !== undefined
        ? { verification: { profile: raw.profile, argv: raw.argv } }
        : {}),
      ...(raw.claude === undefined ? {} : { claude: raw.claude }),
    },
    "local",
    fix,
  );
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

export function migrate(
  checkout: string,
  paths: readonly string[] = [],
  env = process.env,
) {
  const bootstrapRoot = realpathSync(checkout);
  const root = legacyStateDirectory(bootstrapRoot);
  const oldDefaultVolume = `lo-concierge-${createHash("sha256").update(bootstrapRoot).digest("hex").slice(0, 16)}`;
  const cleanup = root + ".migrated";
  if (!exists(root)) {
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
    return { projects: [], orphanedVolumes };
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
  const stateRoot = userStateDirectory(env);
  const credentials = join(stateRoot, "credentials");
  if (exists(credentials)) {
    privatePath(credentials, stateRoot);
    for (const entry of readdirSync(credentials)) {
      const directory = join(credentials, entry);
      privatePath(directory, stateRoot);
      checkDatabase(
        join(directory, "lock.sqlite"),
        [["lease", "1"]],
        leaseRecovery,
      );
    }
  }
  const registered = listProjects(env);
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

  const plans = jobs.map(({ directory, repo }) => {
    assertExternalPaths(repo, env);
    checkDatabase(join(directory, "state.db"), [
      ["actor_sessions", "status = 'active'"],
      ["tasks", "status = 'running'"],
      ["executions", "status IN ('queued', 'running')"],
    ]);
    const name =
      registered.find(({ identity }) => identity === repo.identity)?.name ??
      defaultProjectName(
        basename(repo.identity) === ".git"
          ? dirname(repo.identity)
          : repo.repoRoot,
      );
    const config = legacyConfig(directory, name);
    return { directory, repo, config };
  });

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
  return { projects: names, orphanedVolumes };
}
