import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnAttachedTerminal } from "../src/microsandbox.ts";

test(
  "the adapter's Bun PTY accepts input and resize and reports output and exit",
  { timeout: 5000 },
  async () => {
    let output = "";
    const initialSize = Promise.withResolvers<void>();
    const { terminal, finished, stop } = spawnAttachedTerminal(
      ["/bin/sh", "-c", "stty size; read x; echo got:$x; stty size; exit 7"],
      { cwd: process.cwd(), env: { PATH: "/usr/bin:/bin" } },
      {
        cols: 80,
        rows: 24,
        data(chunk) {
          output += Buffer.from(chunk).toString();
          if (output.includes("24 80\r\n")) initialSize.resolve();
        },
      },
    );
    try {
      await Promise.race([initialSize.promise, finished]);
      assert.match(output, /^24 80\r\n/);
      assert.throws(() => terminal.resize(501, 24), { code: "invalid-input" });
      terminal.resize(100, 30);
      terminal.write(Buffer.from("hello\n"));
      assert.deepEqual(await finished, { exitCode: 7 });
      assert.match(output, /got:hello\r\n30 100\r\n/);
    } finally {
      stop();
      await finished;
    }
  },
);

test(
  "the adapter delivers the final PTY output before reporting completion",
  { timeout: 5000 },
  async () => {
    const chunks: Buffer[] = [];
    const { finished } = spawnAttachedTerminal(
      ["/bin/sh", "-c", "head -c 131072 /dev/zero; printf 'tail\\n'"],
      { cwd: process.cwd(), env: { PATH: "/usr/bin:/bin" } },
      {
        cols: 80,
        rows: 24,
        data(chunk) {
          chunks.push(Buffer.from(chunk));
        },
      },
    );
    assert.deepEqual(await finished, { exitCode: 0 });
    const output = Buffer.concat(chunks);
    assert.equal(output.length, 131072 + "tail\r\n".length);
    assert.equal(output.subarray(131072).toString(), "tail\r\n");
  },
);

test("the adapter validates the initial PTY dimensions before spawning", () => {
  assert.throws(
    () =>
      spawnAttachedTerminal(
        ["/bin/sh"],
        { cwd: process.cwd(), env: {} },
        { cols: 80, rows: 4, data() {} },
      ),
    { code: "invalid-input" },
  );
});
