import { stableStringify } from "./kv";

function fnv1a32(input: string) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export function createStableId(parts: unknown, params: { prefix?: string } = {}) {
  const prefix = String(params.prefix ?? "id").trim() || "id";
  const raw = stableStringify(parts);
  return `${prefix}_${fnv1a32(raw)}`;
}

