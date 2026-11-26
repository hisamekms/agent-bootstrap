import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";
import {
  CODEX,
  codexBinaryPath,
  derivePinnedCodexCatalog,
  siwcCodexEndpoint,
  type CodexOptions,
} from "../codex-exec.ts";
import type { Config } from "../config/layers.ts";
import { ActorConfigError } from "../config/messages.ts";

export function selectsCodex(config?: Config): boolean {
  return config?.actors?.Executor === "codex";
}

export function codexExecutorOptions(config: Config): CodexOptions | undefined {
  if (!selectsCodex(config)) return undefined;
  if (!config.codex?.model)
    throw new ActorConfigError(
      "codex.model",
      "The Codex Executor requires a model.",
      "Set codex.model and codex.auth in user configuration or target local.json.",
    );
  for (const kind of ["mounts", "secretEnv"] as const)
    if (
      Object.values(config[kind] ?? {}).some(({ actors }) =>
        (actors as readonly string[]).includes("Executor"),
      )
    )
      throw new ActorConfigError(
        kind,
        "The Codex Executor cannot receive this grant.",
        `Remove Executor from ${kind} grants or select Claude for the Executor.`,
      );
  return {
    endpoint: siwcCodexEndpoint,
    model: config.codex.model,
    catalog: true,
    classifyAuthFailure: true,
  };
}

export async function readCodexExecutor(root: string, options: CodexOptions) {
  const binary = join(root, codexBinaryPath);
  let bytes: Buffer;
  try {
    await using file = await open(
      binary,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    const stat = await file.stat();
    if (
      !stat.isFile() ||
      stat.size > 512 * 1024 * 1024 ||
      (stat.mode & 0o7777) !== 0o700
    )
      throw new Error();
    bytes = await file.readFile();
    if (createHash("sha256").update(bytes).digest("hex") !== CODEX.sha256)
      throw new Error();
  } catch {
    throw new ActorConfigError(
      "codex.binary",
      "The pinned Codex binary is missing, unsafe, or has the wrong digest.",
      "Review agent-bootstrap setup --json with the same target and stage the pinned binary with setup.",
    );
  }
  try {
    return { binary, catalog: derivePinnedCodexCatalog(bytes, options.model) };
  } catch {
    throw new ActorConfigError(
      "codex.catalog",
      "The pinned Codex catalog failed validation for the selected model.",
      "Check that the selected model is in the pinned release catalog and rerun doctor.",
    );
  }
}
