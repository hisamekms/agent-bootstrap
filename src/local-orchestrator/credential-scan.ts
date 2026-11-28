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
import { credentialMaskMarker } from "./proposal-screening.ts";

export type CredentialScanner = (
  ...text: readonly (string | Uint8Array)[]
) => Promise<void>;

export type CredentialSpan = [start: number, end: number];
type Span = CredentialSpan;
type Match = { span: Span; wholeValue?: true };
type ScanResult = readonly (readonly Match[] | null)[] | null;

const maxScanSize = 16 * 1024 * 1024;
const scanTimeoutMs = 400;
const maxNormalizationEdits = 64 * 1024;
export const maxCredentialMasks = 32;
const tokenPattern = /(?:sk-ant-|bearer\s+)[a-z0-9_./+=-]{24,}/i;
const jsonKey = /"(accessToken|refreshToken|expiresAt)"\s*:\s*/i;
const jsonPatterns = [
  /"accessToken"\s*:\s*"[^"\r\n]+"/i,
  /"refreshToken"\s*:\s*"[^"\r\n]+"/i,
  /"expiresAt"\s*:\s*(?:"[^"\r\n]+"|\d+)/i,
];

function normalize(
  input: string,
  recordEdit?: (start: number, end: number, length: number) => void,
) {
  return input.replace(
    /^\+(?!\+\+)|\\+(?:(")|u([0-9a-f]{4}))?/gim,
    (
      run,
      quote: string | undefined,
      hex: string | undefined,
      index: number,
    ) => {
      const replacement =
        run === "+"
          ? ""
          : (quote ??
            (hex ? String.fromCharCode(Number.parseInt(hex, 16)) : run));
      if (replacement !== run)
        recordEdit?.(index, index + run.length, replacement.length);
      return replacement;
    },
  );
}

function builtInMatch(input: string): boolean {
  const text = normalize(input);
  return (
    jsonPatterns.every((pattern) => pattern.test(text)) ||
    tokenPattern.test(text)
  );
}

export function serializedTextSpan(
  text: string,
  itemStart: number,
  span: Span,
): Span {
  const position = (offset: number) =>
    itemStart + JSON.stringify(text.slice(0, offset)).length - 1;
  return [position(span[0]), position(span[1])];
}

function coversCredentialSpans(
  covered: readonly Span[],
  spans: readonly Span[],
) {
  return spans.every(([start, end]) =>
    covered.some(([from, to]) => from <= start && end <= to),
  );
}

export const builtInCredentialScanner: CredentialScanner = async (
  ...sources
) => {
  if (
    sources.reduce((size, item) => size + item.length, 0) > maxScanSize ||
    sources.some((source) =>
      builtInMatch(
        typeof source === "string" ? source : new TextDecoder().decode(source),
      ),
    )
  )
    throw new ClaudeRunError("credential-leak");
};

function customScan(
  text: readonly string[],
  patterns: readonly string[],
  spans: boolean,
) {
  return new Promise<boolean | (Span[] | null)[] | null>((resolve) => {
    const worker = new Worker(
      `const { parentPort, workerData } = require("node:worker_threads");
      const { text, patterns, spans, maxMasks } = workerData;
      if (!spans) {
        parentPort.postMessage(patterns.some((pattern) => {
          const regex = new RegExp(pattern, "i");
          return text.some((item) => regex.test(item));
        }));
      } else {
        const matches = text.map(() => []);
        for (const pattern of patterns) {
          const regex = new RegExp(pattern, "gi");
          for (let i = 0; i < text.length; i++) {
            const spans = matches[i];
            if (!spans) continue;
            for (const match of text[i].matchAll(regex)) {
              if (!match[0].length || spans.length === maxMasks) {
                matches[i] = null;
                break;
              }
              spans.push([match.index, match.index + match[0].length]);
            }
          }
        }
        parentPort.postMessage(matches);
      }`,
      {
        eval: true,
        workerData: { text, patterns, spans, maxMasks: maxCredentialMasks },
      },
    );
    let settled = false;
    const finish = (result: boolean | (Span[] | null)[] | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate();
      resolve(result);
    };
    const timer = setTimeout(() => finish(null), scanTimeoutMs);
    worker.once("message", finish);
    worker.once("error", () => finish(null));
    worker.once("exit", () => finish(null));
  });
}

function builtInSpans(input: string): Match[] | null {
  if (!builtInMatch(input)) return [];
  // Record edits in normalized order so each match maps back to the source.
  const edits: {
    index: number;
    removed: number;
    offset: number;
    length: number;
  }[] = [];
  let offset = 0;
  let tooManyEdits = false;
  const text = normalize(input, (start, end, length) => {
    if (edits.length === maxNormalizationEdits) {
      tooManyEdits = true;
      return;
    }
    const removed = end - start - length;
    edits.push({
      index: start - offset,
      removed,
      offset: offset + removed,
      length,
    });
    offset += removed;
  });
  if (tooManyEdits) return null;

  function rawSpan([start, end]: Span): Span {
    function rawIndex(index: number, beginning = false) {
      let low = 0;
      let high = edits.length;
      while (low < high) {
        const middle = (low + high) >>> 1;
        if (edits[middle]!.index <= index) low = middle + 1;
        else high = middle;
      }
      const edit = edits[low - 1];
      const adjustment =
        beginning && edit?.index === index && edit.length ? edit.removed : 0;
      return index + (edit?.offset ?? 0) - adjustment;
    }
    return [rawIndex(start, true), rawIndex(end - 1) + 1];
  }

  const matches: Match[] = [];
  for (const match of text.matchAll(new RegExp(tokenPattern, "gi"))) {
    if (matches.length === maxCredentialMasks) return null;
    matches.push({
      span: rawSpan([match.index, match.index + match[0].length]),
    });
  }
  if (jsonPatterns.every((pattern) => pattern.test(text))) {
    const keys = new RegExp(jsonKey, "gi");
    const quotedValue = /"[^"\r\n]*"(?=\s*(?:[,}\]]|$))/y;
    const expiryValue =
      /(?:"[^"\r\n]*"|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)(?=\s*(?:[,}\]]|$))/y;
    for (const key of text.matchAll(keys)) {
      if (matches.length === maxCredentialMasks) return null;
      const pattern =
        key[1]?.toLowerCase() === "expiresat" ? expiryValue : quotedValue;
      const start = key.index + key[0].length;
      pattern.lastIndex = start;
      const value = pattern.exec(text)?.[0];
      if (!value) return null;
      const end = start + value.length;
      if (value.startsWith('"')) {
        const open = rawSpan([start, start + 1]);
        const close = rawSpan([end - 1, end]);
        // Normalization can turn an escaped quote inside a value into
        // an apparent delimiter. Withhold when the boundary is ambiguous.
        if (
          value.at(-2) === "\\" ||
          input.slice(...open) !== input.slice(...close)
        )
          return null;
      }
      // A quoted marker would still match the original credential check.
      matches.push({ span: rawSpan([start, end]), wholeValue: true });
    }
  }
  return matches;
}

function jsonStringValues(input: string, matches: readonly Match[]): Span[] {
  const values: Span[] = [];
  const pending: Span[] = [];
  const first = input.search(/\S/);
  const colon = /\s*:/y;
  let start = 0;
  let depth = 0;
  function validJson(from: number, to: number) {
    try {
      JSON.parse(input.slice(from, to));
      return true;
    } catch {
      return false;
    }
  }

  // Only quotes in a valid JSON fragment delimit a mask. Quotes in prose
  // are ordinary characters and may be part of the credential token.
  for (const match of input.matchAll(/"(?:[^"\\]|\\[\s\S])*"|[[\]{}]/g)) {
    const [token] = match;
    const index = match.index;
    const end = index + token.length;
    if (token === "{" || token === "[") {
      if (!depth) start = index;
      depth++;
    } else if (token === "}" || token === "]") {
      if (depth && --depth === 0 && pending.length) {
        if (validJson(start, end)) values.push(...pending);
        pending.length = 0;
      }
    } else if (
      matches.some(({ span: [from, to] }) => index < from && to < end)
    ) {
      if (depth) {
        colon.lastIndex = end;
        if (!colon.test(input)) pending.push([index + 1, end - 1]);
      } else if (
        index === first &&
        /^\s*$/.test(input.slice(end)) &&
        validJson(index, end)
      ) {
        values.push([index + 1, end - 1]);
      }
    }
  }
  return values;
}

export function maskCredentialSpans(input: string, matches: readonly Match[]) {
  if (!matches.length) return { text: input, spans: [] };
  const values = jsonStringValues(input, matches);
  function splitsCharacter(index: number) {
    const previous = input.charCodeAt(index - 1);
    return previous >= 0xd800 && previous <= 0xdbff;
  }
  const expanded: Span[] = [];
  for (const {
    span: [from, to],
    wholeValue,
  } of matches) {
    if (splitsCharacter(from) || splitsCharacter(to)) return null;
    let start = from;
    let end = to;
    const value = values.find(([left, right]) => left <= start && end <= right);
    if (!wholeValue) {
      if (
        matches.some(
          ({ span: [left, right], wholeValue }) =>
            wholeValue && left <= from && to <= right,
        )
      )
        continue;
      const [left, right] = value ?? [0, input.length];
      while (start > left && !/\s/.test(input[start - 1]!)) start--;
      while (end < right && !/\s/.test(input[end]!)) end++;
    }
    const token = input.slice(start, end);
    if (/\s/.test(token)) return null;
    // JSON can represent whitespace without using a literal space or tab.
    if ((wholeValue || value) && /\\(?:[tnrvf]|u[0-9a-f]{4})/i.test(token)) {
      const decoded = normalize(token).replace(/\\+[tnrvf]/g, " ");
      if (/\s/.test(decoded)) return null;
    }
    expanded.push([start, end]);
  }

  const merged: Span[] = [];
  for (const span of expanded.sort(([a], [b]) => a - b)) {
    const last = merged.at(-1);
    if (last && span[0] < last[1]) last[1] = Math.max(last[1], span[1]);
    else merged.push(span);
  }
  if (merged.length > maxCredentialMasks) return null;
  let masked = "";
  let end = 0;
  for (const span of merged) {
    masked += input.slice(end, span[0]) + credentialMaskMarker;
    end = span[1];
  }
  masked += input.slice(end);
  return masked.isWellFormed() ? { text: masked, spans: merged } : null;
}

type ScannerOptions = {
  patterns: readonly string[];
  evidence?: (displayDigest?: string) => boolean;
};

const scannerOptions = new WeakMap<CredentialScanner, ScannerOptions>([
  [builtInCredentialScanner, { patterns: [] }],
]);

export function credentialScanClean(result: ScanResult) {
  return result !== null && result.every((matches) => matches?.length === 0);
}

export function credentialScanCovered(
  result: ScanResult,
  covered: readonly Span[],
) {
  return result?.every(
    (matches) =>
      matches !== null &&
      coversCredentialSpans(
        covered,
        matches.map(({ span }) => span),
      ),
  );
}

// A read batches the original groups, then checks only new strings after
// masking or terminal escaping. Keep each group's size and evidence boundary.
export function proposalCredentialCheck(
  scan: CredentialScanner,
  displayDigest?: string,
  options = scannerOptions.get(scan),
) {
  const cached = new Map<string, readonly Match[] | null>();
  return async (
    groups: readonly (readonly (string | Uint8Array)[])[],
  ): Promise<ScanResult[]> => {
    if (!options)
      return Promise.all(
        groups.map(async (group) => {
          try {
            await scan(...group);
            return group.map(() => []);
          } catch {
            return null;
          }
        }),
      );
    const { patterns, evidence } = options;
    const decoder = new TextDecoder("utf-8", { fatal: true });
    const inputs = groups.map((group) => {
      if (group.reduce((size, source) => size + source.length, 0) > maxScanSize)
        return null;
      try {
        return group.map((source) =>
          typeof source === "string" ? source : decoder.decode(source),
        );
      } catch {
        return null;
      }
    });
    const fresh = [
      ...new Set(
        inputs.flatMap(
          (group) => group?.filter((text) => !cached.has(text)) ?? [],
        ),
      ),
    ];
    if (fresh.length) {
      let custom: (Span[] | null)[] | null = null;
      try {
        if (!patterns.length) custom = fresh.map(() => []);
        else if (
          fresh.reduce((size, text) => size + text.length, 0) <= maxScanSize
        ) {
          const result = await customScan(fresh, patterns, true);
          if (Array.isArray(result)) custom = result;
        }
      } catch {}
      if (custom) {
        for (const [index, text] of fresh.entries()) {
          const spans = custom[index];
          const builtIn =
            spans && text.isWellFormed() ? builtInSpans(text) : null;
          cached.set(
            text,
            builtIn && spans
              ? [...builtIn, ...spans.map((span) => ({ span }))]
              : null,
          );
        }
      }
    }
    return inputs.map((group) => {
      const result = group?.map((text) => cached.get(text) ?? null) ?? null;
      if (!credentialScanClean(result) && evidence?.(displayDigest) === false)
        return null;
      return result;
    });
  };
}

export async function maskCredentials(
  source: string | Uint8Array,
  patterns: readonly string[] = [],
) {
  try {
    const input =
      typeof source === "string"
        ? source
        : new TextDecoder("utf-8", { fatal: true }).decode(source);
    const check = proposalCredentialCheck(builtInCredentialScanner, undefined, {
      patterns,
    });
    const [result] = await check([[input]]);
    const matches = result?.[0];
    const masked = matches && maskCredentialSpans(input, matches);
    return (
      (masked && { text: masked.text, masked: masked.spans.length }) || null
    );
  } catch {
    return null;
  }
}

export function createCredentialScanner(
  config: Pick<EffectiveClaudeConfig, "leakPatterns">,
  state: string,
  note: (message: string) => void,
): CredentialScanner {
  const patterns = [...(config.leakPatterns ?? [])];
  const displayEvidence = new Map<string, boolean>();
  function evidence(displayDigest?: string) {
    const recorded =
      displayDigest === undefined
        ? undefined
        : displayEvidence.get(displayDigest);
    if (recorded !== undefined) return recorded;
    let written = false;
    let message = "credential-leak evidence could not be written.";
    try {
      privateDirectory(state);
      const path = join(state, `credential-leak-${randomUUID()}.json`);
      writeFileSync(path, JSON.stringify({ code: "credential-leak" }) + "\n", {
        mode: 0o600,
        flag: "wx",
      });
      message = `credential-leak evidence: ${path}`;
      written = true;
    } catch {}
    if (displayDigest !== undefined)
      displayEvidence.set(displayDigest, written);
    try {
      note(message);
    } catch {}
    return written;
  }
  const scan: CredentialScanner = async (...sources) => {
    try {
      await builtInCredentialScanner(...sources);
      if (!patterns.length) return;
      const text = sources.map((source) =>
        typeof source === "string" ? source : new TextDecoder().decode(source),
      );
      if ((await customScan(text, patterns, false)) === false) return;
    } catch {}
    evidence();
    throw new ClaudeRunError("credential-leak");
  };
  scannerOptions.set(scan, { patterns, evidence });
  return scan;
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
