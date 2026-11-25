import { createHash } from "node:crypto";
import type { ProfileName } from "./sandbox-profiles.ts";

/** Alpine 3.23 base image and where its signed packages are kept (relative to
 * the repository root). */
export const ALPINE_3_23 = {
  kind: "alpine",
  reference:
    "docker.io/library/alpine@sha256:5dda816445facf5f7282dc7689a333278834c74265ba25db2e2eb90509e3a9dd",
  packageDir: ".local/alpine/v3.23/main/aarch64",
} as const;

/** Debian 13 (trixie) slim. Packages come from one fixed snapshot.debian.org
 * timestamp; the build VM may reach only `egress` (host:port, TCP). */
export const DEBIAN_TRIXIE = {
  kind: "debian-snapshot",
  reference:
    "docker.io/library/debian@sha256:24a01011d10eba3a023bc8585b9650b8b29021240d4217c05b905e09ef4a5232",
  snapshot: "20261120T000000Z",
  inRelease: [
    {
      archive: "debian",
      suite: "trixie",
      sha256:
        "0584fba32e13e0ab8285fb16c27adea1ec03a73669c18702821094fd6ca86675",
    },
    {
      archive: "debian",
      suite: "trixie-updates",
      sha256:
        "6f57bff7c8bf51425b0d654b57a93a8cf83f07a6a5d6116ee766f4612336c642",
    },
    {
      archive: "debian-security",
      suite: "trixie-security",
      sha256:
        "d0b3748b4eb57be9fe9c58b867fe6f1634863313af007d47767658a0fd7abd90",
    },
  ],
  egress: "snapshot.debian.org:80",
} as const;

export interface PinnedPackage {
  readonly name: string;
  readonly sha256: string;
}

export interface PinnedFile {
  readonly name: string;
  /** Path relative to the repository root. */
  readonly source: string;
  readonly sha256: string;
}

export interface Feature {
  readonly packages: readonly PinnedPackage[];
  /** Non-apk inputs staged alongside the packages in /tmp/pkgs. */
  readonly files?: readonly PinnedFile[];
  /** Shell run in the build VM after the packages are installed. */
  readonly setup?: string;
}

function pkg(name: string, sha256: string): PinnedPackage {
  return { name, sha256 };
}

const POSTGRES_SETUP = `mkdir -p /run/postgresql
chown postgres:postgres /run/postgresql
chmod 2775 /run/postgresql
cat > /usr/local/bin/agent-bootstrap-postgres <<'AGENT_BOOTSTRAP_EOF'
#!/bin/sh
set -eu
data=$(mktemp -d /tmp/agent-bootstrap-pg.XXXXXX)
# As root, hand the directory to postgres. As non-root the caller must already
# be postgres (it owns the new directory), so no chown is attempted.
as_postgres() {
  if [ "$(id -u)" = 0 ]; then
    su -s /bin/sh -c "$1" postgres
  else
    /bin/sh -c "$1"
  fi
}
# $data is a mktemp path made of fixed characters, so it is safe to expand.
if [ "$(id -u)" = 0 ]; then
  chown postgres:postgres "$data"
fi
as_postgres "initdb -D '$data/db' -A trust -U postgres --no-instructions" >/dev/null 2>&1
as_postgres "pg_ctl -D '$data/db' -o '-c listen_addresses=127.0.0.1 -c port=5432 -c unix_socket_directories=/run/postgresql' -w -t 60 -l '$data/log' start" >/dev/null 2>&1

printf '%s\\n' 'postgresql://postgres@127.0.0.1:5432/postgres'
AGENT_BOOTSTRAP_EOF
chmod 0755 /usr/local/bin/agent-bootstrap-postgres
`;

const READLINE_PACKAGES = [
  pkg(
    "readline-8.3.1-r0.apk",
    "70d288a6c3d8daf19b10fb220120d2ebd6f154011c96ca5bc84923b658cb21f7",
  ),
  pkg(
    "libncursesw-6.5_p20251123-r0.apk",
    "7fe332c8af8b97579e89df56466f83f4abda5040a18e1842c07d684320bbef4b",
  ),
  pkg(
    "ncurses-terminfo-base-6.5_p20251123-r0.apk",
    "6952a6b39abaf7bbc498cb085f0f59bf23619b53b3f7328b08fe50c0198a2bd4",
  ),
] as const;

const ZSTD_PACKAGE = pkg(
  "zstd-libs-1.5.7-r2.apk",
  "50a998e56e4bf31504996e49c1b4a23eed5e0cd4e24b8a1356a54daf1a6eabbe",
);

const CXX_RUNTIME_PACKAGES = [
  pkg(
    "libgcc-15.2.0-r2.apk",
    "eaaafda78fde1c904e1741680ddea91649f051e29a343152c8a4327605704b0f",
  ),
  pkg(
    "libstdc++-15.2.0-r2.apk",
    "10d72e25f6fcc0f3d9fdd801c9bdaed81d6e836aa2b65b63f25d2d97f860a7d1",
  ),
] as const;

export const BUN_VERSION = "1.4.4";
const BUN_ARCHIVE = {
  name: "bun-linux-aarch64-musl.zip",
  source: `.local/bun/${BUN_VERSION}/bun-linux-aarch64-musl.zip`,
  sha256: "57f01b02ac7113c61c935f28f38c2eab849e3c970dab21f8b640a87b1ef65009",
} as const satisfies PinnedFile;
const BUN_BINARY_SHA256 =
  "a6a3d99a48600b59597070d2d2ff8d37b65975b8aab247ee3479b1eb33d000a6";
const BUN_SETUP = `mkdir -p /usr/local/bin
busybox unzip -p /tmp/pkgs/${BUN_ARCHIVE.name} bun-linux-aarch64-musl/bun > /usr/local/bin/bun
printf '%s  %s\\n' '${BUN_BINARY_SHA256}' /usr/local/bin/bun | sha256sum -c -
chmod 0755 /usr/local/bin/bun
ln -s bun /usr/local/bin/bunx
`;

export const FEATURES = {
  bun: {
    packages: CXX_RUNTIME_PACKAGES,
    files: [BUN_ARCHIVE],
    setup: BUN_SETUP,
  },
  sqlite: {
    packages: [
      pkg(
        "sqlite-3.53.4-r0.apk",
        "55c5f9d617818f75d0cdfafdc8054629988e5a39422f19357e6f7d82ae429502",
      ),
      ...READLINE_PACKAGES,
    ],
  },
  postgres: {
    packages: [
      pkg(
        "postgresql18-18.7-r0.apk",
        "1b0f34c582e96def6f8fae18f6c9ffdf4d40f3929a6bb5b2dd0db3cbbff9f4a0",
      ),
      pkg(
        "postgresql18-client-18.7-r0.apk",
        "a656485150f59096c095fc3799e64c743b8c0fcff3f6bc2efcdfa893d18ce8e4",
      ),
      pkg(
        "postgresql-common-1.2-r2.apk",
        "8c27827ea79b2b131508d70efea4076efac5f88291b25175bbd923f42c1d57f1",
      ),
      pkg(
        "lz4-libs-1.10.0-r0.apk",
        "5e03989d703634faa3222ec1e2a634393fd28a1114cf6d14eaf64a6d4b0354bd",
      ),
      pkg(
        "libpq-18.7-r0.apk",
        "135ed81b492273e4b50ab88dd64a9cde88cff24d3437c9e8d51aeab0332147b0",
      ),
      ZSTD_PACKAGE,
      pkg(
        "tzdata-2026f-r0.apk",
        "84cd4b6c03ba2d8a06570f0c14188022cb8ebc3274b8ed1cf02ce8881ee8bfdd",
      ),
      pkg(
        "icu-libs-76.1-r1.apk",
        "652915ddcaa46370bc5e0cade07b80497feddd85a4ac5631d9d0f82e1227e897",
      ),
      pkg(
        "icu-data-en-76.1-r1.apk",
        "1a072bb4a9a036a7fc239a94f9e691df059cecfbd92f2058bf4f261cc6636e00",
      ),
      ...CXX_RUNTIME_PACKAGES,
      pkg(
        "libldap-2.6.13-r0.apk",
        "c2808f6bf8129b11c727b356f99a476afc6e1cf8053ea5a1d7cbf368bf5e50b4",
      ),
      pkg(
        "libsasl-2.1.28-r9.apk",
        "459beb4929b2c05487ce4d832bb2f54b90af0ff5cd4d50947a5bff3ed9cbf3a3",
      ),
      pkg(
        "gdbm-1.26-r0.apk",
        "d8981e56b4c16722424ef642313bb710e42cc7181f204e14856a1f21887adf17",
      ),
      pkg(
        "libxml2-2.13.9-r1.apk",
        "91d3e730edbd5214c501696725e7af9a93e12a9dd6a296e719dca2f3de0697d5",
      ),
      pkg(
        "xz-libs-5.8.4-r0.apk",
        "55cec0880e1d06049147cd295a7c8a2909a668fc58a00c187741f3a16c25c55d",
      ),
    ],
    setup: POSTGRES_SETUP,
  },
  git: {
    packages: [
      pkg(
        "git-2.52.1-r0.apk",
        "b7f80755f78ab9b52f62e5bd3c9d75986e13fced5917ce5348eb9ecb2cad2ab2",
      ),
      pkg(
        "libcurl-8.23.0-r0.apk",
        "a7cf7d0813d3a96f2cb65fbf873e8a8661866a843f2b7769b629024d9e5809bc",
      ),
      pkg(
        "brotli-libs-1.2.1-r0.apk",
        "bec9ee522095e9fd01113d8732119847944e3152f228034246a33e2ab82e4195",
      ),
      pkg(
        "c-ares-1.34.9-r0.apk",
        "2af302c4a232fff2abeb56ec9f16edabdb06f0e5f8d040d6e466e91f1c473d00",
      ),
      pkg(
        "libidn2-2.3.8-r0.apk",
        "71db3591a2cb251aae463b966f9731c9ecae3bff4dccea552e0033002b92fd75",
      ),
      pkg(
        "libunistring-1.4.1-r0.apk",
        "03f26b1c897ad74af51b475d5f6cebad50efe90e4d42a0c38ffcb37859077481",
      ),
      pkg(
        "nghttp2-libs-1.69.0-r0.apk",
        "2e17aa1d7d4a37b2d029210d239b8b2e4ac40748d9a8c8912a6b607011034fd1",
      ),
      pkg(
        "libpsl-0.21.5-r3.apk",
        "3078398181f0955da453826965a9e184494e4d9dfd22391e28d72f7561a0ca2b",
      ),
      pkg(
        "libexpat-2.10.0-r0.apk",
        "f6483389ab602a351891337be7e9975106d0749d57aa5339b0725bb4051e4bc3",
      ),
      pkg(
        "pcre2-10.49-r0.apk",
        "a0af38fe98cb22c358aca1e1e504141c6673efef7635c539a914b83fb5c13b58",
      ),
    ],
  },
  "vsock-relay": {
    packages: [
      pkg(
        "socat-1.8.1.3-r0.apk",
        "e415cdf30d41bbf4053ab52eb71c55fb9f5c3b811cd53cf22182960888186cbf",
      ),
      pkg(
        "libssl3-3.5.9-r0.apk",
        "cdb3762116994f767cd1da423fa8004bd36b2e3802e3a1343786a40f00a5030e",
      ),
      pkg(
        "libcrypto3-3.5.9-r0.apk",
        "3b0bd7aaac36d49216f47d025f303dafb6da8d05bd258f71900d3b6156d36012",
      ),
      ...READLINE_PACKAGES,
    ],
  },
  zstd: {
    packages: [ZSTD_PACKAGE],
  },
} as const satisfies Record<string, Feature>;

export type FeatureName = keyof typeof FEATURES;

export interface DebianFeature {
  /** Debian package names, installed with apt from the snapshot. */
  readonly apt: readonly string[];
  /** Shell run in the build VM after the packages are installed. */
  readonly setup?: string;
}

const DEBIAN_POSTGRES_SETUP = `# The package builds a random cluster at install time; drop it so rebuilds match.
if command -v pg_dropcluster >/dev/null 2>&1 && [ -d /etc/postgresql/17/main ]; then
  pg_dropcluster 17 main --stop
fi
rm -f /etc/ssl/certs/ssl-cert-snakeoil.pem /etc/ssl/private/ssl-cert-snakeoil.key
mkdir -p /run/postgresql
chown postgres:postgres /run/postgresql
chmod 2775 /run/postgresql
cat > /usr/local/bin/agent-bootstrap-postgres <<'AGENT_BOOTSTRAP_EOF'
#!/bin/sh
set -eu
# Fixed binary directory: no PATH lookup, and su may reset PATH.
bin=/usr/lib/postgresql/17/bin
data=$(mktemp -d /tmp/agent-bootstrap-pg.XXXXXX)
as_postgres() {
  if [ "$(id -u)" = 0 ]; then
    su -s /bin/sh -c "$1" postgres
  else
    /bin/sh -c "$1"
  fi
}
if [ "$(id -u)" = 0 ]; then
  mkdir -p /run/postgresql
  chown postgres:postgres "$data" /run/postgresql
fi
# $data is a mktemp path made of fixed characters, so it is safe to expand.
as_postgres "$bin/initdb -D '$data/db' -A trust -U postgres --no-instructions" >/dev/null 2>&1
as_postgres "$bin/pg_ctl -D '$data/db' -o '-c listen_addresses=127.0.0.1 -c port=5432 -c unix_socket_directories=/run/postgresql' -w -t 60 -l '$data/log' start" >/dev/null 2>&1

printf '%s\\n' 'postgresql://postgres@127.0.0.1:5432/postgres'
AGENT_BOOTSTRAP_EOF
chmod 0755 /usr/local/bin/agent-bootstrap-postgres
`;

const DEBIAN_CHROMIUM_SETUP = `cat > /usr/local/bin/agent-bootstrap-chromium <<'AGENT_BOOTSTRAP_EOF'
#!/bin/sh
exec chromium --headless --no-sandbox --disable-gpu "$@"
AGENT_BOOTSTRAP_EOF
chmod 0755 /usr/local/bin/agent-bootstrap-chromium
cat > /etc/profile.d/agent-bootstrap-browser.sh <<'AGENT_BOOTSTRAP_EOF'
export PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
export CHROMIUM_PATH=/usr/bin/chromium
AGENT_BOOTSTRAP_EOF
chmod 0644 /etc/profile.d/agent-bootstrap-browser.sh
`;

export const DEBIAN_FEATURES = {
  sqlite: { apt: ["sqlite3"] },
  postgres: { apt: ["postgresql"], setup: DEBIAN_POSTGRES_SETUP },
  chromium: {
    apt: ["chromium", "fonts-liberation"],
    setup: DEBIAN_CHROMIUM_SETUP,
  },
  git: { apt: ["git"] },
} as const satisfies Record<string, DebianFeature>;

export type DebianFeatureName = keyof typeof DEBIAN_FEATURES;

export interface AlpineRecipe {
  readonly base: typeof ALPINE_3_23;
  readonly features: readonly FeatureName[];
  readonly memoryMiB: number;
  readonly cpus: number;
}

export interface DebianRecipe {
  readonly base: typeof DEBIAN_TRIXIE;
  readonly features: readonly DebianFeatureName[];
  readonly memoryMiB: number;
  readonly cpus: number;
}

export type ProfileRecipe = AlpineRecipe | DebianRecipe;

export const PROFILE_RECIPES: Readonly<
  Partial<Record<ProfileName, ProfileRecipe>>
> = {
  db: {
    base: ALPINE_3_23,
    features: ["sqlite", "postgres", "git"],
    memoryMiB: 1024,
    cpus: 2,
  },
  browser: {
    base: DEBIAN_TRIXIE,
    features: ["sqlite", "postgres", "chromium", "git"],
    memoryMiB: 2048,
    cpus: 2,
  },
  concierge: {
    base: ALPINE_3_23,
    features: ["vsock-relay", "zstd", "git"],
    memoryMiB: 1024,
    cpus: 2,
  },
  bun: {
    base: ALPINE_3_23,
    features: ["bun", "zstd", "git"],
    memoryMiB: 2048,
    cpus: 2,
  },
};

export function recipeFor(name: string): ProfileRecipe {
  const recipe = (
    PROFILE_RECIPES as Readonly<Record<string, ProfileRecipe | undefined>>
  )[name];
  if (recipe === undefined) throw new Error(`No image recipe for ${name}`);
  return recipe;
}

function setupOf(recipe: ProfileRecipe, feature: string): string | undefined {
  const table = (
    recipe.base.kind === "alpine" ? FEATURES : DEBIAN_FEATURES
  ) as Readonly<Record<string, { readonly setup?: string }>>;
  return table[feature]?.setup;
}

function setupsOf(recipe: ProfileRecipe): string[] {
  return recipe.features.flatMap((f) => {
    const s = setupOf(recipe, f);
    return s === undefined ? [] : [s];
  });
}

function alpineRecipe(name: string): AlpineRecipe {
  const recipe = recipeFor(name);
  if (recipe.base.kind !== "alpine")
    throw new Error(`Profile ${name} is not an Alpine recipe`);
  return recipe as AlpineRecipe;
}

/** Union of the features' packages, one entry per file name, sorted by name.
 * Alpine recipes only. */
export function profilePackages(name: string): PinnedPackage[] {
  const byName = new Map<string, string>();
  for (const feature of alpineRecipe(name).features) {
    for (const item of FEATURES[feature].packages as readonly PinnedPackage[]) {
      const seen = byName.get(item.name);
      if (seen !== undefined && seen !== item.sha256)
        throw new Error(`Conflicting digests for package ${item.name}`);
      byName.set(item.name, item.sha256);
    }
  }
  return [...byName]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([n, sha256]) => ({ name: n, sha256 }));
}

/** Non-apk files for an Alpine recipe, sorted by staging name. */
export function profileFiles(name: string): PinnedFile[] {
  const packageNames = new Set(profilePackages(name).map((item) => item.name));
  const byName = new Map<string, PinnedFile>();
  for (const feature of alpineRecipe(name).features) {
    const { files } = FEATURES[feature] as Feature;
    for (const item of files ?? []) {
      if (
        !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(item.name) ||
        item.name.endsWith(".apk") ||
        packageNames.has(item.name) ||
        byName.has(item.name)
      )
        throw new Error(`Invalid or duplicate staged file name: ${item.name}`);
      byName.set(item.name, item);
    }
  }
  return [...byName.values()].sort(({ name: a }, { name: b }) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
}

/** Sorted, de-duplicated apt package names of a Debian recipe. */
export function aptPackages(name: string): string[] {
  const recipe = recipeFor(name);
  if (recipe.base.kind !== "debian-snapshot")
    throw new Error(`Profile ${name} is not a Debian recipe`);
  const names = new Set<string>();
  for (const f of (recipe as DebianRecipe).features)
    for (const p of DEBIAN_FEATURES[f].apt) names.add(p);
  return [...names].sort();
}

/** SHA-256 (hex) of the recipe inputs: base, packages, files, setup scripts, limits. */
export function recipeDigest(name: string): string {
  const recipe = recipeFor(name);
  const files =
    recipe.base.kind === "alpine"
      ? profileFiles(name).map(({ name, sha256 }) => [name, sha256])
      : [];
  const canonical =
    recipe.base.kind === "alpine"
      ? JSON.stringify({
          base: recipe.base.reference,
          packages: profilePackages(name).map((p) => [p.name, p.sha256]),
          ...(files.length > 0 ? { files } : {}),
          setup: setupsOf(recipe),
          memoryMiB: recipe.memoryMiB,
          cpus: recipe.cpus,
        })
      : JSON.stringify({
          kind: recipe.base.kind,
          base: recipe.base.reference,
          snapshot: recipe.base.snapshot,
          inRelease: recipe.base.inRelease,
          egress: recipe.base.egress,
          apt: aptPackages(name),
          setup: setupsOf(recipe),
          memoryMiB: recipe.memoryMiB,
          cpus: recipe.cpus,
        });
  return createHash("sha256").update(canonical).digest("hex");
}

/** Shell lines shared by both builds: fixed identity files. */
function archiveLines(): string[] {
  return [
    // The backend writes the build VM's name into these: fixed contents keep
    // rebuilds of the same inputs byte-identical.
    "printf 'localhost\\n' > /etc/hostname",
    "printf '127.0.0.1\\tlocalhost\\n::1\\tlocalhost\\n' > /etc/hosts",
    // No backend or host DNS settings may be archived.
    ": > /etc/resolv.conf",
  ];
}

const TOP_LEVEL_LOOP = [
  "cd /",
  // Top-level entries except proc, sys, dev, tmp and .msb; unmatched globs
  // stay literal and are skipped by the existence test.
  "set --",
  "for entry in .[!.]* ..?* *; do",
  '  case "$entry" in',
  "    proc|sys|dev|tmp|.msb) ;;",
  "    *)",
  '      if [ -e "$entry" ] || [ -L "$entry" ]; then set -- "$@" "$entry"; fi',
  "      ;;",
  "  esac",
  "done",
];

function debianBuildScript(recipe: DebianRecipe, name: string): string {
  const { snapshot, inRelease } = recipe.base;
  const lists = "/var/lib/apt/lists";
  const releases = inRelease.map(({ archive, suite, sha256 }) => ({
    path: `${lists}/snapshot.debian.org_archive_${archive}_${snapshot}_dists_${suite}_InRelease`,
    sha256,
  }));
  const keyring = "/usr/share/keyrings/debian-archive-keyring.gpg";
  const sources = [
    "Types: deb",
    `URIs: http://snapshot.debian.org/archive/debian/${snapshot}/`,
    "Suites: trixie trixie-updates",
    "Components: main",
    `Signed-By: ${keyring}`,
    "",
    "Types: deb",
    `URIs: http://snapshot.debian.org/archive/debian-security/${snapshot}/`,
    "Suites: trixie-security",
    "Components: main",
    `Signed-By: ${keyring}`,
    "",
  ].join("\n");
  return [
    "set -e",
    "rm -f /etc/apt/sources.list.d/debian.sources /etc/apt/sources.list",
    "cat > /etc/apt/sources.list.d/snapshot.sources <<'AGENT_BOOTSTRAP_EOF'",
    sources + "AGENT_BOOTSTRAP_EOF",
    // Snapshot Release files are old by design; their signatures still apply.
    `printf 'Acquire::Check-Valid-Until "false";\\n' > /etc/apt/apt.conf.d/99snapshot`,
    "apt-get update >/dev/null",
    // Signatures alone would still allow replay of older snapshot metadata.
    "printf '%s  %s\\n' \\",
    ...releases.map(({ path, sha256 }) => `  '${sha256}' '${path}' \\`),
    "  | sha256sum -c -",
    `for release in ${lists}/*Release ${lists}/.*Release; do`,
    '  [ -e "$release" ] || [ -L "$release" ] || continue',
    '  case "$release" in',
    `    ${releases.map(({ path }) => `'${path}'`).join("|")}) ;;`,
    '    *) printf "Unexpected apt release file: %s\\n" "$release" >&2; exit 1 ;;',
    "  esac",
    "done",
    `DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends ca-certificates ${aptPackages(name).join(" ")} >/dev/null`,
    ...setupsOf(recipe),
    // Cleanup for determinism. The snapshot sources stay: they record where
    // the packages came from, and task VMs have no network.
    "apt-get clean",
    "rm -rf /var/lib/apt/lists/* /var/cache/apt/* /var/log/* /var/cache/debconf/*-old /var/lib/dpkg/*-old /var/cache/ldconfig/aux-cache /tmp/*",
    "find / -xdev -name '__pycache__' -prune -exec rm -rf {} + || true",
    // Account change dates are install-day numbers; fix them.
    // An empty last-change field disables password aging and carries no date.
    // (0 would mean "change the password now", which makes su refuse.)
    // The shadow- backup that useradd leaves holds the same dates.
    "for file in /etc/shadow /etc/shadow-; do",
    '  if [ -f "$file" ] && [ ! -L "$file" ]; then sed -i -E \'s/^([^:]*:[^:]*):[0-9]*:/\\1::/\' "$file"; fi',
    "done",
    ": > /etc/machine-id",
    // Random per install: an empty machine id, and font caches that fontconfig
    // regenerates on demand (they embed build-time data).
    "if [ -f /var/lib/dbus/machine-id ] && [ ! -L /var/lib/dbus/machine-id ]; then : > /var/lib/dbus/machine-id; fi",
    "rm -rf /var/cache/fontconfig/*",
    ...archiveLines(),
    "dpkg-query -W -f='${Package}=${Version}\\n' | sort > /etc/agent-bootstrap-packages.txt",
    ...TOP_LEVEL_LOOP,
    'tar --format=gnu --numeric-owner -cf /tmp/rootfs.tar --exclude run/microsandbox "$@"',
    "",
  ].join("\n");
}

/** The script the build VM runs. It leaves the root filesystem in
 * /tmp/rootfs.tar (everything except proc, sys, dev, tmp and the backend's
 * own /.msb, where it places runtime state such as an interception CA). */
export function BUILD_SCRIPT(name: string): string {
  const recipe = recipeFor(name);
  if (recipe.base.kind === "debian-snapshot")
    return debianBuildScript(recipe as DebianRecipe, name);
  return [
    "set -e",
    "apk add --no-network --repositories-file /dev/null /tmp/pkgs/*.apk >/dev/null",
    ...setupsOf(recipe),
    // The pinned PostgreSQL apk creates this system account with the current UTC day.
    // Keep the day from the 2026-11-22 locked build as part of archive normalization.
    ...(name === "db"
      ? ["sed -i -E 's/^(postgres:[^:]*):[0-9]+:/\\1:20779:/' /etc/shadow"]
      : []),
    "rm -rf /tmp/pkgs /var/cache/apk/*",
    ...archiveLines(),
    "rm -f /var/log/apk.log",
    ...TOP_LEVEL_LOOP,
    // The backend's guest runtime directory is left out of the archive (not
    // removed: the backend may be using it during exec).
    'tar -cf /tmp/rootfs.tar --exclude run/microsandbox "$@"',
    "",
  ].join("\n");
}

/** The recipe's complete network allowlist for the build gateway. */
export function buildEgress(
  name: string,
): { hostname: string; port: number }[] {
  const { base } = recipeFor(name);
  if (base.kind === "alpine") return [];
  const [hostname, port] = base.egress.split(":");
  return [{ hostname: hostname!, port: Number(port) }];
}

/** A shell script run in a VM of the finished image, and the exact output
 * lines it must print. */
export function smokeTest(name: string): {
  script: string;
  expected: string[];
} {
  const features: readonly string[] = recipeFor(name).features;
  const script: string[] = [];
  const expected: string[] = [];
  if (features.includes("sqlite")) {
    script.push('sqlite3 :memory: "select 1;"');
    expected.push("1");
  }
  if (features.includes("postgres")) {
    script.push('url=$(agent-bootstrap-postgres); psql "$url" -Atc "select 1"');
    expected.push("1");
  }
  if (features.includes("chromium")) {
    script.push(
      'out=$(agent-bootstrap-chromium --dump-dom "data:text/html,<p>browser-ok</p>" 2>/dev/null)',
      'case "$out" in *browser-ok*) echo browser-ok ;; esac',
    );
    expected.push("browser-ok");
  }
  if (features.includes("vsock-relay")) {
    script.push("socat -V >/dev/null && echo socat-ok");
    expected.push("socat-ok");
  }
  if (features.includes("bun")) {
    script.push("bun --version");
    expected.push(BUN_VERSION);
  }
  if (features.includes("git")) {
    script.push("git --version >/dev/null && echo git-ok");
    expected.push("git-ok");
  }
  return { script: script.join("\n"), expected };
}
