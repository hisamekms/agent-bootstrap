import { randomUUID } from "node:crypto";
import { chmodSync, lstatSync, unlinkSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { basename, dirname, isAbsolute } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  canonicalJson,
  ContractError,
  fields,
  identifier,
  integer,
  oneOf,
  validateGoalContent,
  validateTaskContent,
} from "./model.ts";
import { proposalStatuses, type OrchestratorStore } from "./store.ts";

const plannerModes = [
  "goal-design",
  "task-decomposition",
  "replanning",
] as const;
const protocolVersions = [
  "2025-11-25",
  "2025-06-18",
  "2025-03-26",
  "2024-11-05",
];
const briefLimit = 20_000;
const requestMetaLimit = 4 * 1024;
const mib = 1024 * 1024;
const waitLimits = { minimum: 1, maximum: 60, default: 30 };

export interface ExecutionRequester {
  /** Queue a Planner execution and return its execution ID. */
  requestPlanner(input: {
    mode: (typeof plannerModes)[number];
    goalId?: string;
    brief: string;
    sessionId: string;
  }): Promise<string>;
}

export interface HostApiOptions {
  readonly store: OrchestratorStore;
  readonly socketPath: string;
  readonly sessionId: string;
  readonly requester: ExecutionRequester;
  readonly maxLineBytes?: number;
  readonly onTaskRegistered?: () => void;
}

function schema(
  properties: Record<string, object> = {},
  required: readonly string[] = [],
) {
  return { type: "object", properties, required, additionalProperties: false };
}

const idSchema = {
  type: "string",
  minLength: 1,
  maxLength: 200,
  pattern: "^[A-Za-z0-9][A-Za-z0-9._:/@+-]*$",
};
const contentSchema = { type: "object" };
const tools = {
  status: ["Summarize local orchestrator state", schema()],
  list_proposals: [
    "List proposals",
    schema({ status: { type: "string", enum: proposalStatuses } }),
  ],
  get_proposal: [
    "Read a proposal and its approval policy",
    schema({ id: idSchema }, ["id"]),
  ],
  list_goals: ["List registered goals", schema()],
  get_goal: [
    "Read a registered goal and its tasks",
    schema({ id: idSchema }, ["id"]),
  ],
  get_execution: [
    "Read an execution and its result",
    schema({ id: idSchema }, ["id"]),
  ],
  wait_execution: [
    "After request_planner, wait up to timeoutSeconds seconds (default 30) for the returned execution ID to finish",
    schema(
      { id: idSchema, timeoutSeconds: { type: "integer", ...waitLimits } },
      ["id"],
    ),
  ],
  draft_goal: [
    "Draft a goal proposal",
    schema({ content: contentSchema }, ["content"]),
  ],
  draft_task: [
    "Draft a task proposal",
    schema({ content: contentSchema }, ["content"]),
  ],
  request_planner: [
    "Queue a Planner execution",
    schema(
      {
        mode: { type: "string", enum: plannerModes },
        goalId: idSchema,
        brief: { type: "string", maxLength: briefLimit },
      },
      ["mode", "brief"],
    ),
  ],
} as const;
type Tool = keyof typeof tools;
const toolList = Object.entries(tools).map(
  ([name, [description, inputSchema]]) => ({
    name,
    description,
    inputSchema,
  }),
);

function isTool(value: unknown): value is Tool {
  return typeof value === "string" && Object.hasOwn(tools, value);
}

function readExecution(store: OrchestratorStore, id: string) {
  const execution = store.getExecution(id);
  if (!execution) return null;
  const { status, result } = execution;
  if (
    result &&
    typeof result === "object" &&
    Object.hasOwn(result, "rawAnswer")
  ) {
    // Raw reviewer diagnostics are for the operator CLI.
    const { rawAnswer: _rawAnswer, ...visible } = result as Record<
      string,
      unknown
    >;
    return { id, status, result: visible };
  }
  return { id, status, result };
}

async function waitForExecution(
  { store, sessionId }: HostApiOptions,
  id: string,
  deadline: number,
  signal: AbortSignal,
) {
  for (;;) {
    const execution = readExecution(store, id);
    if (
      execution === null ||
      (execution.status !== "queued" && execution.status !== "running") ||
      signal.aborted ||
      !store.isActiveConciergeSession(sessionId)
    )
      return execution;

    const remaining = deadline - performance.now();
    if (remaining <= 0) return { ...execution, waiting: true };
    try {
      await delay(Math.min(500, Math.ceil(remaining)), undefined, { signal });
    } catch (error) {
      if (!signal.aborted) throw error;
    }
  }
}

function prepareTool(
  tool: Tool,
  args: unknown,
  options: HostApiOptions,
  signal: AbortSignal,
  start: number,
): () => unknown {
  const { store, sessionId, requester } = options;
  const input = fields(args, Object.keys(tools[tool][1].properties));
  const origin = { kind: "actor", actor: "Concierge", sessionId } as const;
  switch (tool) {
    case "status":
      return () => store.getHostApiStatus();
    case "list_proposals": {
      const filter = Object.hasOwn(input, "status")
        ? { status: oneOf(input.status, proposalStatuses) }
        : {};
      return () =>
        store.listProposals(filter).map((proposal) => ({
          id: proposal.id,
          kind: proposal.kind,
          status: proposal.status,
          ...(proposal.kind === "integration"
            ? {
                goalId: proposal.content.goalId,
                taskId: proposal.content.taskId,
              }
            : { title: proposal.content.title }),
        }));
    }
    case "get_proposal": {
      const id = identifier(input.id);
      return () => store.getProposalDetails(id);
    }
    case "list_goals":
      return () =>
        store.listGoals().map(({ id, content, status }) => ({
          id,
          title: content.title,
          status,
        }));
    case "get_goal": {
      const id = identifier(input.id);
      return () => {
        const goal = store.getGoal(id);
        return (
          goal && {
            ...goal,
            tasks: store.listTasks(id).map((task) => ({
              ...task,
              budgetTokens: store.taskBudgetTokens(task.id),
              totalTokens: store.taskTokens(task.id),
            })),
            pendingIntegrations: store.pendingIntegrations(id),
          }
        );
      };
    }
    case "get_execution": {
      const id = identifier(input.id);
      return () => readExecution(store, id);
    }
    case "wait_execution": {
      const id = identifier(input.id);
      const seconds = Object.hasOwn(input, "timeoutSeconds")
        ? integer(input.timeoutSeconds, waitLimits.minimum, waitLimits.maximum)
        : waitLimits.default;
      return () =>
        waitForExecution(options, id, start + seconds * 1000, signal);
    }
    case "draft_goal": {
      const content = validateGoalContent(input.content);
      return () => ({
        ...store.proposeGoal(content, origin),
        message: "The operator approves this proposal with the host CLI.",
      });
    }
    case "draft_task": {
      const content = validateTaskContent(input.content);
      return () => {
        const receipt = store.proposeTask(content, origin);
        return receipt.status === "pending"
          ? {
              ...receipt,
              message: "The operator approves this proposal with the host CLI.",
            }
          : receipt;
      };
    }
    case "request_planner": {
      const mode = oneOf(input.mode, plannerModes);
      const goal = Object.hasOwn(input, "goalId")
        ? { goalId: identifier(input.goalId) }
        : {};
      const { brief } = input;
      if (typeof brief !== "string" || brief.length > briefLimit)
        throw new ContractError();
      return async () => ({
        executionId: await requester.requestPlanner({
          mode,
          ...goal,
          brief,
          sessionId,
        }),
      });
    }
  }
}

type ToolCode =
  | "ok"
  | "unknown-tool"
  | "invalid-arguments"
  | "invalid-request"
  | "wait-in-progress"
  | "not-found"
  | "tool-failed"
  | "session-inactive"
  | "audit-unavailable";
type SessionState = "active" | "inactive" | "unavailable";
type Connection = {
  socket: Socket;
  stop: AbortController;
  wait?: Promise<void>;
};

function toolResult(text: string, isError = false) {
  return { content: [{ type: "text", text }], ...(isError ? { isError } : {}) };
}

function toolError(code: ToolCode) {
  return toolResult(JSON.stringify({ code }), true);
}

function duration(start: number) {
  return Math.max(0, performance.now() - start);
}

async function callTool(
  params: unknown,
  options: HostApiOptions,
  session: SessionState,
  notification: boolean,
  connection: Connection,
) {
  const { store, sessionId } = options;
  const start = performance.now();
  const callId = randomUUID();
  let tool: Tool | "unknown" | "invalid" = "invalid";
  let code: ToolCode = "ok";
  let run: (() => unknown) | undefined;
  try {
    const input = fields(params, ["name", "arguments", "_meta"]);
    if (typeof input.name !== "string" || !validRequestMeta(input))
      throw new ContractError();
    if (isTool(input.name)) {
      tool = input.name;
      if (session === "active" && !notification) {
        if (tool === "wait_execution" && connection.wait) {
          code = "wait-in-progress";
        } else {
          run = prepareTool(
            tool,
            Object.hasOwn(input, "arguments") ? input.arguments : {},
            options,
            connection.stop.signal,
            start,
          );
        }
      }
    } else {
      tool = "unknown";
      code = "unknown-tool";
    }
  } catch {
    code = "invalid-arguments";
  }

  if (session === "unavailable") code = "audit-unavailable";
  else if (session === "inactive") code = "session-inactive";
  else if (notification) code = "invalid-request";

  let outcome: "ok" | "denied" | "error" =
    code === "audit-unavailable" ? "error" : "denied";
  let result: string | undefined;
  let taskRegistered = false;
  let executionId: string | undefined;
  if (run) {
    try {
      store.recordApiCall(sessionId, {
        kind: "authorized",
        callId,
        tool,
        durationMs: duration(start),
      });
    } catch {
      code = "audit-unavailable";
      outcome = "error";
      run = undefined;
    }
  }
  if (run) {
    try {
      const value = await run();
      if (value === null) {
        code = "not-found";
        outcome = "error";
      } else {
        if (isObject(value)) {
          if (tool === "draft_task")
            taskRegistered = value.status === "registered";
          if (tool === "request_planner")
            executionId = identifier(value.executionId);
          if (tool === "get_execution" || tool === "wait_execution")
            executionId = identifier(value.id);
        }
        result = JSON.stringify(value);
        outcome = "ok";
      }
    } catch {
      code = "tool-failed";
      outcome = "error";
    }
  }

  try {
    store.recordApiCall(sessionId, {
      kind: "call",
      callId,
      tool,
      outcome,
      code,
      durationMs: duration(start),
      ...(executionId === undefined ? {} : { executionId }),
    });
  } catch {
    return toolError("audit-unavailable");
  }
  if (taskRegistered) options.onTaskRegistered?.();
  return result === undefined ? toolError(code) : toolResult(result);
}

type RequestId = string | number | null;

function rpcError(id: RequestId, code: number, message: string) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validRequestMeta(params: unknown): boolean {
  if (!isObject(params) || !Object.hasOwn(params, "_meta")) return true;
  const meta = params._meta;
  if (!isObject(meta)) return false;
  try {
    // Reject oversized wire JSON before canonicalization sorts and checks its keys.
    if (Buffer.byteLength(JSON.stringify(meta)) > requestMetaLimit)
      return false;
    canonicalJson(meta, requestMetaLimit);
    return true;
  } catch {
    return false;
  }
}

async function dispatch(
  message: Record<string, unknown>,
  id: RequestId | undefined,
  options: HostApiOptions,
  connection: Connection,
) {
  const { method, params } = message;
  let session: SessionState;
  try {
    session = options.store.isActiveConciergeSession(options.sessionId)
      ? "active"
      : "inactive";
  } catch {
    session = "unavailable";
  }

  if (method === "tools/call") {
    return {
      close: session !== "active",
      result: await callTool(
        params,
        options,
        session,
        id === undefined,
        connection,
      ),
    };
  }
  if (session !== "active") {
    return {
      close: true,
      error:
        id === undefined
          ? undefined
          : session === "inactive"
            ? rpcError(id, -32000, "Session inactive")
            : rpcError(id, -32603, "Internal error"),
    };
  }
  if (id === undefined) return {};
  if (
    (method === "initialize" || method === "ping" || method === "tools/list") &&
    !validRequestMeta(params)
  )
    return { error: rpcError(id, -32602, "Invalid params") };
  switch (method) {
    case "initialize": {
      const version = isObject(params) ? params.protocolVersion : undefined;
      if (typeof version !== "string")
        return { error: rpcError(id, -32602, "Invalid params") };
      return {
        result: {
          protocolVersion: protocolVersions.includes(version)
            ? version
            : protocolVersions[0],
          capabilities: { tools: {} },
          serverInfo: { name: "local-orchestrator", version: "0.1.0" },
        },
      };
    }
    case "ping":
      return { result: {} };
    case "tools/list":
      return { result: { tools: toolList } };
    default:
      return { error: rpcError(id, -32601, "Method not found") };
  }
}

function send(socket: Socket, response: object): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.write(JSON.stringify(response) + "\n", (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

async function serve(
  connection: Connection,
  options: HostApiOptions,
  maxLineBytes: number,
) {
  const { socket, stop } = connection;
  async function handle(
    message: Record<string, unknown>,
    id: RequestId | undefined,
  ) {
    const dispatched = await dispatch(message, id, options, connection);
    if (id !== undefined && !socket.destroyed)
      await send(
        socket,
        dispatched.error ?? {
          jsonrpc: "2.0",
          id,
          result: dispatched.result,
        },
      );
    return dispatched.close === true;
  }

  const line = Buffer.allocUnsafe(maxLineBytes);
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  let length = 0;
  let errors = 0;
  for await (const chunk of socket as AsyncIterable<Buffer>) {
    let offset = 0;
    while (offset < chunk.length && !socket.destroyed) {
      const newline = chunk.indexOf(0x0a, offset);
      const end = newline === -1 ? chunk.length : newline;
      if (length + end - offset > maxLineBytes) return;
      length += chunk.copy(line, length, offset, end);
      if (newline === -1) break;
      offset = newline + 1;

      let message: unknown;
      let response: object | undefined;
      try {
        message = JSON.parse(decoder.decode(line.subarray(0, length)));
      } catch {
        response = rpcError(null, -32700, "Parse error");
      }
      length = 0;
      const id = isObject(message) ? message.id : undefined;
      if (!response) {
        if (
          !isObject(message) ||
          message.jsonrpc !== "2.0" ||
          typeof message.method !== "string" ||
          (id !== undefined &&
            typeof id !== "string" &&
            !(typeof id === "number" && Number.isFinite(id)))
        ) {
          response = rpcError(null, -32600, "Invalid request");
        } else {
          if (
            id !== undefined &&
            message.method === "tools/call" &&
            isObject(message.params) &&
            message.params.name === "wait_execution" &&
            !connection.wait
          ) {
            // Keep reading pipelined requests while the wait polls the store.
            connection.wait = handle(message, id)
              .then((close) => {
                if (close) socket.destroy();
              })
              .catch(() => {
                socket.destroy();
              })
              .finally(() => {
                delete connection.wait;
              });
          } else if (await handle(message, id)) {
            return;
          }
          continue;
        }
      }
      await send(socket, response);
      if (++errors >= 3) return;
    }
  }
  stop.abort();
  await connection.wait;
}

function socketStat(path: string) {
  return lstatSync(path, { throwIfNoEntry: false });
}

export class HostApiServer {
  readonly #server: Server;
  readonly #options: HostApiOptions;
  readonly #maxLineBytes: number;
  #client: Connection | undefined;
  #socketIdentity: ReturnType<typeof socketStat>;
  #closing: Promise<void> | undefined;

  private constructor(options: HostApiOptions, maxLineBytes: number) {
    this.#options = options;
    this.#maxLineBytes = maxLineBytes;
    this.#server = createServer({ allowHalfOpen: true }, (socket) =>
      this.#connect(socket),
    );
  }

  static async listen(options: HostApiOptions): Promise<HostApiServer> {
    const { socketPath, store, sessionId } = options;
    const maxLineBytes = integer(options.maxLineBytes ?? mib, 1, 4 * mib);
    if (
      !isAbsolute(socketPath) ||
      socketPath.includes("\0") ||
      socketPath.endsWith("/") ||
      [".", ".."].includes(basename(socketPath)) ||
      Buffer.byteLength(socketPath) >= 100
    )
      throw new Error("Invalid Host API socket path");

    const parent = socketStat(dirname(socketPath));
    if (
      !parent?.isDirectory() ||
      parent.uid !== process.geteuid?.() ||
      (parent.mode & 0o7777) !== 0o700
    )
      throw new Error("Host API socket requires a private parent directory");
    if (socketStat(socketPath))
      throw new Error("Host API socket path already exists");
    if (!store.isActiveConciergeSession(sessionId))
      throw new Error("Concierge session is inactive");

    const api = new HostApiServer({ ...options }, maxLineBytes);
    await new Promise<void>((resolve, reject) => {
      api.#server.once("error", reject);
      api.#server.listen(socketPath, () => {
        api.#server.removeListener("error", reject);
        resolve();
      });
    });
    api.#server.on("error", () => {
      void api.close().catch(() => {});
    });
    try {
      api.#socketIdentity = socketStat(socketPath);
      if (!api.#socketIdentity?.isSocket())
        throw new Error("Host API socket is unavailable");
      chmodSync(socketPath, 0o600);
      return api;
    } catch (error) {
      await api.close();
      throw error;
    }
  }

  #connect(socket: Socket): void {
    socket.on("error", () => {});
    if (this.#client || this.#closing || !this.#socketIdentity) {
      socket.destroy();
      return;
    }
    const { store, sessionId } = this.#options;
    const start = performance.now();
    try {
      store.recordApiCall(sessionId, { kind: "connected", durationMs: 0 });
    } catch {
      socket.destroy();
      return;
    }
    const stop = new AbortController();
    const connection: Connection = { socket, stop };
    this.#client = connection;
    socket.once("end", () => stop.abort());
    socket.once("close", () => {
      stop.abort();
      this.#client = undefined;
      try {
        store.recordApiCall(sessionId, {
          kind: "disconnected",
          durationMs: duration(start),
        });
      } catch {
        // The connection is already closed and SQLite may be unavailable.
      }
    });
    void serve(connection, this.#options, this.#maxLineBytes)
      .catch(() => {})
      .finally(() => {
        stop.abort();
        socket.destroy();
      });
  }

  close(): Promise<void> {
    const client = this.#client;
    this.#closing ??= new Promise<void>((resolve, reject) => {
      this.#server.close((error) => {
        if (error) reject(error);
        else resolve();
      });
      client?.stop.abort();
      client?.socket.destroy();
    }).then(async () => {
      await client?.wait;
      const path = this.#options.socketPath;
      const current = socketStat(path);
      if (
        current?.isSocket() &&
        current.ino === this.#socketIdentity?.ino &&
        current.dev === this.#socketIdentity.dev
      )
        unlinkSync(path);
    });
    return this.#closing;
  }
}
