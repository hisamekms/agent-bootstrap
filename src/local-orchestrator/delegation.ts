import {
  canonicalJson,
  ContractError,
  fields,
  integer,
  oneOf,
  TASK_CATEGORIES,
  unique,
  type Gate,
  type Policy,
  type PolicySource,
  type TaskCategory,
} from "./model.ts";

export const RULE_GATES = ["task-registration", "integration"] as const;
export type RuleGate = (typeof RULE_GATES)[number];
export const GOAL_POLICIES = ["inherit", "human", "agent"] as const;
export const TASK_POLICIES = ["rule", "human", "agent"] as const;
export type GoalPolicy = (typeof GOAL_POLICIES)[number];
export type TaskPolicy = (typeof TASK_POLICIES)[number];
export const POLICY_INVARIANTS = [
  "host-check",
  "integration-verification",
  "integration-symlinks",
  "integration-symlink-evidence",
  "integration-review",
  "concierge-proposal",
  "scope-exception",
  "policy-loosening",
  "operator-commands",
] as const;

export type PolicyInvariant = (typeof POLICY_INVARIANTS)[number];
export type EffectivePolicy = {
  policy: Policy;
  source:
    PolicySource | "operator-task" | "operator-goal" | "rule" | "invariant";
  ruleId?: string;
  ruleName?: string;
  invariant?: PolicyInvariant;
};

export type DiffSize = {
  changedFiles: number;
  changedLines: number | null;
};

export type RuleConditions = {
  pathsWithin?: string[];
  pathsExclude?: string[];
  maxTokens?: number;
  maxChangedLines?: number;
  maxChangedFiles?: number;
  categories?: TaskCategory[];
};

export type DelegationRule = {
  id: string;
  name: string;
  gate: RuleGate;
  action: Policy;
  enabled: boolean;
  order: number;
  conditions: RuleConditions;
};

function glob(value: unknown, exclusion: boolean): string {
  if (
    typeof value !== "string" ||
    value.length > 160 ||
    (exclusion ? value.normalize("NFC") : value)
      .split("/")
      .some(
        (segment) =>
          segment === "." ||
          segment === ".." ||
          !/^[\p{L}\p{N}._ *-]+$/u.test(segment) ||
          (segment.includes("**") && segment !== "**"),
      )
  )
    throw new ContractError();
  return value;
}

export function validateDelegationRules(value: unknown): DelegationRule[] {
  const ids = new Set<string>();
  const rules = unique(value, 0, 50, (item) => {
    const { id, name, gate, action, enabled, order, conditions } = fields(
      item,
      ["id", "name", "gate", "action", "enabled", "order", "conditions"],
    );
    if (
      typeof id !== "string" ||
      !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(id) ||
      ids.has(id) ||
      typeof name !== "string" ||
      !name.trim() ||
      name.length > 80 ||
      /[\p{Cc}\p{Cs}]/u.test(name) ||
      typeof enabled !== "boolean"
    )
      throw new ContractError();
    ids.add(id);
    const validGate = oneOf(gate, RULE_GATES);
    const numbers =
      validGate === "task-registration"
        ? (["maxTokens"] as const)
        : (["maxChangedLines", "maxChangedFiles"] as const);
    const paths = ["pathsWithin", "pathsExclude"] as const;
    const input = fields(conditions, [...paths, ...numbers, "categories"]);
    const parsed: RuleConditions = {};
    for (const key of paths) {
      if (Object.hasOwn(input, key))
        parsed[key] = unique(input[key], 1, 16, (pattern) =>
          glob(pattern, key === "pathsExclude"),
        );
    }
    for (const key of numbers) {
      if (Object.hasOwn(input, key))
        parsed[key] = integer(input[key], 0, Number.MAX_SAFE_INTEGER);
    }
    if (Object.keys(parsed).length === 0) throw new ContractError();
    if (Object.hasOwn(input, "categories"))
      parsed.categories = unique(
        input.categories,
        1,
        TASK_CATEGORIES.length,
        (category) => oneOf(category, TASK_CATEGORIES),
      );
    const rule = {
      id,
      name,
      gate: validGate,
      action: oneOf(action, ["agent", "human"]),
      enabled,
      order: integer(order, 0, 49),
      conditions: parsed,
    };
    // Both versions of one rule must fit in a single append-only event.
    canonicalJson(rule, 1750);
    return rule;
  }).sort((a, b) => a.order - b.order);
  if (rules.some((rule, index) => rule.order !== index))
    throw new ContractError();
  canonicalJson(rules, 48 * 1024);
  return rules;
}

// A single star matches within one component. This uses bounded backtracking
// to the most recent star, without invoking a regular expression on paths.
function matchesSegment(pattern: string, path: string): boolean {
  let i = 0;
  let j = 0;
  let star = -1;
  let consumed = 0;
  while (j < path.length) {
    if (pattern[i] === "*") {
      star = i++;
      consumed = j;
    } else if (pattern[i] === path[j]) {
      i++;
      j++;
    } else if (star !== -1) {
      i = star + 1;
      j = ++consumed;
    } else return false;
  }
  return i === pattern.length || pattern.slice(i) === "*";
}

function excludedSegmentMatcher(pattern: string): (path: string) => boolean {
  const literals = pattern
    .normalize("NFC")
    .split("*")
    .map((literal) => literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const first = literals.shift()!;
  if (literals.length === 0) {
    const exact = new RegExp(`^${first}$`, "iu");
    return (path) => exact.test(path);
  }
  const prefix = new RegExp(`^${first}`, "iu");
  const suffix = new RegExp(`${literals.pop()!}$`, "iu");
  const middle = literals.map((literal) => new RegExp(literal, "giu"));
  // Match each literal in order between the anchored ends. The regular
  // expressions contain no wildcards, so glob stars never backtrack here.
  return (path) => {
    const start = prefix.exec(path)?.[0].length;
    const end = suffix.exec(path)?.index;
    if (start === undefined || end === undefined || start > end) return false;
    const interior = path.slice(start, end);
    let offset = 0;
    for (const literal of middle) {
      literal.lastIndex = offset;
      if (!literal.test(interior)) return false;
      offset = literal.lastIndex;
    }
    return true;
  };
}

type GlobSegment = "**" | ((path: string) => boolean);

function compileGlob(glob: string, mode: "within" | "exclude"): GlobSegment[] {
  return glob.split("/").map((segment) => {
    if (segment === "**") return segment;
    return mode === "exclude"
      ? excludedSegmentMatcher(segment)
      : (path) => matchesSegment(segment, path);
  });
}

function matchesPath(
  segments: readonly GlobSegment[],
  path: string,
  mode: "within" | "exclude",
) {
  const directory = path.endsWith("/");
  let states = new Set([0]);
  const expand = (positions: Set<number>) => {
    for (const i of positions) if (segments[i] === "**") positions.add(i + 1);
  };
  expand(states);
  for (const part of path.replace(/\/$/, "").split("/")) {
    const next = new Set<number>();
    for (const i of states) {
      const segment = segments[i];
      if (segment === "**") next.add(i);
      else if (segment?.(part)) next.add(i + 1);
    }
    expand(next);
    states = next;
    if (states.size === 0) return false;
  }
  if (!directory) return states.has(segments.length);
  // A planned directory covers all descendants. Exclusions must also
  // consider descendants the Planner did not enumerate.
  return mode === "exclude"
    ? states.size > 0
    : segments.at(-1) === "**" && states.has(segments.length - 1);
}

export type RuleFacts = {
  paths: readonly string[];
  category?: TaskCategory | undefined;
  maxTokens?: number;
  diffSize?: DiffSize;
};

export function ruleMatches(
  { conditions }: DelegationRule,
  facts: RuleFacts,
): boolean {
  const {
    pathsWithin,
    pathsExclude,
    maxTokens,
    maxChangedLines,
    maxChangedFiles,
    categories,
  } = conditions;
  if (
    (maxTokens !== undefined && (facts.maxTokens ?? Infinity) > maxTokens) ||
    (maxChangedLines !== undefined &&
      (facts.diffSize?.changedLines ?? Infinity) > maxChangedLines) ||
    (maxChangedFiles !== undefined &&
      (facts.diffSize?.changedFiles ?? Infinity) > maxChangedFiles)
  )
    return false;
  const within = pathsWithin?.map((glob) => compileGlob(glob, "within"));
  const exclude = pathsExclude?.map((glob) => compileGlob(glob, "exclude"));
  return (
    (!categories ||
      (facts.category !== undefined && categories.includes(facts.category))) &&
    ((!within && !exclude) || facts.paths.length > 0) &&
    (!within ||
      facts.paths.every((path) =>
        within.some((segments) => matchesPath(segments, path, "within")),
      )) &&
    (!exclude ||
      !facts.paths.some((path) => {
        const normalized = path.normalize("NFC");
        return exclude.some((segments) =>
          matchesPath(segments, normalized, "exclude"),
        );
      }))
  );
}

export function resolveDelegation(
  gate: Gate,
  options: {
    fallback: EffectivePolicy;
    invariant?: PolicyInvariant | undefined;
    task?: TaskPolicy | undefined;
    goal?: GoalPolicy | undefined;
    rules: readonly DelegationRule[];
    facts?: RuleFacts | undefined;
  },
): EffectivePolicy {
  const { fallback, invariant, task, goal, rules, facts } = options;
  if (gate === "host-check")
    return { policy: "human", source: "invariant", invariant: "host-check" };
  if (invariant) return { policy: "human", source: "invariant", invariant };
  if (gate === "integration" && (task === "human" || task === "agent"))
    return { policy: task, source: "operator-task" };
  if (gate !== "goal-registration" && (goal === "human" || goal === "agent"))
    return { policy: goal, source: "operator-goal" };
  const match =
    facts &&
    rules.find(
      (rule) => rule.enabled && rule.gate === gate && ruleMatches(rule, facts),
    );
  return match
    ? {
        policy: match.action,
        source: "rule",
        ruleId: match.id,
        ruleName: match.name,
      }
    : fallback;
}
