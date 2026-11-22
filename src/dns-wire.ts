import { isIP } from "node:net";

export class DnsWireError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DnsWireError";
  }
}

const HEADER_BYTES = 12;
const MAX_NAME_BYTES = 255;
const TYPE_A = 1;
const TYPE_AAAA = 28;
const TYPE_OPT = 41;
const OPT_HEADER_BYTES = 11;
const CLASS_IN = 1;
const RD = 0x0100;
const RESPONSE_FLAGS = 0x8080; // QR and RA.

export const DNS_MAX_MESSAGE_BYTES = 4096;
export const DNS_UDP_REPLY_BYTES = 512;

export interface DnsQuestion {
  readonly id: number;
  readonly qname: string;
  readonly qtype: number;
  readonly recursionDesired: boolean;
  readonly edns?: true;
}

export type DnsResponse =
  | { readonly code: "NXDOMAIN" | "REFUSED" | "SERVFAIL" }
  | {
      readonly code: "NOERROR";
      readonly addresses: readonly string[];
      readonly ttl: number;
    };

const RESPONSE_CODES = { NOERROR: 0, SERVFAIL: 2, NXDOMAIN: 3, REFUSED: 5 };

function viewOf(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function checkMessageLength(length: number): void {
  if (length < HEADER_BYTES || length > DNS_MAX_MESSAGE_BYTES)
    throw new DnsWireError("DNS message length out of range");
}

/** Validate one EDNS(0) OPT record and discard its options and flags. */
function checkOpt(bytes: Uint8Array, offset: number, view: DataView): void {
  const optionsStart = offset + OPT_HEADER_BYTES;
  if (
    optionsStart > bytes.length ||
    bytes[offset] !== 0 ||
    view.getUint16(offset + 1) !== TYPE_OPT ||
    view.getUint16(offset + 5) !== 0 || // Extended RCODE and EDNS version.
    optionsStart + view.getUint16(offset + 9) !== bytes.length
  )
    throw new DnsWireError("Invalid DNS additional record");

  for (let cursor = optionsStart; cursor < bytes.length;) {
    if (cursor + 4 > bytes.length)
      throw new DnsWireError("Truncated DNS option");
    cursor += 4 + view.getUint16(cursor + 2);
    if (cursor > bytes.length)
      throw new DnsWireError("Truncated DNS option data");
  }
}

/** Parse one IN question with audit-safe LDH labels. The root is ".". */
export function parseDnsQuestion(bytes: Uint8Array): DnsQuestion {
  checkMessageLength(bytes.length);
  const view = viewOf(bytes);
  const flags = view.getUint16(2);
  const additional = view.getUint16(10);
  if (
    (flags & ~0x0130) !== 0 || // RD, AD and CD may be set by the client.
    view.getUint16(4) !== 1 ||
    view.getUint16(6) !== 0 ||
    view.getUint16(8) !== 0 ||
    additional > 1
  )
    throw new DnsWireError("Unsupported DNS query header");

  const labels: string[] = [];
  let cursor = HEADER_BYTES;
  for (;;) {
    const length = bytes[cursor++];
    if (length === undefined) throw new DnsWireError("Truncated DNS name");
    if (length > 63) throw new DnsWireError("Compressed or extended DNS label");
    if (cursor + length > bytes.length)
      throw new DnsWireError("Truncated DNS name");
    if (cursor + length - HEADER_BYTES > MAX_NAME_BYTES)
      throw new DnsWireError("DNS name exceeds its byte limit");
    if (length === 0) break;
    const label = Buffer.from(bytes.subarray(cursor, cursor + length)).toString(
      "latin1",
    );
    if (/[^a-z0-9-]/i.test(label))
      throw new DnsWireError("Invalid DNS hostname label");
    labels.push(label);
    cursor += length;
  }

  if (cursor + 4 > bytes.length)
    throw new DnsWireError("Truncated DNS question");
  const qtype = view.getUint16(cursor);
  if (view.getUint16(cursor + 2) !== CLASS_IN)
    throw new DnsWireError("Unsupported DNS question class");

  cursor += 4;
  if (additional === 1) checkOpt(bytes, cursor, view);
  else if (cursor !== bytes.length) throw new DnsWireError("Trailing DNS data");

  return {
    id: view.getUint16(0),
    qname: labels.length === 0 ? "." : labels.join("."),
    qtype,
    recursionDesired: (flags & RD) !== 0,
    ...(additional === 1 ? { edns: true } : {}),
  };
}

function encodeName(name: string): Uint8Array {
  if (name === ".") return Uint8Array.of(0);
  if (name.length > MAX_NAME_BYTES - 2)
    throw new DnsWireError("DNS name exceeds its byte limit");
  const wire = new Uint8Array(name.length + 2);
  let offset = 0;
  for (const label of name.split(".")) {
    if (!label.length || label.length > 63 || /[^a-z0-9-]/i.test(label))
      throw new DnsWireError("Invalid DNS hostname label");
    wire[offset++] = label.length;
    for (let i = 0; i < label.length; i++) wire[offset++] = label.charCodeAt(i);
  }
  return wire;
}

function encodeAddress(ip: string, qtype: number): Uint8Array {
  const family = qtype === TYPE_A ? 4 : 6;
  if (ip.length > 45 || /[^0-9a-f:.]/i.test(ip) || isIP(ip) !== family)
    throw new DnsWireError("Invalid DNS answer address");
  if (family === 4) return Uint8Array.from(ip.split("."), Number);

  // Normalize IPv4 tails to hex before expanding any abbreviated zero words.
  const host = new URL(`http://[${ip}]`).hostname.slice(1, -1);
  const [head = "", tail] = host.split("::");
  const leading = head ? head.split(":") : [];
  const trailing = tail ? tail.split(":") : [];
  const address = new Uint8Array(16);
  const view = viewOf(address);
  leading.forEach((word, i) => view.setUint16(i * 2, parseInt(word, 16)));
  trailing.forEach((word, i) =>
    view.setUint16((8 - trailing.length + i) * 2, parseInt(word, 16)),
  );
  return address;
}

function isUint16(value: number): boolean {
  return Number.isInteger(value) && value >= 0 && value <= 65535;
}

/** UDP uses the classic 512-byte limit. TCP callers may opt into a larger cap. */
export function encodeDnsResponse(
  question: DnsQuestion,
  response: DnsResponse,
  maxBytes = DNS_UDP_REPLY_BYTES,
): Uint8Array {
  if (
    !Number.isInteger(maxBytes) ||
    maxBytes < HEADER_BYTES ||
    maxBytes > DNS_MAX_MESSAGE_BYTES
  )
    throw new DnsWireError("Invalid DNS response byte limit");
  if (!isUint16(question.id) || !isUint16(question.qtype))
    throw new DnsWireError("Invalid DNS question fields");

  const name = encodeName(question.qname);
  const questionEnd = HEADER_BYTES + name.length + 4;
  const answerCount =
    response.code === "NOERROR" ? response.addresses.length : 0;
  const addressBytes = question.qtype === TYPE_A ? 4 : 16;
  const answerBytes = 12 + addressBytes;
  const answerEnd = questionEnd + answerCount * answerBytes;
  const size = answerEnd + (question.edns ? OPT_HEADER_BYTES : 0);
  if (size > maxBytes)
    throw new DnsWireError("DNS response exceeds byte limit");

  const bytes = new Uint8Array(size);
  const view = viewOf(bytes);
  view.setUint16(0, question.id);
  view.setUint16(
    2,
    RESPONSE_FLAGS |
      (question.recursionDesired ? RD : 0) |
      RESPONSE_CODES[response.code],
  );
  view.setUint16(4, 1);
  view.setUint16(6, answerCount);
  bytes.set(name, HEADER_BYTES);
  view.setUint16(questionEnd - 4, question.qtype);
  view.setUint16(questionEnd - 2, CLASS_IN);

  if (response.code === "NOERROR") {
    if (question.qtype !== TYPE_A && question.qtype !== TYPE_AAAA)
      throw new DnsWireError("Unsupported DNS answer type");
    if (
      !Number.isInteger(response.ttl) ||
      response.ttl < 0 ||
      response.ttl > 0x7fffffff
    )
      throw new DnsWireError("Invalid DNS answer TTL");

    let offset = questionEnd;
    for (const ip of response.addresses) {
      const address = encodeAddress(ip, question.qtype);
      view.setUint16(offset, 0xc00c); // Owner name points to our own question.
      view.setUint16(offset + 2, question.qtype);
      view.setUint16(offset + 4, CLASS_IN);
      view.setUint32(offset + 6, response.ttl);
      view.setUint16(offset + 10, addressBytes);
      bytes.set(address, offset + 12);
      offset += answerBytes;
    }
  }
  if (question.edns) {
    // Advertise the receive limit. Never echo client options or flags.
    view.setUint16(10, 1);
    view.setUint16(answerEnd + 1, TYPE_OPT);
    view.setUint16(answerEnd + 3, DNS_MAX_MESSAGE_BYTES);
  }
  return bytes;
}

export function encodeDnsTcpFrame(message: Uint8Array): Uint8Array {
  checkMessageLength(message.length);
  const frame = new Uint8Array(message.length + 2);
  viewOf(frame).setUint16(0, message.length);
  frame.set(message, 2);
  return frame;
}

/**
 * Reads one DNS TCP message per call. Feed any unconsumed chunk tail back
 * after handling the message. Close the stream on DnsWireError.
 */
export class DnsTcpFrameReader {
  #highByte: number | undefined;
  #message: Uint8Array | undefined;
  #offset = 0;
  #failed = false;

  read(chunk: Uint8Array): {
    readonly bytesRead: number;
    readonly message: Uint8Array | undefined;
  } {
    if (this.#failed) throw new DnsWireError("DNS TCP framer failed");
    let bytesRead = 0;
    if (!this.#message) {
      if (this.#highByte === undefined && chunk.length > 0)
        this.#highByte = chunk[bytesRead++];
      const lowByte = chunk[bytesRead];
      if (this.#highByte === undefined || lowByte === undefined)
        return { bytesRead: chunk.length, message: undefined };
      bytesRead++;
      const size = (this.#highByte << 8) | lowByte;
      if (size < HEADER_BYTES || size > DNS_MAX_MESSAGE_BYTES) {
        this.#failed = true;
        throw new DnsWireError("DNS TCP message length out of range");
      }
      this.#message = new Uint8Array(size);
      this.#highByte = undefined;
    }

    const message = this.#message;
    const count = Math.min(
      chunk.length - bytesRead,
      message.length - this.#offset,
    );
    message.set(chunk.subarray(bytesRead, bytesRead + count), this.#offset);
    this.#offset += count;
    bytesRead += count;
    if (this.#offset < message.length) return { bytesRead, message: undefined };
    this.#message = undefined;
    this.#offset = 0;
    return { bytesRead, message };
  }
}
