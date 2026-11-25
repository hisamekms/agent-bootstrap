import { timingSafeEqual } from "node:crypto";
import { connect, type Socket } from "node:net";
import { boundedLines } from "../lines.ts";
import { fields, identifier } from "./model.ts";

const csp =
  "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; font-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
const headers = {
  "Content-Security-Policy": csp,
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Cache-Control": "no-store",
};
const methods = new Set([
  "inbox.list",
  "inbox.markSeen",
  "inbox.subscribe",
  "status",
  "proposal.get",
  "concierge.attach",
  "concierge.input",
  "concierge.resize",
]);
const messageLimit = 64 * 1024;
const pendingLimit = 1024 * 1024;
const authTimeoutMs = 5000;
const address = "127.0.0.1";

type Client = {
  timer?: ReturnType<typeof setTimeout>;
  socket?: Socket;
  rejected?: boolean;
};
type Asset = { contentType: string; body: Uint8Array };
type WebSocket = {
  data: Client;
  sendText(message: string): number;
  close(code?: number): void;
};
type Server = {
  port: number;
  pendingWebSockets: number;
  upgrade(
    request: Request,
    options: { data: Client; headers: HeadersInit },
  ): boolean;
  stop(force: boolean): Promise<void>;
};
declare const Bun: {
  serve(options: {
    hostname: string;
    port: number;
    development: boolean;
    fetch(request: Request, server: Server): Response | undefined;
    websocket: {
      maxPayloadLength: number;
      backpressureLimit: number;
      closeOnBackpressureLimit: boolean;
      idleTimeout: number;
      open(ws: WebSocket): void;
      message(ws: WebSocket, message: string | Buffer): void;
      close(ws: WebSocket): void;
    };
  }): Server;
};

export function startDevBridge(options: {
  api: string;
  assets: ReadonlyMap<string, Asset>;
}) {
  const token = Buffer.from(
    crypto.getRandomValues(new Uint8Array(32)),
  ).toString("hex");
  const expected = Buffer.from(token);
  const connections = new Set<Socket>();

  function authenticate(message: string) {
    try {
      const { token } = fields(JSON.parse(message), ["token"]);
      if (typeof token !== "string") return false;
      const supplied = Buffer.from(token);
      return (
        supplied.length === expected.length &&
        timingSafeEqual(supplied, expected)
      );
    } catch {
      return false;
    }
  }

  async function sendLines(ws: WebSocket, socket: Socket) {
    for await (const line of boundedLines(socket, pendingLimit)) {
      if (ws.sendText(line) === 0) return;
    }
  }

  function relay(ws: WebSocket) {
    const socket = connect(options.api);
    socket.on("error", () => socket.destroy());
    socket.once("close", () => {
      connections.delete(socket);
      ws.close();
    });
    void sendLines(ws, socket)
      .catch(() => {})
      .finally(() => socket.destroy());
    return socket;
  }

  function reject(ws: WebSocket, code: number) {
    ws.data.rejected = true;
    ws.close(code);
  }

  const server = Bun.serve({
    hostname: address,
    port: 0,
    development: false,
    fetch(request, server) {
      const host = `${address}:${server.port}`;
      if (request.headers.get("host") !== host)
        return new Response(null, { status: 403, headers });
      const { pathname } = new URL(request.url);
      const upgrade =
        pathname === "/ws" &&
        request.headers.get("upgrade")?.toLowerCase() === "websocket";
      if (upgrade && request.headers.get("origin") !== `http://${host}`)
        return new Response(null, { status: 403, headers });
      if (request.method !== "GET")
        return new Response(null, { status: 405, headers });
      if (upgrade) {
        if (server.pendingWebSockets >= 16)
          return new Response(null, { status: 503, headers });
        if (server.upgrade(request, { data: {}, headers })) return;
        return new Response(null, { status: 400, headers });
      }
      const asset = options.assets.get(
        pathname === "/" ? "/index.html" : pathname,
      );
      if (!asset) return new Response(null, { status: 404, headers });
      return new Response(Buffer.from(asset.body), {
        headers: { ...headers, "Content-Type": asset.contentType },
      });
    },
    websocket: {
      maxPayloadLength: messageLimit,
      backpressureLimit: pendingLimit,
      closeOnBackpressureLimit: true,
      idleTimeout: 0,
      open(ws) {
        ws.data.timer = setTimeout(() => reject(ws, 1008), authTimeoutMs);
      },
      message(ws, message) {
        if (ws.data.rejected) return;
        if (typeof message !== "string") {
          reject(ws, 1008);
          return;
        }
        if (Buffer.byteLength(message) > messageLimit) {
          reject(ws, ws.data.socket ? 1009 : 1008);
          return;
        }
        if (!ws.data.socket) {
          if (connections.size >= 4 || !authenticate(message)) {
            reject(ws, 1008);
            return;
          }
          clearTimeout(ws.data.timer);
          ws.data.socket = relay(ws);
          connections.add(ws.data.socket);
          return;
        }

        let id: string | number;
        let line: string;
        try {
          const request = fields(JSON.parse(message), [
            "id",
            "method",
            "params",
          ]);
          id =
            typeof request.id === "number" && Number.isSafeInteger(request.id)
              ? request.id
              : identifier(request.id);
          if (
            typeof request.method !== "string" ||
            !Object.hasOwn(request, "params")
          )
            throw new Error();
          if (!methods.has(request.method)) {
            ws.sendText(
              JSON.stringify({ id, error: { code: "unknown-method" } }),
            );
            return;
          }
          // Re-encode to keep each WebSocket message on exactly one API line.
          line = JSON.stringify({
            id,
            method: request.method,
            params: request.params,
          });
        } catch {
          ws.sendText(
            JSON.stringify({ id: null, error: { code: "invalid-request" } }),
          );
          return;
        }
        const bytes = Buffer.byteLength(line);
        const socket = ws.data.socket;
        if (
          bytes > messageLimit ||
          socket.writableLength + bytes + 1 > pendingLimit
        ) {
          reject(ws, 1009);
          return;
        }
        socket.write(line + "\n");
      },
      close(ws) {
        clearTimeout(ws.data.timer);
        ws.data.socket?.destroy();
      },
    },
  });

  let closing: Promise<void> | undefined;
  return {
    url: `http://${address}:${server.port}/#${token}`,
    close() {
      if (!closing) {
        closing = server.stop(true);
        for (const socket of connections) socket.destroy();
      }
      return closing;
    },
  };
}
