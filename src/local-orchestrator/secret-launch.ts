import type { Config, SecretActor } from "../config/layers.ts";
import { ConfigError } from "../config/messages.ts";
import {
  openSecretFileDelivery,
  readKeychainSecret,
  secretSocketRoot,
} from "../secret-file.ts";
import type { SecretFileDelivery } from "../secret-file.ts";
import { hasSecretTestPass, secretTestCommand } from "./secret-test-record.ts";

type SecretConfig = Pick<Config, "secretEnv" | "secrets">;

export function secretVariable(config: SecretConfig, actor: SecretActor) {
  return Object.entries(config.secretEnv ?? {}).find(([, grant]) =>
    grant.actors.includes(actor),
  )?.[0];
}

export class SecretTestRequiredError extends ConfigError {
  readonly code = "secret-test-required";

  constructor(variable: string, target: string) {
    super(
      `secretEnv.${variable}`,
      "This credential variable has no current self-test pass for the pinned CLI and containment.",
      secretTestCommand(variable, target),
    );
  }
}

export function secretTestWarnings(
  config: SecretConfig,
  state: string,
  baseImage: string,
  target: string,
): string[] {
  return Object.keys(config.secretEnv ?? {})
    .filter(
      (variable) => !hasSecretTestPass(state, variable, undefined, baseImage),
    )
    .map(
      (variable) =>
        `Warning: ${variable} has no current self-test pass.\nnext: ${secretTestCommand(variable, target)}`,
    );
}

export async function withActorSecret<T>(
  config: SecretConfig,
  state: string,
  variable: string,
  baseImage: string,
  target: string,
  run: (options: {
    secretFile: SecretFileDelivery;
    secretTest: "passed";
  }) => Promise<T>,
  read = readKeychainSecret,
): Promise<T> {
  const key = `secretEnv.${variable}`;
  const grant = config.secretEnv?.[variable];
  const definition = grant && config.secrets?.[grant.secret];
  if (!definition)
    throw new ConfigError(
      key,
      "The secret source is unavailable.",
      "Define the secret in the user configuration.",
    );
  if (!hasSecretTestPass(state, variable, undefined, baseImage))
    throw new SecretTestRequiredError(variable, target);
  const root = await secretSocketRoot();
  const value = await read(definition.keychainService).catch(() => {
    throw new ConfigError(
      key,
      "The secret could not be read from Keychain.",
      "Check the configured Keychain item for your account and retry.",
    );
  });
  let delivery: SecretFileDelivery;
  try {
    delivery = await openSecretFileDelivery(root, variable, value);
  } finally {
    value.fill(0);
  }
  try {
    return await run({ secretFile: delivery, secretTest: "passed" });
  } finally {
    try {
      await delivery.close();
    } finally {
      delivery.clearScreen();
    }
  }
}
