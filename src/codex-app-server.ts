import type {
  CoordinatorModel,
  CoordinatorTurnInput,
  ModelToolCall,
} from "./model-coordinator.ts";

/** One line-delimited JSON-RPC connection to a Codex app-server process. The
 * trusted host owns the process and its sandbox. Implementations must bound
 * each line while reading it (see boundedLines) and end `lines` on close. */
export interface JsonlChannel {
  send(line: string): void;
  readonly lines: AsyncIterable<string>;
  close(): void;
}

export interface CodexCoordinatorOptions {
  /** Open a fresh app-server for this invocation identity. */
  connect(id: string): Promise<JsonlChannel>;
  /** Covers connecting and the whole turn. */
  readonly timeoutMs: number;
}

export const CODEX_LIMITS = {
  lineBytes: 1024 * 1024,
  turnBytes: 16 * 1024 * 1024,
  serverRequests: 64,
} as const;

/** Fixed diagnostics only: no app-server output, model text or arguments. */
export class CodexAppServerError extends Error {
  readonly code: string;
  constructor(
    code:
      "timed-out" | "connect" | "protocol" | "rpc-error" | "closed" | "limit",
  ) {
    super(`Codex app-server: ${code}`);
    this.name = "CodexAppServerError";
    this.code = code;
  }
}

/** Split a byte stream into UTF-8 lines, failing before a line exceeds the
 * limit rather than after buffering it. */
export async function* boundedLines(
  chunks: AsyncIterable<Uint8Array | string>,
  maxBytes: number = CODEX_LIMITS.lineBytes,
): AsyncGenerator<string> {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let parts: Buffer[] = [];
  let size = 0;
  const take = () => {
    const line = Buffer.concat(parts);
    parts = [];
    size = 0;
    try {
      return decoder.decode(line);
    } catch {
      throw new CodexAppServerError("protocol");
    }
  };
  for await (const chunk of chunks) {
    let data = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    for (;;) {
      const end = data.indexOf(0x0a);
      const piece = end < 0 ? data : data.subarray(0, end);
      size += piece.length;
      if (size > maxBytes) throw new CodexAppServerError("limit");
      parts.push(Buffer.from(piece));
      if (end < 0) break;
      const line = take();
      yield line.endsWith("\r") ? line.slice(0, -1) : line;
      data = data.subarray(end + 1);
    }
  }
  if (size > 0) yield take();
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
  ): Promise<ModelToolCall | null> {
    let channel: JsonlChannel | undefined;
    let expiredFlag = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        expiredFlag = true;
        channel?.close();
        reject(new CodexAppServerError("timed-out"));
      }, this.#options.timeoutMs);
    });
    const run = (async () => {
      let opened: JsonlChannel;
      try {
        opened = await this.#options.connect(id);
      } catch {
        throw new CodexAppServerError("connect");
      }
      channel = opened;
      if (expiredFlag) {
        opened.close();
        throw new CodexAppServerError("timed-out");
      }
      return this.#converse(opened, input);
    })();
    run.catch(() => {});
    try {
      return await Promise.race([run, expired]);
    } finally {
      clearTimeout(timer);
      channel?.close();
    }
  }

  async #converse(
    channel: JsonlChannel,
    input: CoordinatorTurnInput,
  ): Promise<ModelToolCall | null> {
    const send = (message: object) => channel.send(JSON.stringify(message));
    let threadId: string | undefined;
    let turnId: string | undefined;
    let call: ModelToolCall | null = null;
    let voided = false;
    let interrupted = false;
    let bytes = 0;
    let requests = 0;
    const answered = new Set<unknown>();
    const interrupt = () => {
      if (interrupted || !threadId || !turnId) return;
      interrupted = true;
      send({ id: 3, method: "turn/interrupt", params: { threadId, turnId } });
    };
    const voidTurn = () => {
      voided = true;
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
          if (!usable || !call) voidTurn();
          else interrupt();
        } else {
          send({ id, error: { code: -32601, message: "Declined by host" } });
          voidTurn();
        }
        continue;
      }
      if (method === "item/started" || method === "item/completed") {
        const type = field(params, "item", "type");
        if (typeof type !== "string" || !allowedItems.has(type)) voidTurn();
        continue;
      }
      if (
        method === "turn/completed" &&
        turnId !== undefined &&
        field(params, "turn", "id") === turnId
      )
        return voided ? null : call;
    }
    throw new CodexAppServerError("closed");
  }
}
