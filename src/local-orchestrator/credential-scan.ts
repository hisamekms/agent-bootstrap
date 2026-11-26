import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import {
  loadClaudeConfig,
  readLegacyPrivateFile,
  userStateDirectory,
  type EffectiveClaudeConfig,
  type ClaudeAuthMode,
} from "./claude-config.ts";
import { privateDirectory } from "../volumes/volume.ts";
import { ClaudeRunError } from "./claude-errors.ts";

export type CredentialScanner = (
  ...text: readonly (string | Uint8Array)[]
) => Promise<void>;

function builtInMatch(input: string): boolean {
  const text = input
    .replace(/^\+(?!\+\+)/gm, "")
    .replace(
      /\\+(?:(")|u([0-9a-f]{4}))?/gi,
      (run, quote: string | undefined, hex: string | undefined) =>
        quote ?? (hex ? String.fromCharCode(Number.parseInt(hex, 16)) : run),
    );
  if (
    /"accessToken"\s*:\s*"[^"\r\n]+"/i.test(text) &&
    /"refreshToken"\s*:\s*"[^"\r\n]+"/i.test(text) &&
    /"expiresAt"\s*:\s*(?:"[^"\r\n]+"|\d+)/i.test(text)
  )
    return true;
  return /(?:sk-ant-|bearer\s+)[a-z0-9_./+=-]{24,}/i.test(text);
}

export const builtInCredentialScanner: CredentialScanner = async (
  ...sources
) => {
  if (
    sources.reduce((size, item) => size + item.length, 0) > 16 * 1024 * 1024 ||
    sources.some((source) =>
      builtInMatch(
        typeof source === "string" ? source : new TextDecoder().decode(source),
      ),
    )
  )
    throw new ClaudeRunError("credential-leak");
};

async function customMatch(text: string[], patterns: readonly string[]) {
  return new Promise<boolean>((resolve) => {
    const worker = new Worker(
      `const { parentPort, workerData } = require("node:worker_threads");
      const { text, patterns } = workerData;
      parentPort.postMessage(patterns.some((pattern) => {
        const regex = new RegExp(pattern, "i");
        return text.some((item) => regex.test(item));
      }));`,
      { eval: true, workerData: { text, patterns } },
    );
    const finish = (blocked: boolean) => {
      clearTimeout(timer);
      void worker.terminate();
      resolve(blocked !== false);
    };
    const timer = setTimeout(() => finish(true), 400);
    worker.once("message", finish);
    worker.once("error", () => finish(true));
    worker.once("exit", () => finish(true));
  });
}

export function createCredentialScanner(
  config: Pick<EffectiveClaudeConfig, "leakPatterns">,
  state: string,
  note: (message: string) => void,
): CredentialScanner {
  const patterns = [...(config.leakPatterns ?? [])];
  return async (...sources) => {
    try {
      await builtInCredentialScanner(...sources);
      if (!patterns.length) return;
      const text = sources.map((source) =>
        typeof source === "string" ? source : new TextDecoder().decode(source),
      );
      if (!(await customMatch(text, patterns))) return;
    } catch {}

    let message = "credential-leak evidence could not be written.";
    try {
      privateDirectory(state);
      const evidence = join(state, `credential-leak-${randomUUID()}.json`);
      writeFileSync(
        evidence,
        JSON.stringify({ code: "credential-leak" }) + "\n",
        {
          mode: 0o600,
          flag: "wx",
        },
      );
      message = `credential-leak evidence: ${evidence}`;
    } catch {}
    try {
      note(message);
    } catch {}
    throw new ClaudeRunError("credential-leak");
  };
}

const markerName = "credential-screen.json";

function targetRequiresScan(directory: string | undefined): boolean {
  if (!directory) return false;
  const marker = readLegacyPrivateFile(join(directory, markerName), 1024, true);
  if (marker && typeof marker === "object" && !Array.isArray(marker)) {
    const entries = Object.entries(marker);
    if (!entries.length) return false;
    if (
      entries.length === 1 &&
      entries[0]?.[0] === "required" &&
      entries[0]?.[1] === true
    )
      return true;
  }
  throw new ClaudeRunError("config-invalid");
}

export function requireCredentialScan(directory: string): void {
  try {
    writeFileSync(join(directory, markerName), '{"required":true}\n', {
      mode: 0o600,
      flag: "wx",
    });
  } catch (error) {
    if (
      (error as NodeJS.ErrnoException).code !== "EEXIST" ||
      !targetRequiresScan(directory)
    )
      throw error;
  }
}

export function configuredCredentialScanner(
  directory: string | undefined,
  note: (message: string) => void,
  env = process.env,
  override?: ClaudeAuthMode,
  configurationDirectory?: string,
  effective?: ReturnType<typeof loadClaudeConfig>,
): CredentialScanner | undefined {
  const config =
    effective ?? loadClaudeConfig(env, configurationDirectory, override);
  if (
    config.auth === "external" ||
    config.leakPatterns?.length ||
    Object.keys(config.config.mounts ?? {}).length ||
    targetRequiresScan(directory)
  )
    return createCredentialScanner(config, userStateDirectory(env), note);
}

export function recordedCredentialScanner(
  directory: string,
  note: (message: string) => void,
): CredentialScanner | undefined {
  if (targetRequiresScan(directory))
    return configuredCredentialScanner(directory, note);
}
