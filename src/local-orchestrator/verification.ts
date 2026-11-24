import { join } from "node:path";
import { MICROSANDBOX_LIMITS } from "../microsandbox.ts";
import type { Verification } from "../reviewed-integration.ts";
import {
  PROFILE_NAMES,
  ROLE_PROFILES,
  type ProfileName,
} from "../sandbox-profiles.ts";
import {
  configRoot,
  loadConfig,
  readLayer,
  writePrivateConfig,
} from "../config/layers.ts";
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
  env = process.env,
): VerificationConfig | null {
  return loadConfig(env, directory).config.verification ?? null;
}

/** The operator CLI holds the target's SQLite writer lock while publishing. */
export function writeVerificationConfig(
  directory: string,
  config: VerificationConfig | null,
  env = process.env,
): void {
  const local = readLayer("local", directory, env);
  if (config === null) delete local.verification;
  else local.verification = config;
  writePrivateConfig(join(directory, "local.json"), configRoot(env), local);
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
