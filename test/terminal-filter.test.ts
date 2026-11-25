import assert from "node:assert/strict";
import { test } from "node:test";
import { createTerminalFilter } from "../src/local-orchestrator/terminal-filter.ts";

const bytes = (text: string) => Buffer.from(text);
const cases = [
  ["plain text and UTF-8", bytes("Hello 👋 良い Ü"), "Hello 👋 良い Ü"],
  ["C0 and DEL", bytes("a\0\x07\b\t\n\v\f\r\x0e\x7fb"), "a\b\t\n\rb"],
  [
    "CSI",
    bytes("a\x1b[?25l\x1b[38;5;2m\x1b[1 q\x1b[1\x07mb"),
    "a\x1b[?25l\x1b[38;5;2m\x1b[1 q\x1b[1\x07mb",
  ],
  ["other ESC sequences", bytes("a\x1b(B\x1b7\x1b\\b"), "ab"],
  ["canceled CSI", bytes("a\x1b[0\x18b\x1b[12\x1b[mc"), "ab\x1b[mc"],
  ["incomplete escapes", bytes("a\x1b[42"), "a"],
  ["incomplete strings", bytes("a\x1b]52;secret"), "a"],
  ["UTF-8 inside an OSC", bytes("a\x1b]0;Ü hidden\x1b\\b"), "ab"],
  ["UTF-8 encoded C1 controls", bytes("a\u009d52;hidden\u009cb"), "ab"],
  ["OSC with C0 in the introducer", bytes("a\x1b\0]52;hidden\x07b"), "ab"],
  ...(
    [
      ["raw ST", [0x9c]],
      ["ST byte after an interrupted UTF-8 sequence", [0xe0, 0x9c]],
      ["raw CSI", [0x9b]],
      ["UTF-8 encoded CSI", [0xc2, 0x9b]],
      ["CAN", [0x18]],
      ["SUB", [0x1a]],
    ] as const
  ).map(
    ([name, control]) =>
      [
        `OSC containing ${name}`,
        Buffer.concat([
          bytes("a\x1b]0;"),
          Buffer.from(control),
          bytes("hidden\x1b[m\x1b\\b"),
        ]),
        "ab",
      ] as const,
  ),
  [
    "overlong OSC",
    bytes(`a\x1b]0;${"x".repeat(4096)}hidden\x1b[m\x1b\\b`),
    "ab",
  ],
  [
    "invalid UTF-8 followed by C1",
    Buffer.from([0x61, 0xe0, 0x9d, 0x78, 0x07, 0x62]),
    "axb",
  ],
  [
    "raw C1",
    Buffer.concat([
      bytes("a"),
      Buffer.from([0x84, 0x85, 0x9b]),
      bytes("31mb"),
      Buffer.from([0x9c]),
      bytes("c"),
    ]),
    "a31mbc",
  ],
  ...[0x90, 0x98, 0x9d, 0x9e, 0x9f].map(
    (start) =>
      [
        `raw ${start.toString(16)} before text and CSI`,
        Buffer.concat([Buffer.of(start), bytes("ok\x1b[31m")]),
        "ok\x1b[31m",
      ] as const,
  ),
  ...[
    ["ESC", "\x1b"],
    ["ESC intermediate", "\x1b("],
    ["CSI", "\x1b[1"],
    ["discarded CSI", "\u009b1"],
  ].map(
    ([name, prefix]) =>
      [`UTF-8 punctuation after ${name}`, bytes(`${prefix}”ok`), "ok"] as const,
  ),
  [
    "raw C1 within an ESC introducer and CSI",
    Buffer.from([0x1b, 0x90, 0x5b, 0x31, 0x9d, 0x6d, 0x61]),
    "\x1b[1ma",
  ],
  [
    "raw C1 between ESC and the backslash of ST",
    Buffer.from([0x1b, 0x50, 0x1b, 0x9c, 0x5c, 0x61]),
    "a",
  ],
  [
    "Shift-JIS bytes",
    Buffer.concat([Buffer.of(0x82, 0xa0, 0x83, 0x41), bytes("ok")]),
    "Aok",
  ],
  [
    "binary noise without ESC or encoded C1 followed by text",
    Buffer.concat([
      Buffer.from(
        Array.from({ length: 256 }, (_, byte) => byte).filter(
          (byte) => byte !== 0x1b,
        ),
      ),
      bytes("\r\nok"),
    ]),
    "\b\t\n\r" +
      String.fromCharCode(
        ...Array.from({ length: 95 }, (_, byte) => byte + 0x20),
      ) +
      "\r\nok",
  ],
  ...[
    "52;c;secret",
    "8;;https://example.invalid",
    "0;title",
    "1;title",
    "2;title",
    "9;notification",
    "777;notification",
  ].flatMap((payload) =>
    ["\x07", "\x1b\\"].map(
      (end) =>
        [
          `OSC ${payload} with ${JSON.stringify(end)}`,
          bytes(`a\x1b]${payload}${end}b`),
          "ab",
        ] as const,
    ),
  ),
  ...(
    [
      ["DCS", 0x50, 0x90],
      ["APC", 0x5f, 0x9f],
      ["PM", 0x5e, 0x9e],
      ["SOS", 0x58, 0x98],
      ["OSC", 0x5d, 0x9d],
    ] as const
  ).flatMap(([name, esc, c1]) =>
    [[0x1b, esc], [c1], [0xc2, c1]].flatMap((start) =>
      [
        [0x1b, 0x5c],
        [0xc2, 0x9c],
      ].map(
        (end) =>
          [
            `${name} ${start.join(",")} through ${end.join(",")}`,
            Buffer.concat([
              bytes("a"),
              Buffer.from(start),
              bytes(
                name === "OSC" ? "hidden\x1b[31m Ü" : "\x07hidden\x1b[31m Ü",
              ),
              Buffer.from(end),
              bytes("b"),
            ]),
            start.length === 1 ? "ahidden\x1b[31m Üb" : "ab",
          ] as const,
      ),
    ),
  ),
] as const;

for (const [name, input, expected] of cases) {
  test(`terminal filter handles ${name} at every split`, () => {
    for (let split = 0; split <= input.length; split++) {
      const filter = createTerminalFilter();
      assert.deepEqual(
        Buffer.concat([
          filter.push(input.subarray(0, split)),
          filter.push(input.subarray(split)),
        ]),
        bytes(expected),
        `split at byte ${split}`,
      );
    }
    const filter = createTerminalFilter();
    assert.deepEqual(
      Buffer.concat(
        Array.from(input, (byte) => filter.push(Uint8Array.of(byte))),
      ),
      bytes(expected),
    );
  });
}

test("terminal filter caps CSI at 4 KiB", () => {
  const limit = 4096;
  const csi = `\x1b[${"1".repeat(limit - 3)}m`;
  const filter = createTerminalFilter();
  assert.equal(filter.push(bytes(csi.slice(0, -1))).length, 0);
  assert.deepEqual(Buffer.from(filter.push(bytes("m"))), bytes(csi));
  assert.equal(filter.push(bytes(csi.slice(0, -1) + "11")).length, 0);
  assert.deepEqual(Buffer.from(filter.push(bytes("ma"))), bytes("a"));
});

// The renderer only ever sees filter output, so the guarantee that does not
// depend on matching any renderer's parser is about that output: it is valid
// UTF-8, has no C1 controls, and every ESC starts a complete CSI.
test("filter output never contains a string sequence for any input", () => {
  const alphabet = [
    0x00, 0x07, 0x08, 0x09, 0x0a, 0x0d, 0x18, 0x1a, 0x1b, 0x31, 0x3b, 0x41,
    0x50, 0x58, 0x5b, 0x5c, 0x5d, 0x5e, 0x5f, 0x6d, 0x7f, 0x80, 0x90, 0x9b,
    0x9c, 0x9d, 0xa0, 0xbb, 0xbf, 0xc2, 0xe2, 0xed, 0xef, 0xf0, 0xff,
  ];
  let seed = 12345;
  const random = () =>
    (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const decoder = new TextDecoder("utf-8", { fatal: true });
  for (let run = 0; run < 20_000; run += 1) {
    const input = Array.from(
      { length: 1 + Math.floor(random() * 40) },
      () => alphabet[Math.floor(random() * alphabet.length)]!,
    );
    const filter = createTerminalFilter();
    const chunks: Uint8Array[] = [];
    for (let at = 0; at < input.length;) {
      const size = 1 + Math.floor(random() * 5);
      chunks.push(filter.push(new Uint8Array(input.slice(at, at + size))));
      at += size;
    }
    const text = decoder.decode(Buffer.concat(chunks));
    const label = JSON.stringify(input);
    for (let index = 0; index < text.length; index += 1) {
      const code = text.charCodeAt(index);
      assert.ok(code < 0x80 || code > 0x9f, label);
      if (code !== 0x1b) continue;
      assert.equal(text[index + 1], "[", label);
      let end = index + 2;
      while (end < text.length && /[0-?\b\t\n\r]/.test(text[end]!)) end += 1;
      while (end < text.length && /[ -/\b\t\n\r]/.test(text[end]!)) end += 1;
      assert.ok(end < text.length && /[@-~]/.test(text[end]!), label);
      index = end;
    }
  }
});
