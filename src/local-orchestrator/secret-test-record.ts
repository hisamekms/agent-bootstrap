import { join } from "node:path";
import { CLAUDE_CODE } from "../claude-code.ts";
import { readPrivateConfig, writePrivateConfig } from "../config/layers.ts";
import { isSafeCredentialVariable } from "../sandbox-runtime.ts";

const recordPath = (
  stateDirectory: string,
  variable: string,
  version: string,
) => {
  if (!isSafeCredentialVariable(variable) || !/^\d+\.\d+\.\d+$/.test(version))
    throw new Error("Invalid secret self-test record");
  return join(stateDirectory, "secret-tests", version, `${variable}.json`);
};

const next = "Run agent-bootstrap secrets test for the granted variable.";

export function hasSecretTestPass(
  stateDirectory: string,
  variable: string,
  version: string = CLAUDE_CODE.version,
): boolean {
  try {
    const result = readPrivateConfig(
      recordPath(stateDirectory, variable, version),
      stateDirectory,
      "secret-tests",
      next,
      512,
    );
    return Boolean(
      result &&
      typeof result === "object" &&
      Object.keys(result).length === 3 &&
      "schema" in result &&
      result.schema === 1 &&
      "variable" in result &&
      result.variable === variable &&
      "version" in result &&
      result.version === version,
    );
  } catch {
    return false;
  }
}

export function recordSecretTestPass(
  stateDirectory: string,
  variable: string,
  version: string = CLAUDE_CODE.version,
): void {
  writePrivateConfig(
    recordPath(stateDirectory, variable, version),
    stateDirectory,
    {
      schema: 1,
      variable,
      version,
    },
  );
}
