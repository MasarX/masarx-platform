import { labelFromKey } from "./resource-query";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const DISPLAY_IDENTIFIER_KEYS = [
  "display_id",
  "public_id",
  "external_id",
  "tracking_number",
  "reference",
  "code",
  "number",
];

type ResolveDisplayIdentifierOptions = {
  fallback?: string | null;
  preferredKeys?: string[] | null;
};

export type DisplayIdentifier = {
  key: string;
  label: string;
  value: string;
};

function isUuidLike(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return false;
  return UUID_PATTERN.test(trimmed);
}

function normalizeIdentifierKey(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, "");
}

function normalizeIdentifierValue(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

function resolveCandidateKeys(preferredKeys: string[] | null | undefined) {
  const merged = [...(preferredKeys ?? []), ...DISPLAY_IDENTIFIER_KEYS];
  const seen = new Set<string>();
  const unique: string[] = [];
  merged.forEach((entry) => {
    const key = String(entry ?? "").trim();
    if (!key) return;
    const normalized = normalizeIdentifierKey(key);
    if (!normalized || seen.has(normalized)) return;
    seen.add(normalized);
    unique.push(key);
  });
  return unique;
}

export function resolveDisplayIdentifier(
  item: Record<string, unknown>,
  options: ResolveDisplayIdentifierOptions = {}
): DisplayIdentifier | null {
  const fallback = normalizeIdentifierValue(String(options.fallback ?? ""));
  const candidates = resolveCandidateKeys(options.preferredKeys);

  for (const key of candidates) {
    const raw = item[key];
    if (typeof raw !== "string") continue;
    const value = raw.trim();
    if (!value) continue;
    if (isUuidLike(value)) continue;
    if (normalizeIdentifierValue(value) === fallback) continue;
    return {
      key,
      label: labelFromKey(key),
      value,
    };
  }

  return null;
}
