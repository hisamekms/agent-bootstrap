import assert from "node:assert/strict";
import test from "node:test";
import { RoutingSandboxRuntime } from "../src/routing-runtime.ts";
import type { SandboxRuntime } from "../src/sandbox-runtime.ts";

function fake(name: string, calls: string[]): SandboxRuntime {
  return {
    async create() {
      calls.push(`${name}:create`);
      return { id: name };
    },
    async exec() {
      calls.push(`${name}:exec`);
      return {
        status: "exited",
        exitCode: 0,
        stdout: new Uint8Array(),
        stderr: new Uint8Array(),
      };
    },
    async collect() {
      calls.push(`${name}:collect`);
      return { files: [] };
    },
    async destroy() {
      calls.push(`${name}:destroy`);
    },
  };
}

const openai = { host: "api.openai.com", secretEnv: "AGENT_BOOTSTRAP_TOKEN" };
const anthropic = {
  host: "api.anthropic.com",
  secretEnv: "ANTHROPIC_API_KEY",
  header: "x-api-key" as const,
};

test("sandboxes go to the runtime bound to their provider, and unknown providers are refused", async () => {
  const calls: string[] = [];
  const runtime = new RoutingSandboxRuntime([
    { runtime: fake("plain", calls) },
    { provider: openai, runtime: fake("openai", calls) },
    { provider: anthropic, runtime: fake("anthropic", calls) },
  ]);
  for (const spec of [
    {},
    { provider: { ...openai, header: "authorization" as const, port: 443 } },
    { provider: anthropic },
  ]) {
    const handle = await runtime.create(spec);
    await runtime.exec(handle, { argv: ["x"], timeoutMs: 10 });
    await runtime.destroy(handle);
  }
  assert.deepEqual(calls, [
    "plain:create",
    "plain:exec",
    "plain:destroy",
    "openai:create",
    "openai:exec",
    "openai:destroy",
    "anthropic:create",
    "anthropic:exec",
    "anthropic:destroy",
  ]);
  await assert.rejects(
    runtime.create({ provider: { ...anthropic, header: "authorization" } }),
    /invalid-input/,
  );
  await assert.rejects(
    runtime.exec({ id: "forged" }, { argv: ["x"], timeoutMs: 10 }),
    /unknown-handle/,
  );
  assert.throws(
    () =>
      new RoutingSandboxRuntime([
        { provider: openai, runtime: fake("a", calls) },
        { provider: openai, runtime: fake("b", calls) },
      ]),
    /invalid-input/,
  );
});

test("bound creation routes by provider and retains ownership by handle", async () => {
  const calls: string[] = [];
  const digest = "a".repeat(64);
  const audited = (name: string): SandboxRuntime => ({
    ...fake(name, calls),
    netRuleDigest: () => digest,
    async createBound(spec, sandboxId) {
      assert.equal(spec.expectedNetRuleDigest, digest);
      calls.push(`${name}:createBound:${sandboxId}`);
      return { id: sandboxId, netRuleDigest: digest };
    },
  });
  const runtime = new RoutingSandboxRuntime([
    { runtime: audited("plain") },
    { provider: openai, runtime: audited("openai") },
    { provider: anthropic, runtime: fake("anthropic", calls) },
  ]);
  const spec = { expectedNetRuleDigest: digest };
  const plain = await runtime.createBound(spec, "bound-plain");
  const credentialed = await runtime.createBound(
    { ...spec, provider: openai },
    "bound-openai",
  );
  assert.deepEqual(credentialed, { id: "bound-openai", netRuleDigest: digest });
  await assert.rejects(runtime.destroy({ ...credentialed }), /unknown-handle/);
  await assert.rejects(
    runtime.createBound({ ...spec, provider: anthropic }, "bound-anthropic"),
    /unsupported/,
  );
  await runtime.exec(credentialed, { argv: ["x"], timeoutMs: 10 });
  await runtime.destroy(plain);
  await runtime.destroy(credentialed);
  assert.deepEqual(calls, [
    "plain:createBound:bound-plain",
    "openai:createBound:bound-openai",
    "openai:exec",
    "plain:destroy",
    "openai:destroy",
  ]);
});
