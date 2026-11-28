import { randomBytes, timingSafeEqual } from "node:crypto";
import { operatorBridgeMethods } from "../../src/local-orchestrator/dev-bridge.ts";
import {
  ContractError,
  fields,
  identifier,
} from "../../src/local-orchestrator/model.ts";
import { loadWorkplaceAssets } from "../../src/operator-ui/assets.ts";
import { workplaceEndedCode } from "../../src/operator-ui/session-end.ts";
import type { Methods, Push } from "../../src/operator-ui/web/protocol.ts";
import { createPreviewMethods, PreviewError } from "./preview-fixtures.ts";

const address = "127.0.0.1";
const headers = {
  // Match the development bridge's asset and WebSocket security headers.
  "Content-Security-Policy":
    "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; font-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Cache-Control": "no-store",
};

type Client = {
  authenticated?: true;
  authTimer?: ReturnType<typeof setTimeout>;
  inbox?: true;
  activity?: true;
};

type Browser = {
  data: Client;
  sendText(message: string): number;
  close(code?: number): void;
};

type PreviewServer = {
  port: number;
  upgrade(
    request: Request,
    options: { data: Client; headers: HeadersInit },
  ): boolean;
  stop(force?: boolean): Promise<void>;
};

declare const Bun: {
  serve(options: {
    hostname: string;
    port: number;
    development: boolean;
    error(): Response;
    fetch(request: Request, server: PreviewServer): Response | undefined;
    websocket: {
      maxPayloadLength: number;
      backpressureLimit: number;
      closeOnBackpressureLimit: boolean;
      idleTimeout: number;
      open(ws: Browser): void;
      message(ws: Browser, message: string | Buffer): void;
      close(ws: Browser): void;
    };
  }): PreviewServer;
};

export async function startWorkplacePreview(port = 0) {
  const assets = await loadWorkplaceAssets();
  const token = randomBytes(32).toString("hex");
  const expected = Buffer.from(token);
  const clients = new Set<Browser>();
  let closing: Promise<void> | undefined;

  function send(ws: Browser, message: unknown) {
    ws.sendText(JSON.stringify(message));
  }

  function publish(push: Push) {
    for (const ws of clients) {
      if (
        (push.method === "inbox.changed" && ws.data.inbox) ||
        (push.method === "activity.changed" && ws.data.activity)
      )
        send(ws, push);
    }
  }

  const methods = createPreviewMethods(publish, () => {
    // Send the stop receipt before closing authenticated connections.
    setTimeout(() => {
      for (const ws of clients)
        ws.close(ws.data.authenticated ? workplaceEndedCode : 1001);
      closing ??= server.stop();
    }, 0);
  });

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

  function dispatch<M extends keyof Methods>(
    method: M,
    params: object,
  ): Methods[M]["result"] {
    return methods[method](params as Methods[M]["params"]);
  }

  const server = Bun.serve({
    hostname: address,
    port,
    development: false,
    error: () => new Response(null, { status: 500, headers }),
    fetch(request, server) {
      const host = server.port === 80 ? address : `${address}:${server.port}`;
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
        if (server.upgrade(request, { data: {}, headers })) return;
        return new Response(null, { status: 400, headers });
      }
      const asset = assets.get(pathname === "/" ? "/index.html" : pathname);
      return asset
        ? new Response(Buffer.from(asset.body), {
            headers: { ...headers, "Content-Type": asset.contentType },
          })
        : new Response(null, { status: 404, headers });
    },
    websocket: {
      maxPayloadLength: 64 * 1024,
      backpressureLimit: 1024 * 1024,
      closeOnBackpressureLimit: true,
      idleTimeout: 0,
      open(ws) {
        clients.add(ws);
        ws.data.authTimer = setTimeout(() => ws.close(1008), 5000);
      },
      message(ws, message) {
        if (typeof message !== "string") {
          ws.close(1008);
          return;
        }
        if (!ws.data.authenticated) {
          if (!authenticate(message)) {
            ws.close(1008);
            return;
          }
          clearTimeout(ws.data.authTimer);
          ws.data.authenticated = true;
          return;
        }

        let id: string | number;
        let method: string;
        let params: unknown;
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
            throw new ContractError();
          method = request.method;
          params = request.params;
        } catch {
          send(ws, { id: null, error: { code: "invalid-request" } });
          return;
        }
        if (
          !operatorBridgeMethods.has(method) ||
          !Object.hasOwn(methods, method)
        ) {
          send(ws, { id, error: { code: "unknown-method" } });
          return;
        }
        try {
          if (!params || typeof params !== "object" || Array.isArray(params))
            throw new ContractError();
          const result = dispatch(method as keyof Methods, params);
          if (method === "inbox.subscribe") ws.data.inbox = true;
          if (method === "activity.subscribe") ws.data.activity = true;
          send(ws, { id, result });
        } catch (error) {
          const code =
            error instanceof PreviewError
              ? error.code
              : error instanceof ContractError || error instanceof TypeError
                ? "invalid-params"
                : "write-failed";
          send(ws, { id, error: { code } });
        }
      },
      close(ws) {
        clients.delete(ws);
        clearTimeout(ws.data.authTimer);
      },
    },
  });

  return {
    url: `http://${address}:${server.port}/#${token}`,
    close: () => (closing ??= server.stop(true)),
  };
}

if ((import.meta as ImportMeta & { main?: boolean }).main) {
  const args = process.argv.slice(2);
  const portText = args[1] ?? "";
  if (
    args.length &&
    (args.length !== 2 ||
      args[0] !== "--port" ||
      !/^\d{1,5}$/.test(portText) ||
      Number(portText) > 65535)
  ) {
    console.error("Usage: bun spike/operator-ui/preview.ts [--port <n>]");
    process.exitCode = 2;
  } else {
    const preview = await startWorkplacePreview(Number(portText));
    console.log(preview.url);
  }
}
