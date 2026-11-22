export class Socks5WireError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "Socks5WireError";
  }
}

export const SOCKS5_MAX_FRAME_BYTES = 513; // RFC 1929: 3 + 255 + 255.
export type Socks5Command = 1 | 2 | 3;
export type Socks5Destination =
  | { readonly atyp: 1 | 4; readonly ip: string }
  | { readonly atyp: 3; readonly hostname: string };

export interface Socks5Request {
  readonly command: Socks5Command;
  readonly destination: Socks5Destination;
  readonly port: number;
}

export type Socks5Message =
  | { readonly kind: "greeting"; readonly methods: readonly number[] }
  | {
      readonly kind: "auth";
      readonly username: Uint8Array;
      readonly password: Uint8Array;
    }
  | ({ readonly kind: "request" } & Socks5Request);

function parseGreeting(bytes: Uint8Array): Socks5Message | undefined {
  if (bytes[0] !== 5) throw new Socks5WireError("Invalid SOCKS version");
  const count = bytes[1];
  if (count === undefined) return;
  if (count === 0) throw new Socks5WireError("Empty SOCKS method list");
  if (bytes.length === 2 + count)
    return { kind: "greeting", methods: Array.from(bytes.subarray(2)) };
}

function parseAuth(bytes: Uint8Array): Socks5Message | undefined {
  if (bytes[0] !== 1) throw new Socks5WireError("Invalid SOCKS auth version");
  const usernameLength = bytes[1];
  if (usernameLength === undefined) return;
  if (usernameLength === 0) throw new Socks5WireError("Empty SOCKS username");
  const usernameEnd = 2 + usernameLength;
  const passwordLength = bytes[usernameEnd];
  if (passwordLength === undefined) return;
  if (passwordLength === 0) throw new Socks5WireError("Empty SOCKS password");
  if (bytes.length === usernameEnd + 1 + passwordLength)
    return {
      kind: "auth",
      username: bytes.slice(2, usernameEnd),
      password: bytes.slice(usernameEnd + 1),
    };
}

function parseRequest(bytes: Uint8Array): Socks5Message | undefined {
  if (bytes[0] !== 5) throw new Socks5WireError("Invalid SOCKS version");
  const command = bytes[1];
  if (command === undefined) return;
  if (command !== 1 && command !== 2 && command !== 3)
    throw new Socks5WireError("Unsupported SOCKS command");
  if (bytes.length < 3) return;
  if (bytes[2] !== 0) throw new Socks5WireError("Invalid SOCKS reserved byte");
  const atyp = bytes[3];
  if (atyp === undefined) return;

  let addressStart = 4;
  let addressLength: number;
  switch (atyp) {
    case 1:
      addressLength = 4;
      break;
    case 4:
      addressLength = 16;
      break;
    case 3:
      if (bytes[4] === undefined) return;
      addressLength = bytes[4];
      if (addressLength === 0)
        throw new Socks5WireError("Empty SOCKS hostname");
      addressStart = 5;
      break;
    default:
      throw new Socks5WireError("Unsupported SOCKS address type");
  }
  const addressEnd = addressStart + addressLength;
  if (bytes.length < addressEnd + 2) return;

  const address = bytes.subarray(addressStart, addressEnd);
  let destination: Socks5Destination;
  switch (atyp) {
    case 1:
      destination = { atyp, ip: address.join(".") };
      break;
    case 4: {
      const view = new DataView(address.buffer, address.byteOffset, 16);
      const words = Array.from({ length: 8 }, (_, i) =>
        view.getUint16(i * 2).toString(16),
      );
      const ip = new URL(`http://[${words.join(":")}]`).hostname.slice(1, -1);
      destination = { atyp, ip };
      break;
    }
    case 3: {
      // Latin-1 preserves every input byte for validation without replacement.
      const hostname = Buffer.from(address).toString("latin1");
      if (/[^a-z0-9.-]/i.test(hostname))
        throw new Socks5WireError("Invalid SOCKS hostname");
      destination = { atyp, hostname };
      break;
    }
  }
  const port = new DataView(
    bytes.buffer,
    bytes.byteOffset,
    bytes.length,
  ).getUint16(addressEnd);
  return { kind: "request", command, destination, port };
}

/**
 * Reads one handshake message at a time. bytesRead is relative to the chunk.
 * The caller must authorize each transition before feeding any unconsumed tail.
 * After the request, the tail belongs to the caller (it may be relay data).
 * An invalid frame makes the reader unusable.
 */
export class Socks5HandshakeReader {
  readonly #frame = new Uint8Array(SOCKS5_MAX_FRAME_BYTES);
  #size = 0;
  #stage: Socks5Message["kind"] | "done" = "greeting";

  read(chunk: Uint8Array): {
    readonly bytesRead: number;
    readonly message: Socks5Message | undefined;
  } {
    const stage = this.#stage;
    if (stage === "done") throw new Socks5WireError("SOCKS handshake ended");
    const parse =
      stage === "greeting"
        ? parseGreeting
        : stage === "auth"
          ? parseAuth
          : parseRequest;
    try {
      for (let i = 0; i < chunk.length; i++) {
        if (this.#size === this.#frame.length)
          throw new Socks5WireError("SOCKS frame exceeds its byte limit");
        this.#frame[this.#size++] = chunk[i]!;
        const message = parse(this.#frame.subarray(0, this.#size));
        if (message) {
          this.#clear();
          this.#stage =
            stage === "greeting"
              ? "auth"
              : stage === "auth"
                ? "request"
                : "done";
          return { bytesRead: i + 1, message };
        }
      }
      return { bytesRead: chunk.length, message: undefined };
    } catch (error) {
      this.#clear();
      this.#stage = "done";
      throw error;
    }
  }

  /** Drop any partial handshake, including credentials, on disconnect. */
  close(): void {
    this.#clear();
    this.#stage = "done";
  }

  #clear(): void {
    this.#frame.fill(0, 0, this.#size);
    this.#size = 0;
  }
}

/** The gateway supports user/password authentication exclusively. */
export function encodeSocks5Method(accepted: boolean): Uint8Array {
  return Uint8Array.of(5, accepted ? 2 : 255);
}

export function encodeSocks5AuthReply(accepted: boolean): Uint8Array {
  return Uint8Array.of(1, accepted ? 0 : 1);
}

/** Encode a reply with an optional bound hostname or packed IP and port. */
export function encodeSocks5Reply(
  code: number,
  boundAddress: Uint8Array | string = new Uint8Array(4),
  boundPort = 0,
): Uint8Array {
  if (!Number.isInteger(code) || code < 0 || code > 8)
    throw new Socks5WireError("Invalid SOCKS reply code");
  if (!Number.isInteger(boundPort) || boundPort < 0 || boundPort > 65535)
    throw new Socks5WireError("Invalid SOCKS bound port");

  let reply: Uint8Array;
  if (typeof boundAddress === "string") {
    if (
      boundAddress.length === 0 ||
      boundAddress.length > 255 ||
      /[^a-z0-9.-]/i.test(boundAddress)
    )
      throw new Socks5WireError("Invalid SOCKS bound hostname");
    reply = new Uint8Array(7 + boundAddress.length);
    reply.set([5, code, 0, 3, boundAddress.length]);
    reply.set(Buffer.from(boundAddress, "ascii"), 5);
  } else {
    if (boundAddress.length !== 4 && boundAddress.length !== 16)
      throw new Socks5WireError("Invalid SOCKS bound address length");
    reply = new Uint8Array(6 + boundAddress.length);
    reply.set([5, code, 0, boundAddress.length === 4 ? 1 : 4]);
    reply.set(boundAddress, 4);
  }
  new DataView(reply.buffer).setUint16(reply.length - 2, boundPort);
  return reply;
}
