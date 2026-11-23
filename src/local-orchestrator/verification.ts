import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  openSync,
  readSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { MICROSANDBOX_LIMITS } from "../microsandbox.ts";
import type { Verification } from "../reviewed-integration.ts";
import {
  PROFILE_NAMES,
  ROLE_PROFILES,
  type ProfileName,
} from "../sandbox-profiles.ts";
import { ContractError, fields, oneOf } from "./model.ts";

export interface VerificationConfig {
  readonly profile: ProfileName;
  readonly argv: readonly string[];
}

export function parseVerificationConfig(value: unknown): VerificationConfig {
  const { profile, argv } = fields(value, ["profile", "argv"]);
  const name = oneOf(profile, PROFILE_NAMES);
  if (
    !ROLE_PROFILES.Verification.includes(name) ||
    !Array.isArray(argv) ||
    argv.length < 1 ||
    argv.length > 32 ||
    !argv[0] ||
    [...argv].some(
      (entry) =>
        typeof entry !== "string" ||
        entry.length > 1024 ||
        entry.includes("\0"),
    )
  )
    throw new ContractError();
  return { profile: name, argv: [...argv] };
}

export function readVerificationConfig(
  directory: string,
): VerificationConfig | null {
  let file: number;
  try {
    file = openSync(
      join(directory, "config.json"),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  try {
    const info = fstatSync(file);
    // JSON may use six bytes per character in an escaped argument.
    const maxBytes = 256 * 1024;
    if (
      !info.isFile() ||
      info.uid !== process.getuid?.() ||
      (info.mode & 0o077) !== 0 ||
      info.size > maxBytes
    )
      throw new Error("Invalid verification configuration file");
    const bytes = Buffer.alloc(info.size + 1);
    const count = readSync(file, bytes, 0, bytes.length, 0);
    if (count !== info.size)
      throw new Error("Verification configuration changed");
    return parseVerificationConfig(
      JSON.parse(bytes.subarray(0, count).toString("utf8")),
    );
  } finally {
    closeSync(file);
  }
}

/** The operator CLI holds the target's SQLite writer lock while publishing. */
export function writeVerificationConfig(
  directory: string,
  config: VerificationConfig | null,
): void {
  const path = join(directory, "config.json");
  if (config === null) {
    rmSync(path, { force: true });
  } else {
    const temporary = join(directory, `.config-${randomUUID()}`);
    const file = openSync(temporary, "wx", 0o600);
    try {
      try {
        writeFileSync(file, JSON.stringify(config) + "\n");
        fsyncSync(file);
      } finally {
        closeSync(file);
      }
      renameSync(temporary, path);
    } finally {
      rmSync(temporary, { force: true });
    }
  }
  const dir = openSync(directory, "r");
  try {
    fsyncSync(dir);
  } finally {
    closeSync(dir);
  }
}

// The shell source is fixed. Candidate output stays off the verdict channel,
// and a subshell confines builtins such as exit to the command invocation.
const verificationScript = `
if ( "$@" ) >/dev/null 2>&1; then
  printf '%s\\n' '{"review":"pass"}'
else
  printf '%s\\n' '{"review":"revise","tests":{"passed":0,"failed":1,"failures":["Verification command exited unsuccessfully"]}}'
fi
`;

export function configuredVerification(
  config: VerificationConfig,
): Verification {
  return {
    profile: config.profile,
    command: {
      argv: ["/bin/sh", "-c", verificationScript, "verify", ...config.argv],
      timeoutMs: MICROSANDBOX_LIMITS.commandTimeoutMs,
    },
  };
}
