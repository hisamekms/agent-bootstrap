import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createSocket } from "node:dgram";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { connect, createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import {
  SqliteAudit,
  type DnsQueryInput,
  type NetworkFinishedInput,
  type NetworkInput,
  type ResourceEventInput,
} from "../src/audit.ts";
import { encodeDnsTcpFrame } from "../src/dns-wire.ts";
import {
  EgressGateway,
  type EgressGatewayOptions,
} from "../src/egress-gateway.ts";
import {
  DnsPinTable,
  EgressPolicy,
  HOST_SERVICE_NAME,
  type IpPort,
} from "../src/egress-policy.ts";
import type { RuntimeEvent } from "../src/runtime-events.ts";
import { createTelemetry } from "../src/telemetry.ts";
import { ExportResultCode, type ExportResult } from "@opentelemetry/core";
import { InMemorySpanExporter } from "@opentelemetry/sdk-trace";
import {
  AggregationTemporality,
  InMemoryMetricExporter,
} from "@opentelemetry/sdk-metrics";

const loopback = "127.0.0.1";
const publicIp = "192.0.2.9";
const hostname = "allowed.example";
const pause = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

async function until(condition: () => boolean): Promise<void> {
  const deadline = performance.now() + 5000;
  while (!condition()) {
    assert.ok(
      performance.now() < deadline,
      "socket or audit event did not arrive",
    );
    await pause(5);
  }
}

class FakeAudit {
  isV5Writable = true;
  readonly decisions: NetworkInput[] = [];
  readonly outcomes: NetworkFinishedInput[] = [];
  readonly queries: DnsQueryInput[] = [];
  readonly resources: ResourceEventInput[] = [];
  decide?: () => void | Promise<void>;
  finish?: () => void | Promise<void>;
  dns?: () => void | Promise<void>;

  appendNetwork(input: NetworkInput) {
    this.decisions.push(input);
    return this.decide?.();
  }

  appendNetworkFinished(input: NetworkFinishedInput) {
    this.outcomes.push(input);
    return this.finish?.();
  }

  appendDnsQuery(input: DnsQueryInput) {
    this.queries.push(input);
    return this.dns?.();
  }

  appendResourceEvent(input: ResourceEventInput) {
    this.resources.push(input);
  }
}

async function gateway(
  t: TestContext,
  options: Partial<EgressGatewayOptions> = {},
) {
  const audit = new FakeAudit();
  const events: RuntimeEvent[] = [];
  const destinations: IpPort[] = [];
  const executionId = options.executionId ?? randomUUID();
  const sandboxLabel = options.sandboxLabel ?? `bootstrap-${randomUUID()}`;
  const proxy = await EgressGateway.open({
    executionId,
    sandboxLabel,
    audit,
    policy: new EgressPolicy({ allow: [{ hostname, port: 443 }] }),
    observer: { observe: (event) => events.push(event) },
    resolver: async () => [{ address: publicIp, ttl: 120 }],
    connect: (destination) => {
      destinations.push(destination);
      throw new Error("Unexpected fixture dial");
    },
    ...options,
  });
  t.after(() => proxy.close());
  return { proxy, audit, events, destinations, executionId, sandboxLabel };
}

class TcpClient {
  readonly socket: Socket;
  buffer = Buffer.alloc(0);
  closed = false;

  constructor(port: number) {
    this.socket = connect(port, loopback);
    this.socket.on("error", () => {});
    this.socket.on("data", (chunk) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
    });
    this.socket.once("close", () => {
      this.closed = true;
    });
  }

  async read(length: number): Promise<Buffer> {
    await until(() => this.closed || this.buffer.length >= length);
    assert.ok(
      this.buffer.length >= length,
      "socket closed before expected reply",
    );
    const value = this.buffer.subarray(0, length);
    this.buffer = this.buffer.subarray(length);
    return value;
  }
}

function socketClient(t: TestContext, port: number): TcpClient {
  const client = new TcpClient(port);
  t.after(() => {
    client.socket.destroy();
  });
  return client;
}

function credentials(username: string, password: string): Buffer {
  return Buffer.concat([
    Buffer.from([1, username.length]),
    Buffer.from(username),
    Buffer.from([password.length]),
    Buffer.from(password),
  ]);
}

async function authenticate(t: TestContext, proxy: EgressGateway) {
  const client = socketClient(t, proxy.socksPort);
  client.socket.write(Buffer.from([5, 2, 0, 2]));
  assert.deepEqual(await client.read(2), Buffer.from([5, 2]));
  client.socket.write(credentials(proxy.username, proxy.password));
  assert.deepEqual(await client.read(2), Buffer.from([1, 0]));
  return client;
}

function request(address: readonly number[], command = 1, port = 443): Buffer {
  return Buffer.from([
    5,
    command,
    0,
    address.length === 4 ? 1 : 4,
    ...address,
    port >>> 8,
    port & 255,
  ]);
}

const ipv4 = [192, 0, 2, 9];
const mapped = [...Array<number>(10).fill(0), 255, 255];
const nat64 = [0, 100, 255, 155, ...Array<number>(8).fill(0)];

function question(name: string, type = 1): Buffer {
  const header = Buffer.from([0x12, 0x34, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0]);
  return Buffer.concat([
    header,
    ...name
      .split(".")
      .map((label) => Buffer.from([label.length, ...Buffer.from(label)])),
    Buffer.from([0, type >>> 8, type & 255, 0, 1]),
  ]);
}

function dnsUdp(t: TestContext, proxy: EgressGateway, query: Buffer) {
  const socket = createSocket("udp4");
  const messages: Buffer[] = [];
  socket.on("message", (message) => messages.push(message));
  t.after(() => {
    socket.close();
  });
  socket.send(query, proxy.dnsPort, loopback);
  return {
    messages,
    read: async () => {
      await until(() => messages.length > 0);
      return messages[0]!;
    },
  };
}

async function echo(t: TestContext): Promise<number> {
  const clients = new Set<Socket>();
  const server = createServer({ allowHalfOpen: true }, (socket) => {
    clients.add(socket);
    socket.on("error", () => {});
    socket.once("close", () => clients.delete(socket));
    socket.on("data", (chunk) => socket.write(chunk));
    socket.on("end", () => socket.end());
  });
  server.listen(0, loopback);
  await once(server, "listening");
  t.after(() => {
    for (const client of clients) client.destroy();
    return new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return address.port;
}

const ipPolicy = () =>
  new EgressPolicy({ allow: [], allowIps: [{ ip: publicIp, port: 443 }] });
const failWrite = () => {
  throw new Error("Injected write failure");
};

test("canonicalizes mapped and NAT64 literals, denies unpinned and reserved IPs", async (t) => {
  const { proxy, audit, destinations } = await gateway(t, {
    policy: new EgressPolicy({
      allow: [{ hostname, port: 443 }],
      allowIps: [{ ip: "127.0.0.1", port: 443 }],
    }),
  });
  for (const [wireIp, canonical, reason] of [
    [ipv4, publicIp, "unpinned-ip"],
    [[...mapped, ...ipv4], publicIp, "unpinned-ip"],
    [[...nat64, ...ipv4], publicIp, "unpinned-ip"],
    [[...nat64, 127, 0, 0, 1], "127.0.0.1", "reserved-range"],
  ] as const) {
    const client = await authenticate(t, proxy);
    client.socket.write(request(wireIp));
    assert.equal((await client.read(10))[1], 2);
    assert.equal(audit.decisions.at(-1)?.destinationIp, canonical);
    assert.equal(audit.decisions.at(-1)?.reasonCode, reason);
  }
  assert.deepEqual(destinations, []);
});

test("requires method 2 and private credentials and refuses UDP, BIND and hostname requests", async (t) => {
  const { proxy, audit, destinations } = await gateway(t);
  assert.match(proxy.password, /^[0-9a-f]{64}$/);
  const noMethod = socketClient(t, proxy.socksPort);
  noMethod.socket.write(Buffer.from([5, 1, 0]));
  assert.deepEqual(await noMethod.read(2), Buffer.from([5, 255]));
  const invalid = socketClient(t, proxy.socksPort);
  invalid.socket.write(Buffer.from([5, 1, 2]));
  await invalid.read(2);
  invalid.socket.write(credentials(proxy.username, "wrong"));
  assert.deepEqual(await invalid.read(2), Buffer.from([1, 1]));
  for (const cmd of [2, 3]) {
    const client = await authenticate(t, proxy);
    client.socket.write(request(ipv4, cmd));
    assert.equal((await client.read(10))[1], 7);
  }
  const domain = await authenticate(t, proxy);
  domain.socket.write(
    Buffer.from([
      5,
      1,
      0,
      3,
      hostname.length,
      ...Buffer.from(hostname),
      1,
      187,
    ]),
  );
  assert.equal((await domain.read(10))[1], 2);
  assert.deepEqual(
    audit.decisions.map((row) => row.reasonCode),
    [
      "auth-failed",
      "auth-failed",
      "invalid-destination",
      "udp-refused",
      "invalid-destination",
    ],
  );
  assert.deepEqual(destinations, []);
  assert.ok(!JSON.stringify(audit.decisions).includes(proxy.username));
  assert.ok(!JSON.stringify(audit.decisions).includes(proxy.password));
});

test("waits for durable SOCKS decisions, relays pipelined data and counts bytes", async (t) => {
  const port = await echo(t);
  const hold = Promise.withResolvers<void>();
  const dials: IpPort[] = [];
  const { proxy, audit } = await gateway(t, {
    policy: ipPolicy(),
    connect: (destination) => {
      dials.push(destination);
      return connect({ host: loopback, port, allowHalfOpen: true });
    },
  });
  const payload = Buffer.from("pipelined data");
  const followup = Buffer.from(" and later data");
  const client = await authenticate(t, proxy);
  audit.decide = () => hold.promise;
  try {
    client.socket.write(Buffer.concat([request(ipv4), payload]));
    await until(() => audit.decisions.length === 1);
    client.socket.write(followup);
    await pause(25);
    assert.equal(client.buffer.length, 0);
    assert.deepEqual(dials, []);
  } finally {
    hold.resolve();
  }
  assert.equal((await client.read(10))[1], 0);
  assert.deepEqual(
    await client.read(payload.length + followup.length),
    Buffer.concat([payload, followup]),
  );
  client.socket.end();
  await until(() => audit.outcomes.length === 1);
  const outcome = audit.outcomes[0]!;
  assert.equal(outcome.result, "connected");
  assert.equal(outcome.endReason, "client-closed");
  assert.equal(outcome.bytesSent, payload.length + followup.length);
  assert.equal(outcome.bytesReceived, outcome.bytesSent);
  assert.equal(outcome.connectionId, audit.decisions[0]?.connectionId);
  assert.deepEqual(dials, [{ ip: publicIp, port: 443 }]);
});

test("a stalled telemetry exporter leaves gateway decision callbacks and replies responsive", async (t) => {
  let exportsStarted = 0;
  let ranInline = false;
  const release = Promise.withResolvers<void>();
  const decisions: RuntimeEvent[] = [];
  const telemetry = createTelemetry(
    {
      enabled: true,
      traceSamplingRatio: 1,
      resourceSamplingIntervalMs: 1000,
    },
    "/unused",
    {
      exporters: {
        logs: {
          export(_records, callback: (result: ExportResult) => void) {
            exportsStarted++;
            void release.promise.then(() =>
              callback({ code: ExportResultCode.SUCCESS }),
            );
          },
          async forceFlush() {},
          async shutdown() {},
        },
        traces: new InMemorySpanExporter(),
        metrics: new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE),
      },
    },
  );
  try {
    const { proxy, audit } = await gateway(t, {
      observer: {
        observe(event) {
          const before = exportsStarted;
          telemetry.observe(event);
          if (exportsStarted !== before) ranInline = true;
          if (event.eventType === "network.connect.decided")
            decisions.push(event);
        },
      },
    });
    const first = await authenticate(t, proxy);
    first.socket.write(request(ipv4));
    await until(() => exportsStarted > 0);
    assert.equal(decisions.length, 1);
    assert.equal((await first.read(10))[1], 2);

    const next = await authenticate(t, proxy);
    next.socket.write(request(ipv4));
    assert.equal((await next.read(10))[1], 2);
    assert.equal(decisions.length, 2);
    assert.equal(audit.decisions.length, 2);
    assert.equal(exportsStarted, 1);
    assert.equal(ranInline, false);
  } finally {
    release.resolve();
    await telemetry.shutdown();
  }
});

test("DNS UDP and TCP audit only allowed-type lookups and only publish durable pins", async (t) => {
  const hold = Promise.withResolvers<void>();
  const resolved: [string, number][] = [];
  const { proxy, audit, destinations } = await gateway(t, {
    resolver: async (name, type) => {
      resolved.push([name, type]);
      return [
        { address: type === 1 ? publicIp : "64:ff9b::c000:209", ttl: 31 },
      ];
    },
  });
  audit.dns = () => hold.promise;
  const udp = dnsUdp(t, proxy, question(hostname.toUpperCase()));
  try {
    await until(() => audit.queries.length === 1);
    const unpinned = await authenticate(t, proxy);
    unpinned.socket.write(request(ipv4));
    assert.equal((await unpinned.read(10))[1], 2);
    assert.equal(udp.messages.length, 0);
    assert.deepEqual(destinations, []);
  } finally {
    hold.resolve();
  }
  const allowedReply = await udp.read();
  assert.equal(allowedReply.readUInt16BE(6), 1);
  assert.deepEqual([...allowedReply.subarray(-4)], ipv4);

  const pinned = await authenticate(t, proxy);
  pinned.socket.write(request([...nat64, ...ipv4]));
  assert.equal((await pinned.read(10))[1], 5);
  assert.equal(audit.decisions.at(-1)?.hostname, hostname);
  assert.equal(audit.outcomes.at(-1)?.result, "connect-failed");
  assert.deepEqual(destinations, [{ ip: publicIp, port: 443 }]);

  const tcp = socketClient(t, proxy.dnsPort);
  const aaaa = encodeDnsTcpFrame(question(hostname, 28));
  tcp.socket.write(aaaa.subarray(0, 1));
  tcp.socket.write(
    Buffer.concat([
      aaaa.subarray(1),
      encodeDnsTcpFrame(question("denied.example")),
      encodeDnsTcpFrame(question(hostname, 16)),
    ]),
  );
  const readFrame = async () => tcp.read((await tcp.read(2)).readUInt16BE(0));
  assert.equal((await readFrame()).readUInt16BE(6), 1);
  assert.equal((await readFrame())[3]! & 15, 3);
  assert.equal((await readFrame())[3]! & 15, 3);
  assert.deepEqual(resolved, [
    [hostname, 1],
    [hostname, 28],
  ]);
  assert.deepEqual(
    audit.queries.map(({ protocol, qname, reasonCode, answerIps }) => [
      protocol,
      qname,
      reasonCode,
      answerIps,
    ]),
    [
      ["udp", hostname, "allowlisted-host", [publicIp]],
      ["tcp", hostname, "allowlisted-host", [publicIp]],
      ["tcp", "denied.example", "dns-not-allowlisted", []],
      ["tcp", hostname, "dns-type-refused", []],
    ],
  );
});

test("a write failure at either SOCKS audit phase quarantines active relays", async (t) => {
  const port = await echo(t);
  for (const phase of ["decide", "finish"] as const) {
    const { proxy, audit, events } = await gateway(t, {
      policy: ipPolicy(),
      connect: () => connect(port, loopback),
    });
    const active = await authenticate(t, proxy);
    active.socket.write(request(ipv4));
    assert.equal((await active.read(10))[1], 0);
    audit[phase] = failWrite;
    const trigger = await authenticate(t, proxy);
    trigger.socket.write(request(ipv4));
    if (phase === "decide") assert.equal((await trigger.read(10))[1], 1);
    else {
      assert.equal((await trigger.read(10))[1], 0);
      trigger.socket.end();
    }
    await until(() => proxy.quarantined && active.closed);
    assert.ok(audit.outcomes.some((row) => row.endReason === "audit-failure"));
    assert.ok(
      events.some(
        (event) =>
          event.eventType === "policy.evaluated" &&
          event.payload.reasonCode === "audit-failure",
      ),
    );
    const next = socketClient(t, proxy.socksPort);
    await until(() => next.closed);
    assert.equal(next.buffer.length, 0);
  }
});

test("records an upstream TCP refusal after the durable allow", async (t) => {
  const server = createServer();
  server.listen(0, loopback);
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  await new Promise<void>((resolve) => server.close(() => resolve()));
  const { proxy, audit } = await gateway(t, {
    policy: ipPolicy(),
    connect: () => connect(address.port, loopback),
  });
  const client = await authenticate(t, proxy);
  client.socket.write(request(ipv4));
  assert.equal((await client.read(10))[1], 5);
  assert.equal(audit.decisions[0]?.decision, "allow");
  assert.equal(audit.outcomes[0]?.result, "connect-failed");
});

test("DNS audit failure returns SERVFAIL and closes an active relay", async (t) => {
  const port = await echo(t);
  const { proxy, audit } = await gateway(t, {
    policy: new EgressPolicy({
      allow: [{ hostname, port: 443 }],
      allowIps: [{ ip: publicIp, port: 443 }],
    }),
    connect: () => connect(port, loopback),
  });
  const client = await authenticate(t, proxy);
  client.socket.write(request(ipv4));
  assert.equal((await client.read(10))[1], 0);
  audit.dns = failWrite;
  const udp = dnsUdp(t, proxy, question(hostname));
  const response = await udp.read();
  assert.equal(response[3]! & 15, 2);
  assert.equal(response.readUInt16BE(6), 0);
  await until(() => client.closed);
  assert.equal(proxy.quarantined, true);
  assert.equal(audit.outcomes[0]?.endReason, "audit-failure");
});

test("isolates credentials, DNS pins and audit attribution across concurrent gateways", async (t) => {
  const sharedAudit = new FakeAudit();
  const policy = new EgressPolicy({ allow: [{ hostname, port: 443 }] });
  const [first, second] = await Promise.all([
    gateway(t, { policy, audit: sharedAudit }),
    gateway(t, { policy, audit: sharedAudit }),
  ]);
  await dnsUdp(t, first.proxy, question(hostname)).read();
  assert.notEqual(first.proxy.password, second.proxy.password);
  const crossed = socketClient(t, second.proxy.socksPort);
  crossed.socket.write(
    Buffer.concat([
      Buffer.from([5, 1, 2]),
      credentials(first.proxy.username, first.proxy.password),
    ]),
  );
  assert.deepEqual(await crossed.read(4), Buffer.from([5, 2, 1, 1]));
  const clients = await Promise.all([
    authenticate(t, first.proxy),
    authenticate(t, second.proxy),
  ]);
  for (const client of clients) client.socket.write(request(ipv4));
  assert.deepEqual(
    await Promise.all(
      clients.map(async (client) => (await client.read(10))[1]),
    ),
    [5, 2],
  );
  for (const [instance, reason] of [
    [first, "allowlisted-host"],
    [second, "unpinned-ip"],
  ] as const) {
    const row = sharedAudit.decisions.find(
      (item) => item.reasonCode === reason,
    );
    assert.equal(row?.invocationId, instance.executionId);
    assert.equal(row?.sandboxId, instance.sandboxLabel);
  }
  assert.equal(sharedAudit.queries[0]?.sandboxId, first.sandboxLabel);
});

test("default dial uses the proven host-service mapping and the real SQLite schema", async (t) => {
  const port = await echo(t);
  const directory = mkdtempSync(join(tmpdir(), "bootstrap-egress-"));
  const audit = new SqliteAudit(join(directory, "audit.sqlite"));
  const executionId = randomUUID();
  audit.append({ invocationId: executionId, kind: "invocation.started" });
  try {
    const proxy = await EgressGateway.open({
      executionId,
      sandboxLabel: `bootstrap-${randomUUID()}`,
      audit,
      policy: new EgressPolicy({
        allow: [],
        hostServices: [
          {
            ip: publicIp,
            port: 443,
            hostname: HOST_SERVICE_NAME,
            loopbackPort: port,
          },
        ],
      }),
      resolver: async () => {
        throw new Error("Host service should resolve locally");
      },
    });
    try {
      await dnsUdp(t, proxy, question(HOST_SERVICE_NAME)).read();
      const client = await authenticate(t, proxy);
      client.socket.write(request(ipv4));
      assert.equal((await client.read(10))[1], 0);
      await proxy.close();
      const rows = audit.readExecution(executionId).networkEvents;
      assert.deepEqual(
        rows.map((row) => row.phase),
        ["dns", "requested", "decided", "finished"],
      );
      const decision = rows.find((row) => row.phase === "decided");
      assert.equal(decision?.channel, "host-service");
      assert.equal(decision?.hostname, HOST_SERVICE_NAME);
      const outcome = rows.find((row) => row.phase === "finished");
      assert.equal(outcome?.endReason, "sandbox-destroyed");
    } finally {
      await proxy.close();
    }
  } finally {
    audit.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("enforces handshake and relay limits and records idle timeout", async (t) => {
  const port = await echo(t);
  const { proxy, audit } = await gateway(t, {
    policy: ipPolicy(),
    connect: () => connect(port, loopback),
    limits: { idleTimeoutMs: 300, maxRelays: 1, maxPendingHandshakes: 1 },
  });
  const first = await authenticate(t, proxy);
  const extra = socketClient(t, proxy.socksPort);
  await until(() => extra.closed);
  assert.equal(proxy.refusalCounts.capacity, 1);
  first.socket.write(request(ipv4));
  assert.equal((await first.read(10))[1], 0);
  const over = await authenticate(t, proxy);
  over.socket.write(request(ipv4));
  assert.equal((await over.read(10))[1], 2);
  assert.equal(audit.decisions[1]?.reasonCode, "capacity");
  await until(() => over.closed);
  await until(() => first.closed && audit.outcomes.length === 1);
  assert.equal(audit.outcomes[0]?.result, "timeout");
  assert.equal(audit.outcomes[0]?.endReason, "idle-timeout");
});

test("a shared SQLite write failure stops relays in both gateways", async (t) => {
  const port = await echo(t);
  const directory = mkdtempSync(join(tmpdir(), "bootstrap-gateway-shared-"));
  const filename = join(directory, "audit.sqlite");
  const audit = new SqliteAudit(filename);
  t.after(() => {
    audit.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const clients: TcpClient[] = [];
  const proxies: EgressGateway[] = [];
  for (const _ of [0, 1]) {
    const { proxy } = await gateway(t, {
      audit,
      policy: ipPolicy(),
      connect: () => connect(port, loopback),
    });
    proxies.push(proxy);
    const client = await authenticate(t, proxy);
    client.socket.write(request(ipv4));
    assert.equal((await client.read(10))[1], 0);
    clients.push(client);
  }
  const { Database } = createRequire(import.meta.url)("bun:sqlite") as {
    Database: new (path: string) => { exec(sql: string): void; close(): void };
  };
  const fault = new Database(filename);
  try {
    fault.exec(
      "CREATE TRIGGER fail_decision BEFORE INSERT ON network_events WHEN NEW.phase = 'decided' BEGIN SELECT RAISE(ABORT, 'fixture'); END",
    );
  } finally {
    fault.close();
  }
  const trigger = await authenticate(t, proxies[0]!);
  trigger.socket.write(request(ipv4));
  assert.equal((await trigger.read(10))[1], 1);
  await until(() => clients.every((client) => client.closed));
  assert.deepEqual(
    proxies.map((proxy) => proxy.quarantineReason),
    ["audit-failure", "audit-failure"],
  );
});

test("DNS TCP reports an audit failure with SERVFAIL and closes", async (t) => {
  const { proxy, audit } = await gateway(t);
  audit.dns = failWrite;
  const client = socketClient(t, proxy.dnsPort);
  client.socket.write(encodeDnsTcpFrame(question(hostname)));
  const length = (await client.read(2)).readUInt16BE();
  const reply = await client.read(length);
  assert.equal(reply[3]! & 15, 2);
  assert.equal(reply.readUInt16BE(6), 0);
  await until(() => client.closed);
});

test("counts TCP clients disconnecting before their first decision", async (t) => {
  const { proxy } = await gateway(t);
  for (const port of [proxy.socksPort, proxy.dnsPort]) {
    const client = socketClient(t, port);
    await once(client.socket, "connect");
    client.socket.end();
    await until(() => client.closed);
  }
  assert.equal(proxy.refusalCounts["pre-decision-disconnect"], 2);
});

test("relay transfer checks writability even without a notification", async (t) => {
  const port = await echo(t);
  const { proxy, audit } = await gateway(t, {
    policy: ipPolicy(),
    connect: () => connect(port, loopback),
  });
  const client = await authenticate(t, proxy);
  client.socket.write(request(ipv4));
  assert.equal((await client.read(10))[1], 0);
  audit.isV5Writable = false;
  client.socket.write("must not be relayed");
  await until(() => client.closed && audit.outcomes.length === 1);
  assert.equal(audit.outcomes[0]?.endReason, "audit-failure");
  assert.equal(audit.outcomes[0]?.bytesSent, 0);
  assert.equal(client.buffer.length, 0);
});

test("SOCKS and DNS share one rate budget and log a single limit marker", async (t) => {
  const port = await echo(t);
  const { proxy, audit, events } = await gateway(t, {
    policy: ipPolicy(),
    connect: () => connect(port, loopback),
    limits: { attemptBurst: 2, attemptsPerSecond: 1 },
  });
  const client = await authenticate(t, proxy);
  client.socket.write(request(ipv4));
  assert.equal((await client.read(10))[1], 0);
  await dnsUdp(t, proxy, question("denied.example")).read();
  dnsUdp(t, proxy, question("denied.example"));
  await until(() => client.closed && audit.resources.length === 1);
  const refused = socketClient(t, proxy.socksPort);
  await until(() => refused.closed && proxy.refusalCounts.quarantined === 1);
  assert.equal(proxy.quarantineReason, "rate-limited");
  assert.equal(audit.queries.length, 1);
  assert.equal(audit.resources.length, 1);
  assert.ok(
    events.some(
      (event) =>
        event.eventType === "policy.evaluated" &&
        event.payload.reasonCode === "rate-limited",
    ),
  );
});

test("the row cap reserves an allowed relay's finish even during quarantine", async (t) => {
  const port = await echo(t);
  const { proxy, audit } = await gateway(t, {
    policy: ipPolicy(),
    connect: () => connect(port, loopback),
    limits: { maxNetworkRows: 4 },
  });
  const relay = await authenticate(t, proxy);
  relay.socket.write(request(ipv4));
  assert.equal((await relay.read(10))[1], 0);
  await dnsUdp(t, proxy, question("denied.example")).read();
  const over = await authenticate(t, proxy);
  over.socket.write(request(ipv4));
  await until(
    () => relay.closed && over.closed && audit.resources.length === 1,
  );
  assert.equal(proxy.quarantineReason, "network-row-limit");
  assert.equal(audit.decisions.length, 1);
  assert.equal(audit.queries.length, 1);
  assert.equal(audit.outcomes.length, 1);
});

test("counts DNS capacity, malformed names and TCP framing refusals", async (t) => {
  const hold = Promise.withResolvers<[]>();
  const resolving = Promise.withResolvers<void>();
  const { proxy, audit, events } = await gateway(t, {
    resolver: () => {
      resolving.resolve();
      return hold.promise;
    },
    limits: { maxPendingHandshakes: 1 },
  });
  const first = dnsUdp(t, proxy, question(hostname));
  try {
    await resolving.promise;
    const over = dnsUdp(t, proxy, question(hostname));
    await until(() => proxy.refusalCounts["dns-capacity"] === 1);
    assert.equal(over.messages.length, 0);
  } finally {
    hold.resolve([]);
  }
  await first.read();
  dnsUdp(t, proxy, question("bad_label.example"));
  dnsUdp(t, proxy, question("-bad.example"));
  await until(() => proxy.refusalCounts["dns-malformed"] === 2);
  const badFrame = socketClient(t, proxy.dnsPort);
  badFrame.socket.write(Buffer.from([0, 1]));
  await until(() => badFrame.closed);
  assert.equal(proxy.refusalCounts["dns-tcp-framing"], 1);
  assert.equal(audit.queries.length, 1);
  await proxy.close();
  assert.ok(
    events.some(
      (event) =>
        event.eventType === "policy.evaluated" &&
        event.payload.reasonCode === "dns-malformed" &&
        "refusalCount" in event.payload &&
        event.payload.refusalCount === 2,
    ),
  );
});

test("DNS TCP trickling cannot extend the frame deadline", async (t) => {
  const { proxy, audit } = await gateway(t, {
    limits: { handshakeTimeoutMs: 350 },
  });
  const client = socketClient(t, proxy.dnsPort);
  await once(client.socket, "connect");
  client.socket.write(Buffer.from([1, 0])); // A 256-byte frame.
  const trickle = setInterval(() => client.socket.write(Buffer.from([0])), 40);
  try {
    await until(() => client.closed);
  } finally {
    clearInterval(trickle);
  }
  assert.equal(proxy.refusalCounts["pre-decision-timeout"], 1);
  assert.equal(audit.queries.length, 0);
  assert.equal(client.buffer.length, 0);
});

test("close stops an in-flight dial decision and waits for the allowed outcome", async (t) => {
  const hold = Promise.withResolvers<void>();
  const { proxy, audit, destinations } = await gateway(t, {
    policy: ipPolicy(),
  });
  audit.decide = () => hold.promise;
  const client = await authenticate(t, proxy);
  client.socket.write(request(ipv4));
  let closed: Promise<void> | undefined;
  try {
    await until(() => audit.decisions.length === 1);
    closed = proxy.close();
    await until(() => client.closed);
    assert.equal(client.buffer.length, 0);
  } finally {
    hold.resolve();
  }
  await closed;
  assert.deepEqual(destinations, []);
  assert.equal(audit.outcomes[0]?.endReason, "sandbox-destroyed");
});

test("a DNS pin that expires while the decision is committing cannot authorize a dial", async (t) => {
  let now = 0;
  const policy = new EgressPolicy(
    { allow: [{ hostname, port: 443 }] },
    new DnsPinTable(() => now),
  );
  const { proxy, audit, destinations } = await gateway(t, { policy });
  await dnsUdp(t, proxy, question(hostname)).read();
  const client = await authenticate(t, proxy);
  const hold = Promise.withResolvers<void>();
  audit.decide = () => hold.promise;
  try {
    client.socket.write(request(ipv4));
    await until(() => audit.decisions.length === 1);
    assert.equal(audit.decisions[0]?.decision, "allow");
    now = 121_000;
  } finally {
    hold.resolve();
  }
  assert.equal((await client.read(10))[1], 2);
  assert.deepEqual(destinations, []);
  assert.equal(audit.outcomes[0]?.result, "refused");
});
