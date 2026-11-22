import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DNS_MAX_MESSAGE_BYTES,
  DnsTcpFrameReader,
  DnsWireError,
  encodeDnsResponse,
  encodeDnsTcpFrame,
  parseDnsQuestion,
} from "../src/dns-wire.ts";

function query(qtype = 1, name = "ExAmple.test"): Buffer {
  const header = Buffer.from("123401000001000000000000", "hex");
  const questionType = Buffer.alloc(4);
  questionType.writeUInt16BE(qtype);
  questionType.writeUInt16BE(1, 2);
  const labels = name === "." ? [] : name.split(".");
  return Buffer.concat([
    header,
    ...labels.map((label) =>
      Buffer.from(String.fromCharCode(label.length) + label, "latin1"),
    ),
    Uint8Array.of(0),
    questionType,
  ]);
}

test("DNS decodes a single question and round-trips its wire bytes in replies", () => {
  for (const [qtype, name] of [
    [1, "ExAmple.test"],
    [16, "x.test"],
    [28, "."],
    [255, "test"],
  ] as const) {
    const wire = query(qtype, name);
    const question = parseDnsQuestion(wire);
    assert.deepEqual(question, {
      id: 0x1234,
      qname: name,
      qtype,
      recursionDesired: true,
    });
    for (const [code, rcode] of [
      ["SERVFAIL", 2],
      ["NXDOMAIN", 3],
      ["REFUSED", 5],
    ] as const) {
      const reply: Buffer = Buffer.from(encodeDnsResponse(question, { code }));
      assert.equal(reply.readUInt16BE(), 0x1234);
      assert.equal(reply.readUInt16BE(2), 0x8180 | rcode);
      assert.deepEqual(reply.subarray(4), wire.subarray(4));
    }
  }
});

test("DNS encodes A, AAAA, and empty NOERROR answers with correct addresses and TTL", () => {
  for (const [qtype, addresses, hex] of [
    [1, ["192.0.2.1", "198.51.100.2"], ["c0000201", "c6336402"]],
    [
      28,
      ["2001:db8::1", "::ffff:192.0.2.1"],
      ["20010db8000000000000000000000001", "00000000000000000000ffffc0000201"],
    ],
    [28, [], []],
  ] as const) {
    const wire = query(qtype);
    wire.writeUInt16BE(0, 2);
    const reply = Buffer.from(
      encodeDnsResponse(parseDnsQuestion(wire), {
        code: "NOERROR",
        ttl: 0x12345678,
        addresses,
      }),
    );
    assert.equal(reply.readUInt16BE(2), 0x8080);
    assert.equal(reply.readUInt16BE(6), addresses.length);
    assert.deepEqual(reply.subarray(12, wire.length), wire.subarray(12));
    let offset = wire.length;
    for (const address of hex) {
      assert.equal(reply.readUInt16BE(offset), 0xc00c);
      assert.equal(reply.readUInt16BE(offset + 2), qtype);
      assert.equal(reply.readUInt16BE(offset + 4), 1);
      assert.equal(reply.readUInt32BE(offset + 6), 0x12345678);
      const size = reply.readUInt16BE(offset + 10);
      assert.equal(size, qtype === 1 ? 4 : 16);
      offset += 12;
      assert.equal(
        reply.subarray(offset, offset + size).toString("hex"),
        address,
      );
      offset += size;
    }
    assert.equal(offset, reply.length);
  }
});

test("DNS validates additive EDNS options without carrying them into the response", () => {
  const wire = query();
  const edns = Buffer.from(
    "00002904d000008000000c000a00080102030405060708",
    "hex",
  );
  const input = Buffer.concat([wire, edns]);
  input.writeUInt16BE(1, 10);
  const question = parseDnsQuestion(input);
  assert.deepEqual(question, { ...parseDnsQuestion(wire), edns: true });
  const reply = Buffer.from(encodeDnsResponse(question, { code: "NXDOMAIN" }));
  assert.equal(reply.readUInt16BE(10), 1);
  assert.equal(
    reply.subarray(wire.length).toString("hex"),
    "0000291000000000000000",
  );
  assert.throws(() => parseDnsQuestion(input.subarray(0, -1)), DnsWireError);
  const malformedOption = Buffer.from(input);
  malformedOption[wire.length + 14] = 9;
  assert.throws(() => parseDnsQuestion(malformedOption), DnsWireError);
  const otherRecord = Buffer.from(input);
  otherRecord[wire.length + 2] = 16;
  assert.throws(() => parseDnsQuestion(otherRecord), DnsWireError);
});

test("DNS rejects compressed and ambiguous questions, trailers, and oversized messages", () => {
  const valid = query();
  const compression = Buffer.concat([
    valid.subarray(0, 12),
    Buffer.from("c00c00010001", "hex"),
  ]);
  const extendedLabel = Buffer.from(compression);
  extendedLabel[12] = 0x40;
  const multi = Buffer.from(valid);
  multi.writeUInt16BE(2, 4);
  const response = Buffer.from(valid);
  response.writeUInt16BE(0x8000, 2);
  const wrongClass = Buffer.from(valid);
  wrongClass.writeUInt16BE(3, wrongClass.length - 2);

  for (const invalid of [
    compression,
    extendedLabel,
    multi,
    response,
    wrongClass,
    query(1, "a/b.test"),
    query(33, "_sip._tcp.test"),
    query(1, "a\xff.test"),
    query(1, "a\x00.test"),
    Buffer.concat([valid, Uint8Array.of(0)]),
    new Uint8Array(DNS_MAX_MESSAGE_BYTES + 1),
  ])
    assert.throws(() => parseDnsQuestion(invalid), DnsWireError);
  for (let size = 0; size < valid.length; size++)
    assert.throws(
      () => parseDnsQuestion(valid.subarray(0, size)),
      DnsWireError,
    );

  const longLabel = "a".repeat(63);
  const maxName = [longLabel, longLabel, longLabel, "b".repeat(61)].join(".");
  assert.equal(parseDnsQuestion(query(1, maxName)).qname, maxName);
  assert.throws(() => parseDnsQuestion(query(1, maxName + "b")), DnsWireError);
});

test("DNS response encoding bounds output and validates answer families and TTLs", () => {
  const question = parseDnsQuestion(query());
  const response = {
    code: "NOERROR",
    ttl: 60,
    addresses: Array<string>(32).fill("192.0.2.1"),
  } as const;
  assert.throws(() => encodeDnsResponse(question, response), DnsWireError);
  assert.equal(
    encodeDnsResponse(question, response, DNS_MAX_MESSAGE_BYTES).length,
    query().length + 32 * 16,
  );
  assert.throws(
    () => encodeDnsResponse(question, { ...response, addresses: ["::1"] }),
    DnsWireError,
  );
  assert.throws(
    () =>
      encodeDnsResponse(question, {
        ...response,
        addresses: [],
        ttl: 0x80000000,
      }),
    DnsWireError,
  );
  assert.throws(
    () =>
      encodeDnsResponse(
        { ...question, qtype: 16 },
        { ...response, addresses: [] },
      ),
    DnsWireError,
  );
  assert.throws(
    () =>
      encodeDnsResponse({ ...question, qname: "path/a" }, { code: "REFUSED" }),
    DnsWireError,
  );
});

test("DNS TCP framing round-trips fragmented and coalesced messages", () => {
  const a = Uint8Array.from(query());
  const b = Uint8Array.from(query(28));
  const frameA = encodeDnsTcpFrame(a);
  const frameB = encodeDnsTcpFrame(b);
  assert.equal(Buffer.from(frameA).readUInt16BE(), a.length);
  const chunk = Buffer.concat([frameA, frameB]);
  for (let split = 0; split < frameA.length; split++) {
    const reader = new DnsTcpFrameReader();
    assert.deepEqual(reader.read(chunk.subarray(0, split)), {
      bytesRead: split,
      message: undefined,
    });
    assert.deepEqual(reader.read(new Uint8Array()), {
      bytesRead: 0,
      message: undefined,
    });
    const first = reader.read(chunk.subarray(split));
    assert.deepEqual(first, { bytesRead: frameA.length - split, message: a });
    assert.deepEqual(reader.read(chunk.subarray(split + first.bytesRead)), {
      bytesRead: frameB.length,
      message: b,
    });
  }

  const max = new Uint8Array(DNS_MAX_MESSAGE_BYTES);
  assert.deepEqual(
    new DnsTcpFrameReader().read(encodeDnsTcpFrame(max)).message,
    max,
  );
});

test("DNS TCP rejects oversized and undersized lengths before reading bodies", () => {
  for (const length of [0, 11, DNS_MAX_MESSAGE_BYTES + 1, 65535]) {
    const header = Uint8Array.of(length >>> 8, length & 0xff);
    const reader = new DnsTcpFrameReader();
    assert.equal(reader.read(header.subarray(0, 1)).message, undefined);
    assert.throws(() => reader.read(header.subarray(1)), DnsWireError);
    assert.throws(() => reader.read(encodeDnsTcpFrame(query())), DnsWireError);
  }
  assert.throws(() => encodeDnsTcpFrame(new Uint8Array(11)), DnsWireError);
  assert.throws(
    () => encodeDnsTcpFrame(new Uint8Array(DNS_MAX_MESSAGE_BYTES + 1)),
    DnsWireError,
  );
});

test("DNS fuzz-style random and query-shaped inputs produce only typed errors", () => {
  let seed = 0x1e44aa53;
  for (let i = 0; i < 1000; i++) {
    const bytes = Uint8Array.from({ length: i % 300 }, () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed >>> 24;
    });
    const shaped = i % 2 === 0 && bytes.length >= 12;
    try {
      if (shaped) bytes.set(query().subarray(0, 12));
      parseDnsQuestion(bytes);
    } catch (error) {
      assert.ok(error instanceof DnsWireError);
    }
    const reader = new DnsTcpFrameReader();
    try {
      reader.read(bytes);
    } catch (error) {
      assert.ok(error instanceof DnsWireError);
    }
  }
});
