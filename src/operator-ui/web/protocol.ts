import type { InboxItem } from "../../local-orchestrator/inbox.ts";
import type {
  operatorProposal,
  operatorStatus,
} from "../../local-orchestrator/operator-read.ts";

export type Proposal = NonNullable<
  Awaited<ReturnType<typeof operatorProposal>>
>;
export type Status = ReturnType<typeof operatorStatus>;

export interface Methods {
  status: { params: Record<string, never>; result: Status };
  "inbox.list": { params: { includeResolved?: boolean }; result: InboxItem[] };
  "inbox.subscribe": {
    params: Record<string, never>;
    result: { subscribed: true };
  };
  "inbox.markSeen": { params: { ids: string[] }; result: { marked: number } };
  "proposal.get": { params: { id: string }; result: Proposal };
  "concierge.attach": {
    params: Record<string, never>;
    result: { replay: string };
  };
  "concierge.input": { params: { data: string }; result: object };
  "concierge.resize": {
    params: { cols: number; rows: number };
    result: object;
  };
}

export type Push =
  | { method: "inbox.changed"; params: { ids: string[] } }
  | { method: "concierge.output"; params: { data: string } }
  | { method: "concierge.exit"; params: { exitCode: number | null } }
  | { method: "concierge.notice"; params: { code: "input-transferred" } };

export function decodeBase64(data: string): Uint8Array {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++)
    bytes[index] = binary.charCodeAt(index);
  return bytes;
}

export function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

const maxInputBytes = 16 * 1024;

export function* chunkInput(bytes: Uint8Array) {
  for (let offset = 0; offset < bytes.length; offset += maxInputBytes) {
    yield bytes.subarray(offset, offset + maxInputBytes);
  }
}

function clamp(value: number, min: number, max: number): number {
  return Number.isNaN(value)
    ? min
    : Math.min(max, Math.max(min, Math.trunc(value)));
}

export function clampSize(cols: number, rows: number) {
  return { cols: clamp(cols, 20, 500), rows: clamp(rows, 5, 200) };
}

export function orderInbox<T extends Pick<InboxItem, "weight">>(
  items: readonly T[],
): T[] {
  return [
    ...items.filter(({ weight }) => weight === "action"),
    ...items.filter(({ weight }) => weight === "info"),
  ];
}
