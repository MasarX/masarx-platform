import { buildLookupFriendlyLabel } from "./lookup-friendly-label";

export function marketplaceReferenceLabel(kind: string, value: unknown, label: unknown) {
  return stringValue(label) ?? (buildLookupFriendlyLabel(kind, value) || null);
}

export function normalizeObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function normalizeArray(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => normalizeObject(entry))
    .filter((entry): entry is Record<string, unknown> => Boolean(entry));
}

export function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function jsonTextareaValue(value: unknown, fallback = "{}") {
  if (value == null) return fallback;
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return fallback;
  }
}

export function parseJsonValue(
  raw: string,
  fallback: unknown,
): { ok: true; value: unknown } | { ok: false; message: string } {
  const trimmed = raw.trim();
  if (!trimmed) return { ok: true, value: fallback };
  try {
    return { ok: true, value: JSON.parse(trimmed) };
  } catch {
    return { ok: false, message: "Invalid JSON payload." };
  }
}

export function marketplaceOrganizationLabel(...values: unknown[]) {
  return Array.from(new Set(values.map(stringValue).filter(Boolean))).join(" | ") || null;
}
