import { declarationFailureNote } from "../environments/declarations.ts";
import { codexFailureActions, isCodexFailureCode } from "../codex-exec.ts";
import { escapeTerminalControls } from "./analysis.ts";

const maxFieldLength = 4000;

export function boundField(value: string): string {
  // Bound the displayed string even when escaping expands its contents.
  const length = (text: string) =>
    escapeTerminalControls(JSON.stringify(text)).length;
  let end = Math.min(value.length, maxFieldLength);
  if (end === value.length && length(value) <= maxFieldLength) return value;

  let start = 0;
  while (start < end) {
    const middle = Math.ceil((start + end) / 2);
    if (length(`${value.slice(0, middle)}…`) <= maxFieldLength) start = middle;
    else end = middle - 1;
  }
  return `${value.slice(0, start)}…`;
}

export function executionDisplay(result: unknown): {
  code?: string;
  next?: string;
} {
  if (!result || typeof result !== "object" || !("code" in result)) return {};
  const { code } = result;
  if (typeof code !== "string") return {};
  const next = isCodexFailureCode(code)
    ? codexFailureActions[code]
    : "next" in result &&
        typeof result.next === "string" &&
        (code === "secret-test-required" ||
          code === "env-missing" ||
          (code === "env-build-failed" &&
            result.next === declarationFailureNote))
      ? result.next
      : undefined;
  return {
    code: escapeTerminalControls(boundField(code)),
    ...(next !== undefined && {
      next: escapeTerminalControls(boundField(next)),
    }),
  };
}
