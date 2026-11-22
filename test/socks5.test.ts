import assert from "node:assert/strict";
import { test } from "node:test";
import {
  encodeSocks5AuthReply,
  encodeSocks5Method,
  encodeSocks5Reply,
  SOCKS5_MAX_FRAME_BYTES,
  Socks5HandshakeReader,
  Socks5WireError,
} from "../src/socks5.ts";

// Reconstructed from the Phase 0 SOCKS method and request shapes.
const greeting = Buffer.from("05020002", "hex");
const auth = Buffer.from("0101750170", "hex");
const connect4 = Buffer.from("05010001c000020101bb", "hex");
const connect6 = Buffer.from(
  "0501000420010db800000000000000000000000101bb",
  "hex",
);
const udpAssociate = Buffer.from("05030001000000000000", "hex");

function requestReader(): Socks5HandshakeReader {
  const reader = new Socks5HandshakeReader();
  reader.read(greeting);
  reader.read(auth);
  return reader;
}

test("SOCKS parses Phase 0 greeting, IPv4 and IPv6 CONNECT, and UDP ASSOCIATE", () => {
  const reader = new Socks5HandshakeReader();
  assert.deepEqual(reader.read(greeting), {
    bytesRead: 4,
    message: { kind: "greeting", methods: [0, 2] },
  });
  assert.deepEqual(reader.read(auth).message, {
    kind: "auth",
    username: Uint8Array.of(117),
    password: Uint8Array.of(112),
  });
  assert.deepEqual(reader.read(connect4).message, {
    kind: "request",
    command: 1,
    destination: { atyp: 1, ip: "192.0.2.1" },
    port: 443,
  });
  assert.deepEqual(requestReader().read(connect6).message, {
    kind: "request",
    command: 1,
    destination: { atyp: 4, ip: "2001:db8::1" },
    port: 443,
  });
  assert.deepEqual(requestReader().read(udpAssociate).message, {
    kind: "request",
    command: 3,
    destination: { atyp: 1, ip: "0.0.0.0" },
    port: 0,
  });
});

test("SOCKS recognizes BIND with a domain destination", () => {
  const domain = Buffer.from("example.test");
  const frame = Buffer.concat([
    Uint8Array.of(5, 2, 0, 3, domain.length),
    domain,
    Uint8Array.of(0, 80),
  ]);
  assert.deepEqual(requestReader().read(frame).message, {
    kind: "request",
    command: 2,
    destination: { atyp: 3, hostname: "example.test" },
    port: 80,
  });
});

test("SOCKS accepts every split of a frame including a split at either end", () => {
  for (const [frame, initialize] of [
    [greeting, () => new Socks5HandshakeReader()],
    [
      auth,
      () => {
        const reader = new Socks5HandshakeReader();
        reader.read(greeting);
        return reader;
      },
    ],
    [connect6, requestReader],
  ] as const) {
    const expected = initialize().read(frame).message;
    for (let split = 0; split <= frame.length; split++) {
      const reader = initialize();
      const first = reader.read(frame.subarray(0, split));
      assert.equal(first.bytesRead, split);
      if (split === frame.length) assert.deepEqual(first.message, expected);
      else {
        assert.equal(first.message, undefined);
        const last = reader.read(frame.subarray(split));
        assert.equal(last.bytesRead, frame.length - split);
        assert.deepEqual(last.message, expected);
      }
    }
  }
});

test("SOCKS reads one stage per call and leaves an oversized coalesced tail untouched", () => {
  const tail = Buffer.alloc(65536, 0xa5);
  const chunk = Buffer.concat([greeting, auth, connect4, tail]);
  const reader = new Socks5HandshakeReader();
  let offset = 0;
  for (const [kind, frame] of [
    ["greeting", greeting],
    ["auth", auth],
    ["request", connect4],
  ] as const) {
    const result = reader.read(chunk.subarray(offset));
    assert.equal(result.message?.kind, kind);
    assert.equal(result.bytesRead, frame.length);
    offset += result.bytesRead;
  }
  assert.deepEqual(chunk.subarray(offset), tail);
  assert.throws(() => reader.read(tail), Socks5WireError);
});

test("SOCKS accepts the maximum auth frame and preserves opaque octets", () => {
  const reader = new Socks5HandshakeReader();
  reader.read(greeting);
  const username = new Uint8Array(255).fill(0xff);
  const password = new Uint8Array(255).fill(0x80);
  const frame = Buffer.concat([
    Uint8Array.of(1, 255),
    username,
    Uint8Array.of(255),
    password,
  ]);
  assert.equal(frame.length, SOCKS5_MAX_FRAME_BYTES);
  for (const byte of frame.subarray(0, -1))
    assert.equal(reader.read(Uint8Array.of(byte)).message, undefined);
  assert.deepEqual(reader.read(frame.subarray(-1)).message, {
    kind: "auth",
    username,
    password,
  });
});

test("SOCKS rejects malformed fields and invalidates the reader", () => {
  for (const [initialize, hex] of [
    [() => new Socks5HandshakeReader(), "040100"],
    [() => new Socks5HandshakeReader(), "0500"],
    [requestReader, "05090001"],
    [requestReader, "05010101"],
    [requestReader, "05010005"],
    [requestReader, "0501000300"],
    [requestReader, "05010003010a0050"],
    [requestReader, "0501000301e10050"],
  ] as const) {
    const reader = initialize();
    assert.throws(() => reader.read(Buffer.from(hex, "hex")), Socks5WireError);
    assert.throws(() => reader.read(greeting), Socks5WireError);
  }
  for (const hex of ["0201", "0100", "01017500"]) {
    const reader = new Socks5HandshakeReader();
    reader.read(greeting);
    assert.throws(() => reader.read(Buffer.from(hex, "hex")), Socks5WireError);
  }
  const reader = new Socks5HandshakeReader();
  reader.read(greeting);
  reader.read(auth.subarray(0, -1));
  reader.close();
  assert.throws(() => reader.read(auth.subarray(-1)), Socks5WireError);
});

test("SOCKS encodes method, auth and address replies", () => {
  assert.deepEqual([...encodeSocks5Method(true)], [5, 2]);
  assert.deepEqual([...encodeSocks5Method(false)], [5, 255]);
  assert.deepEqual([...encodeSocks5AuthReply(true)], [1, 0]);
  assert.deepEqual([...encodeSocks5AuthReply(false)], [1, 1]);
  assert.equal(
    Buffer.from(encodeSocks5Reply(7)).toString("hex"),
    "05070001000000000000",
  );
  for (const request of [connect4, connect6]) {
    const reply = encodeSocks5Reply(0, request.subarray(4, -2), 443);
    assert.equal(reply[1], 0);
    // CONNECT replies and requests share the same address and port layout.
    assert.deepEqual(reply.subarray(2), Uint8Array.from(request.subarray(2)));
  }
  const hostname = "example.test";
  const domainReply = encodeSocks5Reply(0, hostname, 443);
  assert.equal(domainReply[1], 0);
  domainReply[1] = 1; // The reply address fields serve as a CONNECT fixture.
  assert.deepEqual(requestReader().read(domainReply).message, {
    kind: "request",
    command: 1,
    destination: { atyp: 3, hostname },
    port: 443,
  });
  assert.throws(() => encodeSocks5Reply(9), Socks5WireError);
  assert.throws(() => encodeSocks5Reply(0, "invalid/name"), Socks5WireError);
  assert.throws(() => encodeSocks5Reply(0, new Uint8Array(5)), Socks5WireError);
  assert.throws(
    () => encodeSocks5Reply(0, new Uint8Array(4), 65536),
    Socks5WireError,
  );
});

test("SOCKS fuzz-style inputs produce only typed errors", () => {
  let seed = 0x126ac017;
  for (let i = 0; i < 1000; i++) {
    const bytes = Uint8Array.from({ length: i % 600 }, () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed >>> 24;
    });
    const reader = new Socks5HandshakeReader();
    if (i % 3 === 1) reader.read(greeting);
    if (i % 3 === 2) {
      reader.read(greeting);
      reader.read(auth);
    }
    if (bytes.length && i % 2 === 0) bytes[0] = i % 3 === 1 ? 1 : 5;
    try {
      const split = bytes.length >>> 1;
      if (!reader.read(bytes.subarray(0, split)).message)
        reader.read(bytes.subarray(split));
    } catch (error) {
      assert.ok(error instanceof Socks5WireError);
    } finally {
      reader.close();
    }
  }
});
