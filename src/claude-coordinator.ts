import {
  claudeCodeCommand,
  parseClaudeCodeResult,
  type ClaudeCodeAuth,
} from "./claude-code.ts";
import type {
  CoordinatorModel,
  CoordinatorTurnInput,
  CoordinatorTurnResult,
} from "./model-coordinator.ts";
import type { SandboxSpec } from "./sandbox-runtime.ts";
import type { ReviewerPlan, ReviewerRun } from "./trusted-host.ts";

/** Fixed diagnostics only: no model text or CLI output. */
export class ClaudeCoordinatorError extends Error {
  readonly code: string;
  constructor(code: "sandbox" | "protocol" | "limit") {
    super(`Claude Coordinator: ${code}`);
    this.name = "ClaudeCoordinatorError";
    this.code = code;
  }
}

export interface ClaudeCoordinatorOptions {
  /** Usually `(plan, id) => host.runCoordinator(plan, id)`. One sandbox per turn. */
  run(plan: ReviewerPlan, id: string): Promise<ReviewerRun>;
  /** Tools and egress for the Coordinator sandbox. */
  readonly sandbox: Pick<SandboxSpec, "tools" | "provider" | "hostTcpPort">;
  readonly auth: ClaudeCodeAuth;
  readonly model: string;
  readonly timeoutMs: number;
  readonly baseUrl?: string;
  onUsage?(usage: { inputTokens: number; outputTokens: number }): void;
}

const replyFormat = `Reply with exactly one JSON object and nothing else.
To call a tool: {"tool": "<tool name>", ...its arguments}.
To end the task: {"tool": "finish"}.`;

/**
 * Claude Code as the Coordinator model. Each turn runs the official CLI once,
 * with no tools, in a fresh sandbox whose only file is the host-prepared
 * control.json. The CLI's answer is parsed into one proposed call; like any
 * model output it is untrusted, and the router alone authorizes it.
 */
export class ClaudeCodeCoordinator implements CoordinatorModel {
  readonly #options: ClaudeCoordinatorOptions;

  constructor(options: ClaudeCoordinatorOptions) {
    this.#options = options;
  }

  async turn(
    input: CoordinatorTurnInput,
    id: string,
  ): Promise<CoordinatorTurnResult> {
    const control = Buffer.from(
      `${input.prompt}\n\nTools (JSON Schema for arguments):\n${JSON.stringify(
        input.tools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          arguments: tool.inputSchema,
        })),
        null,
        2,
      )}\n\n${replyFormat}\n`,
    );
    if (control.length > 65_536) throw new ClaudeCoordinatorError("limit");
    const run = await this.#options.run(
      {
        sandbox: {
          ...this.#options.sandbox,
          readOnlyFiles: [{ path: "control.json", bytes: control }],
          maxLifetimeMs: Math.min(this.#options.timeoutMs + 60_000, 300_000),
        },
        command: claudeCodeCommand(
          {
            role: "Coordinator",
            prompt: "coordinator",
            model: this.#options.model,
            maxTurns: 1,
            timeoutMs: this.#options.timeoutMs,
            ...(this.#options.baseUrl
              ? { baseUrl: this.#options.baseUrl }
              : {}),
          },
          this.#options.auth,
        ),
      },
      id,
    );
    if (run.outcome !== "ok") throw new ClaudeCoordinatorError("sandbox");
    const result = parseClaudeCodeResult(run.response);
    if (!result) throw new ClaudeCoordinatorError("protocol");
    if (result.inputTokens !== null && result.outputTokens !== null)
      this.#options.onUsage?.({
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
      });
    if (result.isError) return { call: null, reason: "turn-failed/cli" };
    return proposal(result.text);
  }
}

/** One JSON object, optionally inside a single fenced block. */
function proposal(text: string): CoordinatorTurnResult {
  const body = text
    .trim()
    .replace(/^```(?:json)?\s*\n?/, "")
    .replace(/\n?```$/, "")
    .trim();
  try {
    const value = JSON.parse(body) as unknown;
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const { tool, ...rest } = value as Record<string, unknown>;
      if (typeof tool === "string")
        return { call: { name: tool, arguments: rest } };
    }
  } catch {
    // Not JSON: the turn proposed nothing.
  }
  return { call: null, reason: "no-call" };
}
