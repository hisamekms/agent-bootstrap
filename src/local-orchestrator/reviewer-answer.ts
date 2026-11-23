import type { RoleHarness } from "../actors.ts";
import { parseClaudeCodeResult } from "../claude-code.ts";

const rawAnswerLimit = 4096;

export function rawReviewerAnswer(
  harness: RoleHarness,
  response: Uint8Array | undefined,
): string | undefined {
  if (response === undefined) return undefined;
  const result =
    harness.harness === "claude" ? parseClaudeCodeResult(response) : null;
  const bytes = Buffer.from(result?.text ?? Buffer.from(response).toString());
  // Streaming decode preserves complete code points at the byte boundary.
  return new TextDecoder("utf-8", { ignoreBOM: true }).decode(
    bytes.subarray(0, rawAnswerLimit),
    { stream: true },
  );
}

export function taskReviewerOutput(
  harness: RoleHarness,
  response: Uint8Array | undefined,
): Uint8Array | undefined {
  const answer = harness.reviewerOutput
    ? harness.reviewerOutput(response)
    : response;
  if (!answer || harness.harness !== "claude") return answer;
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(answer).trim();
  } catch {
    return answer;
  }
  const fence = /^```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n```$/.exec(text);
  return Buffer.from(fence?.[1]?.trim() ?? text);
}
