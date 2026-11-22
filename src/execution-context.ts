import { types } from "node:util";
import { uuidPattern } from "./private-journal.ts";

export type ExecutionAttribute = string | number | boolean;

export interface TraceContext {
  readonly traceparent: string;
  readonly tracestate?: string;
}

export interface ExecutionContext {
  /** The existing invocation ID, in its canonical lowercase UUIDv4 form. */
  readonly executionId: string;
  readonly sessionId?: string;
  readonly retryOfExecutionId?: string;
  readonly correlationId?: string;
  readonly attributes?: Readonly<Record<string, ExecutionAttribute>>;
  readonly traceContext?: TraceContext;
}

const contextKeys = [
  "executionId",
  "sessionId",
  "retryOfExecutionId",
  "correlationId",
  "attributes",
  "traceContext",
];
const optionalIds = [
  "sessionId",
  "retryOfExecutionId",
  "correlationId",
] as const;
const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const attributeKey = /^[a-z][a-z0-9_.]{0,63}$/;
// Use the credential suffixes from isSafeCredentialVariable, without its
// exclusions for configuration variables. Those names can still hold secrets.
const credentialKey =
  /(?:^|[_.@-])(?:token|key|secret|password|authorization|cookie|credential|credentials)(?:$|[_.@-])|password$/i;
const credentialValuePatterns = [
  /\b(?:bearer|basic)[ \t]+[a-z0-9+/_.=-]+/i,
  /\b(?:authorization|cookie|x-api-key|[\w.-]*(?:token|secret|password|_key|api[-_]?key))["']?\s*[:=]\s*\S/i,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\beyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\b/,
  /\b(?:sk-|sk_(?:live|test)_|gh[pousr]_|github_pat_|xox[baprs]-|AIza)[a-z0-9_-]{8,}/i,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/,
  // The gateway's per-sandbox password is 32 random bytes encoded in hex.
  /\b[0-9a-f]{64}\b/i,
];
const rawLocation =
  /[a-z][a-z0-9+.-]*:\/\/|(?:^|[\s=:,"'(])(?:[a-z]:[\\/]|\\\\|~?\/|\.{1,2}[\\/]|[a-z_.][a-z0-9_.-]*[\\/])\S/i;
// oxlint-disable-next-line eslint/no-control-regex -- Reject control bytes in metadata.
const controlCharacters = /[\u0000-\u001f\u007f-\u009f]/u;

function invalid(): never {
  // Do not put rejected input (including field names) in diagnostics.
  throw new TypeError("Invalid execution context");
}

/** Snapshot own data properties without calling user code. */
function dataRecord(
  value: unknown,
  allowed?: readonly string[],
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || types.isProxy(value))
    return invalid();

  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== null && prototype !== Object.prototype) return invalid();

  const descriptors = Object.getOwnPropertyDescriptors(value);
  const result: Record<string, unknown> = Object.create(null);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== "string" || (allowed && !allowed.includes(key)))
      return invalid();
    const descriptor = descriptors[key];
    if (!descriptor || !Object.hasOwn(descriptor, "value")) return invalid();
    result[key] = descriptor.value;
  }
  return result;
}

function looksLikeCredential(value: string): boolean {
  return credentialValuePatterns.some((pattern) => pattern.test(value));
}

function parseAttributes(
  value: unknown,
): Readonly<Record<string, ExecutionAttribute>> {
  const entries = Object.entries(dataRecord(value));
  if (entries.length > 16) return invalid();

  const attributes: Record<string, ExecutionAttribute> = {};
  for (const [key, attribute] of entries) {
    if (
      !attributeKey.test(key) ||
      credentialKey.test(key) ||
      looksLikeCredential(key)
    )
      return invalid();
    if (typeof attribute === "string") {
      if (
        Buffer.byteLength(attribute) > 256 ||
        controlCharacters.test(attribute) ||
        rawLocation.test(attribute) ||
        looksLikeCredential(attribute)
      )
        return invalid();
    } else if (
      typeof attribute !== "boolean" &&
      !(typeof attribute === "number" && Number.isFinite(attribute))
    ) {
      return invalid();
    }
    attributes[key] = attribute;
  }
  return Object.freeze(attributes);
}

function parseTraceState(value: unknown): string {
  if (typeof value !== "string" || Buffer.byteLength(value) > 512)
    return invalid();
  const members = value.split(",");
  if (members.length > 32) return invalid();

  const seen = new Set<string>();
  for (const member of members) {
    const entry =
      /^[ \t]*([a-z][a-z0-9_*/-]{0,255}|[a-z0-9][a-z0-9_*/-]{0,240}@[a-z][a-z0-9_*/-]{0,13})[ \t]*=[ \t]*([\x20-\x2b\x2d-\x3c\x3e-\x7e]{0,255}[\x21-\x2b\x2d-\x3c\x3e-\x7e])[ \t]*$/.exec(
        member,
      );
    const key = entry?.[1];
    const state = entry?.[2];
    if (
      key === undefined ||
      state === undefined ||
      seen.has(key) ||
      credentialKey.test(key) ||
      looksLikeCredential(key) ||
      rawLocation.test(state) ||
      looksLikeCredential(state)
    )
      return invalid();
    seen.add(key);
  }
  return value;
}

function parseTraceContext(value: unknown): TraceContext {
  const trace = dataRecord(value, ["traceparent", "tracestate"]);
  const parent = trace.traceparent;
  // Only the version 00 layout is understood in v0.1. Future extensions
  // could carry opaque data, so refuse them until supported explicitly.
  if (
    typeof parent !== "string" ||
    !/^00-(?!0{32}-)[a-f0-9]{32}-(?!0{16}-)[a-f0-9]{16}-[a-f0-9]{2}$/.test(
      parent,
    )
  )
    return invalid();

  return Object.freeze(
    Object.hasOwn(trace, "tracestate")
      ? { traceparent: parent, tracestate: parseTraceState(trace.tracestate) }
      : { traceparent: parent },
  );
}

/** Validate host metadata before it is shared with audit or telemetry. */
export function parseExecutionContext(value: unknown): ExecutionContext {
  const input = dataRecord(value, contextKeys);
  if (
    typeof input.executionId !== "string" ||
    !uuidPattern.test(input.executionId)
  )
    return invalid();

  const ids: Partial<Record<(typeof optionalIds)[number], string>> = {};
  for (const key of optionalIds) {
    if (!Object.hasOwn(input, key)) continue;
    const id = input[key];
    if (
      typeof id !== "string" ||
      !uuid.test(id) ||
      (key === "retryOfExecutionId" && !uuidPattern.test(id))
    )
      return invalid();
    ids[key] = id;
  }

  return Object.freeze({
    executionId: input.executionId,
    ...ids,
    ...(Object.hasOwn(input, "attributes")
      ? { attributes: parseAttributes(input.attributes) }
      : {}),
    ...(Object.hasOwn(input, "traceContext")
      ? { traceContext: parseTraceContext(input.traceContext) }
      : {}),
  });
}
