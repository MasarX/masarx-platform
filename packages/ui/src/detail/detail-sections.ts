import { labelFromKey } from "../resource-query";
import {
  formatResourceValue,
  formatDisplayIdentifierValue,
  formatIdValue,
  formatReferenceValue,
  isUuidValue,
  isHumanizableMachineValue,
} from "../resource-utils";
import { resolveDisplayIdentifier } from "../display-identifiers";
import { normalizeEditOptions, resolveEditOptionLabel } from "../edit-option-utils";
import { resolveSafeHref } from "../url-guard";

export type ResourceDetailColumn = {
  key: string;
  label?: string | null;
  detailSection?: string | null;
  renderType?: string | null;
  formatOptions?: Record<string, unknown> | null;
  editType?: string | null;
  editMode?: string | null;
  editOptions?: unknown[] | null;
};

export type ResourceDetailEntry = {
  key: string;
  label: string;
  displayValue: string;
  title?: string;
  hint?: string | null;
  sectionId: string;
  sectionLabel: string;
  hideDisplayValue?: boolean;
  rawValue: unknown;
  linkHref?: string | null;
};

export type ResourceDetailSection = {
  id: string;
  label: string;
  entries: ResourceDetailEntry[];
};

const GENERAL_SECTION_ID = "general";

function resolveColumnLabel(column: ResourceDetailColumn | undefined, key: string) {
  const label = column?.label?.trim();
  if (label) return label;
  return labelFromKey(key);
}

function resolveSectionId(value: string | null | undefined) {
  const trimmed = value?.trim();
  if (!trimmed) return GENERAL_SECTION_ID;
  return trimmed.toLowerCase();
}

function resolveSectionLabel(value: string | null | undefined, fallback: string) {
  const trimmed = value?.trim();
  if (!trimmed) return fallback;
  return labelFromKey(trimmed);
}

function resolveDetailIdentifierKeys(key: string) {
  if (key === "id") {
    return ["display_id", "public_id", "external_id", "tracking_number", "reference", "code", "number"];
  }
  if (!key.endsWith("_id")) return null;
  const baseKey = key.slice(0, Math.max(0, key.length - 3));
  return [
    `${baseKey}_display_id`,
    `${baseKey}_public_id`,
    `${baseKey}_external_id`,
    `${baseKey}_name`,
  ];
}

/**
 * Build detail sections from raw data and columns.
 * Shared between read-only ResourceDetail and editable ResourceDetailEditable.
 */
export function resolveResourceKeyFromFk(fieldKey: string): string | null {
  if (!fieldKey.endsWith("_id") || fieldKey === "id") return null;
  const base = fieldKey.slice(0, fieldKey.length - 3);
  if (!base) return null;
  // Use the last segment after underscores as the entity noun
  // e.g. "destination_address" -> "address", "sender" -> "sender"
  const segments = base.split("_");
  const noun = segments[segments.length - 1] ?? base;
  if (!noun) return null;
  // Simple pluralization: add 's', handle 'ss' -> 'sses', 'y' -> 'ies'
  if (noun.endsWith("ss")) return `${noun}es`;
  if (noun.endsWith("s")) return noun;
  if (noun.endsWith("y") && noun.length > 1 && !/[aeiou]/.test(noun[noun.length - 2] ?? "")) {
    return `${noun.slice(0, -1)}ies`;
  }
  return `${noun}s`;
}

export function resolveFkLinkHref(
  key: string,
  value: unknown,
  appBasePath: string | null | undefined
): string | null {
  if (appBasePath == null) return null;
  if (key === "id" || !key.endsWith("_id")) return null;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || !isUuidValue(trimmed)) return null;
  const resourceKey = resolveResourceKeyFromFk(key);
  if (!resourceKey) return null;
  return resolveSafeHref(
    appBasePath,
    `/resources/${encodeURIComponent(resourceKey)}?id=${encodeURIComponent(trimmed)}&detail_open=1`
  );
}

export function buildDetailSections(
  data: Record<string, unknown>,
  columns: ResourceDetailColumn[] | null | undefined,
  generalLabel: string,
  internalIdLabel: string,
  showInternalIdHints: boolean,
  appBasePath?: string | null
): ResourceDetailSection[] {
  const columnMap = new Map<string, ResourceDetailColumn>();
  const orderMap = new Map<string, number>();
  (columns ?? []).forEach((column, index) => {
    if (!column?.key) return;
    columnMap.set(column.key, column);
    orderMap.set(column.key, index);
  });

  const entries: ResourceDetailEntry[] = Object.entries(data).map(
    ([key, value]) => {
      const column = columnMap.get(key);
      const isLookup = typeof value === "string" &&
        /(?:^|_)(status|state|reason|action|source|type|mode|kind|outcome|category|priority)$/i.test(key) &&
        isHumanizableMachineValue(value);
      const optionLabel = resolveEditOptionLabel(value, normalizeEditOptions(column?.editOptions));
      const textValue = formatResourceValue(value, {
        renderType: column?.renderType ?? (isLookup ? "lookup" : null),
        formatOptions: column?.formatOptions ?? null,
      });
      const isIdKey = key === "id" || key.endsWith("_id");
      const isUuidLiteralValue = !isIdKey && typeof value === "string" && isUuidValue(value);
      const uuidReferenceValue = isUuidLiteralValue ? formatReferenceValue(String(value)) : null;
      const displayIdentifier = isIdKey
        ? resolveDisplayIdentifier(data, {
            fallback: textValue,
            preferredKeys: resolveDetailIdentifierKeys(key) ?? undefined,
            skipGlobalFallback: key !== "id",
          })
        : null;
      const rawIdValue = isIdKey && value !== null && value !== undefined ? String(value) : "";
      const idFallbackValue = isIdKey ? formatResourceValue(rawIdValue, { renderType: "id" }) : null;
      const compactDisplayIdentifier = displayIdentifier?.value
        ? formatDisplayIdentifierValue(displayIdentifier.value)
        : null;
      const displayValue = optionLabel ?? (compactDisplayIdentifier
        ? compactDisplayIdentifier
        : isIdKey
          ? idFallbackValue ?? textValue
          : uuidReferenceValue ?? textValue);
      const title = displayIdentifier?.value
        ? displayIdentifier.value
        : isIdKey && rawIdValue && displayValue !== rawIdValue
          ? rawIdValue
          : isUuidLiteralValue
            ? String(value)
            : undefined;
      const internalIdHintValue = rawIdValue
        ? formatIdValue(rawIdValue)
        : isUuidLiteralValue
          ? formatIdValue(String(value))
          : isIdKey && textValue !== "-"
            ? formatIdValue(textValue)
            : null;
      const hint =
        (isIdKey || isUuidLiteralValue) && showInternalIdHints && internalIdHintValue
          ? `${internalIdLabel}: ${internalIdHintValue}`
          : null;
      const sectionId = resolveSectionId(column?.detailSection);
      const sectionLabel = resolveSectionLabel(column?.detailSection, generalLabel);
      return {
        key,
        label: resolveColumnLabel(column, key),
        displayValue,
        title,
        hint,
        sectionId,
        sectionLabel,
        rawValue: value,
        linkHref: resolveFkLinkHref(key, value, appBasePath),
      };
    }
  );

  entries.sort((left, right) => {
    const leftIndex = orderMap.get(left.key);
    const rightIndex = orderMap.get(right.key);
    if (leftIndex !== undefined || rightIndex !== undefined) {
      return (leftIndex ?? Number.MAX_SAFE_INTEGER) - (rightIndex ?? Number.MAX_SAFE_INTEGER);
    }
    return left.label.localeCompare(right.label);
  });

  const sections = new Map<string, ResourceDetailSection>();
  entries.forEach((entry) => {
    const existing = sections.get(entry.sectionId);
    if (existing) {
      existing.entries.push(entry);
      return;
    }
    sections.set(entry.sectionId, {
      id: entry.sectionId,
      label: entry.sectionLabel,
      entries: [entry],
    });
  });
  return Array.from(sections.values());
}
