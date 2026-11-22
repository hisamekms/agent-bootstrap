import assert from "node:assert/strict";
import test from "node:test";
import {
  PROFILE_NAMES,
  ProfileCatalog,
  ROLE_PROFILES,
  type SandboxProfile,
} from "../src/sandbox-profiles.ts";
import { SandboxRuntimeError } from "../src/sandbox-runtime.ts";

const digest = "a".repeat(64);
const image = `fixture.invalid/alpine@sha256:${digest}`;

function refused(build: () => unknown) {
  assert.throws(
    build,
    (error: unknown) =>
      error instanceof SandboxRuntimeError && error.code === "invalid-input",
  );
}

test("catalog requires base and rejects unknown names and fields", () => {
  refused(() => new ProfileCatalog({}));
  refused(() => new ProfileCatalog({ db: { image } }));
  refused(
    () => new ProfileCatalog({ base: { image }, gpu: { image } } as never),
  );
  refused(() => new ProfileCatalog({ base: { image, extra: 1 } } as never));
  refused(() => new ProfileCatalog(null as never));
  refused(() => new ProfileCatalog({ base: null } as never));
});

test("catalog requires digest-pinned images", () => {
  for (const bad of [
    "alpine:latest",
    `alpine@sha256:${"a".repeat(63)}`,
    `alpine@sha256:${"A".repeat(64)}`,
    `alpine@sha256:${digest}\n`,
    "",
    1,
  ])
    refused(() => new ProfileCatalog({ base: { image: bad as string } }));
});

test("catalog bounds memory and cpus to integers", () => {
  for (const memoryMiB of [255, 8193, 512.5, Number.NaN, "512"])
    refused(
      () =>
        new ProfileCatalog({ base: { image, memoryMiB: memoryMiB as number } }),
    );
  for (const cpus of [0, 9, 1.5, Number.POSITIVE_INFINITY, "2"])
    refused(
      () => new ProfileCatalog({ base: { image, cpus: cpus as number } }),
    );
  const edge = new ProfileCatalog({
    base: { image, memoryMiB: 256, cpus: 1 },
    db: { image, memoryMiB: 8192, cpus: 8 },
  });
  assert.equal(edge.get("db").cpus, 8);
});

test("catalog copies and freezes its input", () => {
  const input: { base: SandboxProfile; db?: SandboxProfile } = {
    base: { image, memoryMiB: 512 },
  };
  const catalog = new ProfileCatalog(input);
  (input.base as { image: string }).image = "alpine:latest";
  (input.base as { memoryMiB?: number }).memoryMiB = 99999;
  input.db = { image };
  assert.equal(catalog.get("base").image, image);
  assert.equal(catalog.get("base").memoryMiB, 512);
  assert.equal(catalog.has("db"), false);
  assert.ok(Object.isFrozen(catalog.get("base")));
  assert.throws(() => {
    (catalog.get("base") as { image: string }).image = "x";
  });
});

test("has, get and imageDigest", () => {
  const catalog = new ProfileCatalog({ base: { image } });
  assert.equal(catalog.has("base"), true);
  assert.equal(catalog.has("db"), false);
  assert.equal(catalog.has("nope"), false);
  assert.equal(catalog.has(undefined), false);
  assert.equal(catalog.imageDigest("base"), digest);
  refused(() => catalog.get("db"));
  refused(() => catalog.imageDigest("browser"));
});

test("role profiles are fixed and deeply frozen", () => {
  assert.deepEqual(PROFILE_NAMES, ["base", "db", "browser"]);
  for (const role of ["Coordinator", "Planner", "Reviewer"] as const)
    assert.deepEqual(ROLE_PROFILES[role], ["base"]);
  for (const role of ["Worker", "Verification"] as const)
    assert.deepEqual(ROLE_PROFILES[role], ["base", "db", "browser"]);
  assert.ok(Object.isFrozen(ROLE_PROFILES));
  for (const list of Object.values(ROLE_PROFILES))
    assert.ok(Object.isFrozen(list));
});
