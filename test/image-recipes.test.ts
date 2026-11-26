import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import {
  BUILD_SCRIPT,
  ALPINE_3_23,
  DEBIAN_FEATURES,
  DEBIAN_TRIXIE,
  FEATURES,
  PROFILE_RECIPES,
  aptPackages,
  buildEgress,
  smokeTest,
  profileFiles,
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
    assert.deepEqual(
      new Map(pkgs.map(({ name, sha256 }) => [name, sha256])),
      new Map(
        [
          ...FEATURES.sqlite.packages,
          ...FEATURES.postgres.packages,
          ...FEATURES.git.packages,
        ].map(({ name, sha256 }) => [name, sha256]),
      ),
    );
  });

  test("recipe digest is stable and sensitive", () => {
    const first = recipeDigest("db");
    assert.match(first, /^[0-9a-f]{64}$/);
    assert.equal(recipeDigest("db"), first);
    const feature = FEATURES.git.packages[0] as { sha256: string };
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

  test("existing recipe digests match the checked-in profile lock", () => {
    const lock = parseProfileLock(
      readFileSync(
        new URL("../images/profiles.lock.json", import.meta.url),
        "utf8",
      ),
    );
    for (const name of ["db", "browser", "concierge"]) {
      assert.equal(recipeDigest(name), lock.profiles[name]?.recipeDigest, name);
    }
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
    assert.match(script, /postgres:[^\n]+20779:[^\n]+\/etc\/shadow/);
  });

  test("db smoke checks Git after SQLite and Postgres", () => {
    const smoke = smokeTest("db");
    assert.equal(
      smoke.script.split("\n").at(-1),
      "git --version >/dev/null && echo git-ok",
    );
    assert.deepEqual(smoke.expected, ["1", "1", "git-ok"]);
  });

  test("concierge pins the offline vsock relay, zstd, and Git packages", () => {
    assert.deepEqual(PROFILE_RECIPES.concierge, {
      base: ALPINE_3_23,
      features: ["vsock-relay", "zstd", "git"],
      memoryMiB: 1024,
      cpus: 2,
    });
    const packages = profilePackages("concierge");
    const pins = new Map(packages.map(({ name, sha256 }) => [name, sha256]));
    assert.equal(pins.size, packages.length);
    const readlinePins = FEATURES.sqlite.packages.filter(({ name }) =>
      /^(readline|libncursesw|ncurses-terminfo-base)-/.test(name),
    );
    assert.deepEqual(
      readlinePins.map(({ name }) => name),
      [
        "readline-8.3.1-r0.apk",
        "libncursesw-6.5_p20251123-r0.apk",
        "ncurses-terminfo-base-6.5_p20251123-r0.apk",
      ],
    );
    assert.deepEqual(
      pins,
      new Map([
        [
          "socat-1.8.1.3-r0.apk",
          "e415cdf30d41bbf4053ab52eb71c55fb9f5c3b811cd53cf22182960888186cbf",
        ],
        [
          "libssl3-3.5.9-r1.apk",
          "c6e06484ab80e8c575b4c3c0e0cea34b350d8cbd35406e59e186ee1a3e0ebedf",
        ],
        [
          "libcrypto3-3.5.9-r1.apk",
          "719af95f8e01494aa8dd0e06e3af6d0eaf96cb816d13c52c81628e2780c1adae",
        ],
        [
          "zstd-libs-1.6.0-r1.apk",
          "621c9247644e398fd3d32bba10fbf68c18f05b7941f1d055c4d48311fbfa9673",
        ],
        ...readlinePins.map(({ name, sha256 }) => [name, sha256] as const),
        ...FEATURES.git.packages.map(
          ({ name, sha256 }) => [name, sha256] as const,
        ),
      ]),
    );
    assert.deepEqual(buildEgress("concierge"), []);
  });

  test("concierge smoke checks socat and Git", () => {
    assert.deepEqual(smokeTest("concierge"), {
      script: [
        "socat -V >/dev/null && echo socat-ok",
        "git --version >/dev/null && echo git-ok",
      ].join("\n"),
      expected: ["socat-ok", "git-ok"],
    });
  });

  test("bun pins an offline archive, installs Bun and checks Bun and Git", () => {
    assert.deepEqual(PROFILE_RECIPES.bun, {
      base: ALPINE_3_23,
      features: ["bun", "zstd", "git"],
      memoryMiB: 2048,
      cpus: 2,
    });
    const [archive] = profileFiles("bun");
    assert.deepEqual(archive, {
      name: "bun-linux-aarch64-musl.zip",
      source: ".local/bun/1.4.5/bun-linux-aarch64-musl.zip",
      sha256:
        "d655765d3a0c0fdf707e27c7aa1a4f2c84f1bbc1f759db7e6e3d3c5be414396c",
    });
    const pin = FEATURES.bun.files[0] as { sha256: string };
    const original = pin.sha256;
    const digest = recipeDigest("bun");
    try {
      pin.sha256 = "0".repeat(64);
      assert.notEqual(recipeDigest("bun"), digest);
    } finally {
      pin.sha256 = original;
    }
    assert.deepEqual(buildEgress("bun"), []);
    const script = BUILD_SCRIPT("bun");
    assert.match(script, /busybox unzip -p .* > \/usr\/local\/bin\/bun/);
    assert.match(script, /sha256sum -c -\nchmod 0755 \/usr\/local\/bin\/bun/);
    assert.match(script, /ln -s bun \/usr\/local\/bin\/bunx/);
    assert.deepEqual(smokeTest("bun"), {
      script: "bun --version\ngit --version >/dev/null && echo git-ok",
      expected: ["1.4.5", "git-ok"],
    });
    const entry = lockEntry("bun", DIGEST);
    const lock = parseProfileLock(
      JSON.stringify({ version: 1, profiles: { bun: entry } }),
    );
    assert.equal(profileCatalog(BASE, lock).get("bun").image, entry.image);
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
    const packages = profilePackages("db");
    sqlite.push({ ...item });
    try {
      assert.deepEqual(profilePackages("db"), packages);
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

  test("build script verifies exactly the pinned InRelease files before installing", () => {
    const lines = BUILD_SCRIPT("browser").split("\n");
    const update = lines.findIndex((line) => line.startsWith("apt-get update"));
    const check = lines.indexOf("  | sha256sum -c -");
    const install = lines.findIndex((line) => line.includes("apt-get install"));
    const lists = "/var/lib/apt/lists/snapshot.debian.org_archive";
    const ts = DEBIAN_TRIXIE.snapshot;
    assert.ok(update >= 0 && update < check && check < install);
    assert.deepEqual(lines.slice(update + 1, check), [
      "printf '%s  %s\\n' \\",
      `  'bfacad4ca61899ce20d4a0d439f29339f66541561b67506364efb88e27dee870' '${lists}_debian_${ts}_dists_trixie_InRelease' \\`,
      `  '655abcf3a2226cfd3accdb1ef6500e1b4e02d1d3962e1eb3b2b5dd6258b1c45c' '${lists}_debian_${ts}_dists_trixie-updates_InRelease' \\`,
      `  '092d249a34e1f705cc3038efbe16f9ae27dd6b9efc84618d2b6ffb0f1c604575' '${lists}_debian-security_${ts}_dists_trixie-security_InRelease' \\`,
    ]);
  });

  test("the browser recipe digest changes when an InRelease pin changes", () => {
    const first = recipeDigest("browser");
    const release = DEBIAN_TRIXIE.inRelease[0] as { sha256: string };
    const saved = release.sha256;
    release.sha256 = "0".repeat(64);
    try {
      assert.notEqual(recipeDigest("browser"), first);
    } finally {
      release.sha256 = saved;
    }
    assert.equal(recipeDigest("browser"), first);
  });

  test("egress is limited to DNS and the snapshot host", () => {
    assert.deepEqual(buildEgress("browser"), [
      { hostname: "snapshot.debian.org", port: 80 },
    ]);
    assert.deepEqual(buildEgress("db"), []);
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
