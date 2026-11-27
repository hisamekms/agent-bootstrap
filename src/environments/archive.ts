import { posix } from "node:path";
import { readTar, writeWorkspaceTar, type TarEntryView } from "../oci-image.ts";
import { EnvironmentError } from "./adapter.ts";
import { environmentPath, unsafePathCharacters } from "./bun.ts";

export const environmentArchiveLimit = 256 * 1024 * 1024;

// toUpperCase first so that expansions such as ß → SS fold like the
// case-insensitive filesystems that may later unpack this archive.
const foldedPath = (path: string) =>
  path.normalize("NFC").toUpperCase().toLowerCase();

function containsRoot(roots: ReadonlySet<string>, path: string): boolean {
  if (roots.has(path)) return true;
  for (
    let end = path.lastIndexOf("/");
    end > 0;
    end = path.lastIndexOf("/", end - 1)
  )
    if (roots.has(path.slice(0, end))) return true;
  return false;
}

function checkLink(
  entry: TarEntryView,
  byPath: ReadonlyMap<string, TarEntryView>,
  roots: ReadonlySet<string>,
  ancestors: ReadonlySet<string>,
  targets: ReadonlySet<string>,
) {
  const pending = [
    ...posix.dirname(entry.path).split("/"),
    ...entry.linkname.split("/"),
  ].reverse();
  const parts: string[] = [];
  let links = 0;
  while (pending.length) {
    const segment = pending.pop()!;
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (!parts.length) throw new EnvironmentError();
      parts.pop();
      continue;
    }
    if (!environmentPath(segment)) throw new EnvironmentError();
    parts.push(segment);
    const path = parts.join("/");
    const inside = containsRoot(roots, path);
    // A link may end exactly on a declared source directory, such as a Bun
    // workspace package. Its contents are not in this archive, so a path
    // continues beneath it only where it also leads to an output root.
    if (
      !inside &&
      targets.has(path) &&
      pending.every((rest) => rest === "" || rest === ".")
    )
      return;
    // Only the known directories leading to output roots may be
    // traversed outside those roots. Source-tree links are not visible in
    // this archive and could change how an otherwise lexical path resolves.
    if (!inside && !ancestors.has(path)) throw new EnvironmentError();
    const target = byPath.get(path);
    if (target?.type === "symlink") {
      if (++links > 40) throw new EnvironmentError();
      parts.pop();
      pending.push(...target.linkname.split("/").reverse());
    } else if (pending.length && inside && target?.type !== "directory") {
      throw new EnvironmentError();
    }
  }
  if (!containsRoot(roots, parts.join("/"))) throw new EnvironmentError();
}

export function validateEnvironmentArchive(
  bytes: Uint8Array,
  roots: readonly string[],
  limit = environmentArchiveLimit,
  linkTargets: readonly string[] = [],
): Uint8Array {
  try {
    if (
      bytes.length < 1024 ||
      bytes.length % 512 ||
      bytes.subarray(-1024).some((byte) => byte !== 0)
    )
      throw new EnvironmentError();
    const entries = readTar(bytes, limit, true);
    const byPath = new Map(entries.map((entry) => [entry.path, entry]));
    if (
      !roots.length ||
      roots.some(
        (root) =>
          !environmentPath(root) || byPath.get(root)?.type !== "directory",
      )
    )
      throw new EnvironmentError();
    const outputRoots = new Set(roots);
    const targets = new Set(linkTargets);
    if (
      linkTargets.some(
        (target) =>
          !environmentPath(target) || containsRoot(outputRoots, target),
      )
    )
      throw new EnvironmentError();
    const ancestors = new Set<string>();
    for (const root of [...roots, ...linkTargets])
      for (
        let end = root.lastIndexOf("/");
        end > 0;
        end = root.lastIndexOf("/", end - 1)
      )
        ancestors.add(root.slice(0, end));
    const foldedEntries = new Map<string, TarEntryView>();
    for (const entry of entries) {
      if (
        !environmentPath(entry.path) ||
        !containsRoot(outputRoots, entry.path) ||
        entry.type === "char" ||
        entry.type === "block" ||
        entry.type === "fifo" ||
        (entry.type === "symlink" &&
          (!entry.linkname ||
            entry.linkname.startsWith("/") ||
            unsafePathCharacters(entry.linkname)))
      )
        throw new EnvironmentError();
      // Aliases matter only where a symlink is involved: two plain files that
      // differ by case are legitimate on Linux.
      const folded = foldedPath(entry.path);
      const alias = foldedEntries.get(folded);
      if (alias && (alias.type === "symlink" || entry.type === "symlink"))
        throw new EnvironmentError();
      if (!alias || entry.type === "symlink") foldedEntries.set(folded, entry);
    }
    for (const entry of entries) {
      const folded = foldedPath(entry.path);
      for (
        let end = folded.lastIndexOf("/");
        end > 0;
        end = folded.lastIndexOf("/", end - 1)
      )
        if (foldedEntries.get(folded.slice(0, end))?.type === "symlink")
          throw new EnvironmentError();
      if (entry.type === "symlink")
        checkLink(entry, byPath, outputRoots, ancestors, targets);
    }
    const archive = writeWorkspaceTar(entries);
    if (archive.byteLength > limit) throw new EnvironmentError();
    return archive;
  } catch {
    throw new EnvironmentError();
  }
}
