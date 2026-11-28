import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, open, realpath } from "node:fs/promises";
import { realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import { invalid, type ConfigFix } from "../config/messages.ts";
import { matchesBunEnvironmentPath } from "../environments/bun.ts";
import type { LocalGitIntegration } from "../git-integration.ts";
import { foldTreePath, matchesTreePaths } from "../workspace-tree.ts";
import {
  ContractError,
  contentDigest,
  fields,
  integer,
  scopePath,
  string,
  unique,
  validateIntegrationContent,
  type IntegrationContent,
} from "./model.ts";

export interface HostCheckDeclaration {
  readonly name: string;
  readonly argv: readonly [string, ...string[]];
  readonly timeoutMs: number;
  readonly env?: Readonly<Record<string, string>>;
  readonly keychain?: readonly {
    readonly service: string;
    readonly env: string;
  }[];
  readonly triggers?: readonly string[];
  readonly vmCount: number;
}

type Fix = string | ConfigFix;

const reservedEnv = new Set(["PATH", "HOME", "TMPDIR"]);
const envName = /^[A-Z_][A-Z0-9_]*$/;
const fieldsAllowed = [
  "name",
  "argv",
  "timeoutMs",
  "env",
  "keychain",
  "triggers",
  "vmCount",
];

function object(
  value: unknown,
  key: string,
  next: Fix,
  allowed?: readonly string[],
) {
  try {
    return fields(value, allowed ?? Object.keys(value as object));
  } catch {
    return invalid(
      key,
      allowed
        ? "Expected an object with only supported keys."
        : "Expected an object.",
      next,
    );
  }
}

function boundedArray(
  value: unknown,
  key: string,
  min: number,
  max: number,
  next: Fix,
): unknown[] {
  if (!Array.isArray(value) || value.length < min || value.length > max)
    invalid(key, `Provide a list with ${min} to ${max} entries.`, next);
  return Array.from(value);
}

function boundedInteger(
  value: unknown,
  key: string,
  min: number,
  max: number,
  next: Fix,
): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < min ||
    value > max
  )
    invalid(key, `Provide an integer between ${min} and ${max}.`, next);
  return value === 0 ? 0 : value;
}

function environmentName(value: unknown, key: string, next: Fix): string {
  if (typeof value !== "string" || !envName.test(value))
    invalid(
      key,
      "Use an environment variable name matching [A-Z_][A-Z0-9_]*.",
      next,
    );
  if (reservedEnv.has(value))
    invalid(key, "PATH, HOME and TMPDIR are set by the host.", next);
  return value;
}

export function parseHostChecks(
  value: unknown,
  next: Fix,
): HostCheckDeclaration[] {
  const names = new Set<string>();
  return boundedArray(value, "hostChecks", 0, 8, next).map((item, index) => {
    const key = `hostChecks[${index}]`;
    const raw = object(item, key, next, fieldsAllowed);
    const { name } = raw;
    if (
      typeof name !== "string" ||
      !/^[a-z0-9-]{1,32}$/.test(name) ||
      names.has(name)
    )
      invalid(
        `${key}.name`,
        "Use a unique name of 1 to 32 lowercase letters, digits or hyphens.",
        next,
      );
    names.add(name);
    const argv = boundedArray(raw.argv, `${key}.argv`, 1, 32, next).map(
      (arg, i) => {
        if (
          typeof arg !== "string" ||
          arg.length < 1 ||
          arg.length > 1024 ||
          arg.includes("\0")
        )
          invalid(
            `${key}.argv[${i}]`,
            "Use a string of 1 to 1024 characters with no NUL.",
            next,
          );
        return arg;
      },
    );
    const [command, ...args] = argv;
    if (!command || !isAbsolute(command))
      invalid(`${key}.argv[0]`, "Use an absolute executable path.", next);
    const timeoutMs = boundedInteger(
      raw.timeoutMs,
      `${key}.timeoutMs`,
      1000,
      7_200_000,
      next,
    );
    const vmCount =
      "vmCount" in raw
        ? boundedInteger(raw.vmCount, `${key}.vmCount`, 0, 4, next)
        : 0;

    let env: Record<string, string> | undefined;
    if ("env" in raw) {
      const entries = Object.entries(object(raw.env, `${key}.env`, next));
      if (entries.length > 32)
        invalid(`${key}.env`, "Use at most 32 environment variables.", next);
      env = Object.fromEntries(
        entries.map(([variable, value]) => {
          environmentName(variable, `${key}.env`, next);
          if (
            typeof value !== "string" ||
            value.length > 1024 ||
            value.includes("\0")
          )
            invalid(
              `${key}.env.${variable}`,
              "Use a string of up to 1024 characters with no NUL.",
              next,
            );
          return [variable, value];
        }),
      );
    }
    const home = env?.MSB_HOME;
    if (vmCount > 0 && (!home || !isAbsolute(home)))
      invalid(
        `${key}.env.MSB_HOME`,
        "An absolute path is required when vmCount is above zero.",
        next,
      );

    const keychainNames = new Set<string>();
    const keychain =
      "keychain" in raw
        ? boundedArray(raw.keychain, `${key}.keychain`, 0, 8, next).map(
            (item, i) => {
              const entryKey = `${key}.keychain[${i}]`;
              const { service, env: variable } = object(item, entryKey, next, [
                "service",
                "env",
              ]);
              if (
                typeof service !== "string" ||
                service.length < 1 ||
                service.length > 128 ||
                /[\p{C}\p{Zl}\p{Zp}]/u.test(service)
              )
                invalid(
                  `${entryKey}.service`,
                  "Use a Keychain item name of 1 to 128 printable characters.",
                  next,
                );
              const name = environmentName(variable, `${entryKey}.env`, next);
              if (name === "MSB_HOME")
                invalid(
                  entryKey + ".env",
                  "Declare MSB_HOME as a literal value.",
                  next,
                );
              if (keychainNames.has(name) || (env && Object.hasOwn(env, name)))
                invalid(
                  `${entryKey}.env`,
                  "Use a variable that appears only once across env and keychain.",
                  next,
                );
              keychainNames.add(name);
              return { service, env: name };
            },
          )
        : undefined;
    let triggers: string[] | undefined;
    if ("triggers" in raw) {
      const triggerKey = `${key}.triggers`;
      if (Array.isArray(raw.triggers) && raw.triggers.length === 0)
        invalid(
          triggerKey,
          "Omit triggers to always run the check; otherwise list at least one path.",
          next,
        );
      const paths = boundedArray(raw.triggers, triggerKey, 1, 64, next);
      try {
        triggers = paths.map(scopePath);
      } catch {
        invalid(triggerKey, "Use relative scope paths.", next);
      }
    }

    return {
      name,
      argv: [command, ...args],
      timeoutMs,
      ...(env && { env }),
      ...(keychain && { keychain }),
      ...(triggers && { triggers }),
      vmCount,
    };
  });
}

/** Identify existing aliases, including homes yet to be created under them. */
function homeIdentity(path: string) {
  const missingParts: string[] = [];
  for (;;) {
    try {
      const real = realpathSync.native(path);
      if (missingParts.length > 0)
        return { path: resolve(real, ...missingParts) };
      const { dev, ino } = statSync(real, { bigint: true });
      return { path: real, inode: `${dev}:${ino}` };
    } catch (error) {
      const parent = dirname(path);
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" || parent === path)
        return undefined;
      missingParts.unshift(basename(path));
      path = parent;
    }
  }
}

function pathsOverlap(left: string, right: string): boolean {
  return (
    left === right ||
    left.startsWith(right === "/" ? right : `${right}/`) ||
    right.startsWith(left === "/" ? left : `${left}/`)
  );
}

export function validateHostCheckHome(
  { vmCount, env }: HostCheckDeclaration,
  agentHome: string | undefined,
  next: Fix,
  key = "hostCheck",
): void {
  if (vmCount === 0) return;
  const homeKey = `${key}.env.MSB_HOME`;
  const home = env?.MSB_HOME;
  if (!home || !isAbsolute(home))
    invalid(
      homeKey,
      "An absolute path is required when vmCount is above zero.",
      next,
    );
  if (!agentHome || !isAbsolute(agentHome))
    invalid(
      homeKey,
      "Set agent-bootstrap's Microsandbox home to an absolute path.",
      next,
    );
  const check = homeIdentity(home);
  const agent = homeIdentity(agentHome);
  if (!check || !agent)
    invalid(
      homeKey,
      "Cannot resolve the Microsandbox homes for comparison.",
      next,
    );
  const overlap =
    check.inode !== undefined && agent.inode !== undefined
      ? check.inode === agent.inode || pathsOverlap(check.path, agent.path)
      : pathsOverlap(foldTreePath(check.path), foldTreePath(agent.path)) ||
        pathsOverlap(
          foldTreePath(resolve(home)),
          foldTreePath(resolve(agentHome)),
        );
  if (overlap)
    invalid(
      homeKey,
      "Use a different Microsandbox home. Neither home may contain the other.",
      next,
    );
}

export function validateHostCheckHomes(
  checks: readonly HostCheckDeclaration[],
  agentHome: string | undefined,
  next: Fix,
): void {
  for (const [index, check] of checks.entries())
    validateHostCheckHome(check, agentHome, next, `hostChecks[${index}]`);
}

export function hostCheckDigest(declaration: HostCheckDeclaration): string {
  const { env, keychain, ...fields } = declaration;
  return contentDigest({
    ...fields,
    ...(env && Object.keys(env).length > 0 && { env }),
    ...(keychain?.length && { keychain }),
  });
}

const baselineNames = new Set([
  "bunfig.toml",
  ".bunfig.toml",
  "bun.lockb",
  "mise.toml",
  ".mise.toml",
  "mise.lock",
  ".tool-versions",
  ".env",
  ".npmrc",
]);

type CandidateChange = Awaited<
  ReturnType<LocalGitIntegration["candidateChanges"]>
>[number];
type ChangedPath = Pick<CandidateChange, "path" | "newMode"> &
  Partial<Pick<CandidateChange, "oldMode">>;

function fileDirectoryReplacements(
  changes: readonly ChangedPath[],
): Set<string> {
  // The recursive Git diff reports the file and the directory's children
  // separately when one takes the place of the other.
  const added = new Map<string, string>();
  const deleted = new Map<string, string>();
  for (const { path, oldMode, newMode } of changes) {
    if (oldMode === "000000") added.set(foldTreePath(path), path);
    if (newMode === "000000") deleted.set(foldTreePath(path), path);
  }
  const replaced = new Set<string>();
  for (const [paths, opposite] of [
    [added, deleted],
    [deleted, added],
  ] as const) {
    for (const path of paths.keys()) {
      for (
        let i = path.lastIndexOf("/");
        i > 0;
        i = path.lastIndexOf("/", i - 1)
      ) {
        const parent = opposite.get(path.slice(0, i));
        if (parent !== undefined) replaced.add(parent);
      }
    }
  }
  return replaced;
}

/** Candidate diffs represent a rename as a deletion and an addition. */
export function matchHostCheck(
  declaration: HostCheckDeclaration,
  changes: readonly ChangedPath[],
): { required: boolean; matched: string[] } {
  const { triggers } = declaration;
  if (triggers === undefined) return { required: true, matched: [] };
  const matched = fileDirectoryReplacements(changes);
  for (const { path, oldMode, newMode } of changes) {
    const folded = foldTreePath(path);
    const basename = folded.slice(folded.lastIndexOf("/") + 1);
    if (
      oldMode === "120000" ||
      newMode === "120000" ||
      (oldMode !== undefined &&
        oldMode !== "000000" &&
        newMode !== "000000" &&
        oldMode !== newMode) ||
      baselineNames.has(basename) ||
      /^\.?mise\..*\.toml$/s.test(basename) ||
      /(?:^|\/)\.config\/mise\//.test(folded) ||
      /(?:^|\/)(?:\.?mise\/config|\.config\/mise)\.toml$/.test(folded) ||
      basename.startsWith(".env.") ||
      (basename.startsWith("tsconfig") && basename.endsWith(".json")) ||
      matchesBunEnvironmentPath(folded) ||
      matchesTreePaths(path, triggers)
    )
      matched.add(path);
  }
  return { required: matched.size > 0, matched: [...matched].sort() };
}

export const HOST_CHECK_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";
export const hostCheckExposure =
  "This runs the candidate as you, with access to your files, network and Keychain. It can change files you can write and read other Keychain items available without a prompt.\nA process that leaves the process group (for example, with setsid) cannot be contained.";

type RequiredCheck = {
  declaration: HostCheckDeclaration;
  matched: readonly string[];
};

export interface HostCheckContent extends IntegrationContent {
  readonly hostCheck: {
    readonly digest: string;
    readonly protectedPaths: readonly string[];
    readonly checks: readonly {
      readonly name: string;
      readonly declarationDigest: string;
      readonly matchedPaths: readonly string[];
      readonly argv: readonly string[];
      readonly envNames: readonly string[];
      readonly keychainServices: readonly string[];
      readonly vmCount: number;
    }[];
  };
}

export function validateHostCheckContent(value: unknown): HostCheckContent {
  const { hostCheck, ...pin } = fields(value, [
    "taskId",
    "goalId",
    "branch",
    "base",
    "candidate",
    "digest",
    "changedPaths",
    "verified",
    "symlinks",
    "review",
    "hostCheck",
  ]);
  const integration = validateIntegrationContent(pin);
  const data = fields(hostCheck, ["digest", "protectedPaths", "checks"]);
  const digest = string(data.digest, 64, 64);
  if (
    !/^[a-f0-9]{64}$/.test(digest) ||
    integration.verified !== true ||
    !Array.isArray(data.checks) ||
    data.checks.length < 1 ||
    data.checks.length > 8
  )
    throw new ContractError();
  const changed = new Set(integration.changedPaths);
  const paths = (value: unknown) =>
    unique(value, 0, changed.size, (path) => {
      const result = scopePath(path);
      if (!changed.has(result)) throw new ContractError();
      return result;
    });
  const checks = data.checks.map((check: unknown) => {
    const {
      name,
      declarationDigest,
      matchedPaths,
      argv,
      envNames,
      keychainServices,
      vmCount,
    } = fields(check, [
      "name",
      "declarationDigest",
      "matchedPaths",
      "argv",
      "envNames",
      "keychainServices",
      "vmCount",
    ]);
    if (
      !Array.isArray(argv) ||
      argv.length < 1 ||
      argv.length > 32 ||
      !Array.isArray(keychainServices) ||
      keychainServices.length > 8
    )
      throw new ContractError();
    const args = Array.from(argv, (arg) => string(arg, 1, 1024));
    const checkDigest = string(declarationDigest, 64, 64);
    if (!isAbsolute(args[0]!) || !/^[a-f0-9]{64}$/.test(checkDigest))
      throw new ContractError();
    return {
      name: string(name, 1, 32),
      declarationDigest: checkDigest,
      matchedPaths: paths(matchedPaths),
      argv: args,
      envNames: unique(envNames, 0, 40, (name) => string(name, 1, 1024)),
      keychainServices: Array.from(keychainServices, (service) =>
        string(service, 1, 128),
      ),
      vmCount: integer(vmCount, 0, 4),
    };
  });
  return {
    ...integration,
    hostCheck: { digest, protectedPaths: paths(data.protectedPaths), checks },
  };
}

const executableDigests = new Map<
  string,
  { identity: string; sha256: string }
>();

export async function executableIdentity(command: string, useCache = true) {
  const path = await realpath(command);
  await access(path, constants.X_OK);
  const file = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const identityOf = async () => {
      const stat = await file.stat({ bigint: true });
      if (!stat.isFile() || (stat.mode & 0o111n) === 0n)
        throw new Error("Invalid host check executable");
      return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(
        ":",
      );
    };
    const identity = await identityOf();
    const cached = executableDigests.get(path);
    if (useCache && cached?.identity === identity)
      return { path, sha256: cached.sha256 };
    const hash = createHash("sha256");
    for await (const bytes of file.createReadStream({ autoClose: false }))
      hash.update(bytes);
    if ((await identityOf()) !== identity)
      throw new Error("Host check executable changed during hashing");
    const sha256 = hash.digest("hex");
    executableDigests.set(path, { identity, sha256 });
    return { path, sha256 };
  } finally {
    await file.close();
  }
}

/** Recompute against current declarations, executables and cached archive before use. */
export async function readHostCheckPin(
  { base, candidate }: Pick<IntegrationContent, "base" | "candidate">,
  declarations: readonly HostCheckDeclaration[],
  environmentArchiveDigest: string | null,
  protectedPaths: readonly string[] = [],
  useCache = true,
) {
  const checks = [];
  for (const declaration of declarations) {
    checks.push({
      declaration: hostCheckDigest(declaration),
      executable: await executableIdentity(declaration.argv[0], useCache),
      keychainServices:
        declaration.keychain?.map(({ service }) => service) ?? [],
    });
  }
  const digest = contentDigest({
    base,
    candidate,
    checks,
    path: HOST_CHECK_PATH,
    environmentArchiveDigest,
    protectedPaths: [...new Set(protectedPaths)].sort(),
  });
  return { digest, executables: checks.map(({ executable }) => executable) };
}

export async function recomputeHostCheckApprovalDigest(
  ...args: Parameters<typeof readHostCheckPin>
): Promise<string> {
  return (await readHostCheckPin(...args)).digest;
}

export function hostCheckRequirement(
  declarations: readonly HostCheckDeclaration[],
  changes: readonly ChangedPath[],
) {
  const required: RequiredCheck[] = [];
  const skipped: string[] = [];
  for (const declaration of declarations) {
    const { required: runs, matched } = matchHostCheck(declaration, changes);
    if (runs) required.push({ declaration, matched });
    else skipped.push(declaration.name);
  }
  return { required, skipped };
}

export async function hostCheckApproval(
  pin: Pick<IntegrationContent, "base" | "candidate">,
  required: readonly RequiredCheck[],
  protectedPaths: readonly string[],
  environmentArchiveDigest: string | null,
): Promise<HostCheckContent["hostCheck"]> {
  return {
    digest: await recomputeHostCheckApprovalDigest(
      pin,
      required.map(({ declaration }) => declaration),
      environmentArchiveDigest,
      protectedPaths,
    ),
    protectedPaths,
    checks: required.map(({ declaration, matched }) => ({
      name: declaration.name,
      declarationDigest: hostCheckDigest(declaration),
      matchedPaths: matched,
      argv: declaration.argv,
      envNames: [
        ...Object.keys(declaration.env ?? {}),
        ...(declaration.keychain?.map(({ env }) => env) ?? []),
      ].sort(),
      keychainServices:
        declaration.keychain?.map(({ service }) => service) ?? [],
      vmCount: declaration.vmCount,
    })),
  };
}
