import type { Config, SecretActor } from "../config/layers.ts";
import { ConfigError } from "../config/messages.ts";
import {
  openSecretFileDelivery,
  readKeychainSecret,
  secretSocketRoot,
} from "../secret-file.ts";
import type { SecretFileDelivery } from "../secret-file.ts";
import { hasSecretTestPass } from "./secret-test-record.ts";

type SecretConfig = Pick<Config, "secretEnv" | "secrets">;

export function secretVariable(config: SecretConfig, actor: SecretActor) {
  return Object.entries(config.secretEnv ?? {}).find(([, grant]) =>
    grant.actors.includes(actor),
  )?.[0];
}

export async function withActorSecret<T>(
  config: SecretConfig,
  state: string,
  variable: string,
  baseImage: string,
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
    throw new ConfigError(
      key,
      "This credential variable has no current self-test pass for the pinned CLI and containment.",
      `Run agent-bootstrap secrets test ${variable} with the same target, then retry.`,
    );
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
