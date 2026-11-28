import { realpath, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import type { Config } from "./layers.ts";

type Source = "env" | "user" | "default";
type Failure = {
  source: Source;
  status: "missing" | "wrong";
  detail: string;
  fix: string[];
};

export type MsbHomeResolution = { path: string; source: Source } | Failure;

const editHome =
  "Run agent-bootstrap config edit and set microsandbox.home to a short absolute directory.";
const envFix = ['mkdir -p "$HOME/.msb"', 'export MSB_HOME="$HOME/.msb"'];

export function msbHomeCandidate(
  env: NodeJS.ProcessEnv,
  user: Pick<Config, "microsandbox">,
) {
  const override = env.MSB_HOME;
  const configured = user.microsandbox?.home;
  const source = override
    ? "env"
    : configured !== undefined
      ? "user"
      : "default";
  const candidate =
    override || (configured ?? (env.HOME && `${env.HOME}/.msb`));
  return { candidate, source } as const;
}

export async function resolveMsbHome(
  env: NodeJS.ProcessEnv,
  user: Pick<Config, "microsandbox">,
): Promise<MsbHomeResolution> {
  const { candidate, source } = msbHomeCandidate(env, user);
  const fix = source === "env" ? envFix : [editHome];

  if (!candidate && source === "default")
    return {
      source,
      status: "missing",
      detail:
        "Set HOME to an absolute directory to use the default Microsandbox home.",
      fix,
    };
  if (!candidate || !isAbsolute(candidate))
    return {
      source,
      status: "wrong",
      detail: "The Microsandbox home must be an absolute path.",
      fix,
    };
  try {
    const path = await realpath(candidate);
    if (!(await stat(path)).isDirectory())
      return {
        source,
        status: "wrong",
        detail: "The Microsandbox home must be a directory.",
        fix,
      };
    if (Buffer.byteLength(path) > 40)
      return {
        source,
        status: "wrong",
        detail:
          "The Microsandbox home must be at most 40 bytes after realpath.",
        fix,
      };
    return { path, source };
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
      const shellPath = /^[\w./-]+$/.test(candidate)
        ? candidate
        : "'" + candidate.replaceAll("'", "'\"'\"'") + "'";
      const create = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(candidate)
        ? {
            env: 'mkdir -p "$MSB_HOME"',
            user: "Use mkdir -p to create the directory set in microsandbox.home.",
            default: 'mkdir -p "$HOME/.msb"',
          }[source]
        : `mkdir -p ${shellPath}`;
      return {
        source,
        status: "missing",
        detail: "The Microsandbox home directory is missing.",
        fix: [create],
      };
    }
    return {
      source,
      status: "wrong",
      detail: "The Microsandbox home is inaccessible.",
      fix,
    };
  }
}

export class MsbHomeError extends Error {
  readonly next: string;

  constructor(failure: Failure) {
    super(`${failure.detail} (source: ${failure.source})`);
    this.next = failure.fix.join(" && ");
  }
}

export async function requireMsbHome(
  env: NodeJS.ProcessEnv,
  user: Pick<Config, "microsandbox">,
): Promise<string> {
  const home = await resolveMsbHome(env, user);
  if ("path" in home) return home.path;
  throw new MsbHomeError(home);
}
