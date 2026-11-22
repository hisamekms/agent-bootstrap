import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  BUILD_SCRIPT,
  DEBIAN_FEATURES,
  DEBIAN_TRIXIE,
  FEATURES,
  aptPackages,
  buildNetRules,
  smokeTest,
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

  test("build script excludes runtime state and resets DNS config", () => {
    const script = BUILD_SCRIPT("db");
    assert.ok(script.includes(": > /etc/resolv.conf"));
    assert.ok(script.includes("proc|sys|dev|tmp|.msb) ;;"));
    assert.ok(script.includes("--exclude run/microsandbox"));
    assert.ok(!script.includes("$(ls"));
  });

  test("postgres helper chowns only in the root branch", () => {
    const setup = (FEATURES.postgres as { setup: string }).setup;
    const chowns = setup
      .split("\n")
      .filter((l) => l.includes('chown postgres:postgres "$data"'));
    assert.equal(chowns.length, 1);
    assert.ok(setup.includes('if [ "$(id -u)" = 0 ]; then\n  chown postgres'));
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

const PACKAGES = ["git=1:2.47.3-0+deb13u1", "sqlite3=3.46.1-7+deb13u2"];

function browserLock(
  patch: (e: Record<string, unknown>) => void = () => {},
  packages: readonly string[] | null = PACKAGES,
) {
  const entry: Record<string, unknown> = {
    ...lockEntry("browser", DIGEST, packages ?? undefined),
  };
  patch(entry);
  return JSON.stringify({ version: 1, profiles: { browser: entry } });
}

describe("browser recipe (Debian snapshot)", () => {
  test("digests differ per profile and react to snapshot and apt names", () => {
    const first = recipeDigest("browser");
    assert.match(first, /^[0-9a-f]{64}$/);
    assert.notEqual(first, recipeDigest("db"));
    const base = DEBIAN_TRIXIE as { snapshot: string };
    const saved = base.snapshot;
    base.snapshot = "20260101T000000Z";
    try {
      assert.notEqual(recipeDigest("browser"), first);
    } finally {
      base.snapshot = saved;
    }
    const git = DEBIAN_FEATURES.git as unknown as { apt: string[] };
    git.apt.push("tig");
    try {
      assert.notEqual(recipeDigest("browser"), first);
    } finally {
      git.apt.pop();
    }
    assert.equal(recipeDigest("browser"), first);
    assert.deepEqual(aptPackages("browser"), [
      "chromium",
      "fonts-liberation",
      "git",
      "postgresql",
      "sqlite3",
    ]);
  });

  test("build script pins the snapshot and installs signed packages", () => {
    const script = BUILD_SCRIPT("browser");
    const ts = DEBIAN_TRIXIE.snapshot;
    assert.ok(
      script.includes(`URIs: http://snapshot.debian.org/archive/debian/${ts}/`),
    );
    assert.ok(
      script.includes(
        `URIs: http://snapshot.debian.org/archive/debian-security/${ts}/`,
      ),
    );
    assert.ok(script.includes("Suites: trixie trixie-updates"));
    assert.ok(script.includes("Suites: trixie-security"));
    assert.ok(
      script.includes(
        "Signed-By: /usr/share/keyrings/debian-archive-keyring.gpg",
      ),
    );
    assert.ok(script.includes("Check-Valid-Until"));
    assert.ok(script.includes("--no-install-recommends"));
    assert.ok(script.includes("apt-get clean"));
    assert.ok(script.includes("rm -rf /var/lib/apt/lists/*"));
    assert.ok(script.includes(": > /etc/machine-id"));
    assert.ok(script.includes(": > /etc/resolv.conf"));
    assert.ok(script.includes("/etc/agent-bootstrap-packages.txt"));
    assert.ok(script.includes("--exclude run/microsandbox"));
    assert.ok(!script.includes("trusted=yes"));
    assert.ok(!script.includes("--allow-unauthenticated"));
    assert.ok(!script.includes("apk "));
  });

  test("egress is limited to DNS and the snapshot host", () => {
    assert.deepEqual(buildNetRules("browser"), [
      "allow@dns",
      "allow@snapshot.debian.org:tcp:80",
    ]);
    assert.deepEqual(buildNetRules("db"), []);
    assert.throws(() => profilePackages("browser"), /not an Alpine/);
    assert.throws(() => aptPackages("db"), /not a Debian/);
  });

  test("chromium and postgres helpers are installed", () => {
    const script = BUILD_SCRIPT("browser");
    assert.ok(script.includes("/usr/local/bin/agent-bootstrap-chromium"));
    assert.ok(script.includes("--no-sandbox"));
    assert.ok(script.includes("PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1"));
    assert.ok(script.includes("/usr/lib/postgresql/17/bin"));
    assert.deepEqual(smokeTest("browser").expected, [
      "1",
      "1",
      "browser-ok",
      "git-ok",
    ]);
    assert.deepEqual(smokeTest("db").expected, ["1", "1"]);
  });

  test("lock with and without packages", () => {
    const withList = parseProfileLock(browserLock());
    assert.deepEqual(withList.profiles["browser"]?.packages, PACKAGES);
    const catalog = profileCatalog(BASE, withList);
    assert.equal(catalog.get("browser").memoryMiB, 2048);
    const without = parseProfileLock(browserLock(() => {}, null));
    assert.equal(without.profiles["browser"]?.packages, undefined);
  });

  test("bad package lists are rejected", () => {
    const bad = (list: unknown) =>
      assert.throws(() =>
        parseProfileLock(browserLock((e) => (e["packages"] = list))),
      );
    bad("git=1");
    bad([]);
    bad(["Git=1"]);
    bad(["git"]);
    bad(["git=1 2"]);
    bad([PACKAGES[1], PACKAGES[0]]);
    bad([PACKAGES[0], PACKAGES[0]]);
    bad(
      Array.from(
        { length: 2001 },
        (_, i) => `p${String(i).padStart(5, "0")}=1`,
      ),
    );
  });

  test("packages are refused on Alpine profiles", () => {
    assert.throws(() => lockEntry("db", DIGEST, PACKAGES), /not allowed/);
    assert.throws(() =>
      parseProfileLock(lockText((e) => (e["packages"] = PACKAGES))),
    );
  });
});
