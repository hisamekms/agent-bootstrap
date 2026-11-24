import { createHash } from "node:crypto";
import { join } from "node:path";
import {
  CLAUDE_CODE,
  SECRET_FILE_PACKAGES,
  secretFileLauncherTemplate,
} from "../claude-code.ts";
import { readPrivateConfig, writePrivateConfig } from "../config/layers.ts";
import { ALPINE_3_23 } from "../image-recipes.ts";
import { isSafeCredentialVariable } from "../sandbox-runtime.ts";
import {
  managedClaudeSettings,
  SECRET_EXECUTOR_SHELL,
} from "./claude-policy.ts";

function containment(baseImage: string): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        launcher: secretFileLauncherTemplate(),
        settings: (["Planner", "Executor", "Reviewer"] as const).map((actor) =>
          managedClaudeSettings(
            actor,
            actor === "Executor" && SECRET_EXECUTOR_SHELL,
            [],
            "secret-file",
          ),
        ),
        packages: SECRET_FILE_PACKAGES.map(({ name, sha256 }) => ({
          name,
          sha256,
        })),
        baseImage,
      }),
    )
    .digest("hex");
}

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
  baseImage: string = ALPINE_3_23.reference,
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
      Object.keys(result).length === 4 &&
      "schema" in result &&
      result.schema === 2 &&
      "variable" in result &&
      result.variable === variable &&
      "version" in result &&
      result.version === version &&
      "containment" in result &&
      result.containment === containment(baseImage),
    );
  } catch {
    return false;
  }
}

export function recordSecretTestPass(
  stateDirectory: string,
  variable: string,
  version: string = CLAUDE_CODE.version,
  baseImage: string = ALPINE_3_23.reference,
): void {
  writePrivateConfig(
    recordPath(stateDirectory, variable, version),
    stateDirectory,
    {
      schema: 2,
      variable,
      version,
      containment: containment(baseImage),
    },
  );
}
