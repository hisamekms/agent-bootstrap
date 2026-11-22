import {
  claudeCodeCommand,
  claudeCodeProvider,
  parseClaudeCodeResult,
  type ClaudeCodeAuth,
} from "./claude-code.ts";
import {
  codexProvider,
  codexRoleCommand,
  type CodexOptions,
} from "./codex-exec.ts";
import type {
  SandboxCommand,
  SandboxSpec,
  SandboxTool,
} from "./sandbox-runtime.ts";

/** The official agent CLI an actor runs on. */
export type Harness = "codex" | "claude";
export const ACTORS = ["Coordinator", "Planner", "Worker", "Reviewer"] as const;
export type Actor = (typeof ACTORS)[number];
export type ActorHarnesses = Readonly<Record<Actor, Harness>>;

/**
 * Parse `Coordinator=codex,Worker=claude` (or `all=claude`) into a harness
 * per actor; unnamed actors get `fallback`. Unknown actors or harnesses are
 * refused.
 */
export function parseActorHarnesses(
  text: string | undefined,
  fallback: Harness = "codex",
): ActorHarnesses {
  const result: Record<Actor, Harness> = {
    Coordinator: fallback,
    Planner: fallback,
    Worker: fallback,
    Reviewer: fallback,
  };
  for (const part of (text ?? "").split(",").map((item) => item.trim())) {
    if (!part) continue;
    const [actor, harness, extra] = part.split("=");
    if (extra !== undefined || (harness !== "codex" && harness !== "claude"))
      throw new Error("Invalid actor harness");
    if (actor === "all") for (const name of ACTORS) result[name] = harness;
    else if (ACTORS.includes(actor as Actor)) result[actor as Actor] = harness;
    else throw new Error("Invalid actor harness");
  }
  return Object.freeze(result);
}

/** Sandbox inputs and the guest command for one Planner, Worker or Reviewer
 * invocation. Every harness follows the same output contract: Worker prints
 * the collect request, Reviewer yields `{"review", "notes"}` JSON (after
 * `reviewerOutput`), Planner prints its plan. */
export interface RoleHarness {
  readonly harness: Harness;
  readonly sandbox: Pick<SandboxSpec, "tools" | "provider" | "hostTcpPort">;
  command(task: {
    readonly role: "Planner" | "Worker" | "Reviewer";
    readonly prompt: string;
    readonly timeoutMs: number;
  }): SandboxCommand;
  readonly reviewerOutput?: (
    response: Uint8Array | undefined,
  ) => Uint8Array | undefined;
}

export function codexRoleHarness(
  options: CodexOptions,
  tools: SandboxTool[],
  hostTcpPort?: number,
): RoleHarness {
  const provider = codexProvider(options.endpoint);
  return {
    harness: "codex",
    sandbox: {
      tools,
      ...(provider ? { provider } : {}),
      ...(hostTcpPort !== undefined ? { hostTcpPort } : {}),
    },
    command: (task) => codexRoleCommand(task, options),
  };
}

export function claudeRoleHarness(options: {
  readonly auth: ClaudeCodeAuth;
  readonly model: string;
  readonly tools: SandboxTool[];
  /** Local stand-in for the provider host, for fixtures. */
  readonly fixture?: { host: string; port: number; upstreamCaCertPath: string };
  readonly maxTurns?: number;
}): RoleHarness {
  const provider = claudeCodeProvider(options.auth, options.fixture);
  const baseUrl = options.fixture
    ? `https://${options.fixture.host}:${options.fixture.port}`
    : undefined;
  return {
    harness: "claude",
    sandbox: { tools: options.tools, provider },
    command: (task) =>
      claudeCodeCommand(
        {
          role: task.role,
          prompt: task.prompt,
          model: options.model,
          maxTurns: options.maxTurns ?? 8,
          timeoutMs: task.timeoutMs,
          ...(baseUrl ? { baseUrl } : {}),
        },
        options.auth,
      ),
    // The CLI prints a result object; the review JSON is its text.
    reviewerOutput: (response) => {
      const result = parseClaudeCodeResult(response);
      return result && !result.isError
        ? Buffer.from(result.text.trim())
        : undefined;
    },
  };
}
