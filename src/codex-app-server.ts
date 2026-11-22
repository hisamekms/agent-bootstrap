import { LineStreamError } from "./lines.ts";
import type {
  CoordinatorModel,
  CoordinatorTurnInput,
  CoordinatorTurnResult,
  ModelToolCall,
} from "./model-coordinator.ts";
import { SandboxRuntimeError } from "./sandbox-runtime.ts";
import { HostAuditError } from "./trusted-host.ts";

/** One line-delimited JSON-RPC connection to a Codex app-server process. The
 * trusted host owns the process and its sandbox. Implementations must bound
 * each line while reading it (see boundedLines) and end `lines` on close. */
export interface JsonlChannel {
  send(line: string): void;
  readonly lines: AsyncIterable<string>;
  close(): void;
}

export interface CodexCoordinatorOptions {
  /** Run `use` against a fresh app-server for this invocation identity, for
   * example inside TrustedHost.runCoordinatorSession, and return its value. */
  open<T>(id: string, use: (channel: JsonlChannel) => Promise<T>): Promise<T>;
  /** Covers opening and the whole turn. */
  readonly timeoutMs: number;
}

export const CODEX_LIMITS = {
  lineBytes: 1024 * 1024,
  turnBytes: 16 * 1024 * 1024,
  serverRequests: 64,
  /** How long a timed-out turn waits for the host to tear down and audit. */
  teardownMs: 30_000,
} as const;

/** Fixed diagnostics only: no app-server output, model text or arguments. */
export class CodexAppServerError extends Error {
  readonly code: string;
  constructor(
    code:
      | "timed-out"
      | "connect"
      | "encoding"
      | "protocol"
      | "rpc-error"
      | "closed"
      | "limit",
  ) {
    super(`Codex app-server: ${code}`);
    this.name = "CodexAppServerError";
    this.code = code;
  }
}

type Message = {
  id?: unknown;
  method?: unknown;
  result?: unknown;
  error?: unknown;
  params?: unknown;
};

const field = (value: unknown, ...path: string[]): unknown =>
  path.reduce<unknown>(
    (current, key) =>
      current && typeof current === "object" && !Array.isArray(current)
        ? (current as Record<string, unknown>)[key]
        : undefined,
    value,
  );

/** Thread configuration that removes native tools a Coordinator must not use.
 * With Codex 0.170.0 the M4 model smoke shows that this removes the shell,
 * stdin and goal tools. Code mode, patch, MCP resource, image and
 * collaboration tools still come from the model catalog and remain visible,
 * so the adapter also voids any turn that starts a non-dynamic tool item. */
export const CODEX_COORDINATOR_CONFIG = {
  features: {
    code_mode: false,
    code_mode_only: false,
    shell_tool: false,
    unified_exec: false,
    apply_patch_freeform: false,
    multi_agent: false,
    multi_agent_v2: false,
    collaboration_modes: false,
    default_mode_request_user_input: false,
    request_permissions_tool: false,
    current_time_reminder: false,
    goals: false,
    apps: false,
    plugins: false,
    memories: false,
    hooks: false,
  },
  web_search: "disabled",
  mcp_servers: {},
} as const;

/** Thread items a Coordinator turn may produce. Any other item, such as a
 * command, file change, MCP, web, image or sub-agent item, voids the turn. */
const allowedItems = new Set([
  "userMessage",
  "agentMessage",
  "reasoning",
  "dynamicToolCall",
  "contextCompaction",
]);

/** Known app-server names for the trace. Codex 0.170.0 schema. */
const knownRequests = new Set([
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
  "item/tool/requestUserInput",
  "mcpServer/elicitation/request",
  "item/permissions/requestApproval",
  "item/tool/call",
  "account/chatgptAuthTokens/refresh",
  "attestation/generate",
  "currentTime/read",
  "applyPatchApproval",
  "execCommandApproval",
]);
const knownItems = new Set([
  "userMessage",
  "hookPrompt",
  "agentMessage",
  "functionCallOutput",
  "plan",
  "reasoning",
  "commandExecution",
  "fileChange",
  "mcpToolCall",
  "dynamicToolCall",
  "collabAgentToolCall",
  "subAgentActivity",
  "webSearch",
  "imageView",
  "sleep",
  "imageGeneration",
  "enteredReviewMode",
  "exitedReviewMode",
  "contextCompaction",
]);

/** A fixed label: a known protocol name, or `other`. Guest-chosen text never
 * reaches the journal. */
function label(value: unknown, known: ReadonlySet<string>): string {
  return typeof value === "string" && known.has(value) ? value : "other";
}

/** Keep host and adapter errors, which carry fixed diagnostics; replace
 * anything else with a fixed code. */
function transportError(error: unknown, fallback: "closed" | "connect"): Error {
  if (
    error instanceof CodexAppServerError ||
    error instanceof HostAuditError ||
    error instanceof SandboxRuntimeError
  )
    return error;
  if (error instanceof LineStreamError)
    return new CodexAppServerError(
      error.code === "limit" ? "limit" : "encoding",
    );
  return new CodexAppServerError(fallback);
}

const submitted =
  "Submitted to the trusted host. Its outcome arrives in the next turn.";
const refused = "Only one host request is accepted per turn.";

/** Codex app-server adapter. Coordinator tools are registered as dynamic tools.
 * The first dynamic call is captured and the turn is interrupted; nothing the
 * model proposes is executed here. Any other server request or native item is
 * refused and voids the turn. */
export class CodexAppServerCoordinator implements CoordinatorModel {
  readonly #options: CodexCoordinatorOptions;

  constructor(options: CodexCoordinatorOptions) {
    if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1)
      throw new Error("Invalid Codex app-server timeout");
    this.#options = options;
  }

  async turn(
    input: CoordinatorTurnInput,
    id: string,
  ): Promise<CoordinatorTurnResult> {
    let channel: JsonlChannel | undefined;
    let expired = false;
    let entered = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const run = this.#options.open(id, async (opened) => {
      entered = true;
      channel = opened;
      try {
        if (expired) throw new CodexAppServerError("timed-out");
        return await this.#converse(opened, input);
      } catch (error) {
        // A stream ended by the deadline is a timeout, not a closed channel.
        throw expired
          ? new CodexAppServerError("timed-out")
          : transportError(error, "closed");
      } finally {
        opened.close();
      }
    });
    const deadline = new Promise<"expired">((resolve) => {
      timer = setTimeout(() => resolve("expired"), this.#options.timeoutMs);
    });
    try {
      const first = await Promise.race([
        run.then(
          (value) => ({ value }),
          (error: unknown) => ({ error }),
        ),
        deadline,
      ]);
      if (first === "expired") {
        expired = true;
        channel?.close();
        // Let the host finish teardown and audit, within a bound, before
        // reporting. A host audit failure takes precedence over the timeout.
        let wait: ReturnType<typeof setTimeout> | undefined;
        const settled = await Promise.race([
          run.then(
            () => null,
            (error: unknown) => error,
          ),
          new Promise<null>((resolve) => {
            wait = setTimeout(() => resolve(null), CODEX_LIMITS.teardownMs);
          }),
        ]);
        clearTimeout(wait);
        if (settled instanceof HostAuditError) throw settled;
        throw new CodexAppServerError("timed-out");
      }
      if ("error" in first)
        throw transportError(first.error, entered ? "closed" : "connect");
      if (!first.value) throw new CodexAppServerError("closed");
      return first.value;
    } finally {
      clearTimeout(timer);
    }
  }

  async #converse(
    channel: JsonlChannel,
    input: CoordinatorTurnInput,
  ): Promise<CoordinatorTurnResult> {
    const send = (message: object) => channel.send(JSON.stringify(message));
    let threadId: string | undefined;
    let turnId: string | undefined;
    let call: ModelToolCall | null = null;
    let voided: string | undefined;
    let interrupted = false;
    let bytes = 0;
    let requests = 0;
    const answered = new Set<unknown>();
    const interrupt = () => {
      if (interrupted || !threadId || !turnId) return;
      interrupted = true;
      send({ id: 3, method: "turn/interrupt", params: { threadId, turnId } });
    };
    const voidTurn = (reason: string) => {
      voided ??= reason;
      interrupt();
    };
    send({
      id: 0,
      method: "initialize",
      params: {
        clientInfo: { name: "agent-bootstrap-coordinator", version: "0.0.0" },
        capabilities: { experimentalApi: true },
      },
    });
    for await (const line of channel.lines) {
      bytes += Buffer.byteLength(line) + 1;
      if (
        Buffer.byteLength(line) > CODEX_LIMITS.lineBytes ||
        bytes > CODEX_LIMITS.turnBytes
      )
        throw new CodexAppServerError("limit");
      let message: Message;
      try {
        message = JSON.parse(line) as Message;
      } catch {
        throw new CodexAppServerError("protocol");
      }
      if (!message || typeof message !== "object" || Array.isArray(message))
        throw new CodexAppServerError("protocol");
      const { id, method } = message;
      if (method === undefined) {
        // Responses to this client's requests, each accepted once.
        if (id === 3) continue;
        if (answered.has(id) || !(id === 0 || id === 1 || id === 2))
          throw new CodexAppServerError("protocol");
        answered.add(id);
        if (message.error !== undefined)
          throw new CodexAppServerError("rpc-error");
        if (id === 0) {
          send({ method: "initialized" });
          send({
            id: 1,
            method: "thread/start",
            params: {
              cwd: "/tmp",
              ephemeral: true,
              sandbox: "read-only",
              approvalPolicy: "never",
              config: CODEX_COORDINATOR_CONFIG,
              dynamicTools: input.tools.map((tool) => ({
                type: "function",
                name: tool.name,
                description: tool.description,
                inputSchema: tool.inputSchema,
              })),
            },
          });
        } else if (id === 1) {
          const thread = field(message.result, "thread", "id");
          if (typeof thread !== "string" || !answered.has(0))
            throw new CodexAppServerError("protocol");
          threadId = thread;
          send({
            id: 2,
            method: "turn/start",
            params: {
              threadId,
              input: [{ type: "text", text: input.prompt, text_elements: [] }],
            },
          });
        } else {
          const turn = field(message.result, "turn", "id");
          if (typeof turn !== "string" || threadId === undefined)
            throw new CodexAppServerError("protocol");
          turnId = turn;
          if (call || voided) interrupt();
        }
        continue;
      }
      if (typeof method !== "string") throw new CodexAppServerError("protocol");
      const params = message.params;
      if (id !== undefined) {
        // A server request: answer it without performing any effect.
        if (++requests > CODEX_LIMITS.serverRequests)
          throw new CodexAppServerError("limit");
        const name = field(params, "tool");
        const usable =
          method === "item/tool/call" &&
          threadId !== undefined &&
          turnId !== undefined &&
          field(params, "threadId") === threadId &&
          field(params, "turnId") === turnId &&
          typeof name === "string" &&
          input.tools.some((tool) => tool.name === name);
        if (usable && !call && !voided) {
          call = { name, arguments: field(params, "arguments") };
          send({
            id,
            result: {
              success: true,
              contentItems: [{ type: "inputText", text: submitted }],
            },
          });
          interrupt();
        } else if (method === "item/tool/call") {
          send({
            id,
            result: {
              success: false,
              contentItems: [{ type: "inputText", text: refused }],
            },
          });
          if (!usable) voidTurn("foreign-call");
          else if (!call) voidTurn("extra-call");
          else interrupt();
        } else {
          send({ id, error: { code: -32601, message: "Declined by host" } });
          voidTurn(`server-request/${label(method, knownRequests)}`);
        }
        continue;
      }
      if (method === "item/started" || method === "item/completed") {
        const type = field(params, "item", "type");
        if (typeof type !== "string" || !allowedItems.has(type))
          voidTurn(`native-item/${label(type, knownItems)}`);
        continue;
      }
      if (
        method === "turn/completed" &&
        turnId !== undefined &&
        field(params, "turn", "id") === turnId
      )
        return voided
          ? { call: null, reason: voided }
          : call
            ? { call }
            : { call: null, reason: "no-call" };
    }
    throw new CodexAppServerError("closed");
  }
}
