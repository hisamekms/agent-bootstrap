import { createHash } from "node:crypto";
import { isIP } from "node:net";

export const HOST_SERVICE_NAME = "host-service.agent-bootstrap.internal";

export interface HostPort {
  readonly hostname: string;
  readonly port: number;
}

export interface IpPort {
  readonly ip: string;
  readonly port: number;
}

export interface HostService extends IpPort {
  readonly hostname?: string;
  readonly loopbackPort: number;
}

export interface EgressPolicyConfig {
  readonly allow: readonly HostPort[];
  readonly allowIps?: readonly IpPort[];
  readonly hostServices?: readonly HostService[];
  readonly providerBinding?: HostPort;
}

export interface ConnectDestination extends IpPort {
  readonly sandbox: string;
  readonly protocol?: "tcp" | "udp";
}

export type ConnectDecision =
  | {
      readonly decision: "allow";
      readonly reasonCode:
        "allowlisted-host" | "allowlisted-ip" | "host-service";
      readonly hostname?: string;
      readonly channel: "egress" | "provider-egress" | "host-service";
      readonly upstream: IpPort;
    }
  | {
      readonly decision: "deny";
      readonly reasonCode:
        | "not-allowlisted"
        | "reserved-range"
        | "unpinned-ip"
        | "udp-refused"
        | "invalid-destination";
      readonly channel: "egress";
      readonly upstream: null;
    };

export type DnsDecision =
  | {
      readonly decision: "allow";
      readonly reasonCode: "allowlisted-host" | "host-service";
      readonly hostname: string;
      /** Present for local answers, including an empty answer for the other family. */
      readonly addresses?: readonly string[];
    }
  | {
      readonly decision: "deny";
      readonly reasonCode: "dns-not-allowlisted" | "dns-type-refused";
      readonly response: "NXDOMAIN";
    };

function validPort(port: number): boolean {
  return Number.isInteger(port) && port >= 1 && port <= 65535;
}

function connectPort(port: number): boolean {
  return validPort(port) && port !== 53 && port !== 853;
}

function normalizeHostname(value: string): string | undefined {
  if (typeof value !== "string" || /[^a-z0-9.-]/i.test(value)) return;
  const name = value.toLowerCase().replace(/\.$/, "");
  if (
    name.length > 253 ||
    isIP(name) ||
    !name
      .split(".")
      .every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
  )
    return;
  return name;
}

/** Returns an unscoped address literal, or undefined for malformed input. */
export function canonicalizeIp(value: string): string | undefined {
  if (typeof value !== "string" || /[^0-9a-f:.]/i.test(value)) return;
  const family = isIP(value);
  if (family === 4) return value;
  if (family !== 6) return;

  // WHATWG URL serializes a validated IPv6 literal in compressed hex form.
  const ip = new URL(`http://[${value}]`).hostname.slice(1, -1);
  const [head = "", tail] = ip.split("::");
  const leading = head ? head.split(":") : [];
  const trailing = tail ? tail.split(":") : [];
  const words =
    tail === undefined
      ? leading
      : [
          ...leading,
          ...Array<string>(8 - leading.length - trailing.length).fill("0"),
          ...trailing,
        ];
  const prefix = words.slice(0, 6).join(":");
  if (prefix !== "0:0:0:0:0:ffff" && prefix !== "64:ff9b:0:0:0:0") return ip;
  const high = Number.parseInt(words[6] ?? "0", 16);
  const low = Number.parseInt(words[7] ?? "0", 16);
  return [high >>> 8, high & 255, low >>> 8, low & 255].join(".");
}

function isReserved(ip: string): boolean {
  if (ip.includes(":")) {
    const first = Number.parseInt(ip.split(":", 1)[0] ?? "", 16);
    return (
      // Unspecified, loopback and deprecated IPv4-compatible addresses.
      (ip.startsWith("::") && ip.slice(2).split(":").length <= 2) ||
      ip.startsWith("64:ff9b:1:") || // Local-use IPv4/IPv6 translation.
      first >= 0xfc00 // ULA (including the msb pool), link-local, site-local, multicast.
    );
  }
  const [a = 0, b = 0] = ip.split(".").map(Number);
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a >= 224 && a <= 239) ||
    ip === "255.255.255.255"
  );
}

function isDocumentationAddress(ip: string): boolean {
  return (
    ip.startsWith("192.0.2.") ||
    ip.startsWith("198.51.100.") ||
    ip.startsWith("203.0.113.") ||
    ip.startsWith("2001:db8:")
  );
}

function isHostServiceName(name: string): boolean {
  return name === HOST_SERVICE_NAME || name.endsWith(`.${HOST_SERVICE_NAME}`);
}

interface SandboxPins {
  readonly addresses: Map<string, Map<string, number>>;
  nextSweepAt: number;
}

function expireNames(names: Map<string, number>, now: number): void {
  for (const [name, expiresAt] of names)
    if (!(expiresAt > now)) names.delete(name);
}

/** Pin answers for one sandbox only. TTLs are in seconds and the clock is in ms. */
export class DnsPinTable {
  readonly #pins = new Map<string, SandboxPins>();
  readonly #now: () => number;

  constructor(now: () => number = () => performance.now()) {
    this.#now = now;
  }

  /** Publish only answers cleared for delivery by the durable DNS audit. */
  pin(sandbox: string, hostname: string, ip: string, ttlSeconds: number): void {
    const name = normalizeHostname(hostname);
    const address = canonicalizeIp(ip);
    if (
      !sandbox ||
      !name ||
      !address ||
      !Number.isInteger(ttlSeconds) ||
      ttlSeconds < 0 ||
      ttlSeconds > 0x7fffffff
    )
      throw new TypeError("invalid DNS pin");

    const now = this.#now();
    let pins = this.#pins.get(sandbox);
    if (!pins) {
      pins = { addresses: new Map(), nextSweepAt: now + 1000 };
      this.#pins.set(sandbox, pins);
    }
    // Expire addresses that are never looked up again as new answers arrive.
    if (now >= pins.nextSweepAt) {
      for (const [ip, names] of pins.addresses) {
        expireNames(names, now);
        if (names.size === 0) pins.addresses.delete(ip);
      }
      pins.nextSweepAt = now + 1000;
    }
    const names = pins.addresses.get(address) ?? new Map<string, number>();
    if (ttlSeconds === 0) names.delete(name);
    else names.set(name, now + ttlSeconds * 1000);
    if (names.size === 0) pins.addresses.delete(address);
    else pins.addresses.set(address, names);
    if (pins.addresses.size === 0) this.clear(sandbox);
  }

  namesFor(sandbox: string, ip: string): readonly string[] {
    const address = canonicalizeIp(ip);
    if (address === undefined) return [];
    const addresses = this.#pins.get(sandbox)?.addresses;
    if (!addresses) return [];
    const names = addresses.get(address);
    if (!names) return [];

    expireNames(names, this.#now());
    if (names.size === 0) addresses.delete(address);
    if (addresses.size === 0) this.clear(sandbox);
    return [...names.keys()].sort();
  }

  clear(sandbox: string): void {
    this.#pins.delete(sandbox);
  }
}

function deny(
  reasonCode: Extract<ConnectDecision, { decision: "deny" }>["reasonCode"],
): ConnectDecision {
  return { decision: "deny", reasonCode, channel: "egress", upstream: null };
}

function normalizeHostPort(entry: HostPort): HostPort {
  const hostname = normalizeHostname(entry.hostname);
  if (
    !hostname ||
    isHostServiceName(hostname) ||
    hostname === "host.microsandbox.internal" ||
    !connectPort(entry.port)
  )
    throw new TypeError("invalid egress host entry");
  return { hostname, port: entry.port };
}

function normalizeIpPort(entry: IpPort): IpPort {
  const ip = canonicalizeIp(entry.ip);
  if (!ip || !connectPort(entry.port))
    throw new TypeError("invalid egress IP entry");
  return { ip, port: entry.port };
}

function canonicalEntries<T extends object>(
  entries: T[],
): readonly Readonly<T>[] {
  const byJson = new Map(
    entries.map((entry) => [JSON.stringify(entry), entry]),
  );
  return Object.freeze(
    [...byJson.keys()].sort().map((key) => Object.freeze(byJson.get(key)!)),
  );
}

export class EgressPolicy {
  readonly allow: readonly HostPort[];
  readonly allowIps: readonly IpPort[];
  readonly hostServices: readonly HostService[];
  readonly providerBinding: HostPort | undefined;
  readonly policyId: string;
  readonly dnsPins: DnsPinTable;

  constructor(
    config: EgressPolicyConfig,
    pins: DnsPinTable = new DnsPinTable(),
  ) {
    this.dnsPins = pins;
    this.allow = canonicalEntries(config.allow.map(normalizeHostPort));
    this.allowIps = canonicalEntries(
      (config.allowIps ?? []).map(normalizeIpPort),
    );
    this.hostServices = canonicalEntries(
      (config.hostServices ?? []).map((entry) => {
        const destination = normalizeIpPort(entry);
        const hostname =
          entry.hostname === undefined
            ? undefined
            : normalizeHostname(entry.hostname);
        if (
          !isDocumentationAddress(destination.ip) ||
          !connectPort(entry.loopbackPort) ||
          (entry.hostname !== undefined &&
            (!hostname || !isHostServiceName(hostname)))
        )
          throw new TypeError("invalid host service");
        return {
          ...destination,
          ...(hostname === undefined ? {} : { hostname }),
          loopbackPort: entry.loopbackPort,
        };
      }),
    );
    const serviceEndpoints = new Set<string>();
    for (const { ip, port } of this.hostServices) {
      const endpoint = `[${ip}]:${port}`;
      if (serviceEndpoints.has(endpoint))
        throw new TypeError("conflicting host services");
      serviceEndpoints.add(endpoint);
    }
    this.providerBinding =
      config.providerBinding === undefined
        ? undefined
        : Object.freeze(normalizeHostPort(config.providerBinding));
    this.policyId = createHash("sha256")
      .update(
        JSON.stringify({
          allow: this.allow,
          allowIps: this.allowIps,
          hostServices: this.hostServices,
          providerBinding: this.providerBinding ?? null,
        }),
      )
      .digest("hex");
    Object.freeze(this);
  }

  decideConnect({
    ip,
    port,
    sandbox,
    protocol = "tcp",
  }: ConnectDestination): ConnectDecision {
    if (protocol === "udp") return deny("udp-refused");
    const address = canonicalizeIp(ip);
    if (protocol !== "tcp" || !address || !connectPort(port) || !sandbox)
      return deny("invalid-destination");

    const service = this.hostServices.find(
      (entry) => entry.ip === address && entry.port === port,
    );
    if (service) {
      const hostname = service.hostname;
      return {
        decision: "allow",
        reasonCode: "host-service",
        channel: "host-service",
        ...(hostname !== undefined &&
        this.dnsPins.namesFor(sandbox, address).includes(hostname)
          ? { hostname }
          : {}),
        upstream: { ip: "127.0.0.1", port: service.loopbackPort },
      };
    }
    if (isReserved(address)) return deny("reserved-range");

    const upstream = { ip: address, port };
    const names = this.dnsPins.namesFor(sandbox, address);
    const allowedHosts = this.allow.filter((entry) => entry.port === port);
    const binding = this.providerBinding;
    const provider =
      binding?.port === port &&
      names.includes(binding.hostname) &&
      allowedHosts.some((entry) => entry.hostname === binding.hostname);
    const hostname = provider
      ? binding.hostname
      : names.find((name) =>
          allowedHosts.some((entry) => entry.hostname === name),
        );
    if (hostname !== undefined)
      return {
        decision: "allow",
        reasonCode: "allowlisted-host",
        hostname,
        channel: provider ? "provider-egress" : "egress",
        upstream,
      };
    if (
      this.allowIps.some((entry) => entry.ip === address && entry.port === port)
    )
      return {
        decision: "allow",
        reasonCode: "allowlisted-ip",
        channel: "egress",
        upstream,
      };
    return deny(
      names.length === 0 && allowedHosts.length > 0
        ? "unpinned-ip"
        : "not-allowlisted",
    );
  }

  /** qtype is the numeric DNS wire type (1 for A and 28 for AAAA). */
  decideDns({
    qname,
    qtype,
  }: {
    readonly qname: string;
    readonly qtype: number;
  }): DnsDecision {
    if (qtype !== 1 && qtype !== 28)
      return {
        decision: "deny",
        reasonCode: "dns-type-refused",
        response: "NXDOMAIN",
      };
    const hostname = normalizeHostname(qname);
    if (hostname !== undefined) {
      const services = this.hostServices.filter(
        (entry) => entry.hostname === hostname,
      );
      if (services.length > 0)
        return {
          decision: "allow",
          reasonCode: "host-service",
          hostname,
          addresses: [
            ...new Set(
              services
                .map((entry) => entry.ip)
                .filter((ip) => isIP(ip) === (qtype === 1 ? 4 : 6)),
            ),
          ],
        };
      if (this.allow.some((entry) => entry.hostname === hostname))
        return { decision: "allow", reasonCode: "allowlisted-host", hostname };
    }
    return {
      decision: "deny",
      reasonCode: "dns-not-allowlisted",
      response: "NXDOMAIN",
    };
  }
}
