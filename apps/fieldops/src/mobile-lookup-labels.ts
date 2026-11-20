export const FIELDOPS_LOOKUP_MISSING_FRIENDLY_LABEL =
  "Lookup option missing friendly label";

const UUID_VALUE_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const LOOKUP_LABEL_ACRONYMS = new Set(["id", "cod", "ndr", "pod", "rto", "sla"]);

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function normalizeText(value: unknown) {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "";
}

function isRawLookupOptionLabel(label: string, value: string) {
  const normalized = label.trim();
  if (!normalized) return true;
  if (normalized.toLowerCase() === value.trim().toLowerCase()) return true;
  return UUID_VALUE_PATTERN.test(normalized);
}

export function formatFieldOpsLookupKeyLabel(key: string) {
  return key
    .replace(/[_-]+/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => {
      const lower = part.toLowerCase();
      return LOOKUP_LABEL_ACRONYMS.has(lower)
        ? lower.toUpperCase()
        : lower.charAt(0).toUpperCase() + lower.slice(1);
    })
    .join(" ");
}

export function resolveFieldOpsLookupOptionLabel(
  record: Record<string, unknown>,
  value: string,
) {
  const metadata = asRecord(record.metadata);
  const friendlyCandidates = [
    record.label,
    metadata.display_label,
    metadata.label,
    metadata.name,
    metadata.title,
    record.name,
    record.title,
  ];

  for (const candidate of friendlyCandidates) {
    const label = normalizeText(candidate);
    if (label && !isRawLookupOptionLabel(label, value)) return label;
  }

  const normalizedValue = value.trim();
  if (!normalizedValue || UUID_VALUE_PATTERN.test(normalizedValue)) {
    return FIELDOPS_LOOKUP_MISSING_FRIENDLY_LABEL;
  }
  return formatFieldOpsLookupKeyLabel(normalizedValue);
}
