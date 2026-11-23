import type { parseClaudeCodeResult } from "../claude-code.ts";

export type TokenUsage = {
  input: number;
  output: number;
  cacheCreation: number;
  cacheRead: number;
};

export const emptyTokenUsage: Readonly<TokenUsage> = Object.freeze({
  input: 0,
  output: 0,
  cacheCreation: 0,
  cacheRead: 0,
});

type RawUsage = TokenUsage | TokenUsage[];
type TokenReport = {
  tokens: number | null;
  usage: RawUsage | "unavailable" | null;
  rawUsage?: RawUsage;
};

const isTokenCount = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

function rawCounts(value: unknown): TokenUsage | undefined {
  if (!value || typeof value !== "object") return;
  const { input, output, cacheCreation, cacheRead } =
    value as Partial<TokenUsage>;
  if (
    isTokenCount(input) &&
    isTokenCount(output) &&
    isTokenCount(cacheCreation) &&
    isTokenCount(cacheRead)
  )
    return { input, output, cacheCreation, cacheRead };
}

function rawUsage(value: unknown): RawUsage | undefined {
  if (!Array.isArray(value)) return rawCounts(value);
  const counts = value.map(rawCounts);
  if (counts.every((entry) => entry !== undefined)) return counts;
}

export function readTokenReport(
  result: unknown,
  finished: boolean,
): TokenReport {
  const fields = result as Partial<TokenReport> | null;
  const tokens = isTokenCount(fields?.tokens) ? fields.tokens : null;
  const partial = rawUsage(fields?.rawUsage);
  return {
    tokens,
    usage:
      rawUsage(fields?.usage) ??
      (fields?.usage === "unavailable" || finished ? "unavailable" : null),
    ...(partial === undefined ? {} : { rawUsage: partial }),
  };
}

export function compareTokenBudget<
  T extends TokenReport,
  M extends number | null,
>(report: T, maxTokens: M) {
  const { tokens, usage } = report;
  const overBudget =
    maxTokens !== null && tokens !== null && tokens > maxTokens;
  return {
    ...report,
    maxTokens,
    ...(overBudget ||
    (maxTokens !== null && tokens !== null && usage !== "unavailable")
      ? { overBudget }
      : {}),
  };
}

export function reportedUsage(
  result: ReturnType<typeof parseClaudeCodeResult>,
): { tokens: number; usage: TokenUsage } | undefined {
  if (
    result?.inputTokens == null ||
    result.outputTokens == null ||
    result.cacheCreationInputTokens == null ||
    result.cacheReadInputTokens == null
  )
    return undefined;
  const usage = {
    input: result.inputTokens,
    output: result.outputTokens,
    cacheCreation: result.cacheCreationInputTokens,
    cacheRead: result.cacheReadInputTokens,
  };
  return {
    tokens: Math.min(
      Number.MAX_SAFE_INTEGER,
      usage.input +
        usage.output +
        usage.cacheCreation +
        Math.ceil(usage.cacheRead / 10),
    ),
    usage,
  };
}
