export type PickupJsonRecord = Record<string, unknown>;

export function normalizeObject(value: unknown): PickupJsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as PickupJsonRecord)
    : null;
}

export function normalizeArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function stringValue(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

export { parseJsonValue } from "./json-field";

export function parsePickupIdList(raw: string): string[] {
  const trimmed = raw.trim();
  if (!trimmed) return [];

  if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        return Array.from(
          new Set(
            parsed
              .map((entry) => String(entry ?? "").trim())
              .filter(Boolean),
          ),
        );
      }
    } catch {
      return [];
    }
  }

  return Array.from(
    new Set(
      trimmed
        .split(/[\s,]+/g)
        .map((entry) => entry.trim())
        .filter(Boolean),
    ),
  );
}

export function formatPickupAddress(address: unknown): string | null {
  const record = normalizeObject(address);
  if (!record) return null;

  const parts = [
    stringValue(record.line1),
    stringValue(record.line2),
    stringValue(record.district),
    stringValue(record.city),
    stringValue(record.province),
    stringValue(record.postal_code),
    stringValue(record.country),
  ]
    .map((part) => part?.trim() ?? "")
    .filter(Boolean);

  const rawInput = stringValue(record.raw_input)?.trim();
  if (parts.length === 0) {
    return rawInput || null;
  }

  return rawInput ? `${parts.join(", ")} (${rawInput})` : parts.join(", ");
}

export function formatDateTime(
  value: unknown,
  locale?: string | null,
  timeZone?: string | null,
): string | null {
  const raw = stringValue(value)?.trim() ?? "";
  if (!raw) return null;

  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) return raw;

  try {
    return new Intl.DateTimeFormat(locale ?? undefined, {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone: timeZone ?? undefined,
    }).format(date);
  } catch {
    return raw;
  }
}

export function formatDateTimeRange(
  start: unknown,
  end: unknown,
  locale?: string | null,
  timeZone?: string | null,
): string | null {
  const startLabel = formatDateTime(start, locale, timeZone);
  const endLabel = formatDateTime(end, locale, timeZone);
  if (!startLabel && !endLabel) return null;
  if (!startLabel) return endLabel;
  if (!endLabel) return startLabel;
  return `${startLabel} - ${endLabel}`;
}
