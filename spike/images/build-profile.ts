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
  profilePackages,
  recipeFor,
} from "../../src/image-recipes.ts";
import {
  MAX_INPUT_BYTES,
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

function run(args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      msb,
      args,
      {
        env: { PATH: "/usr/bin:/bin", MSB_HOME: msbHome },
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
  const home = process.env["MSB_HOME"];
  if (
    binary === undefined ||
    !isAbsolute(binary) ||
    profile === undefined ||
    home === undefined ||
    !isAbsolute(home)
  )
    throw new Error(
      "usage: MSB_HOME=<abs> build-profile.ts <abs msb> <profile>",
    );
  msb = binary;
  msbHome = home;
  const recipe = recipeFor(profile);
  const imageName = `localhost/agent-bootstrap/${profile}`;

  stage = "work directory";
  await mkdir(join(root, ".local"), { recursive: true });
  const work = await mkdtemp(join(root, ".local", "images-"));
  try {
    stage = "package verification";
    await mkdir(join(work, "pkgs"), { mode: 0o700 });
    for (const item of profilePackages(profile)) {
      const source = join(root, recipe.base.packageDir, item.name);
      const target = join(work, "pkgs", item.name);
      await copyFile(source, target);
      if (sha256(await readFile(target)) !== item.sha256)
        throw new Error(`digest mismatch for ${item.name}`);
    }

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
      ["--copy-dir", `${join(work, "pkgs")}:/tmp/pkgs`],
      async (name) => {
        await guestExec(name, BUILD_SCRIPT(profile), 10 * MINUTE);
        stage = "root filesystem export";
        await run(
          ["copy", `${name}:/tmp/rootfs.tar`, join(work, "rootfs.tar")],
          5 * MINUTE,
        );
      },
    );

    stage = "image assembly";
    const rootfsPath = join(work, "rootfs.tar");
    if ((await stat(rootfsPath)).size > MAX_INPUT_BYTES) {
      throw new Error("rootfs.tar exceeds the maximum input size");
    }
    const layer = normalizeLayer(await readFile(rootfsPath));
    const image = ociImage({
      baseConfig: base.config,
      layer,
      platform: { architecture: "arm64", os: "linux" },
    });
    await writeFile(join(work, "image.tar"), layoutTar(image.files));
    const digest = image.manifestDigest;
    const reference = `${imageName}@sha256:${digest}`;

    stage = "image load";
    await run(
      ["load", "-q", "-i", join(work, "image.tar"), "-t", reference],
      5 * MINUTE,
    );
    const inspected = JSON.parse(
      await run(["image", "inspect", "--format", "json", reference], MINUTE),
    ) as { digest?: unknown };
    if (inspected.digest !== `sha256:${digest}`)
      throw new Error("loaded image digest differs");

    stage = "smoke test";
    const output = await withSandbox(reference, recipe.memoryMiB, [], (name) =>
      guestExec(
        name,
        `sqlite3 :memory: "select 1;"; url=$(agent-bootstrap-postgres); psql "$url" -Atc "select 1"`,
        5 * MINUTE,
      ),
    );
    const lines = output.split("\n").filter((l) => l !== "");
    if (lines.length !== 2 || lines[0] !== "1" || lines[1] !== "1")
      throw new Error("smoke test output differs");

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
      const raw = JSON.parse(text) as {
        profiles?: Record<string, unknown>;
      };
      const others = { ...raw, profiles: { ...raw.profiles } };
      delete others.profiles[profile];
      existing = parseProfileLock(JSON.stringify(others));
    }
    const entry = lockEntry(profile, digest);
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
