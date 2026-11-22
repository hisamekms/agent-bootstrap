import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  BUILD_SCRIPT,
  FEATURES,
  profilePackages,
  recipeDigest,
} from "../src/image-recipes.ts";
import {
  lockEntry,
  parseProfileLock,
  profileCatalog,
} from "../src/profile-lock.ts";

const DIGEST = "a".repeat(64);
const BASE = `docker.io/library/alpine@sha256:${"b".repeat(64)}`;

function lockText(patch: (e: Record<string, unknown>) => void = () => {}) {
  const entry: Record<string, unknown> = { ...lockEntry("db", DIGEST) };
  patch(entry);
  return JSON.stringify({ version: 1, profiles: { db: entry } });
}

describe("image recipes", () => {
  test("packages are the sorted union without duplicates", () => {
    const pkgs = profilePackages("db");
    const names = pkgs.map((p) => p.name);
    assert.deepEqual(names, [...new Set(names)].sort());
    const total =
      FEATURES.sqlite.packages.length + FEATURES.postgres.packages.length;
    assert.equal(pkgs.length, total);
  });

  test("recipe digest is stable and sensitive", () => {
    const first = recipeDigest("db");
    assert.match(first, /^[0-9a-f]{64}$/);
    assert.equal(recipeDigest("db"), first);
    const feature = FEATURES.sqlite.packages[0] as { sha256: string };
    const saved = feature.sha256;
    feature.sha256 = "0".repeat(64);
    try {
      assert.notEqual(recipeDigest("db"), first);
    } finally {
      feature.sha256 = saved;
    }
    const pg = FEATURES.postgres as { setup: string };
    const setup = pg.setup;
    pg.setup = `${setup}\ntrue`;
    try {
      assert.notEqual(recipeDigest("db"), first);
    } finally {
      pg.setup = setup;
    }
    assert.equal(recipeDigest("db"), first);
  });

  test("conflicting digests for one file are rejected", () => {
    const item = FEATURES.postgres.packages[0] as { name: string };
    const sqlite = FEATURES.sqlite.packages as unknown as {
      name: string;
      sha256: string;
    }[];
    sqlite.push({ name: item.name, sha256: "1".repeat(64) });
    try {
      assert.throws(() => profilePackages("db"), /Conflicting/);
    } finally {
      sqlite.pop();
    }
  });

  test("build script installs offline and signed only", () => {
    const script = BUILD_SCRIPT("db");
    assert.ok(!script.includes("--allow-untrusted"));
    assert.ok(script.includes("--no-network"));
    assert.ok(script.includes("agent-bootstrap-postgres"));
  });
});

describe("profile lock", () => {
  test("valid lock parses and builds a catalog", () => {
    const lock = parseProfileLock(lockText());
    const catalog = profileCatalog(`alpine@sha256:${"b".repeat(64)}`, lock);
    assert.equal(
      catalog.get("db").image,
      `localhost/agent-bootstrap/db@sha256:${DIGEST}`,
    );
    assert.equal(catalog.get("db").memoryMiB, 1024);
    assert.equal(catalog.get("db").cpus, 2);
    assert.equal(catalog.has("base"), true);
    assert.equal(profileCatalog(BASE).has("db"), false);
  });

  test("stale digest is rejected", () => {
    assert.throws(
      () =>
        parseProfileLock(lockText((e) => (e["recipeDigest"] = "0".repeat(64)))),
      /stale for db/,
    );
  });

  test("bad image, extra keys, unknown profile, wrong limits", () => {
    assert.throws(() =>
      parseProfileLock(lockText((e) => (e["image"] = `x/db@sha256:${DIGEST}`))),
    );
    assert.throws(() => parseProfileLock(lockText((e) => (e["extra"] = 1))));
    assert.throws(() =>
      parseProfileLock(lockText((e) => (e["memoryMiB"] = 512))),
    );
    const text = JSON.parse(lockText()) as {
      profiles: Record<string, unknown>;
    };
    text.profiles["browser"] = text.profiles["db"];
    assert.throws(() => parseProfileLock(JSON.stringify(text)));
    assert.throws(() =>
      parseProfileLock(JSON.stringify({ ...text, version: 1, extra: true })),
    );
  });
});

describe("dedupe", () => {
  test("the same file with the same digest is listed once", () => {
    const item = FEATURES.postgres.packages[0] as {
      name: string;
      sha256: string;
    };
    const sqlite = FEATURES.sqlite.packages as unknown as {
      name: string;
      sha256: string;
    }[];
    sqlite.push({ ...item });
    try {
      assert.equal(profilePackages("db").length, 20);
    } finally {
      sqlite.pop();
    }
  });
});
