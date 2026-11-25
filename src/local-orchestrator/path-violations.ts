import { escapeTerminalControls } from "./analysis.ts";

export type PathViolation = { path: string; symlink: boolean };
export const MAX_PATH_VIOLATIONS = 20;
const maxPathLength = 256;

export function boundedPathViolation(
  path: string,
  symlink: boolean,
): PathViolation {
  let escaped = "";
  for (const character of path) {
    const piece =
      character === "\\" ? "\\\\" : escapeTerminalControls(character);
    if (escaped.length + piece.length > maxPathLength - 1)
      return { path: escaped + "…", symlink };
    escaped += piece;
  }
  return { path: escaped, symlink };
}

export function readPathViolations(
  value: unknown,
): PathViolation[] | undefined {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > MAX_PATH_VIOLATIONS
  )
    return;
  const paths: PathViolation[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") return;
    const { path, symlink } = item as Partial<PathViolation>;
    if (
      typeof path !== "string" ||
      path.length > maxPathLength ||
      typeof symlink !== "boolean"
    )
      return;
    if (escapeTerminalControls(path) !== path) return;
    paths.push({ path, symlink });
  }
  return paths;
}
