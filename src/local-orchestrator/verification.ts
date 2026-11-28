import { join } from "node:path";
import { MICROSANDBOX_LIMITS } from "../microsandbox.ts";
import type { Verification } from "../reviewed-integration.ts";
import {
  VERIFICATION_FAILURE_VERDICT,
  VERIFICATION_TAIL_LIMIT,
  VERIFICATION_TAIL_PATH,
  VERIFICATION_TIMEOUT_LIMIT_MS,
} from "../sandbox-runtime.ts";
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
import { ContractError, fields, integer, oneOf } from "./model.ts";

export interface VerificationConfig {
  readonly profile: ProfileName;
  readonly argv: readonly string[];
  readonly timeoutMs?: number;
}

export function parseVerificationConfig(value: unknown): VerificationConfig {
  const input = fields(value, ["profile", "argv", "timeoutMs"]);
  const { profile, argv, timeoutMs } = input;
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
  return {
    profile: name,
    argv: [...argv],
    ...(Object.hasOwn(input, "timeoutMs")
      ? { timeoutMs: integer(timeoutMs, 1, VERIFICATION_TIMEOUT_LIMIT_MS) }
      : {}),
  };
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

// The previous fixed wrapper is part of existing journal target digests.
// Change this identity whenever the verdict semantics or the verdict
// channel change, so that pins made under the old meaning lapse.
const verificationIdentityScript = `
if ( "$@" ) >/dev/null 2>&1; then
  printf '%s\\n' '{"review":"pass"}'
else
  printf '%s\\n' '{"review":"revise","tests":{"passed":0,"failed":1,"failures":["Verification command exited unsuccessfully"]}}'
fi
`;

// A file keeps background children from delaying the verdict by holding a pipe open.
const verificationScript = `
p=${VERIFICATION_TAIL_PATH}
if mkdir -m 700 -- "\${p%/*}"; then
  output="$p.full"
  ( "$@" ) >"$output" 2>&1 3>&-
  status=$?
  tail -c ${VERIFICATION_TAIL_LIMIT} "$output" >"$p"
  rm -f -- "$output"
else
  ( "$@" ) >/dev/null 2>&1 3>&-
  status=$?
fi
if [ "$status" = 0 ]; then
  printf '%s\\n' '{"review":"pass"}'
else
  printf '%s' '${VERIFICATION_FAILURE_VERDICT}'
fi
`;

export function configuredVerification(
  config: VerificationConfig,
): Verification {
  return {
    profile: config.profile,
    captureFailureTail: true,
    identityArgv: [
      "/bin/sh",
      "-c",
      verificationIdentityScript,
      "verify",
      ...config.argv,
    ],
    command: {
      argv: ["/bin/sh", "-c", verificationScript, "verify", ...config.argv],
      timeoutMs: config.timeoutMs ?? MICROSANDBOX_LIMITS.commandTimeoutMs,
    },
  };
}
