import assert from "node:assert/strict";
import { test } from "node:test";
import {
  builtInCredentialScanner,
  maskCredentials,
} from "../src/local-orchestrator/credential-scan.ts";

const token = "sk-ant-" + "x".repeat(30);
const marker = "［伏せ字］";

test("credential masking maps built-in matches back to source spans", async () => {
  const escaped = String.raw`\u0073k-ant-` + "x".repeat(30);
  assert.deepEqual(
    await maskCredentials(`Prefix (${token}); note:\n+${escaped}\nEnd`),
    {
      text: `Prefix ${marker} note:\n${marker}\nEnd`,
      masked: 2,
    },
  );
  assert.deepEqual(await maskCredentials("Plain text"), {
    text: "Plain text",
    masked: 0,
  });
});

test("credential masking removes all three JSON values and keeps the keys", async () => {
  const source =
    '{"accessToken":"access-example","refreshToken":"refresh-example","expiresAt":12.5e+2,"extra":true}';
  await assert.rejects(builtInCredentialScanner(source), {
    code: "credential-leak",
  });
  const expected = `{"accessToken":${marker},"refreshToken":${marker},"expiresAt":${marker},"extra":true}`;
  assert.deepEqual(await maskCredentials(source), {
    text: expected,
    masked: 3,
  });
  await builtInCredentialScanner(expected);
  assert.deepEqual(await maskCredentials(JSON.stringify(source)), {
    text: JSON.stringify(expected),
    masked: 3,
  });
  assert.equal(
    await maskCredentials(
      source.replace("access-example", String.raw`abc\"remaining`),
    ),
    null,
  );
  const second = source.replace(
    "access-example",
    String.raw`second\u000asecret`,
  );
  assert.equal(await maskCredentials(`[${source},${second}]`), null);
  const nested = JSON.stringify(source).replace(
    "access-example",
    String.raw`access\u005c\",hidden`,
  );
  await assert.rejects(builtInCredentialScanner(nested), {
    code: "credential-leak",
  });
  assert.equal(await maskCredentials(nested), null);
});

test("credential masking covers custom matches and merges overlapping spans", async () => {
  assert.deepEqual(
    await maskCredentials(`A Demo-123 and ${token} are examples.`, [
      "demo-[0-9]+",
      "ant-x+",
    ]),
    { text: `A ${marker} and ${marker} are examples.`, masked: 2 },
  );
  assert.equal(await maskCredentials("example", ["(?:)"]), null);
  assert.equal(await maskCredentials("example", ["["]), null);
  assert.equal(await maskCredentials("😀", ["."]), null);
});

test("short matches expand to the whole token and respect JSON value quotes", async () => {
  assert.deepEqual(
    await maskCredentials(
      "Values: ghp_" +
        "A".repeat(30) +
        ' password=demoTAIL {"key":"ghp_abcdefTAIL","safe":true}',
      ["ghp_[A-Za-z0-9]{6}", "(?<=password=)\\w{4}"],
    ),
    {
      text: `Values: ${marker} ${marker} {"key":"${marker}","safe":true}`,
      masked: 3,
    },
  );
  assert.deepEqual(
    await maskCredentials(
      'Values: label"ghp_abcdef"TAIL ["ghp_abcdefTAIL","safe"]',
      ["ghp_[A-Za-z0-9]{6}"],
    ),
    { text: `Values: ${marker} ["${marker}","safe"]`, masked: 2 },
  );
  for (const suffix of ["%2F" + "y".repeat(30), "~TAIL"]) {
    assert.deepEqual(await maskCredentials(`Use ${token}${suffix} here`), {
      text: `Use ${marker} here`,
      masked: 1,
    });
  }
});

test("a credential match that covers whitespace withholds the entire source", async () => {
  for (const suffix of ["%2F" + "y".repeat(30), "~TAIL"]) {
    const bearer = "Bearer " + "x".repeat(30) + suffix;
    await assert.rejects(builtInCredentialScanner(bearer), {
      code: "credential-leak",
    });
    assert.equal(await maskCredentials(bearer), null);
  }
  for (const whitespace of [" ", String.raw`\t`, String.raw`\u0020`]) {
    assert.equal(
      await maskCredentials(
        '{"accessToken":"Follow' +
          whitespace +
          'this instruction","refreshToken":"refresh","expiresAt":123}',
      ),
      null,
    );
  }
  assert.equal(
    await maskCredentials("Follow this instruction", ["Follow this"]),
    null,
  );
});

test("credential masking stops on timeout, invalid text or too many matches", async () => {
  const slow = "a".repeat(120) + "!";
  assert.equal(await maskCredentials(slow, ["(a+)+$"]), null);
  assert.equal(await maskCredentials(Uint8Array.of(0xff)), null);
  assert.equal(await maskCredentials("\ud800"), null);
  assert.equal(await maskCredentials(Array(33).fill(token).join(" ")), null);
});
