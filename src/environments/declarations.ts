import { isDeepStrictEqual } from "node:util";
import { EnvironmentError } from "./adapter.ts";

const dependencyFields = new Set([
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
]);

// Admit registry version ranges. Locators and aliases are kept verbatim.
const version = String.raw`[vV]?(?:\d+|[xX*])(?:\.(?:\d+|[xX*])){0,2}(?:-[a-zA-Z0-9-]+(?:\.[a-zA-Z0-9-]+)*)?(?:\+[a-zA-Z0-9-]+(?:\.[a-zA-Z0-9-]+)*)?`;
const comparator = String.raw`(?:(?:<=|>=|<|>|=|~>?|\^)\s*)?${version}`;
const rangeSet = String.raw`(?:${version}\s+-\s+${version}|${comparator}(?:\s+${comparator})*)`;
const range = new RegExp(
  String.raw`^(?:${rangeSet}(?:\s*\|\|\s*${rangeSet})*)?$`,
);

export const declarationFailureNote =
  "The Provisioner returned unexpected dependency declarations.";

export class DeclarationError extends EnvironmentError {
  constructor() {
    super("env-build-failed");
    this.message = declarationFailureNote;
  }
}

function rejected(): never {
  throw new DeclarationError();
}

/** Read JSON object members and retain their value offsets for source edits. */
function values(source: string) {
  const parsed: unknown = JSON.parse(source);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
    return rejected();
  const token = /\s*("(?:[^"\\]|\\[\s\S])*"|[{}[\],:]|[^\s{}[\],:"]+)/y;
  const next = () => token.exec(source)![1]!;
  next();
  const result = new Map<string, { start: number; source: string }>();
  for (let key = next(); key !== "}"; key = next()) {
    const name = JSON.parse(key) as string;
    if (result.has(name)) return rejected();
    next();
    const first = next();
    const start = token.lastIndex - first.length;
    let depth = first === "{" || first === "[" ? 1 : 0;
    while (depth) {
      const part = next();
      if (part === "{" || part === "[") depth++;
      if (part === "}" || part === "]") depth--;
    }
    result.set(name, { start, source: source.slice(start, token.lastIndex) });
    if (next() === "}") break;
  }
  return result;
}

type UpdateScope = { names?: readonly string[]; allowMajor?: boolean };

const rangeToken = new RegExp(
  String.raw`(<=|>=|<|>|=|~>?|\^)?\s*(${version})`,
  "g",
);

function versionLane(version: string) {
  const parts = /^[vV]?(\d+)(?:\.(\d+))?/.exec(version);
  if (!parts) return undefined;
  const major = BigInt(parts[1]!);
  if (major !== 0n) return { major, minor: undefined };
  if (parts[2] === undefined) return undefined;
  return { major, minor: BigInt(parts[2]) };
}

/** A comparator set can stay in one lane via a version selector, hyphen
 * range, or a lower and upper bound. Check each branch of a union. */
function rangeLanes(text: string, requireBound: boolean) {
  const lanes = new Set<string>();
  for (const set of text.split("||")) {
    const tokens = [...set.matchAll(rangeToken)];
    const hyphen = /\s+-\s+/.test(set);
    const lower = tokens.find(
      ([, operator]) => operator !== "<" && operator !== "<=",
    );
    const lane = lower && versionLane(lower[2]!);
    if (!lane) return undefined;
    const { major, minor } = lane;
    const boundary = minor === undefined ? `${major + 1n}` : `0.${minor + 1n}`;
    let bounded = hyphen;
    for (const [, operator, selected] of tokens) {
      const selectedLane = versionLane(selected!);
      if (operator === "<" || operator === "<=") {
        bounded = true;
        const normalized = selected!.replace(/^[vV]/, "");
        if (
          operator === "<" &&
          [
            boundary,
            boundary + ".0",
            boundary + ".0.0",
            boundary + ".0-0",
            boundary + ".0.0-0",
          ].includes(normalized)
        )
          continue;
      } else if (operator !== ">" && operator !== ">=") {
        bounded = true;
      }
      if (selectedLane?.major !== major || selectedLane?.minor !== minor)
        return undefined;
    }
    if (requireBound && !bounded) return undefined;
    lanes.add(minor === undefined ? String(major) : `0.${minor}`);
  }
  return lanes;
}

function allowsVersion(from: unknown, to: unknown, allowMajor: boolean) {
  if (typeof from !== "string" || typeof to !== "string") return false;
  const previous = from.trim();
  const current = to.trim();
  if (!range.test(previous) || !range.test(current)) return false;
  if (allowMajor) return true;
  const before = rangeLanes(previous, false);
  const after = rangeLanes(current, true);
  return (
    before !== undefined &&
    after !== undefined &&
    isDeepStrictEqual(before, after)
  );
}

function restoreDeclaration(
  source: string,
  output: string,
  update?: UpdateScope,
) {
  const before = values(source);
  const after = values(output);
  if (before.size !== after.size) return rejected();
  const names = update?.names?.length ? new Set(update.names) : undefined;
  if (update?.allowMajor && !names) return rejected();
  const replacements: { start: number; end: number; value: string }[] = [];
  for (const [key, original] of before) {
    const updated = after.get(key);
    if (!updated) return rejected();
    if (updated.source === original.source) continue;
    if (!update || !dependencyFields.has(key)) {
      if (
        !isDeepStrictEqual(
          JSON.parse(original.source),
          JSON.parse(updated.source),
        )
      )
        return rejected();
      continue;
    }
    const previous = values(original.source);
    const current = values(updated.source);
    if (previous.size !== current.size) return rejected();
    for (const [name, from] of previous) {
      const to = current.get(name);
      if (!to) return rejected();
      const oldValue: unknown = JSON.parse(from.source);
      const newValue: unknown = JSON.parse(to.source);
      if (isDeepStrictEqual(oldValue, newValue)) continue;
      if (
        (names && !names.has(name)) ||
        !allowsVersion(oldValue, newValue, update.allowMajor === true)
      )
        return rejected();
      const start = original.start + from.start;
      replacements.push({
        start,
        end: start + from.source.length,
        value: JSON.stringify(newValue),
      });
    }
  }
  if (!replacements.length) return undefined;
  const parts: string[] = [];
  let cursor = 0;
  for (const { start, end, value } of replacements) {
    parts.push(source.slice(cursor, start), value);
    cursor = end;
  }
  parts.push(source.slice(cursor));
  return parts.join("");
}

export function checkDeclaration(
  before: Uint8Array | undefined,
  after: Uint8Array,
  update?: UpdateScope,
): Uint8Array | undefined {
  try {
    if (!before) return rejected();
    const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
    const original = decoder.decode(before);
    const bom = original.startsWith("\uFEFF") ? "\uFEFF" : "";
    const restored = restoreDeclaration(
      original.slice(bom.length),
      decoder.decode(after).replace(/^\uFEFF/, ""),
      update,
    );
    return restored === undefined ? undefined : Buffer.from(bom + restored);
  } catch {
    return rejected();
  }
}
