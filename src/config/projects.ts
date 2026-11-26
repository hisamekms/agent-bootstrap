import { randomBytes, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  lstatSync,
  readdirSync,
  renameSync,
  realpathSync,
  rmSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import {
  configRoot,
  declarationBounds,
  layerFix,
  mergeConfig,
  missing,
  oid,
  parseConfig,
  parseJson,
  privateConfigDirectory,
  projectConfigDirectory,
  projectStateDirectory,
  userStateDirectory,
  projectName,
  projectsRoot,
  readApproved,
  readLayer,
  readPrivateConfig,
  record,
  syncDirectory,
  writePrivateConfig,
  type ApprovedConfig,
  type Config,
} from "./layers.ts";
import { ConfigError, invalid, type ConfigFix } from "./messages.ts";

export interface Project {
  version: 1;
  name: string;
  identity: string;
  id: string;
}

const registryFix =
  "Run agent-bootstrap project list and check the project registration.";
const declarationPath = ".agent-bootstrap/project.json";
const maxDeclarationBytes = 64 * 1024;

function git(directory: string, args: string[], common = false) {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
  );
  const command = common ? ["--git-dir", directory] : ["-C", directory];
  return spawnSync("git", ["--no-replace-objects", ...command, ...args], {
    env: {
      ...env,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_NO_LAZY_FETCH: "1",
      GIT_ALLOW_PROTOCOL: "",
    },
    maxBuffer: maxDeclarationBytes + 8192,
    timeout: 15_000,
  });
}

function line(bytes: Buffer) {
  return bytes.toString("utf8").replace(/\n$/, "");
}

function invalidWorktree(): never {
  return invalid(
    "project.identity",
    "Provide an accessible Git worktree root.",
    "Run agent-bootstrap project add <path> with a Git worktree root.",
  );
}

export function repository(path: string) {
  try {
    const repoRoot = realpathSync(resolve(path));
    const result = git(repoRoot, [
      "rev-parse",
      "--path-format=absolute",
      "--git-common-dir",
      "--show-toplevel",
    ]);
    if (result.status !== 0) throw new Error();
    const output = line(result.stdout);
    const suffix = "\n" + repoRoot;
    if (!output.endsWith(suffix)) throw new Error();
    const identity = realpathSync(output.slice(0, -suffix.length));
    return { identity, repoRoot };
  } catch {
    return invalidWorktree();
  }
}

export function repositoryWithinRoot(
  path: string,
  env: NodeJS.ProcessEnv,
  ErrorType = ConfigError,
) {
  const configured = readLayer("user", undefined, env).repositories?.root;
  const outsideRoot = (): never => {
    throw new ErrorType(
      "repositories.root",
      "The target is outside repositories.root.",
      "Set repositories.root in the user configuration to a directory that contains the target (agent-bootstrap config edit).",
    );
  };
  const canonicalDirectory = (value: string, fail: () => never): string => {
    try {
      const canonical = realpathSync(value);
      if (statSync(canonical).isDirectory()) return canonical;
    } catch {}
    return fail();
  };
  const root = canonicalDirectory(configured ?? (env.HOME || homedir()), () => {
    throw new ErrorType(
      "repositories.root",
      "The repository root cannot be resolved to a directory.",
      "Set repositories.root in the user configuration to an accessible directory (agent-bootstrap config edit).",
    );
  });
  const repoRoot = canonicalDirectory(resolve(path), invalidWorktree);
  const child =
    process.platform === "darwin"
      ? relative(root.toLowerCase(), repoRoot.toLowerCase())
      : relative(root, repoRoot);
  if (isAbsolute(child) || child === ".." || child.startsWith(".." + sep))
    return outsideRoot();
  const depth = child ? child.split(sep).length : 0;
  const parts = repoRoot.split(sep);
  const repositoryPath = depth ? parts.slice(-depth).join(sep) : ".";
  if (process.platform === "darwin") {
    // A case-sensitive volume can have a different directory with the same
    // folded name. Require the candidate's ancestor to be the actual root.
    const ancestor = parts.slice(0, parts.length - depth).join(sep) || sep;
    let sameDirectory = false;
    try {
      const expected = statSync(root);
      const actual = statSync(ancestor);
      sameDirectory =
        expected.dev === actual.dev && expected.ino === actual.ino;
    } catch {}
    if (!sameDirectory) return outsideRoot();
  }
  const repo = repository(repoRoot);
  if (repo.repoRoot !== repoRoot) return invalidWorktree();
  return { ...repo, repositoryPath };
}

export function assertExternalPaths(
  { repoRoot, identity }: ReturnType<typeof repository>,
  env: NodeJS.ProcessEnv,
) {
  const checkouts = [repoRoot];
  if (basename(identity) === ".git") checkouts.push(dirname(identity));
  for (const checkout of checkouts) {
    for (const path of [configRoot(env), userStateDirectory(env)]) {
      const child = relative(checkout, path);
      if (
        !child ||
        (child !== ".." && !child.startsWith(".." + sep) && !isAbsolute(child))
      )
        invalid(
          path,
          "Keep configuration and state outside project worktrees.",
          "Set XDG_CONFIG_HOME and XDG_STATE_HOME to private paths outside the repository.",
        );
    }
  }
}

export function worktrees(identity: string) {
  const result = git(identity, ["worktree", "list", "--porcelain", "-z"], true);
  if (result.status !== 0) return [];
  return result.stdout
    .toString("utf8")
    .split("\0")
    .filter((entry) => entry.startsWith("worktree "))
    .map((entry) => entry.slice("worktree ".length));
}

export function defaultProjectName(repoRoot: string) {
  const name = basename(repoRoot)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return (/^[a-z]/.test(name) ? name : `project-${name}`)
    .slice(0, 48)
    .replace(/-$/, "");
}

export function readProject(
  name: string,
  env = process.env,
): Project | undefined {
  const directory = projectConfigDirectory(name, env);
  const value = readPrivateConfig(
    join(directory, "project.json"),
    configRoot(env),
    "project",
    registryFix,
  );
  if (value === undefined) return undefined;
  const entry = record(value, "project", registryFix, [
    "version",
    "name",
    "identity",
    "id",
  ]);
  if (
    entry.version !== 1 ||
    entry.name !== name ||
    typeof entry.id !== "string" ||
    !/^[a-f0-9]{12}$/.test(entry.id) ||
    typeof entry.identity !== "string" ||
    !isAbsolute(entry.identity) ||
    resolve(entry.identity) !== entry.identity ||
    entry.identity.includes("\0")
  )
    return invalid(
      "project",
      "Expected version 1, the registered name, a project ID and a canonical Git directory.",
      registryFix,
    );
  return { version: 1, name, identity: entry.identity, id: entry.id };
}

export function requireProject(name: string, env = process.env): Project {
  return (
    readProject(name, env) ??
    invalid("project.name", "The project is not registered.", registryFix)
  );
}

export function listProjects(env = process.env): Project[] {
  const root = projectsRoot(env);
  try {
    privateConfigDirectory(root, configRoot(env));
  } catch (error) {
    if (missing(error)) return [];
    throw error;
  }
  const result: Project[] = [];
  for (const name of readdirSync(root)
    .filter((name) => projectName.test(name))
    .sort()) {
    const entry = readProject(name, env);
    if (entry) result.push(entry);
  }
  return result;
}

export function projectMissing(project: Project) {
  try {
    return (
      !lstatSync(project.identity).isDirectory() ||
      realpathSync(project.identity) !== project.identity
    );
  } catch {
    return true;
  }
}

export function addProject(
  path: string,
  name?: string,
  env = process.env,
): Project {
  const repo = repositoryWithinRoot(path, env);
  assertExternalPaths(repo, env);
  const { identity, repoRoot } = repo;
  name ??= defaultProjectName(
    basename(identity) === ".git" ? dirname(identity) : repoRoot,
  );
  const directory = projectConfigDirectory(name, env);
  const alreadyRegistered = () =>
    invalid(
      "project",
      "The name or Git directory is already registered.",
      registryFix,
    );
  if (
    listProjects(env).some(
      (project) => project.name === name || project.identity === identity,
    )
  )
    return alreadyRegistered();
  try {
    lstatSync(projectStateDirectory(name, env));
    invalid(
      "project.name",
      "State remains for this project name.",
      "Archive the retained state or choose a different project name.",
    );
  } catch (error) {
    if (!missing(error)) throw error;
  }
  const project: Project = {
    version: 1,
    name,
    identity,
    id: randomBytes(6).toString("hex"),
  };
  try {
    writePrivateConfig(
      join(directory, "project.json"),
      configRoot(env),
      project,
      true,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST")
      return alreadyRegistered();
    throw error;
  }
  return project;
}

export function moveProject(
  name: string,
  path: string,
  env = process.env,
): Project {
  const previous = requireProject(name, env);
  const repo = repositoryWithinRoot(path, env);
  assertExternalPaths(repo, env);
  const { identity } = repo;
  if (
    listProjects(env).some(
      (project) => project.name !== name && project.identity === identity,
    )
  )
    return invalid(
      "project.identity",
      "The Git directory is already registered.",
      registryFix,
    );
  const project = { ...previous, identity };
  writePrivateConfig(
    join(projectConfigDirectory(name, env), "project.json"),
    configRoot(env),
    project,
  );
  return project;
}

export function removeProject(name: string, env = process.env) {
  requireProject(name, env);
  const directory = projectConfigDirectory(name, env);
  const root = projectsRoot(env);
  privateConfigDirectory(root, configRoot(env));
  const retired = join(root, `.removed-${randomUUID()}`);
  renameSync(directory, retired);
  syncDirectory(root);
  rmSync(retired, { recursive: true });
  syncDirectory(root);
}

function treeEntry(
  identity: string,
  tree: string,
  name: string,
  fix: ConfigFix,
) {
  const result = git(identity, ["ls-tree", "-z", tree, "--", name], true);
  if (result.status !== 0)
    return declarationError("Git could not read the declaration tree.", fix);
  const value = result.stdout.toString("utf8");
  if (value === "") return undefined;
  const match = /^(\d+) (tree|blob|commit) ([a-f0-9]+)\t([^\0]+)\0$/.exec(
    value,
  );
  if (!match || !oid.test(match[3]!) || match[4] !== name)
    return declarationError("Git returned an invalid declaration entry.", fix);
  return { mode: match[1], type: match[2], oid: match[3]! };
}

function declarationError(reason: string, fix: ConfigFix, key = "$"): never {
  return invalid(key, reason, fix);
}

function declarationHead(identity: string, fix: ConfigFix) {
  const result = git(
    identity,
    [
      "for-each-ref",
      "--format=%(refname)%00%(symref)%00%(objectname)%00%(objecttype)",
      "--",
      "refs/heads/main",
    ],
    true,
  );
  const output = result.status === 0 ? line(result.stdout) : "";
  const [ref, symbolic, commit, type] = output.split("\0");
  if (
    ref !== "refs/heads/main" ||
    symbolic !== "" ||
    !commit ||
    !oid.test(commit) ||
    type !== "commit"
  )
    return declarationError(
      "Local main must be a direct commit reference.",
      fix,
      "refs/heads/main",
    );
  const tree = treeEntry(identity, commit, ".agent-bootstrap", fix);
  if (!tree) return { commit };
  if (tree.mode !== "040000" || tree.type !== "tree")
    return declarationError(
      "The declaration directory must be a Git tree.",
      fix,
      ".agent-bootstrap",
    );
  const entry = treeEntry(identity, tree.oid, "project.json", fix);
  if (!entry) return { commit };
  if (entry.mode !== "100644" || entry.type !== "blob")
    return declarationError(
      "The declaration must be a Git blob with mode 100644.",
      fix,
    );
  return { commit, blob: entry.oid };
}

function declarationConfig(
  identity: string,
  blob: string,
  fix: ConfigFix,
): Config {
  const size = git(identity, ["cat-file", "-s", blob], true);
  const bytes = size.status === 0 ? line(size.stdout) : "";
  if (!/^\d+$/.test(bytes) || Number(bytes) > maxDeclarationBytes)
    return declarationError(
      "The declaration must be accessible and at most 64 KiB.",
      fix,
    );
  const result = git(identity, ["cat-file", "blob", blob], true);
  if (result.status !== 0 || result.stdout.length !== Number(bytes))
    return declarationError(
      "Git could not read the complete declaration blob.",
      fix,
    );
  const raw = parseJson(result.stdout, "$", fix);
  declarationBounds(raw, "$", fix);
  return parseConfig(raw, "approved", fix);
}

export function readDeclaration({ identity, name }: Project) {
  const fix = layerFix("declaration", { path: declarationPath, name });
  const { commit, blob } = declarationHead(identity, fix);
  return {
    commit,
    blob,
    config: blob ? declarationConfig(identity, blob, fix) : undefined,
  };
}

export function escapedJson(value: unknown) {
  return JSON.stringify(value, null, 2).replace(
    /[\p{C}\p{Z}\p{Default_Ignorable_Code_Point}]/gu,
    (char) =>
      char === " " || char === "\n"
        ? char
        : char
            .split("")
            .map(
              (part) =>
                "\\u" + part.charCodeAt(0).toString(16).padStart(4, "0"),
            )
            .join(""),
  );
}

function destinations(config?: Config) {
  return config?.egress ?? {};
}

function delta(before: readonly string[] = [], after: readonly string[] = []) {
  return [...new Set(after)].filter((item) => !before.includes(item));
}

export async function approveProject(
  name: string,
  env: NodeJS.ProcessEnv,
  io: {
    isTTY: boolean;
    write(text: string): unknown;
    confirm(question: string): Promise<string | undefined>;
  },
) {
  if (!io.isTTY)
    invalid(
      "approval",
      "Approval requires a terminal on stdin and stdout.",
      `Run agent-bootstrap project approve ${projectName.test(name) ? name : "<name>"} from an operator terminal.`,
    );
  const project = requireProject(name, env);
  const directory = projectConfigDirectory(name, env);
  const shown = readDeclaration(project);
  const approveFix = layerFix("approved", {
    path: join(directory, "approved.json"),
  });
  // An absent declaration requests removal of every prior grant.
  const next: Config = shown.config ?? { version: 1 };
  const approvedBefore = readApproved(directory, env);
  const validateApproval = () =>
    mergeConfig(
      readLayer("user", undefined, env),
      next,
      readLayer("local", directory, env),
      env,
      directory,
    ).config;
  const proposed = validateApproval();
  const old = approvedBefore?.config;
  io.write(`Declaration at main (${shown.commit.slice(0, 7)})\n`);
  const { added, removed } = changes(old, next);
  for (const entry of removed) io.write(`- ${entry}\n`);
  for (const entry of added) io.write(`+ ${entry}\n`);
  if (!added.length && !removed.length)
    io.write("No changes to the approved settings.\n");
  for (const [actor, after] of Object.entries(destinations(next))) {
    if (
      delta(
        destinations(old)[actor as keyof NonNullable<Config["egress"]>],
        after,
      ).length &&
      Object.values(proposed.mounts ?? {}).some((mount) =>
        mount.actors.includes(actor),
      )
    )
      io.write(
        `Warning: egress.${actor} adds destinations for an actor with a mount.\n`,
      );
  }
  if ((await io.confirm(`Type "${name}" to approve: `)) !== name)
    invalid("approval", "The confirmation did not match.", approveFix);
  if (
    requireProject(name, env).identity !== project.identity ||
    escapedJson(readApproved(directory, env) ?? null) !==
      escapedJson(approvedBefore ?? null)
  )
    invalid(
      "approval",
      "The registration or approved copy changed during review.",
      approveFix,
    );
  validateApproval();
  const path = join(directory, "approved.json");
  if (shown.blob) {
    const approved: ApprovedConfig = {
      version: 1,
      commit: shown.commit,
      blob: shown.blob,
      config: next,
    };
    writePrivateConfig(path, configRoot(env), approved);
  } else {
    rmSync(path, { force: true });
    syncDirectory(directory);
  }
}

function changes(before?: Config, after?: Config) {
  const added: string[] = [];
  const removed: string[] = [];
  const old = destinations(before);
  const next = destinations(after);
  for (const actor of Object.keys({ ...old, ...next }) as (keyof NonNullable<
    Config["egress"]
  >)[]) {
    for (const [entries, count] of [
      [added, delta(old[actor], next[actor]).length],
      [removed, delta(next[actor], old[actor]).length],
    ] as const)
      if (count)
        entries.push(
          `egress.${actor} (${count} destination${count === 1 ? "" : "s"})`,
        );
  }
  for (const key of ["verification", "profiles"] as const) {
    const lhs = before?.[key];
    const rhs = after?.[key];
    if (key === "profiles") {
      const a = before?.profiles ?? {};
      const b = after?.profiles ?? {};
      for (const role of Object.keys({ ...a, ...b }) as (keyof typeof a)[]) {
        if (a[role] === b[role]) continue;
        if (a[role]) removed.push(`profiles.${role}`);
        if (b[role]) added.push(`profiles.${role}`);
      }
    } else if (JSON.stringify(lhs) !== JSON.stringify(rhs)) {
      if (lhs) removed.push(key);
      if (rhs) added.push(key);
    }
  }
  return { added, removed };
}

export function driftWarning(project: Project, approved?: ApprovedConfig) {
  const next = `next: Review the change, then run agent-bootstrap project approve ${project.name}.`;
  try {
    const fix = layerFix("declaration", {
      path: declarationPath,
      name: project.name,
    });
    const head = declarationHead(project.identity, fix);
    if (head.blob === approved?.blob) return undefined;
    const after = head.blob
      ? declarationConfig(project.identity, head.blob, fix)
      : undefined;
    const { added, removed } = changes(approved?.config, after);
    return [
      `Warning: .agent-bootstrap/project.json at main (${head.commit.slice(0, 7)}) differs from the approved copy (${approved ? `from ${approved.commit.slice(0, 7)}` : "none"}).`,
      ...(added.length
        ? [`Added requests: ${added.join(", ")}. Not granted until approved.`]
        : []),
      ...(removed.length
        ? [
            `Removed requests: ${removed.join(", ")}. Still granted until approved.`,
          ]
        : []),
      next,
    ].join("\n");
  } catch {
    return `Warning: .agent-bootstrap/project.json at main could not be validated. Approved permissions stay in effect.\n${next}`;
  }
}
