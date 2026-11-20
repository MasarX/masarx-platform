import { getUiDefaults } from "@masarx/config";

const uiDefaults = getUiDefaults();
const DATE_TIME_FORMATTER_CACHE = new Map<string, Intl.DateTimeFormat>();
const NUMBER_FORMATTER_CACHE = new Map<string, Intl.NumberFormat>();
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MACHINE_LOOKUP_VALUE_PATTERN = /^[a-z][a-z0-9]*(?:[_-][a-z0-9]+)+$/;
const LOOKUP_LABEL_ACRONYMS = new Set([
  "api",
  "cod",
  "db",
  "id",
  "ndr",
  "pod",
  "rls",
  "rto",
  "sla",
  "ui",
]);

export type ResourceFormatMeta = {
  renderType?: string | null;
  formatOptions?: Record<string, unknown> | null;
};

function normalizeLookupLabelEntries(options?: Record<string, unknown> | null) {
  const raw = options?.lookup_labels ?? options?.lookupLabels;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const labels = new Map<string, string>();
  Object.entries(raw as Record<string, unknown>).forEach(([value, label]) => {
    const normalizedValue = value.trim();
    const normalizedLabel = String(label ?? "").trim();
    if (!normalizedValue || !normalizedLabel) return;
    labels.set(normalizedValue, normalizedLabel);
    labels.set(normalizedValue.toLowerCase(), normalizedLabel);
  });
  return labels.size > 0 ? labels : null;
}

function resolveLookupLabel(
  value: unknown,
  options?: Record<string, unknown> | null
) {
  const labels = normalizeLookupLabelEntries(options);
  if (!labels || value === null || value === undefined) return null;
  const normalizedValue = String(value).trim();
  if (!normalizedValue) return null;
  return labels.get(normalizedValue) ?? labels.get(normalizedValue.toLowerCase()) ?? null;
}

export function isHumanizableMachineValue(value: string) {
  const trimmed = value.trim();
  if (!trimmed || UUID_PATTERN.test(trimmed)) return false;
  return MACHINE_LOOKUP_VALUE_PATTERN.test(trimmed);
}

export function formatMachineValueLabel(value: string) {
  const trimmed = value.trim();
  if (!isHumanizableMachineValue(trimmed)) return trimmed;
  return trimmed
    .split(/[_-]+/)
    .filter(Boolean)
    .map((part) => {
      const lower = part.toLowerCase();
      if (LOOKUP_LABEL_ACRONYMS.has(lower)) return lower.toUpperCase();
      return lower.charAt(0).toUpperCase() + lower.slice(1);
    })
    .join(" ");
}

function hasLookupFormatting(
  renderType?: string | null,
  options?: Record<string, unknown> | null
) {
  return (
    renderType?.toLowerCase() === "lookup" ||
    normalizeLookupLabelEntries(options) !== null
  );
}

function formatLookupFallbackValue(value: unknown) {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return "";
    if (UUID_PATTERN.test(trimmed)) return formatReferenceValue(trimmed);
    return formatMachineValueLabel(trimmed);
  }
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return JSON.stringify(formatStructuredResourceValue(value));
  } catch {
    return String(value);
  }
}

function formatLookupValue(
  value: unknown,
  options?: Record<string, unknown> | null
) {
  if (value === null || value === undefined) return "-";
  if (Array.isArray(value)) {
    const labels = value
      .map((entry) => resolveLookupLabel(entry, options) ?? formatLookupFallbackValue(entry))
      .filter(Boolean);
    return labels.length > 0 ? labels.join(", ") : "-";
  }
  const label = resolveLookupLabel(value, options);
  if (label) return label;
  return formatLookupFallbackValue(value) || "-";
}

function parseDate(value: unknown) {
  if (value instanceof Date) return value;
  if (typeof value === "number") return Number.isFinite(value) ? new Date(value) : null;
  if (typeof value === "string" && value.trim()) {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  return null;
}

function serializeFormatOptions(options?: Record<string, unknown> | null) {
  if (!options) return "";
  const entries = Object.entries(options)
    .filter(([, value]) => value !== undefined)
    .sort(([left], [right]) => left.localeCompare(right));
  return JSON.stringify(entries);
}

function resolveDateFormatter(options?: Record<string, unknown> | null) {
  const key = `${uiDefaults.locale}:${serializeFormatOptions(options)}`;
  const cached = DATE_TIME_FORMATTER_CACHE.get(key);
  if (cached) return cached;
  try {
    const formatter = new Intl.DateTimeFormat(
      uiDefaults.locale,
      options as Intl.DateTimeFormatOptions
    );
    DATE_TIME_FORMATTER_CACHE.set(key, formatter);
    return formatter;
  } catch {
    return null;
  }
}

function formatDateValue(value: unknown, options?: Record<string, unknown> | null) {
  const date = parseDate(value);
  if (!date) return null;
  const dateStyle = typeof options?.dateStyle === "string" ? options.dateStyle : "medium";
  const timeStyle = typeof options?.timeStyle === "string" ? options.timeStyle : "short";
  const timeZone = typeof options?.timeZone === "string" ? options.timeZone : undefined;
  const formatter = resolveDateFormatter({
    dateStyle: dateStyle as Intl.DateTimeFormatOptions["dateStyle"],
    timeStyle: timeStyle as Intl.DateTimeFormatOptions["timeStyle"],
    timeZone,
  });
  return formatter ? formatter.format(date) : null;
}

function formatNumberValue(value: unknown, options?: Record<string, unknown> | null) {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  try {
    const key = `${uiDefaults.locale}:${serializeFormatOptions(options)}`;
    const cached = NUMBER_FORMATTER_CACHE.get(key);
    if (cached) return cached.format(value);
    const formatter = new Intl.NumberFormat(
      uiDefaults.locale,
      options as Intl.NumberFormatOptions
    );
    NUMBER_FORMATTER_CACHE.set(key, formatter);
    return formatter.format(value);
  } catch {
    return String(value);
  }
}

function isUuidLike(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return false;
  return UUID_PATTERN.test(trimmed);
}

function formatStructuredResourceValue(value: unknown, depth = 0): unknown {
  if (depth > 8) return "[truncated]";
  if (typeof value === "string") {
    return isUuidLike(value) ? formatReferenceValue(value) : value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => formatStructuredResourceValue(entry, depth + 1));
  }
  if (!value || typeof value !== "object" || value instanceof Date) {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
      key,
      formatStructuredResourceValue(entry, depth + 1),
    ])
  );
}

export function formatResourceValue(
  value: unknown,
  meta?: ResourceFormatMeta
): string {
  const renderType = meta?.renderType?.toLowerCase();
  const options = meta?.formatOptions ?? null;

  if (hasLookupFormatting(renderType, options)) {
    return formatLookupValue(value, options);
  }

  if (renderType === "id") {
    if (value === null || value === undefined) return "-";
    const text = String(value);
    return isUuidLike(text) ? formatReferenceValue(text) : formatIdValue(text);
  }
  if (renderType === "uuid") {
    if (value === null || value === undefined) return "-";
    return formatReferenceValue(String(value));
  }

  if (renderType === "date") {
    return formatDateValue(value, { ...options, timeStyle: undefined }) ?? "-";
  }
  if (renderType === "datetime" || renderType === "timestamp") {
    return formatDateValue(value, options) ?? "-";
  }
  if (renderType === "number") {
    return formatNumberValue(value, options) ?? "-";
  }
  if (renderType === "currency") {
    return formatNumberValue(value, {
      style: "currency",
      currency: typeof options?.currency === "string" ? options.currency : "USD",
      ...options,
    }) ?? "-";
  }
  if (renderType === "boolean") {
    if (typeof value === "boolean") return value ? "true" : "false";
  }

  if (value === null || value === undefined) return "-";
  if (typeof value === "string") return value;
  if (typeof value === "number")
    return Number.isFinite(value) ? String(value) : String(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (value instanceof Date) return value.toISOString();
  try {
    return JSON.stringify(formatStructuredResourceValue(value));
  } catch {
    return String(value);
  }
}

export function formatResourceSearchValue(
  value: unknown,
  meta?: ResourceFormatMeta
): string {
  const renderType = meta?.renderType?.toLowerCase();
  const options = meta?.formatOptions ?? null;
  if (hasLookupFormatting(renderType, options)) {
    return formatLookupValue(value, options);
  }
  if (renderType === "id" || renderType === "uuid") {
    return value === null || value === undefined ? "" : String(value);
  }
  if (renderType === "date") {
    const date = parseDate(value);
    return date ? date.toISOString().split("T")[0] ?? "" : "";
  }
  if (renderType === "datetime" || renderType === "timestamp") {
    const date = parseDate(value);
    return date ? date.toISOString() : "";
  }
  if (renderType === "number" || renderType === "currency") {
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
    return value === null || value === undefined ? "" : String(value);
  }
  if (renderType === "boolean") {
    if (typeof value === "boolean") return value ? "true" : "false";
  }
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value instanceof Date) return value.toISOString();
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function formatIdValue(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "-";
  if (trimmed.length <= 12) return trimmed;
  return `${trimmed.slice(0, 4)}...${trimmed.slice(-4)}`;
}

export function formatDisplayIdentifierValue(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "-";
  if (trimmed.length <= 18) return trimmed;
  const head = 10;
  const tail = 6;
  if (trimmed.length <= head + tail + 3) return trimmed;
  return `${trimmed.slice(0, head)}...${trimmed.slice(-tail)}`;
}

export function isUuidValue(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return false;
  return UUID_PATTERN.test(trimmed);
}

export function formatReferenceValue(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "-";
  if (trimmed.length <= 12) return trimmed;
  const token = trimmed.replace(/[^a-z0-9]/gi, "").toUpperCase();
  if (!token) return formatIdValue(trimmed);
  if (isUuidValue(trimmed) && token.length >= 8) {
    return `REF-${token.slice(0, 4)}${token.slice(-4)}`;
  }
  if (token.length >= 6) {
    return `REF-${token.slice(0, 3)}${token.slice(-3)}`;
  }
  return `REF-${token}`;
}

export function resolveRecordLabel(
  item: Record<string, unknown>,
  labelKeys: string[] = uiDefaults.resourceLabelKeys
): string | null {
  for (const key of labelKeys) {
    const value = item[key];
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (trimmed) return trimmed;
    }
  }
  return null;
}

export function resolveRecordDescriptor(
  item: Record<string, unknown>,
  descriptorKeys: string[] = uiDefaults.resourceDescriptorKeys
): string | null {
  for (const key of descriptorKeys) {
    const value = item[key];
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (trimmed) return trimmed;
    }
  }
  return null;
}
