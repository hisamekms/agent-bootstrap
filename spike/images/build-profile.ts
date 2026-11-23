import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  stat,
  rm,
  writeFile,
} from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BUILD_SCRIPT,
  buildNetRules,
  profileFiles,
  profilePackages,
  recipeFor,
  smokeTest,
} from "../../src/image-recipes.ts";
import { checkDirectory } from "../../src/local-orchestrator/target.ts";
import { MISE_MSB, offlineMiseEnv } from "../../src/mise-tools.ts";
import {
  layoutTar,
  normalizeLayer,
  ociImage,
  readOciLayout,
} from "../../src/oci-image.ts";
import {
  PROFILE_LOCK_PATH,
  lockEntry,
  parseProfileLock,
  type ProfileLock,
} from "../../src/profile-lock.ts";

const root = fileURLToPath(new URL("../..", import.meta.url));
let stage = "arguments";

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

let msb = "";
let msbHome = "";
let locked = false;

function run(args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      locked ? "mise" : msb,
      locked ? [...MISE_MSB, ...args] : args,
      {
        env: {
          ...(locked ? offlineMiseEnv(process.env) : { PATH: "/usr/bin:/bin" }),
          MSB_HOME: msbHome,
        },
        encoding: "utf8",
        killSignal: "SIGKILL",
        timeout: timeoutMs,
        maxBuffer: 16 * 1024 * 1024,
      },
      (error, stdout) => (error ? reject(error) : resolve(stdout)),
    );
  });
}

const MINUTE = 60_000;
// The Debian root filesystem is about 1 GiB; normalizeLayer holds the whole
// archive in memory (a few GiB peak), which is acceptable for a spike.
const MAX_ROOTFS_BYTES = 4 * 1024 ** 3;

/** Create a no-network sandbox, run `use`, and always remove it. */
async function withSandbox<T>(
  image: string,
  memoryMiB: number,
  extra: string[],
  use: (name: string) => Promise<T>,
): Promise<T> {
  const name = `agent-bootstrap-build-${randomBytes(8).toString("hex")}`;
  try {
    await run(
      [
        "create",
        "--name",
        name,
        "--pull",
        "never",
        "--no-net",
        "--memory",
        `${memoryMiB}M`,
        "--max-duration",
        "900s",
        ...extra,
        image,
      ],
      5 * MINUTE,
    );
    return await use(name);
  } finally {
    await run(["stop", name], MINUTE).catch(() => undefined);
    await run(["rm", "--force", name], MINUTE);
  }
}

function guestExec(name: string, script: string, timeoutMs: number) {
  return run(
    [
      "exec",
      "--no-stdin",
      "--no-tty",
      "--timeout",
      `${Math.ceil(timeoutMs / 1000)}s`,
      name,
      "--",
      "/bin/sh",
      "-ec",
      script,
    ],
    timeoutMs + MINUTE,
  );
}

async function main(): Promise<void> {
  const [binary, profile] = process.argv.slice(2);
  locked = binary === "--locked";
  const home = process.env["MSB_HOME"];
  if (
    binary === undefined ||
    (!locked && !isAbsolute(binary)) ||
    profile === undefined ||
    home === undefined ||
    !isAbsolute(home)
  )
    throw new Error(
      "usage: MSB_HOME=<abs> build-profile.ts <abs msb|--locked> <profile>",
    );
  msb = binary;
  msbHome = home;
  const recipe = recipeFor(profile);
  const expected = locked
    ? parseProfileLock(await readFile(join(root, PROFILE_LOCK_PATH), "utf8"))
        .profiles[profile]
    : undefined;
  if (locked && !expected) throw new Error("Profile is absent from the lock");
  const imageName = `localhost/agent-bootstrap/${profile}`;

  stage = "work directory";
  if (locked) await checkDirectory(root);
  await mkdir(join(root, ".local"), { recursive: true });
  if (locked) await checkDirectory(join(root, ".local"));
  const work = await mkdtemp(join(root, ".local", "images-"));
  let temporaryImage: string | undefined;
  try {
    const copyArgs: string[] = [];
    if (recipe.base.kind === "alpine") {
      stage = "Alpine input verification";
      await mkdir(join(work, "pkgs"), { mode: 0o700 });
      const packageDir = recipe.base.packageDir;
      const inputs = [
        ...profilePackages(profile).map((item) => ({
          ...item,
          source: join(packageDir, item.name),
        })),
        ...profileFiles(profile),
      ];
      for (const item of inputs) {
        const source = join(root, item.source);
        const target = join(work, "pkgs", item.name);
        await copyFile(source, target);
        if (sha256(await readFile(target)) !== item.sha256)
          throw new Error(`digest mismatch for ${item.name}`);
      }
      copyArgs.push("--copy-dir", `${join(work, "pkgs")}:/tmp/pkgs`);
    }
    let packages: string[] | undefined;

    stage = "base image";
    await run(
      [
        "save",
        "--format",
        "oci",
        "-o",
        join(work, "base.tar"),
        recipe.base.reference,
      ],
      5 * MINUTE,
    );
    const base = readOciLayout(await readFile(join(work, "base.tar")));

    stage = "build VM";
    await withSandbox(
      recipe.base.reference,
      recipe.memoryMiB,
      [
        "--cpus",
        String(recipe.cpus),
        ...copyArgs,
        ...buildNetRules(profile).flatMap((rule) => ["--net-rule", rule]),
      ],
      async (name) => {
        await guestExec(name, BUILD_SCRIPT(profile), 10 * MINUTE);
        stage = "root filesystem export";
        await run(
          ["copy", `${name}:/tmp/rootfs.tar`, join(work, "rootfs.tar")],
          5 * MINUTE,
        );
        if (recipe.base.kind === "debian-snapshot") {
          stage = "package list export";
          const listPath = join(work, "packages.txt");
          await run(
            ["copy", `${name}:/etc/agent-bootstrap-packages.txt`, listPath],
            MINUTE,
          );
          packages = (await readFile(listPath, "utf8"))
            .split("\n")
            .filter((l) => l !== "")
            .sort();
        }
      },
    );

    stage = "image assembly";
    const rootfsPath = join(work, "rootfs.tar");
    if ((await stat(rootfsPath)).size > MAX_ROOTFS_BYTES) {
      throw new Error("rootfs.tar exceeds the maximum input size");
    }
    const layer = normalizeLayer(await readFile(rootfsPath), MAX_ROOTFS_BYTES);
    const image = ociImage({
      baseConfig: base.config,
      layer,
      platform: { architecture: "arm64", os: "linux" },
    });
    await writeFile(join(work, "image.tar"), layoutTar(image.files));
    const digest = image.manifestDigest;
    const reference = `${imageName}@sha256:${digest}`;

    if (expected) {
      stage = "locked digest verification";
      const entry = lockEntry(profile, digest, packages);
      if (
        entry.image !== expected.image ||
        JSON.stringify(entry.packages) !== JSON.stringify(expected.packages)
      )
        throw new Error("Build differs from the checked-in profile lock");
    }

    const smokeReference = locked
      ? `${imageName}:setup-${randomBytes(8).toString("hex")}`
      : reference;
    if (locked) temporaryImage = smokeReference;
    stage = "image load";
    await run(
      ["load", "-q", "-i", join(work, "image.tar"), "-t", smokeReference],
      5 * MINUTE,
    );
    const inspected = JSON.parse(
      await run(
        ["image", "inspect", "--format", "json", smokeReference],
        MINUTE,
      ),
    ) as { digest?: unknown };
    if (inspected.digest !== `sha256:${digest}`)
      throw new Error("loaded image digest differs");

    stage = "smoke test";
    const smoke = smokeTest(profile);
    const output = await withSandbox(
      smokeReference,
      recipe.memoryMiB,
      [],
      (name) => guestExec(name, smoke.script, 5 * MINUTE),
    );
    const lines = output.split("\n").filter((l) => l !== "");
    if (lines.join("\n") !== smoke.expected.join("\n"))
      throw new Error("smoke test output differs");

    if (locked) {
      stage = "smoke image cleanup";
      await run(["image", "rm", smokeReference], MINUTE);
      temporaryImage = undefined;
      stage = "locked image load";
      await run(
        ["load", "-q", "-i", join(work, "image.tar"), "-t", reference],
        5 * MINUTE,
      );
      return;
    }

    stage = "lock update";
    const lockPath = join(root, PROFILE_LOCK_PATH);
    let existing: ProfileLock = { version: 1, profiles: {} };
    let text: string | undefined;
    try {
      text = await readFile(lockPath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (text !== undefined) {
      // The entry being rebuilt is expected to be stale. Every other entry is
      // still validated strictly.
      const raw: unknown = JSON.parse(text);
      const plain = (value: unknown): value is Record<string, unknown> =>
        typeof value === "object" && value !== null && !Array.isArray(value);
      // Refuse a malformed lock rather than rewrite it from a partial copy.
      if (
        !plain(raw) ||
        Object.keys(raw).sort().join(",") !== "profiles,version" ||
        !plain(raw.profiles)
      )
        throw new Error("Profile lock is malformed");
      const others = { ...raw, profiles: { ...raw.profiles } };
      delete others.profiles[profile];
      existing = parseProfileLock(JSON.stringify(others));
    }
    const entry = lockEntry(profile, digest, packages);
    const lock = {
      version: 1,
      profiles: { ...existing.profiles, [profile]: entry },
    };
    await mkdir(join(root, "images"), { recursive: true });
    await writeFile(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
    console.log(
      JSON.stringify({
        profile,
        image: entry.image,
        recipeDigest: entry.recipeDigest,
      }),
    );
  } finally {
    if (temporaryImage)
      await run(["image", "rm", temporaryImage], MINUTE).catch(() => undefined);
    // IMAGE_KEEP=1 keeps the work directory for comparing builds.
    if (process.env.IMAGE_KEEP === "1") console.error(`kept ${work}`);
    else await rm(work, { recursive: true, force: true });
  }
}

try {
  await main();
} catch (error) {
  console.error(`Image build stopped at ${stage}.`);
  if (process.env["IMAGE_DEBUG"] === "1") console.error(error);
  process.exit(1);
}
