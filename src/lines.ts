/** Thrown when a line stream exceeds its bound or is not valid UTF-8. */
export class LineStreamError extends Error {
  readonly code: "limit" | "encoding";
  constructor(code: "limit" | "encoding") {
    super(`Line stream: ${code}`);
    this.name = "LineStreamError";
    this.code = code;
  }
}

/** Split a byte stream into UTF-8 lines, failing before a line exceeds the
 * limit rather than after buffering it. */
export async function* boundedLines(
  chunks: AsyncIterable<Uint8Array | string>,
  maxBytes: number,
): AsyncGenerator<string> {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let parts: Buffer[] = [];
  let size = 0;
  const take = () => {
    const line = Buffer.concat(parts);
    parts = [];
    size = 0;
    try {
      return decoder.decode(line);
    } catch {
      throw new LineStreamError("encoding");
    }
  };
  for await (const chunk of chunks) {
    let data = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    for (;;) {
      const end = data.indexOf(0x0a);
      const piece = end < 0 ? data : data.subarray(0, end);
      size += piece.length;
      if (size > maxBytes) throw new LineStreamError("limit");
      parts.push(Buffer.from(piece));
      if (end < 0) break;
      const line = take();
      yield line.endsWith("\r") ? line.slice(0, -1) : line;
      data = data.subarray(end + 1);
    }
  }
  if (size > 0) yield take();
}
