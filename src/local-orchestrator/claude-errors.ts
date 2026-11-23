import { Worker } from "node:worker_threads";
import { parseClaudeCodeResult } from "../claude-code.ts";
import type {
  ClaudeErrorPattern,
  ClaudeFailureCode,
  ClaudePatternCode,
} from "./claude-config.ts";

export class ClaudeRunError extends Error {
  readonly code: ClaudeFailureCode;
  constructor(code: ClaudeFailureCode) {
    super(code);
    this.code = code;
  }
}

export async function classifyClaudeFailure(
  bytes: Uint8Array,
  patterns: readonly ClaudeErrorPattern[],
): Promise<ClaudePatternCode | undefined> {
  const text =
    parseClaudeCodeResult(bytes)?.text ??
    new TextDecoder().decode(bytes.subarray(0, 8192));
  const message = text.slice(0, 8192);
  if (
    /\b(?:HTTP(?:\/[\d.]+)?\s+|status(?:[ _]?code)?["']?\s*[:=]?\s*|API error\s*:\s*)(?:401|403)\b|\bauthentication[ _-](?:failed|failure|error)\b/i.test(
      message,
    )
  )
    return "auth-required";
  if (
    /\b(?:HTTP(?:\/[\d.]+)?\s+|status(?:[ _]?code)?["']?\s*[:=]?\s*|API error\s*:\s*)429\b|\b(?:rate|usage)[ _-]limit(?:ed|[ _-](?:error|exceeded|reached))?\b/i.test(
      message,
    )
  )
    return "rate-limited";
  if (/\binvalid configuration\b/i.test(message)) return "config-invalid";
  if (!patterns.length) return;
  return new Promise((resolve) => {
    const worker = new Worker(
      `const { parentPort, workerData } = require("node:worker_threads");
      const { message, patterns } = workerData;
      parentPort.postMessage(patterns.find(({ match }) => new RegExp(match, "i").test(message))?.code);`,
      { eval: true, workerData: { message, patterns } },
    );
    const finish = (code?: ClaudePatternCode) => {
      clearTimeout(timer);
      void worker.terminate();
      resolve(code);
    };
    const timer = setTimeout(finish, 200);
    worker.once("message", finish);
    worker.once("error", () => finish());
    worker.once("exit", () => finish());
  });
}

export function claudeNext(code: ClaudeFailureCode): string {
  switch (code) {
    case "auth-required":
      return "Check the selected Claude authentication mode with agent-bootstrap doctor.";
    case "rate-limited":
      return "Wait before retrying the Claude run.";
    case "config-invalid":
      return "Review the Claude configuration and run agent-bootstrap doctor.";
    case "volume-detached":
      return "Run agent-bootstrap doctor and check the volume status.";
    case "shell-disabled":
      return "Run shell commands through host verification.";
    case "credential-leak":
      return "Inspect the host evidence before retrying.";
    case "mount-busy":
      return "Wait for the current mount holder to finish, then retry.";
  }
}
