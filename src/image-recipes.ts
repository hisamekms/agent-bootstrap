import { createHash } from "node:crypto";
import type { ProfileName } from "./sandbox-profiles.ts";

/** Alpine 3.23 base image and where its signed packages are kept (relative to
 * the repository root). */
export const ALPINE_3_23 = {
  reference:
    "docker.io/library/alpine@sha256:5dda816445facf5f7282dc7689a333278834c74265ba25db2e2eb90509e3a9dd",
  packageDir: ".local/alpine/v3.23/main/aarch64",
} as const;

export interface PinnedPackage {
  readonly name: string;
  readonly sha256: string;
}

export interface Feature {
  readonly packages: readonly PinnedPackage[];
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

export const FEATURES = {
  sqlite: {
    packages: [
      pkg(
        "sqlite-3.53.4-r0.apk",
        "55c5f9d617818f75d0cdfafdc8054629988e5a39422f19357e6f7d82ae429502",
      ),
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
      pkg(
        "zstd-libs-1.5.7-r2.apk",
        "50a998e56e4bf31504996e49c1b4a23eed5e0cd4e24b8a1356a54daf1a6eabbe",
      ),
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
      pkg(
        "libgcc-15.2.0-r2.apk",
        "eaaafda78fde1c904e1741680ddea91649f051e29a343152c8a4327605704b0f",
      ),
      pkg(
        "libstdc++-15.2.0-r2.apk",
        "10d72e25f6fcc0f3d9fdd801c9bdaed81d6e836aa2b65b63f25d2d97f860a7d1",
      ),
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
} as const satisfies Record<string, Feature>;

export type FeatureName = keyof typeof FEATURES;

export interface ProfileRecipe {
  readonly base: typeof ALPINE_3_23;
  readonly features: readonly FeatureName[];
  readonly memoryMiB: number;
  readonly cpus: number;
}

export const PROFILE_RECIPES: Readonly<
  Partial<Record<ProfileName, ProfileRecipe>>
> = {
  db: {
    base: ALPINE_3_23,
    features: ["sqlite", "postgres"],
    memoryMiB: 1024,
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

function setupOf(feature: FeatureName): string | undefined {
  return (FEATURES[feature] as Feature).setup;
}

/** Union of the features' packages, one entry per file name, sorted by name. */
export function profilePackages(name: string): PinnedPackage[] {
  const byName = new Map<string, string>();
  for (const feature of recipeFor(name).features) {
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

/** SHA-256 (hex) of the recipe inputs: base, packages, setup scripts, limits. */
export function recipeDigest(name: string): string {
  const recipe = recipeFor(name);
  const canonical = JSON.stringify({
    base: recipe.base.reference,
    packages: profilePackages(name).map((p) => [p.name, p.sha256]),
    setup: recipe.features.flatMap((f) => {
      const s = setupOf(f);
      return s === undefined ? [] : [s];
    }),
    memoryMiB: recipe.memoryMiB,
    cpus: recipe.cpus,
  });
  return createHash("sha256").update(canonical).digest("hex");
}

/** The script the build VM runs. It leaves the root filesystem in
 * /tmp/rootfs.tar (everything except proc, sys, dev, tmp and the backend's
 * own /.msb, where it places runtime state such as an interception CA). */
export function BUILD_SCRIPT(name: string): string {
  const recipe = recipeFor(name);
  const setups = recipe.features.flatMap((f) => {
    const s = setupOf(f);
    return s === undefined ? [] : [s];
  });
  return [
    "set -e",
    "apk add --no-network --repositories-file /dev/null /tmp/pkgs/*.apk >/dev/null",
    ...setups,
    "rm -rf /tmp/pkgs /var/cache/apk/*",
    // The backend writes the build VM's name into these, and apk logs times:
    // fixed contents keep rebuilds of the same inputs byte-identical.
    "printf 'localhost\\n' > /etc/hostname",
    "printf '127.0.0.1\\tlocalhost\\n::1\\tlocalhost\\n' > /etc/hosts",
    // No backend or host DNS settings may be archived.
    ": > /etc/resolv.conf",
    "rm -f /var/log/apk.log",
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
    // The backend's guest runtime directory is left out of the archive (not
    // removed: the backend may be using it during exec).
    'tar -cf /tmp/rootfs.tar --exclude run/microsandbox "$@"',
    "",
  ].join("\n");
}
