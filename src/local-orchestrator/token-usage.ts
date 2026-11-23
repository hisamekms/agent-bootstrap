import type { parseClaudeCodeResult } from "../claude-code.ts";

export type TokenUsage = {
  input: number;
  output: number;
  cacheCreation: number;
  cacheRead: number;
};

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
