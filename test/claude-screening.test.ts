import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { classifyClaudeFailure } from "../src/local-orchestrator/claude-errors.ts";
import {
  configuredCredentialScanner,
  createCredentialScanner,
  requireCredentialScan,
} from "../src/local-orchestrator/credential-scan.ts";

function fixture(t: TestContext) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "lo-claude-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

test("Claude errors classify generic failures and bound operator regex execution", async () => {
  const cliResult = (result: string) =>
    Buffer.from(JSON.stringify({ result, is_error: true }));
  for (const [result, code] of [
    ["HTTP 403", "auth-required"],
    ["Authentication failed", "auth-required"],
    ["HTTP 429", "rate-limited"],
    ["Usage limit reached", "rate-limited"],
    ["Invalid configuration", "config-invalid"],
  ] as const)
    assert.equal(await classifyClaudeFailure(cliResult(result), []), code);
  assert.equal(
    await classifyClaudeFailure(cliResult("fixture error"), [
      { match: "fixture", code: "config-invalid" },
    ]),
    "config-invalid",
  );
  assert.equal(
    await classifyClaudeFailure(cliResult("a".repeat(8191) + "x"), [
      { match: "^(a+)+$", code: "config-invalid" },
    ]),
    undefined,
  );
});

test("credential scans block credential shapes and operator patterns with fixed evidence", async (t) => {
  const root = fixture(t);
  const notes: string[] = [];
  const scan = createCredentialScanner(
    { leakPatterns: ["fixture-private-[0-9]+"] },
    root,
    (note) => notes.push(note),
  );
  await scan('+{"expiresAt":123}', "Public output");
  for (const text of [
    "sk-ant-YMStp5zxuHQ_WMoM6iRSLxLzrjTS",
    "fixture-private-123",
    "prefixsk-ant-YMStp5zxuHQ_WMoM6iRSLxLzrjTS",
  ]) {
    await assert.rejects(scan(text), { code: "credential-leak" });
    const path = notes.at(-1)!.replace("credential-leak evidence: ", "");
    assert.equal(readFileSync(path, "utf8"), '{"code":"credential-leak"}\n');
    assert.ok(!notes.join("\n").includes(text));
  }
});

test("target screening persists for later launches", async (t) => {
  const root = fixture(t);
  const env = { XDG_CONFIG_HOME: root, XDG_STATE_HOME: root };
  const note = () => {};
  assert.equal(configuredCredentialScanner(root, note, env), undefined);
  requireCredentialScan(root);
  requireCredentialScan(root);
  const scan = configuredCredentialScanner(root, note, env);
  assert.ok(scan);
  await assert.rejects(scan("sk-ant-Zew8qZHgxj2uI9yksWwEWP8AnaT"), {
    code: "credential-leak",
  });
});

test("failed evidence writes preserve the fixed refusal code", async (t) => {
  const root = fixture(t);
  const blocked = join(root, "not-a-directory");
  writeFileSync(blocked, "");
  const notes: string[] = [];
  const scan = createCredentialScanner({}, blocked, (note) => notes.push(note));
  await assert.rejects(scan("sk-ant-Fek8A13O5I6CyJCHuZmFL5k5vRu"), {
    code: "credential-leak",
  });
  assert.deepEqual(notes, ["credential-leak evidence could not be written."]);
});
