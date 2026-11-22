import type {
  CoordinatorModel,
  CoordinatorTurnInput,
  ModelToolCall,
} from "./model-coordinator.ts";

/** One line-delimited JSON-RPC connection to a Codex app-server process. The
 * trusted host owns the process and its sandbox. */
export interface JsonlChannel {
  send(line: string): void;
  readonly lines: AsyncIterable<string>;
  close(): void;
}

export interface CodexCoordinatorOptions {
  /** Open a fresh app-server for this invocation identity. */
  connect(id: string): Promise<JsonlChannel>;
  readonly timeoutMs: number;
}

export const CODEX_LIMITS = {
  lineBytes: 1024 * 1024,
  messages: 1024,
} as const;

/** Fixed diagnostics only: no app-server output, model text or arguments. */
export class CodexAppServerError extends Error {
  readonly code: string;
  constructor(
    code: "timed-out" | "protocol" | "rpc-error" | "closed" | "limit",
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

const submitted =
  "Submitted to the trusted host. Its outcome arrives in the next turn.";
const refused = "Only one host request is accepted per turn.";

/** Codex app-server adapter. Coordinator tools are registered as dynamic tools.
 * The first dynamic call is captured and the turn is interrupted; nothing the
 * model proposes is executed here. Any other server request is declined and
 * voids the turn. */
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
    const channel = await this.#options.connect(id);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        channel.close();
        reject(new CodexAppServerError("timed-out"));
      }, this.#options.timeoutMs);
    });
    try {
      return await Promise.race([this.#converse(channel, input), expired]);
    } finally {
      clearTimeout(timer);
      channel.close();
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
    let count = 0;
    const interrupt = () => {
      if (interrupted || !threadId || !turnId) return;
      interrupted = true;
      send({ id: 3, method: "turn/interrupt", params: { threadId, turnId } });
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
      if (++count > CODEX_LIMITS.messages)
        throw new CodexAppServerError("limit");
      if (Buffer.byteLength(line) > CODEX_LIMITS.lineBytes)
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
        // Responses to this client's requests.
        if (message.error !== undefined) {
          // An interrupt racing turn completion is harmless.
          if (id === 3) continue;
          throw new CodexAppServerError("rpc-error");
        }
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
          if (typeof thread !== "string")
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
        } else if (id === 2) {
          const turn = field(message.result, "turn", "id");
          if (typeof turn !== "string")
            throw new CodexAppServerError("protocol");
          turnId = turn;
          if (call || voided) interrupt();
        }
        continue;
      }
      if (typeof method !== "string") throw new CodexAppServerError("protocol");
      if (id !== undefined) {
        // A server request: answer it without performing any effect.
        const params = message.params;
        const belongs =
          threadId !== undefined &&
          field(params, "threadId") === threadId &&
          (turnId === undefined || field(params, "turnId") === turnId);
        const name = field(params, "tool");
        if (
          method === "item/tool/call" &&
          belongs &&
          typeof name === "string" &&
          input.tools.some((tool) => tool.name === name) &&
          !call &&
          !voided
        ) {
          call = { name, arguments: field(params, "arguments") };
          send({
            id,
            result: {
              success: true,
              contentItems: [{ type: "inputText", text: submitted }],
            },
          });
        } else if (method === "item/tool/call") {
          if (!call) voided = true;
          send({
            id,
            result: {
              success: false,
              contentItems: [{ type: "inputText", text: refused }],
            },
          });
        } else {
          voided = true;
          send({ id, error: { code: -32601, message: "Declined by host" } });
        }
        interrupt();
        continue;
      }
      if (
        method === "turn/completed" &&
        turnId !== undefined &&
        field(message.params, "turn", "id") === turnId
      )
        return voided ? null : call;
    }
    throw new CodexAppServerError("closed");
  }
}
