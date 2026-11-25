const sequenceLimit = 4 * 1024;
const escape = 0x1b;
const bell = 0x07;
const stringTerminator = 0x9c;

type State =
  | "text"
  | "escape"
  | "escape-intermediate"
  | "csi"
  | "discard-csi"
  | "string"
  | "string-escape";

function neededControl(byte: number): boolean {
  return byte === 0x08 || byte === 0x09 || byte === 0x0a || byte === 0x0d;
}

export function createTerminalFilter() {
  let state: State = "text";
  const sequence = new Uint8Array(sequenceLimit);
  let length = 0;
  let intermediate = false;
  let osc = false;
  const utf8 = new Uint8Array(4);
  let utf8Length = 0;
  let remaining = 0;
  let min = 0x80;
  let max = 0xbf;

  return {
    push(chunk: Uint8Array): Uint8Array {
      const output = new Uint8Array(
        chunk.length + length + utf8Length + (state === "escape" ? 1 : 0),
      );
      let written = 0;
      for (let byte of chunk) {
        let encodedC1 = false;
        if (remaining) {
          if (byte >= min && byte <= max) {
            utf8[utf8Length++] = byte;
            min = 0x80;
            max = 0xbf;
            if (--remaining) continue;
            const size = utf8Length;
            utf8Length = 0;
            // A UTF-8 decoder exposes these code points as controls too.
            if (utf8[0] !== 0xc2 || byte > 0x9f) {
              if (state === "text") {
                output.set(utf8.subarray(0, size), written);
                written += size;
              } else if (state === "string-escape") {
                state = "string";
              } else if (state !== "string") {
                state = "text";
                length = 0;
              }
              continue;
            }
            encodedC1 = true;
          } else {
            // Reprocess the byte that interrupted the UTF-8 sequence.
            remaining = utf8Length = 0;
          }
        }
        // Uint8Array writes to xterm.js are UTF-8 decoded before parsing.
        if (!encodedC1 && byte >= 0x80 && byte <= 0x9f) continue;
        if (byte >= 0xc2 && byte <= 0xf4) {
          utf8[0] = byte;
          utf8Length = 1;
          remaining = byte < 0xe0 ? 1 : byte < 0xf0 ? 2 : 3;
          min = byte === 0xe0 ? 0xa0 : byte === 0xf0 ? 0x90 : 0x80;
          max = byte === 0xed ? 0x9f : byte === 0xf4 ? 0x8f : 0xbf;
          continue;
        }
        if (state === "string-escape" && byte === 0x5c) {
          state = "text";
          continue;
        }
        if (state === "string-escape") state = "string";
        if (state === "string") {
          // Stream-discard the body at any size. Raw C1 bytes cannot end it.
          if (
            (osc && byte === bell) ||
            (encodedC1 && byte === stringTerminator)
          )
            state = "text";
          else if (byte === escape) state = "string-escape";
          continue;
        }
        if (byte === escape) {
          state = "escape";
          length = 0;
          continue;
        }
        if (encodedC1) {
          length = 0;
          if ([0x90, 0x98, 0x9d, 0x9e, 0x9f].includes(byte)) {
            state = "string";
            osc = byte === 0x9d;
          } else if (byte === 0x9b) state = "discard-csi";
          else if (state === "csi") state = "discard-csi";
          continue;
        }
        switch (state) {
          case "text":
            if (neededControl(byte) || (byte >= 0x20 && byte <= 0x7e))
              output[written++] = byte;
            break;
          case "escape":
          case "escape-intermediate":
            if (byte === 0x18 || byte === 0x1a) {
              state = "text";
              break;
            }
            if (byte < 0x20 || byte === 0x7f) break;
            if (state === "escape-intermediate") {
              if (byte >= 0x30) state = "text";
              break;
            }
            if (byte === 0x5b) {
              sequence[0] = escape;
              sequence[1] = byte;
              length = 2;
              intermediate = false;
              state = "csi";
            } else if ([0x5d, 0x50, 0x5f, 0x5e, 0x58].includes(byte)) {
              state = "string";
              osc = byte === 0x5d;
            } else {
              state =
                byte >= 0x20 && byte <= 0x2f ? "escape-intermediate" : "text";
            }
            break;
          case "csi":
          case "discard-csi": {
            const final = byte >= 0x40 && byte <= 0x7e;
            if (state === "csi") {
              const isIntermediate = byte >= 0x20 && byte <= 0x2f;
              const parameter = !intermediate && byte >= 0x30 && byte <= 0x3f;
              if (
                length === sequenceLimit ||
                !(
                  final ||
                  isIntermediate ||
                  parameter ||
                  neededControl(byte) ||
                  byte === bell
                )
              ) {
                state = "discard-csi";
                length = 0;
              } else {
                intermediate ||= isIntermediate;
                sequence[length++] = byte;
                if (final) {
                  output.set(sequence.subarray(0, length), written);
                  written += length;
                  length = 0;
                }
              }
            }
            if (final || byte === 0x18 || byte === 0x1a) state = "text";
            break;
          }
        }
      }
      return output.subarray(0, written);
    },
  };
}
