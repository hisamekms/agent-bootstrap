import { randomUUID } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  openSync,
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
import { readPrivateConfig } from "./claude-config.ts";
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

function readTargetConfig(directory: string) {
  return fields(
    readPrivateConfig(join(directory, "config.json"), 256 * 1024, true),
    ["profile", "argv", "claude"],
  );
}

export function readVerificationConfig(
  directory: string,
): VerificationConfig | null {
  const { profile, argv } = readTargetConfig(directory);
  return profile === undefined && argv === undefined
    ? null
    : parseVerificationConfig({ profile, argv });
}

/** The operator CLI holds the target's SQLite writer lock while publishing. */
export function writeVerificationConfig(
  directory: string,
  config: VerificationConfig | null,
): void {
  const path = join(directory, "config.json");
  const { claude } = readTargetConfig(directory);
  if (config === null && claude === undefined) {
    rmSync(path, { force: true });
  } else {
    const temporary = join(directory, `.config-${randomUUID()}`);
    const file = openSync(temporary, "wx", 0o600);
    try {
      try {
        writeFileSync(
          file,
          JSON.stringify({
            ...config,
            ...(claude === undefined ? {} : { claude }),
          }) + "\n",
        );
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
