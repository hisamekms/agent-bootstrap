import { chmodSync, lstatSync, unlinkSync } from "node:fs";
import { connect, createServer, type Socket } from "node:net";
import { isAbsolute, join } from "node:path";
import { privatePath } from "../config/layers.ts";
import type { CredentialScanner } from "./credential-scan.ts";
import {
  changedInboxIds,
  inboxLimit,
  inboxSnapshot,
  projectInbox,
  type InboxSource,
} from "./inbox.ts";
import { ContractError, fields, identifier, integer } from "./model.ts";
import { operatorProposal, operatorStatus } from "./operator-read.ts";

interface OperatorApiOptions extends InboxSource {
  stateDirectory: string;
  scan?: CredentialScanner;
  maxLineBytes?: number;
  pollMs?: number;
}

type RequestId = string | number;
type ErrorCode =
  | "invalid-request"
  | "invalid-params"
  | "unknown-method"
  | "not-found"
  | "read-failed"
  | "write-failed";
type Reply = { result: unknown } | { error: { code: ErrorCode } };
type Client = { subscribedSnapshot?: Map<string, string> };

const failure = (code: ErrorCode): Reply => ({ error: { code } });
const maxClients = 8;
const maxPendingBytes = 1024 * 1024;

function requestId(value: unknown): RequestId {
  return typeof value === "number" && Number.isSafeInteger(value)
    ? value
    : identifier(value);
}

function write(socket: Socket, message: object) {
  return new Promise<void>((resolve, reject) => {
    socket.write(JSON.stringify(message) + "\n", (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

/** Remove a socket left by a launcher that exited without cleanup. A socket
 * that still accepts connections belongs to a running launcher. */
async function removeStaleSocket(path: string) {
  const existing = lstatSync(path, { throwIfNoEntry: false });
  if (!existing) return;
  if (!existing.isSocket() || existing.uid !== process.getuid?.())
    throw new Error("Operator socket path already exists");
  const live = await new Promise<boolean>((resolve) => {
    const probe = connect(path);
    probe.once("connect", () => {
      probe.destroy();
      resolve(true);
    });
    probe.once("error", () => resolve(false));
  });
  if (live) throw new Error("Operator API already running");
  unlinkSync(path);
}

export async function listenOperatorApi(options: OperatorApiOptions) {
  const { stateDirectory, store, scan } = options;
  const maxLine = integer(options.maxLineBytes ?? 64 * 1024, 1, 1024 * 1024);
  const pollMs = integer(options.pollMs ?? 1000, 1, 60_000);
  const directory = join(stateDirectory, "operator");
  const path = join(directory, "api.sock");
  if (
    !isAbsolute(path) ||
    path.includes("\0") ||
    Buffer.byteLength(path) >= (process.platform === "darwin" ? 104 : 108)
  )
    throw new Error("Invalid operator socket path");
  privatePath(stateDirectory, stateDirectory);
  privatePath(directory, stateDirectory, true);
  await removeStaleSocket(path);

  const clients = new Map<Socket, Client>();
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  const project = (includeResolved = false) =>
    projectInbox(options, { includeResolved });

  async function dispatch(method: string, params: unknown): Promise<Reply> {
    try {
      switch (method) {
        case "inbox.list": {
          const { includeResolved } = fields(params, ["includeResolved"]);
          if (
            includeResolved !== undefined &&
            typeof includeResolved !== "boolean"
          )
            throw new ContractError();
          return { result: project(includeResolved) };
        }
        case "inbox.markSeen": {
          const { ids } = fields(params, ["ids"]);
          if (!Array.isArray(ids) || ids.length > inboxLimit)
            throw new ContractError();
          const requested = new Set(ids.map(identifier));
          const known = project()
            .filter(({ id }) => requested.has(id))
            .map(({ id }) => id);
          store.markInboxSeen(known);
          return { result: { marked: known.length } };
        }
        case "status":
          fields(params, []);
          return { result: operatorStatus(store) };
        case "proposal.get": {
          const { id } = fields(params, ["id"]);
          const proposal = await operatorProposal(
            store,
            stateDirectory,
            identifier(id),
            scan,
          );
          return proposal ? { result: proposal } : failure("not-found");
        }
        case "inbox.subscribe":
          fields(params, []);
          return { result: { subscribed: true } };
        default:
          return failure("unknown-method");
      }
    } catch (error) {
      if (error instanceof ContractError) return failure("invalid-params");
      return failure(
        method === "inbox.markSeen" ? "write-failed" : "read-failed",
      );
    }
  }

  async function serve(socket: Socket, client: Client) {
    const line = Buffer.allocUnsafe(maxLine);
    let length = 0;
    let invalid = 0;
    for await (const chunk of socket as AsyncIterable<Buffer>) {
      let offset = 0;
      while (offset < chunk.length && !socket.destroyed) {
        const newline = chunk.indexOf(0x0a, offset);
        const end = newline < 0 ? chunk.length : newline;
        if (length + end - offset > maxLine) return;
        length += chunk.copy(line, length, offset, end);
        if (newline < 0) break;
        offset = newline + 1;
        let id: RequestId | null = null;
        let reply: Reply;
        let subscribedSnapshot: Client["subscribedSnapshot"];
        try {
          const message = fields(
            JSON.parse(decoder.decode(line.subarray(0, length))),
            ["id", "method", "params"],
          );
          id = requestId(message.id);
          if (
            typeof message.method !== "string" ||
            !Object.hasOwn(message, "params")
          )
            throw new ContractError();
          reply = await dispatch(message.method, message.params);
          if ("result" in reply) {
            try {
              if (message.method === "inbox.subscribe")
                subscribedSnapshot = inboxSnapshot(project(true));
              else if (message.method !== "inbox.markSeen")
                await scan?.(JSON.stringify(reply.result));
            } catch {
              reply = failure("read-failed");
            }
          }
        } catch {
          reply = failure("invalid-request");
          invalid++;
        }
        length = 0;
        await write(socket, { id, ...reply });
        if (subscribedSnapshot) client.subscribedSnapshot = subscribedSnapshot;
        if (invalid >= 3) return;
      }
    }
  }

  const server = createServer({ allowHalfOpen: true }, (socket) => {
    socket.on("error", () => {});
    if (clients.size >= maxClients) {
      socket.destroy();
      return;
    }
    const client: Client = {};
    clients.set(socket, client);
    socket.once("close", () => clients.delete(socket));
    void serve(socket, client)
      .catch(() => {})
      .finally(() => socket.destroy());
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });

  const identity = lstatSync(path, { throwIfNoEntry: false });
  function removeSocket() {
    const current = lstatSync(path, { throwIfNoEntry: false });
    if (
      identity &&
      current?.isSocket() &&
      current.ino === identity.ino &&
      current.dev === identity.dev
    )
      unlinkSync(path);
  }
  let timer: ReturnType<typeof setInterval> | undefined;
  let closing: Promise<void> | undefined;
  function close() {
    closing ??= new Promise<void>((resolve, reject) => {
      clearInterval(timer);
      for (const socket of clients.keys()) socket.destroy();
      server.close((error) => (error ? reject(error) : resolve()));
    }).finally(removeSocket);
    return closing;
  }
  server.on("error", () => void close().catch(() => {}));
  try {
    if (!identity?.isSocket()) throw new Error("Operator socket unavailable");
    chmodSync(path, 0o600);
    timer = setInterval(() => {
      if (
        ![...clients.values()].some(
          ({ subscribedSnapshot }) => subscribedSnapshot,
        )
      )
        return;
      let current: Map<string, string>;
      try {
        current = inboxSnapshot(project(true));
      } catch {
        return;
      }
      for (const [socket, client] of clients) {
        if (!client.subscribedSnapshot) continue;
        const ids = changedInboxIds(client.subscribedSnapshot, current);
        client.subscribedSnapshot = current;
        if (!ids.length) continue;
        if (socket.writableLength >= maxPendingBytes) socket.destroy();
        else
          void write(socket, {
            method: "inbox.changed",
            params: { ids },
          }).catch(() => socket.destroy());
      }
    }, pollMs);
    timer.unref();
    return { close };
  } catch (error) {
    await close();
    throw error;
  }
}
