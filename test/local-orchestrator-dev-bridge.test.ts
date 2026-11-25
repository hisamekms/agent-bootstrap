import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import { request } from "node:http";
import { createServer } from "node:net";
import { join } from "node:path";
import { test } from "node:test";
import { createConciergeTerminalHub } from "../src/local-orchestrator/concierge-terminal.ts";
import { startDevBridge } from "../src/local-orchestrator/dev-bridge.ts";
import { listenOperatorApi } from "../src/local-orchestrator/operator-api.ts";
import { operatorStatus } from "../src/local-orchestrator/operator-read.ts";
import { loadWorkplaceAssets } from "../src/local-orchestrator/workplace-assets.ts";
import type { TerminalExit } from "../src/sandbox-runtime.ts";
import { orchestratorFixture } from "./local-orchestrator-fixture.ts";

const csp =
  "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; font-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

function assertSecurityHeaders(
  headers: import("node:http").IncomingHttpHeaders,
) {
  assert.equal(headers["content-security-policy"], csp);
  assert.equal(headers["x-content-type-options"], "nosniff");
  assert.equal(headers["referrer-policy"], "no-referrer");
  assert.equal(headers["cache-control"], "no-store");
  assert.equal(headers["set-cookie"], undefined);
}

async function http(
  url: URL,
  path: string,
  method: string,
  headers: Record<string, string> = {},
) {
  return new Promise<{
    status: number | undefined;
    headers: import("node:http").IncomingHttpHeaders;
    body: string;
  }>((resolve, reject) => {
    const client = request(new URL(path, url), { method, headers });
    client.on("response", (response) => {
      response.setEncoding("utf8");
      let body = "";
      response.on("data", (chunk: string) => {
        body += chunk;
      });
      response.on("error", reject);
      response.on("end", () =>
        resolve({
          status: response.statusCode,
          headers: response.headers,
          body,
        }),
      );
    });
    client.on("upgrade", (response, socket) => {
      socket.destroy();
      resolve({
        status: response.statusCode,
        headers: response.headers,
        body: "",
      });
    });
    client.on("error", reject);
    client.end();
  });
}

const websocketHeaders = {
  connection: "Upgrade",
  upgrade: "websocket",
  "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
  "sec-websocket-version": "13",
};

async function openWebSocket(url: URL) {
  const WebSocketClient = WebSocket as unknown as new (
    url: string,
    options: { headers: { origin: string } },
  ) => WebSocket;
  const ws = new WebSocketClient(`ws://${url.host}/ws`, {
    headers: { origin: url.origin },
  });
  const opened = Promise.withResolvers<void>();
  const closed = Promise.withResolvers<number>();
  const messages: unknown[] = [];
  let waiting: (() => void) | undefined;
  ws.addEventListener("open", () => opened.resolve(), { once: true });
  ws.addEventListener("error", () =>
    opened.reject(new Error("WebSocket failed")),
  );
  ws.addEventListener(
    "close",
    (event) => {
      opened.reject(new Error("WebSocket closed before opening"));
      closed.resolve(event.code);
      waiting?.();
    },
    { once: true },
  );
  ws.addEventListener("message", (event) => {
    messages.push(JSON.parse(event.data as string));
    waiting?.();
  });
  await opened.promise;
  return {
    ws,
    closed: closed.promise,
    authenticate: () => ws.send(JSON.stringify({ token: url.hash.slice(1) })),
    async next() {
      if (!messages.length && ws.readyState === WebSocket.OPEN)
        await new Promise<void>((resolve) => {
          waiting = resolve;
        });
      assert.ok(messages.length, "Expected a WebSocket message");
      return messages.shift();
    },
  };
}

test("workplace assets contain no remote URLs", async () => {
  const assets = await loadWorkplaceAssets();
  assert.ok(assets.has("/index.html"));
  for (const [path, asset] of assets)
    assert.doesNotMatch(new TextDecoder().decode(asset.body), /https?:/i, path);
});

test(
  "bridge checks Host and upgrade Origin and hardens HTTP responses",
  { timeout: 5000 },
  async () => {
    const bridge = startDevBridge({
      api: "/unused.sock",
      assets: await loadWorkplaceAssets(),
    });
    try {
      const url = new URL(bridge.url);
      assert.equal(url.protocol, "http:");
      assert.equal(url.hostname, "127.0.0.1");
      assert.equal(url.search, "");
      assert.match(url.hash, /^#[\da-f]{64}$/);

      for (const { response, status } of [
        { response: await http(url, "/", "GET"), status: 200 },
        { response: await http(url, "/index.html", "GET"), status: 200 },
        { response: await http(url, "/missing", "GET"), status: 404 },
        { response: await http(url, "/ws", "GET"), status: 404 },
        { response: await http(url, "/", "HEAD"), status: 405 },
        {
          response: await http(url, "/", "POST", { host: "localhost" }),
          status: 403,
        },
        {
          response: await http(url, "/ws", "GET", websocketHeaders),
          status: 403,
        },
        {
          response: await http(url, "/ws", "GET", {
            ...websocketHeaders,
            origin: "http://localhost",
          }),
          status: 403,
        },
        {
          response: await http(url, "/ws", "GET", {
            ...websocketHeaders,
            origin: url.origin,
            host: "localhost",
          }),
          status: 403,
        },
        {
          response: await http(url, "/ws", "GET", {
            connection: "Upgrade",
            upgrade: "websocket",
            origin: url.origin,
          }),
          status: 400,
        },
        {
          response: await http(url, "/ws", "GET", {
            ...websocketHeaders,
            origin: url.origin,
          }),
          status: 101,
        },
      ]) {
        assert.equal(response.status, status);
        assertSecurityHeaders(response.headers);
        if (status === 200) {
          assert.match(response.headers["content-type"] ?? "", /^text\/html/);
          assert.match(response.body, /<!doctype html>/i);
        }
      }
    } finally {
      await bridge.close();
    }
  },
);

test(
  "bridge limits unauthenticated upgrades and hardens the capacity response",
  { timeout: 5000 },
  async () => {
    const bridge = startDevBridge({ api: "/unused.sock", assets: new Map() });
    try {
      const url = new URL(bridge.url);
      const clients = await Promise.all(
        Array.from({ length: 16 }, () => openWebSocket(url)),
      );
      const response = await http(url, "/ws", "GET", {
        ...websocketHeaders,
        origin: url.origin,
      });
      assert.equal(response.status, 503);
      assertSecurityHeaders(response.headers);
      for (const client of clients) client.ws.close();
      await Promise.all(clients.map(({ closed }) => closed));
    } finally {
      await bridge.close();
    }
  },
);

test(
  "bridge rejects invalid first messages and times out clients without a token",
  { timeout: 9000 },
  async () => {
    const bridge = startDevBridge({ api: "/unused.sock", assets: new Map() });
    try {
      const url = new URL(bridge.url);
      const idle = await openWebSocket(url);
      const wrongToken = url.hash[1] === "a" ? "b" : "a";
      for (const first of [
        JSON.stringify({ token: wrongToken + url.hash.slice(2) }),
        JSON.stringify({ id: 1, method: "status", params: {} }),
        Buffer.from(JSON.stringify({ token: url.hash.slice(1) })),
      ]) {
        const client = await openWebSocket(url);
        client.ws.send(first);
        assert.equal(await client.closed, 1008);
      }
      assert.equal(await idle.closed, 1008);
    } finally {
      await bridge.close();
    }
  },
);

test(
  "bridge refuses methods locally without forwarding to the Unix socket",
  { timeout: 5000 },
  async () => {
    using fixture = orchestratorFixture("lo-bridge-", realpathSync("/tmp"));
    const api = join(fixture.root, "api.sock");
    const lines = Promise.withResolvers<string>();
    const server = createServer((socket) => {
      let received = "";
      socket.setEncoding("utf8");
      socket.on("data", (text: string) => {
        received += text;
        if (received.includes("\n")) lines.resolve(received);
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(api, resolve);
    });
    try {
      const bridge = startDevBridge({ api, assets: new Map() });
      try {
        const client = await openWebSocket(new URL(bridge.url));
        client.authenticate();
        client.ws.send(
          JSON.stringify({ id: "gate", method: "proposal.answer", params: {} }),
        );
        assert.deepEqual(await client.next(), {
          id: "gate",
          error: { code: "unknown-method" },
        });
        const allowed = { id: 2, method: "status", params: {} };
        client.ws.send(JSON.stringify(allowed, null, 2));
        assert.equal(await lines.promise, JSON.stringify(allowed) + "\n");
      } finally {
        await bridge.close();
      }
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  },
);

test(
  "bridge relays terminal traffic through the operator API and closes on binary input",
  { timeout: 5000 },
  async () => {
    using fixture = orchestratorFixture("lo-bridge-", realpathSync("/tmp"));
    const { root, store } = fixture;
    const terminal = createConciergeTerminalHub();
    const finished = Promise.withResolvers<TerminalExit>();
    const input: string[] = [];
    terminal.start({
      terminal: {
        write: (data) => input.push(Buffer.from(data).toString()),
        resize() {},
      },
      finished: finished.promise,
    });
    terminal.data(Buffer.from("initial"));
    const api = await listenOperatorApi({
      stateDirectory: root,
      store,
      target: "/fixture",
      terminal,
    });
    try {
      const bridge = startDevBridge({ api: api.path, assets: new Map() });
      try {
        const url = new URL(bridge.url);
        const client = await openWebSocket(url);
        client.authenticate();
        let id = 0;
        async function call(method: string, params: object = {}) {
          client.ws.send(JSON.stringify({ id: ++id, method, params }));
          return client.next();
        }

        assert.deepEqual(await call("status"), {
          id,
          result: operatorStatus(store),
        });
        assert.deepEqual(await call("concierge.attach"), {
          id,
          result: { replay: Buffer.from("initial").toString("base64") },
        });
        terminal.data(Buffer.from("live"));
        assert.deepEqual(await client.next(), {
          method: "concierge.output",
          params: { data: Buffer.from("live").toString("base64") },
        });
        assert.deepEqual(await call("concierge.input", { data: "eA==" }), {
          id,
          result: {},
        });
        assert.deepEqual(input, ["x"]);

        finished.resolve({ exitCode: 7 });
        assert.deepEqual(await client.next(), {
          method: "concierge.exit",
          params: { exitCode: 7 },
        });
        client.ws.send(new Uint8Array([0x78]));
        assert.equal(await client.closed, 1008);

        const reconnect = await openWebSocket(url);
        reconnect.authenticate();
        reconnect.ws.send(
          JSON.stringify({ id: 1, method: "status", params: {} }),
        );
        assert.deepEqual(await reconnect.next(), {
          id: 1,
          result: operatorStatus(store),
        });
        await api.close();
        await reconnect.closed;
      } finally {
        await bridge.close();
      }
    } finally {
      await api.close();
    }
  },
);
