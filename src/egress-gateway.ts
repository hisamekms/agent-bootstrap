import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createSocket, type RemoteInfo } from "node:dgram";
import { Resolver } from "node:dns/promises";
import {
  connect as netConnect,
  createServer,
  isIP,
  type Server,
  type Socket,
} from "node:net";
import type {
  DnsQueryInput,
  NetworkFinishedInput,
  NetworkInput,
} from "./audit.ts";
import {
  DNS_MAX_MESSAGE_BYTES,
  DNS_UDP_REPLY_BYTES,
  DnsTcpFrameReader,
  encodeDnsResponse,
  encodeDnsTcpFrame,
  parseDnsQuestion,
  type DnsQuestion,
  type DnsResponse,
} from "./dns-wire.ts";
import {
  canonicalizeIp,
  type EgressPolicy,
  type IpPort,
} from "./egress-policy.ts";
import {
  SequenceSource,
  type RuntimeEvent,
  type RuntimeEventPayloads,
  type RuntimeEventType,
  type RuntimeObserver,
} from "./runtime-events.ts";
import {
  encodeSocks5AuthReply,
  encodeSocks5Method,
  encodeSocks5Reply,
  Socks5HandshakeReader,
  type Socks5Request,
} from "./socks5.ts";

const LOOPBACK = "127.0.0.1";
const DNS_TIMEOUT_MS = 5000;
const MAX_EARLY_DATA_BYTES = 65536;
const MAX_ANSWER_TTL = 300;
type EndReason = NetworkFinishedInput["endReason"];
type Result = NetworkFinishedInput["result"];
interface AuditSink {
  appendNetwork(input: NetworkInput): void | Promise<void>;
  appendNetworkFinished(input: NetworkFinishedInput): void | Promise<void>;
  appendDnsQuery(input: DnsQueryInput): void | Promise<void>;
}

export interface ResolvedAddress {
  readonly address: string;
  readonly ttl: number;
}

export interface EgressGatewayOptions {
  readonly executionId: string;
  readonly sandboxLabel: string;
  readonly policy: EgressPolicy;
  readonly audit: AuditSink;
  readonly observer?: RuntimeObserver;
  readonly resolver?: (
    hostname: string,
    qtype: 1 | 28,
  ) => Promise<readonly ResolvedAddress[]>;
  /** Return a connecting or connected TCP socket for the authorized literal. */
  readonly connect?: (destination: IpPort) => Socket;
  readonly limits?: {
    readonly maxRelays?: number;
    readonly maxPendingHandshakes?: number;
    readonly idleTimeoutMs?: number;
    readonly handshakeTimeoutMs?: number;
  };
}

function positiveLimit(value: number): number {
  if (!Number.isInteger(value) || value <= 0 || value > 0x7fffffff)
    throw new RangeError("Invalid egress gateway limit");
  return value;
}

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, LOOPBACK, () => {
      server.off("error", reject);
      const address = server.address();
      if (address && typeof address !== "string") resolve(address.port);
      else reject(new Error("Missing gateway listener address"));
    });
  });
}

function credentialMatches(actual: Uint8Array, expected: Buffer): boolean {
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function encodeSocks5Failure(
  stage: "greeting" | "auth" | "request",
): Uint8Array {
  if (stage === "greeting") return encodeSocks5Method(false);
  if (stage === "auth") return encodeSocks5AuthReply(false);
  return encodeSocks5Reply(1);
}

function sendDnsTcp(socket: Socket, reply: Uint8Array): Promise<boolean> {
  return new Promise((resolve) => {
    const closed = () => resolve(false);
    socket.once("close", closed);
    socket.write(encodeDnsTcpFrame(reply), (error) => {
      socket.off("close", closed);
      resolve(!error);
    });
  });
}

export class EgressGateway {
  readonly username = randomUUID();
  readonly #username = Buffer.from(this.username);
  readonly #password = Buffer.from(randomBytes(32).toString("hex"));
  readonly #pinScope = randomUUID();
  readonly #source = new SequenceSource("egress-gateway");
  readonly #options: EgressGatewayOptions;
  readonly #identity: Pick<NetworkInput, "invocationId" | "sandboxId">;
  readonly #maxRelays: number;
  readonly #maxPending: number;
  readonly #idleMs: number;
  readonly #handshakeMs: number;
  readonly #resolver: NonNullable<EgressGatewayOptions["resolver"]>;
  readonly #defaultResolver: Resolver | undefined;
  readonly #connect: NonNullable<EgressGatewayOptions["connect"]>;

  readonly #socks = createServer({ allowHalfOpen: true }, (socket) =>
    this.#acceptSocks(socket),
  );
  readonly #dnsTcp = createServer((socket) => this.#acceptDnsTcp(socket));
  readonly #dnsUdp = createSocket("udp4");
  readonly #flows = new Set<(reason: EndReason) => void>();
  readonly #dnsClients = new Set<Socket>();
  readonly #socksClients = new Set<Socket>();
  readonly #auditWork = new Set<Promise<unknown>>();
  #dnsQueries = 0;
  #pending = 0;
  #relays = 0;
  #quarantined = false;
  #ready = false;
  #closing: Promise<void> | undefined;
  #socksPort = 0;
  #dnsPort = 0;

  private constructor(options: EgressGatewayOptions) {
    this.#options = options;
    this.#identity = {
      invocationId: options.executionId,
      sandboxId: options.sandboxLabel,
    };
    this.#maxRelays = positiveLimit(options.limits?.maxRelays ?? 64);
    this.#maxPending = positiveLimit(
      options.limits?.maxPendingHandshakes ?? 64,
    );
    this.#idleMs = positiveLimit(options.limits?.idleTimeoutMs ?? 60_000);
    this.#handshakeMs = positiveLimit(
      options.limits?.handshakeTimeoutMs ?? 10_000,
    );
    if (options.resolver) this.#resolver = options.resolver;
    else {
      const resolver = new Resolver({ timeout: DNS_TIMEOUT_MS, tries: 1 });
      this.#defaultResolver = resolver;
      this.#resolver = (hostname, qtype) =>
        qtype === 1
          ? resolver.resolve4(hostname + ".", { ttl: true })
          : resolver.resolve6(hostname + ".", { ttl: true });
    }
    this.#connect =
      options.connect ??
      (({ ip, port }) => netConnect({ host: ip, port, allowHalfOpen: true }));
  }

  static async open(options: EgressGatewayOptions): Promise<EgressGateway> {
    const gateway = new EgressGateway(options);
    try {
      gateway.#socksPort = await listen(gateway.#socks);
      gateway.#dnsPort = await listen(gateway.#dnsTcp);
      await new Promise<void>((resolve, reject) => {
        const socket = gateway.#dnsUdp;
        socket.once("error", reject);
        socket.bind(gateway.#dnsPort, LOOPBACK, () => {
          socket.off("error", reject);
          resolve();
        });
      });
      for (const listener of [gateway.#socks, gateway.#dnsTcp, gateway.#dnsUdp])
        listener.on("error", () => {
          void gateway.close();
        });
      gateway.#dnsUdp.on("message", (message, remote) =>
        gateway.#acceptDnsUdp(message, remote),
      );
      gateway.#ready = true;
      return gateway;
    } catch (error) {
      await gateway.close();
      throw error;
    }
  }

  get socksPort(): number {
    return this.#socksPort;
  }

  get dnsPort(): number {
    return this.#dnsPort;
  }

  get password(): string {
    return this.#password.toString("ascii");
  }

  get quarantined(): boolean {
    return this.#quarantined;
  }

  #observe<K extends RuntimeEventType>(
    eventType: K,
    payload: RuntimeEventPayloads[K],
  ): void {
    if (!this.#options.observer) return;
    try {
      const timestamp = new Date().toISOString();
      this.#options.observer.observe({
        eventId: randomUUID(),
        eventType,
        schemaVersion: 1,
        occurredAt: timestamp,
        recordedAt: timestamp,
        source: this.#source.next(),
        executionId: this.#identity.invocationId,
        sandboxId: this.#identity.sandboxId,
        payload,
      } as RuntimeEvent);
    } catch {
      // Observers do not participate in authorization.
    }
  }

  #audit<T>(write: () => T | Promise<T>): Promise<T> {
    // Register before invoking the sink so shutdown can drain reentrant writes.
    const work = Promise.resolve().then(write);
    this.#auditWork.add(work);
    const remove = () => this.#auditWork.delete(work);
    void work.then(remove, remove);
    return work;
  }

  #quarantine(): void {
    if (this.#quarantined) return;
    this.#quarantined = true;
    this.#options.policy.dnsPins.clear(this.#pinScope);
    this.#defaultResolver?.cancel();
    for (const stop of this.#flows) stop("audit-failure");
    this.#observe("policy.evaluated", {
      policyId: this.#options.policy.policyId,
      decision: "deny",
      reasonCode: "audit-failure",
    });
  }

  #acceptSocks(client: Socket): void {
    if (
      !this.#ready ||
      this.#quarantined ||
      this.#closing ||
      this.#pending >= this.#maxPending ||
      this.#socksClients.size >= this.#maxPending + this.#maxRelays
    ) {
      client.destroy();
      return;
    }

    this.#pending++;
    this.#socksClients.add(client);
    const reader = new Socks5HandshakeReader();
    const identity = { ...this.#identity, connectionId: randomUUID() };
    const started = performance.now();
    let stage: "greeting" | "auth" | "request" = "greeting";
    let upstream: Socket | undefined;
    let slot: "pending" | "relay" | undefined = "pending";
    let outcome:
      | Pick<NetworkFinishedInput, "result" | "endReason" | "durationMs">
      | undefined;
    let firstEnd: EndReason | undefined;
    let allowed = false;
    let decisionPending = false;
    let recorded = false;
    let connected = false;
    let bytesSent = 0;
    let bytesReceived = 0;

    const recordOutcome = () => {
      if (!outcome || decisionPending || recorded) return;
      recorded = true;
      if (!allowed) {
        releaseSlot();
        return;
      }
      const result = {
        ...outcome,
        bytesSent,
        bytesReceived,
      };
      void this.#audit(() =>
        this.#options.audit.appendNetworkFinished({ ...identity, ...result }),
      ).then(
        () => {
          releaseSlot();
          this.#observe("network.connect.finished", {
            connectionId: identity.connectionId,
            ...result,
          });
        },
        () => {
          releaseSlot();
          this.#quarantine();
        },
      );
    };

    const releaseSlot = () => {
      if (slot === "pending") this.#pending--;
      if (slot === "relay") this.#relays--;
      slot = undefined;
    };

    const stop = (
      endReason: EndReason,
      reply?: Uint8Array,
      result?: Result,
    ) => {
      if (outcome) return;
      outcome = {
        endReason,
        result: result ?? (connected ? "connected" : "refused"),
        durationMs: performance.now() - started,
      };
      this.#flows.delete(endFlow);
      reader.close();
      clearTimeout(timer);
      client.removeListener("data", handshake);
      upstream?.destroy();
      if (reply && !client.destroyed) {
        client.setTimeout(this.#handshakeMs, () => client.destroy());
        client.end(reply, () => client.destroy());
      } else client.destroy();
      recordOutcome();
    };

    const endFlow = (reason: EndReason) => stop(reason);
    this.#flows.add(endFlow);
    const timeout = () =>
      stop(
        "idle-timeout",
        !decisionPending && !connected && stage === "request"
          ? encodeSocks5Reply(1)
          : undefined,
        "timeout",
      );
    let timer = setTimeout(timeout, this.#handshakeMs);
    const touch = () => {
      clearTimeout(timer);
      timer = setTimeout(timeout, this.#idleMs);
    };

    const relay = (socket: Socket, earlyData: Uint8Array) => {
      connected = true;
      touch();
      const transfer = (source: Socket, target: Socket, chunk: Uint8Array) => {
        if (
          outcome ||
          this.#closing ||
          target.destroyed ||
          target.writableEnded
        )
          return;
        if (source === client) bytesSent += chunk.length;
        else bytesReceived += chunk.length;
        touch();
        if (!target.write(chunk)) source.pause();
      };
      const forwardEnd = (target: Socket, reason: EndReason) => {
        firstEnd ??= reason;
        target.end();
      };
      client.on("drain", () => socket.resume());
      socket.on("drain", () => client.resume());
      client.on("data", (chunk: Buffer) => transfer(client, socket, chunk));
      socket.on("data", (chunk: Buffer) => transfer(socket, client, chunk));
      socket.on("end", () => forwardEnd(client, "upstream-closed"));
      client.on("end", () => forwardEnd(socket, "client-closed"));
      client.write(encodeSocks5Reply(0));
      if (earlyData.length) transfer(client, socket, earlyData);
      if (client.readableEnded) forwardEnd(socket, "client-closed");
      if (!socket.writableNeedDrain) client.resume();
    };

    const dial = (destination: IpPort, earlyData: Uint8Array) => {
      const failed = () =>
        stop("error", encodeSocks5Reply(5), "connect-failed");
      try {
        const socket = this.#connect(destination);
        upstream = socket;
        socket.on("error", () => (connected ? stop("error") : failed()));
        socket.on("close", () => {
          if (outcome) return;
          if (connected) stop(firstEnd ?? "upstream-closed");
          else failed();
        });
        if (outcome) socket.destroy();
        else if (socket.destroyed) failed();
        else if (socket.connecting || !socket.remoteAddress)
          socket.once("connect", () => {
            if (!outcome) relay(socket, earlyData);
          });
        else relay(socket, earlyData);
      } catch {
        failed();
      }
    };

    const decide = async (
      decision: Pick<NetworkInput, "decision" | "reasonCode">,
      target: Pick<
        NetworkInput,
        "destinationIp" | "destinationPort" | "channel" | "hostname"
      >,
      reply: Uint8Array,
      destination?: IpPort,
      earlyData: Uint8Array = new Uint8Array(),
    ) => {
      client.pause();
      client.removeListener("data", handshake);
      reader.close();
      decisionPending = true;
      const policyId = this.#options.policy.policyId;
      try {
        await this.#audit(() =>
          this.#options.audit.appendNetwork({
            ...identity,
            ...target,
            decision: decision.decision,
            reasonCode: decision.reasonCode,
            policyId,
          }),
        );
      } catch {
        decisionPending = false;
        // Queue this refusal before closing the other flows.
        stop("audit-failure", encodeSocks5Failure(stage));
        recordOutcome();
        this.#quarantine();
        return;
      }

      decisionPending = false;
      allowed = decision.decision === "allow";
      const eventTarget =
        target.destinationIp === undefined
          ? {}
          : {
              ...target,
              channel:
                target.channel === "egress"
                  ? ("direct" as const)
                  : target.channel,
            };
      const eventConnection = {
        connectionId: identity.connectionId,
        protocol: "tcp" as const,
        ...eventTarget,
      };
      this.#observe("network.connect.requested", eventConnection);
      this.#observe("network.connect.decided", {
        ...eventConnection,
        decision: decision.decision,
        reasonCode: decision.reasonCode,
        policyId,
      } as RuntimeEventPayloads["network.connect.decided"]);
      if (this.#closing && !outcome) stop("sandbox-destroyed");
      if (outcome) recordOutcome();
      else if (allowed && destination) {
        // An asynchronous audit may outlive the DNS authorization it records.
        const current = this.#options.policy.decideConnect({
          ip: target.destinationIp ?? "",
          port: target.destinationPort ?? 0,
          sandbox: this.#pinScope,
        });
        if (
          current.decision === "allow" &&
          current.channel === target.channel &&
          current.hostname === target.hostname &&
          current.upstream.ip === destination.ip &&
          current.upstream.port === destination.port
        )
          dial(destination, earlyData);
        else stop("error", encodeSocks5Reply(2));
      } else stop("client-closed", reply);
    };

    const request = (message: Socks5Request, earlyData: Uint8Array) => {
      const ip =
        "ip" in message.destination
          ? canonicalizeIp(message.destination.ip)
          : undefined;
      const target =
        ip && message.port > 0
          ? {
              destinationIp: ip,
              destinationPort: message.port,
              channel: "egress" as const,
            }
          : {};
      if (
        message.command !== 1 ||
        !ip ||
        earlyData.length > MAX_EARLY_DATA_BYTES ||
        this.#relays >= this.#maxRelays
      ) {
        const reasonCode =
          message.command === 3 ? "udp-refused" : "invalid-destination";
        void decide(
          { decision: "deny", reasonCode },
          target,
          encodeSocks5Reply(message.command !== 1 ? 7 : 2),
        );
        return;
      }
      const decision = this.#options.policy.decideConnect({
        ip,
        port: message.port,
        sandbox: this.#pinScope,
      });
      if (decision.decision === "allow") {
        releaseSlot();
        slot = "relay";
        this.#relays++;
        void decide(
          decision,
          {
            ...target,
            channel: decision.channel,
            ...(decision.hostname === undefined
              ? {}
              : { hostname: decision.hostname }),
          },
          encodeSocks5Reply(1),
          decision.upstream,
          earlyData,
        );
      } else {
        void decide(decision, target, encodeSocks5Reply(2));
      }
    };

    const refuseHandshake = (reply: Uint8Array) => {
      void decide(
        {
          decision: "deny",
          reasonCode:
            stage === "request" ? "invalid-destination" : "auth-failed",
        },
        {},
        reply,
      );
    };
    function handshake(chunk: Uint8Array): void {
      let tail = chunk;
      while (tail.length) {
        let read: ReturnType<Socks5HandshakeReader["read"]>;
        try {
          read = reader.read(tail);
        } catch {
          refuseHandshake(encodeSocks5Failure(stage));
          return;
        }
        tail = tail.subarray(read.bytesRead);
        const message = read.message;
        if (!message) return;
        switch (message.kind) {
          case "greeting":
            if (!message.methods.includes(2)) {
              refuseHandshake(encodeSocks5Method(false));
              return;
            }
            client.write(encodeSocks5Method(true));
            stage = "auth";
            break;
          case "auth": {
            const accepted =
              credentialMatches(message.username, expectedUsername) &&
              credentialMatches(message.password, expectedPassword);
            message.username.fill(0);
            message.password.fill(0);
            if (!accepted) {
              refuseHandshake(encodeSocks5AuthReply(false));
              return;
            }
            client.write(encodeSocks5AuthReply(true));
            stage = "request";
            break;
          }
          case "request":
            request(message, tail);
            return;
        }
      }
    }
    const expectedUsername = this.#username;
    const expectedPassword = this.#password;
    client.on("data", handshake);
    client.on("error", () => stop("error"));
    client.on("close", () => {
      this.#socksClients.delete(client);
      stop(firstEnd ?? "client-closed");
    });
    client.on("end", () => {
      if (!connected && !decisionPending) stop("client-closed");
    });
  }

  #acceptDnsTcp(client: Socket): void {
    client.on("error", () => client.destroy());
    if (
      !this.#ready ||
      this.#closing ||
      this.#quarantined ||
      this.#dnsClients.size >= this.#maxPending
    ) {
      client.destroy();
      return;
    }
    this.#dnsClients.add(client);
    client.once("close", () => this.#dnsClients.delete(client));
    client.setTimeout(this.#handshakeMs, () => client.destroy());
    const reader = new DnsTcpFrameReader();
    const consume = async (chunk: Uint8Array) => {
      client.pause();
      try {
        let tail = chunk;
        while (tail.length && !client.destroyed && !this.#closing) {
          if (this.#quarantined) break;
          const { bytesRead, message } = reader.read(tail);
          tail = tail.subarray(bytesRead);
          if (!message) break;
          await this.#answerDns(
            message,
            "tcp",
            () => !client.destroyed,
            (reply) => sendDnsTcp(client, reply),
          );
        }
        if (this.#quarantined) client.destroy();
        else client.resume();
      } catch {
        client.destroy();
      }
    };
    client.on("data", (chunk: Buffer) => {
      void consume(chunk);
    });
  }

  #acceptDnsUdp(message: Buffer, remote: RemoteInfo): void {
    void this.#answerDns(
      message,
      "udp",
      () => true,
      (reply) =>
        new Promise((resolve) => {
          this.#dnsUdp.send(reply, remote.port, remote.address, (error) =>
            resolve(!error),
          );
        }),
    ).catch(() => {});
  }

  async #answerDns(
    bytes: Uint8Array,
    protocol: "tcp" | "udp",
    clientAvailable: () => boolean,
    send: (reply: Uint8Array) => Promise<boolean>,
  ): Promise<void> {
    if (
      this.#closing ||
      this.#quarantined ||
      this.#dnsQueries >= this.#maxPending
    )
      return;
    const question = parseDnsQuestion(bytes);
    const qname = question.qname.toLowerCase();
    // Match the durable audit's hostname schema. Drop queries it cannot store.
    if (
      qname.length > 253 ||
      !qname
        .split(".")
        .every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
    )
      return;

    this.#dnsQueries++;
    try {
      const policy = this.#options.policy;
      const decision = policy.decideDns({ qname, qtype: question.qtype });
      const maxBytes =
        protocol === "tcp" ? DNS_MAX_MESSAGE_BYTES : DNS_UDP_REPLY_BYTES;
      const response: DnsResponse =
        decision.decision === "allow"
          ? await this.#resolveDns(
              question,
              decision.hostname,
              decision.addresses,
              maxBytes,
            )
          : { code: decision.response };
      if (this.#closing || this.#quarantined || !clientAvailable()) return;
      const reply = encodeDnsResponse(question, response, maxBytes);
      const answerIps =
        response.code === "NOERROR"
          ? [...new Set(response.addresses.map((ip) => canonicalizeIp(ip)!))]
          : [];
      const query = {
        queryId: randomUUID(),
        protocol,
        qname,
        qtype: question.qtype,
        policyId: policy.policyId,
        ...(decision.decision === "allow"
          ? {
              decision: decision.decision,
              reasonCode: decision.reasonCode,
              answerIps,
            }
          : {
              decision: decision.decision,
              reasonCode: decision.reasonCode,
              answerIps: [] as const,
            }),
      };
      try {
        await this.#audit(() =>
          this.#options.audit.appendDnsQuery({ ...this.#identity, ...query }),
        );
      } catch {
        this.#quarantine();
        if (!this.#closing && clientAvailable())
          await send(
            encodeDnsResponse(question, { code: "SERVFAIL" }, maxBytes),
          );
        return;
      }
      this.#observe("network.dns.query", query);
      if (this.#closing || this.#quarantined || !clientAvailable()) return;
      const sent = await send(reply);
      if (
        sent &&
        !this.#closing &&
        !this.#quarantined &&
        response.code === "NOERROR" &&
        decision.decision === "allow"
      ) {
        for (const ip of answerIps)
          policy.dnsPins.pin(
            this.#pinScope,
            decision.hostname,
            ip,
            response.ttl,
          );
      }
    } finally {
      this.#dnsQueries--;
    }
  }

  async #resolveDns(
    question: DnsQuestion,
    hostname: string,
    local: readonly string[] | undefined,
    maxBytes: number,
  ): Promise<DnsResponse> {
    const qtype = question.qtype;
    if (qtype !== 1 && qtype !== 28) return { code: "REFUSED" };
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const records =
        local?.map((address) => ({ address, ttl: MAX_ANSWER_TTL })) ??
        (await Promise.race([
          this.#resolver(hostname, qtype),
          new Promise<never>((_, reject) => {
            timer = setTimeout(reject, DNS_TIMEOUT_MS);
          }),
        ]));
      const headerBytes = encodeDnsResponse(question, {
        code: "NOERROR",
        addresses: [],
        ttl: 0,
      }).length;
      const limit = Math.min(
        64,
        Math.floor((maxBytes - headerBytes) / (qtype === 1 ? 16 : 28)),
      );
      const addresses = new Set<string>();
      let ttl = MAX_ANSWER_TTL;
      for (const record of records) {
        if (addresses.size >= limit) break;
        if (
          !canonicalizeIp(record.address) ||
          isIP(record.address) !== (qtype === 1 ? 4 : 6) ||
          !Number.isInteger(record.ttl) ||
          record.ttl < 0 ||
          record.ttl > 0x7fffffff
        )
          continue;
        addresses.add(record.address);
        ttl = Math.min(ttl, record.ttl);
      }
      return { code: "NOERROR", addresses: [...addresses], ttl };
    } catch {
      return { code: "SERVFAIL" };
    } finally {
      clearTimeout(timer);
    }
  }

  close(): Promise<void> {
    return (this.#closing ??= Promise.resolve().then(async () => {
      this.#options.policy.dnsPins.clear(this.#pinScope);
      this.#defaultResolver?.cancel();
      for (const stop of this.#flows) stop("sandbox-destroyed");
      for (const client of this.#socksClients) client.destroy();
      for (const client of this.#dnsClients) client.destroy();
      await Promise.all([
        new Promise<void>((resolve) => this.#socks.close(() => resolve())),
        new Promise<void>((resolve) => this.#dnsTcp.close(() => resolve())),
        new Promise<void>((resolve) => {
          try {
            this.#dnsUdp.close(() => resolve());
          } catch {
            resolve();
          }
        }),
      ]);
      while (this.#auditWork.size) await Promise.allSettled(this.#auditWork);
    }));
  }
}
