import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import {
  parseObservabilityConfig,
  requireAudited,
} from "../src/observability-config.ts";
import type { SandboxSpec } from "../src/sandbox-runtime.ts";

let workspace: string;
let directory: string;
let roots: { msbHome: string; stagingRoot: string };

beforeEach(() => {
  workspace = realpathSync(mkdtempSync(join(tmpdir(), "obs-config-")));
  directory = join(workspace, "observability");
  roots = {
    msbHome: join(workspace, "msb"),
    stagingRoot: join(workspace, "staging"),
  };
});

afterEach(() => rmSync(workspace, { recursive: true, force: true }));

test("defaults to required audit and enabled telemetry", () => {
  assert.deepEqual(parseObservabilityConfig({ directory }, roots), {
    directory,
    audit: { mode: "required" },
    telemetry: {
      enabled: true,
      resourceSamplingIntervalMs: 1000,
      traceSamplingRatio: 1,
    },
  });
});

test("disabling telemetry preserves both audit modes", () => {
  for (const audit of [{ mode: "required" }, { mode: "disabled" }]) {
    const config = parseObservabilityConfig(
      { directory, audit, telemetry: { enabled: false } },
      roots,
    );
    assert.equal(config.telemetry.enabled, false);
    assert.deepEqual(config.audit, audit);
  }
  assert.equal(
    parseObservabilityConfig(
      { directory, telemetry: { enabled: false } },
      roots,
    ).audit.mode,
    "required",
  );
});

test("accepts inclusive telemetry bounds and rejects invalid values", () => {
  for (const telemetry of [
    { resourceSamplingIntervalMs: 250, traceSamplingRatio: 0 },
    { resourceSamplingIntervalMs: 60_000, traceSamplingRatio: 1 },
    { resourceSamplingIntervalMs: 1_500, traceSamplingRatio: 0.5 },
  ]) {
    assert.deepEqual(
      parseObservabilityConfig({ directory, telemetry }, roots).telemetry,
      { enabled: true, ...telemetry },
    );
  }
  for (const resourceSamplingIntervalMs of [
    249,
    60_001,
    Infinity,
    NaN,
    "1000",
    null,
  ]) {
    assert.throws(
      () =>
        parseObservabilityConfig(
          { directory, telemetry: { resourceSamplingIntervalMs } },
          roots,
        ),
      /telemetry\.resourceSamplingIntervalMs/,
    );
  }
  for (const traceSamplingRatio of [-0.01, 1.01, Infinity, NaN, "1", null]) {
    assert.throws(
      () =>
        parseObservabilityConfig(
          { directory, telemetry: { traceSamplingRatio } },
          roots,
        ),
      /telemetry\.traceSamplingRatio/,
    );
  }
});

test("rejects malformed config and an opt-in embedded in config", () => {
  for (const input of [
    null,
    { directory, audit: null },
    { directory, audit: { mode: "optional" } },
    { directory, telemetry: [] },
    { directory, telemetry: { enabled: "false" } },
    { directory, allowUnauditedRun: true },
    { directory, audit: { mode: "disabled", allowUnauditedRun: true } },
    {
      directory,
      audit: {
        get mode() {
          return assert.fail("config must not invoke an accessor");
        },
      },
    },
  ]) {
    assert.throws(() => parseObservabilityConfig(input, roots), TypeError);
  }
});

test("rejects invalid paths and paths inside either protected root", () => {
  for (const path of [
    "",
    "relative",
    directory + "\0",
    roots.msbHome,
    roots.msbHome + "/nested/",
    roots.stagingRoot,
    join(roots.stagingRoot, "nested"),
    directory + "/../staging/nested",
  ]) {
    assert.throws(
      () => parseObservabilityConfig({ directory: path }, roots),
      /Invalid observability config: directory/,
    );
  }
  const sibling = roots.msbHome + "-observability";
  assert.equal(
    parseObservabilityConfig({ directory: sibling }, roots).directory,
    sibling,
  );
});

test("handles aliases of the directory and protected roots through existing symlinks", () => {
  mkdirSync(roots.msbHome);
  mkdirSync(roots.stagingRoot);
  const alias = join(workspace, "alias");
  const stagingAlias = join(workspace, "staging-alias");
  symlinkSync(roots.msbHome, alias, "dir");
  symlinkSync(roots.stagingRoot, stagingAlias, "dir");
  assert.throws(
    () =>
      parseObservabilityConfig(
        { directory: join(alias, "missing", "nested") },
        roots,
      ),
    /protected root/,
  );
  assert.throws(
    () =>
      parseObservabilityConfig(
        { directory: join(roots.stagingRoot, "missing") },
        { ...roots, stagingRoot: stagingAlias },
      ),
    /protected root/,
  );
  symlinkSync(join(workspace, "missing-target"), directory, "dir");
  assert.throws(
    () =>
      parseObservabilityConfig(
        { directory: join(directory, "missing") },
        roots,
      ),
    /Invalid observability config: directory/,
  );
});

test("requires an explicit opt-in for each unaudited agent spec", () => {
  const disabled = parseObservabilityConfig(
    { directory, audit: { mode: "disabled" } },
    roots,
  );
  const required = parseObservabilityConfig(
    { directory, telemetry: { enabled: false } },
    roots,
  );
  const agentSpecs: SandboxSpec[] = [
    { provider: { host: "provider.example", secretEnv: "MODEL_API_KEY" } },
    { tools: [] },
    { repository: { gitDir: "/fixture/repo", tree: "/fixture/tree.tar" } },
  ];
  for (const spec of agentSpecs) {
    assert.doesNotThrow(() => requireAudited(spec, required));
    assert.throws(() => requireAudited(spec, disabled), /allowUnauditedRun/);
    assert.throws(
      () => requireAudited(spec, disabled, { allowUnauditedRun: false }),
      /allowUnauditedRun/,
    );
    assert.doesNotThrow(() =>
      requireAudited(spec, disabled, { allowUnauditedRun: true }),
    );
  }
  assert.doesNotThrow(() => requireAudited({ files: [] }, disabled));
});

test("does not accept inherited, accessor, or truthy non-boolean opt-ins", () => {
  const config = parseObservabilityConfig(
    { directory, audit: { mode: "disabled" } },
    roots,
  );
  const spec = { tools: [] };
  const accessor = {
    get allowUnauditedRun(): boolean {
      return assert.fail("guard must not invoke an accessor");
    },
  };
  for (const options of [
    Object.create({ allowUnauditedRun: true }) as typeof accessor,
    accessor,
    { allowUnauditedRun: "true" } as unknown as typeof accessor,
  ]) {
    assert.throws(
      () => requireAudited(spec, config, options),
      /allowUnauditedRun/,
    );
  }
});
