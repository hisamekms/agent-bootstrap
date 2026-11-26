import { spawn } from "node:child_process";
import { CODEX, codexBinaryPath } from "../codex-exec.ts";
import { createHash } from "node:crypto";
import { constants, createWriteStream } from "node:fs";
import { chmod, mkdir, mkdtemp, open, rename, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  CLAUDE_CODE,
  CLAUDE_CODE_BUILDS,
  CLAUDE_CODE_GUEST_PACKAGES,
  SECRET_FILE_PACKAGES,
} from "../claude-code.ts";
import {
  ALPINE_3_23,
  BUN_VERSION,
  profileFiles,
  profilePackages,
  recipeFor,
} from "../image-recipes.ts";
import { checkDirectory } from "../local-orchestrator/target.ts";

export const defaultProfiles = ["concierge", "bun"] as const;
export const extraProfiles = ["db", "browser"] as const;
export const allProfiles = [...defaultProfiles, ...extraProfiles];
const maxBytes = 512 * 1024 * 1024;
const releases = "https://downloads.claude.ai/claude-code-releases";
const alpine = "https://dl-cdn.alpinelinux.org/alpine/v3.23/main/aarch64";
const codex = "https://github.com/openai/codex/releases/download";
const bun = "https://github.com/oven-sh/bun/releases/download";

export interface Artifact {
  readonly path: string;
  readonly url: string;
  readonly sha256: string;
  readonly archive?: { readonly sha256: string; readonly member: string };
}

export function artifacts(
  profiles: readonly string[],
  alternateClaude?: string,
  includeSecrets = false,
  includeCodex = false,
): Artifact[] {
  const inputs = new Map<string, Artifact>();
  function add(item: Artifact) {
    const previous = inputs.get(item.path);
    if (previous && previous.sha256 !== item.sha256)
      throw new Error("Conflicting artifact pins");
    inputs.set(item.path, item);
  }
  const { platform, sha256 } = CLAUDE_CODE_BUILDS.alpine;
  const releasePath = `${CLAUDE_CODE.version}/${platform}/claude`;
  add({
    path: alternateClaude ?? `.local/claude-code/${releasePath}`,
    url: `${releases}/${releasePath}`,
    sha256,
  });
  if (includeCodex)
    add({
      path: codexBinaryPath,
      url: `${codex}/rust-v${CODEX.version}/${CODEX.archive.name}`,
      sha256: CODEX.sha256,
      archive: { sha256: CODEX.archive.sha256, member: CODEX.archive.member },
    });
  const alpineProfiles = profiles.filter(
    (profile) => recipeFor(profile).base.kind === "alpine",
  );
  for (const { name, sha256 } of [
    ...CLAUDE_CODE_GUEST_PACKAGES,
    ...(includeSecrets ? SECRET_FILE_PACKAGES : []),
    ...alpineProfiles.flatMap(profilePackages),
  ])
    add({
      path: join(ALPINE_3_23.packageDir, name),
      url: `${alpine}/${name}`,
      sha256,
    });
  for (const profile of alpineProfiles)
    for (const { name, source, sha256 } of profileFiles(profile))
      add({ path: source, url: `${bun}/bun-v${BUN_VERSION}/${name}`, sha256 });
  return [...inputs.values()];
}

export async function artifactStatus(
  path: string,
  sha256: string,
  mode?: number,
): Promise<"ok" | "missing" | "wrong"> {
  try {
    await using file = await open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    const info = await file.stat();
    if (
      !info.isFile() ||
      info.size > maxBytes ||
      (mode !== undefined && (info.mode & 0o7777) !== mode)
    )
      return "wrong";
    const hash = createHash("sha256");
    let size = 0;
    for await (const data of file.createReadStream({ autoClose: false })) {
      size += data.length;
      if (size > maxBytes) return "wrong";
      hash.update(data);
    }
    return hash.digest("hex") === sha256 ? "ok" : "wrong";
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT"
      ? "missing"
      : "wrong";
  }
}

function allowedUrl(url: URL, original: string): boolean {
  if (url.protocol !== "https:" || url.username || url.password || url.port)
    return false;
  if (url.href === original)
    return [
      new URL(alpine).host,
      new URL(releases).host,
      new URL(bun).host,
    ].includes(url.hostname);
  return (
    (original.startsWith(bun + "/") || original.startsWith(codex + "/")) &&
    url.hostname === "release-assets.githubusercontent.com"
  );
}

export async function fetchArtifact(
  root: string,
  item: Artifact,
  fetcher: typeof fetch,
): Promise<void> {
  const destination = join(root, item.path);
  const parts = relative(root, dirname(destination)).split(sep);
  if (
    isAbsolute(item.path) ||
    parts[0] !== ".local" ||
    item.path.split(sep).includes("..")
  )
    throw new Error("Artifact destination must be inside .local");
  await checkDirectory(root);
  let directory = root;
  for (const component of parts) {
    directory = join(directory, component);
    await mkdir(directory, { mode: 0o700 }).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code !== "EEXIST") throw error;
      },
    );
    await checkDirectory(directory);
  }

  const work = await mkdtemp(join(directory, ".download-"));
  const temporary = join(work, "artifact");
  const signal = AbortSignal.timeout(180_000);
  try {
    let url = new URL(item.url);
    let response: Response | undefined;
    for (let redirects = 0; redirects < 4; redirects++) {
      if (!allowedUrl(url, item.url))
        throw new Error("Unapproved download URL");
      response = await fetcher(url, {
        redirect: "manual",
        signal,
        credentials: "omit",
      });
      if (![301, 302, 303, 307, 308].includes(response.status)) break;
      await response.body?.cancel();
      const location = response.headers.get("location");
      if (!location) throw new Error("Missing download redirect");
      url = new URL(location, url);
    }
    if (
      !response?.ok ||
      !response.body ||
      Number(response.headers.get("content-length")) > maxBytes
    ) {
      await response?.body?.cancel();
      throw new Error("Download unavailable or too large");
    }
    const hash = createHash("sha256");
    let size = 0;
    await pipeline(
      async function* () {
        const reader = response.body!.getReader();
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            yield value;
          }
        } finally {
          await reader.cancel();
        }
      },
      new Transform({
        transform(chunk: Buffer, _encoding, done) {
          size += chunk.length;
          if (size > maxBytes) return done(new Error("Download too large"));
          hash.update(chunk);
          done(null, chunk);
        },
      }),
      createWriteStream(temporary, { flags: "wx", mode: 0o600 }),
      { signal },
    );
    if (hash.digest("hex") !== (item.archive?.sha256 ?? item.sha256))
      throw new Error("Download checksum does not match");
    let staged = temporary;
    if (item.archive) {
      staged = join(work, "binary");
      // Stream only the named member. Archive metadata never controls the output path or mode.
      const tar = spawn(
        "/usr/bin/tar",
        ["-xOzf", temporary, "--", item.archive.member],
        {
          env: { PATH: "/usr/bin:/bin" },
          stdio: ["ignore", "pipe", "ignore"],
          signal,
        },
      );
      const exited = new Promise<void>((resolve, reject) => {
        tar.once("error", reject);
        tar.once("close", (code) =>
          code === 0
            ? resolve()
            : reject(new Error("Archive extraction failed")),
        );
      });
      let extracted = 0;
      await Promise.all([
        exited,
        pipeline(
          tar.stdout,
          new Transform({
            transform(chunk: Buffer, _encoding, done) {
              extracted += chunk.length;
              if (extracted > maxBytes)
                return done(new Error("Extracted binary too large"));
              done(null, chunk);
            },
          }),
          createWriteStream(staged, { flags: "wx", mode: 0o600 }),
          { signal },
        ),
      ]);
      if ((await artifactStatus(staged, item.sha256)) !== "ok")
        throw new Error("Extracted binary checksum does not match");
      await chmod(staged, 0o700);
    }
    await checkDirectory(directory);
    const existing = await artifactStatus(
      destination,
      item.sha256,
      item.archive ? 0o700 : undefined,
    );
    if (existing === "ok") return;
    if (existing === "wrong") throw new Error("Artifact destination changed");
    await rename(staged, destination);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}
