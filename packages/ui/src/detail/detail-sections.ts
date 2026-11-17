import { labelFromKey } from "../resource-query";
import {
  formatResourceValue,
  formatDisplayIdentifierValue,
  formatIdValue,
  formatReferenceValue,
  isUuidValue,
} from "../resource-utils";
import { resolveDisplayIdentifier } from "../display-identifiers";

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
export function buildDetailSections(
  data: Record<string, unknown>,
  columns: ResourceDetailColumn[] | null | undefined,
  generalLabel: string,
  internalIdLabel: string,
  showInternalIdHints: boolean
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
      const textValue = formatResourceValue(value, {
        renderType: column?.renderType ?? null,
        formatOptions: column?.formatOptions ?? null,
      });
      const isIdKey = key === "id" || key.endsWith("_id");
      const isUuidLiteralValue = !isIdKey && typeof value === "string" && isUuidValue(value);
      const uuidReferenceValue = isUuidLiteralValue ? formatReferenceValue(String(value)) : null;
      const displayIdentifier = isIdKey
        ? resolveDisplayIdentifier(data, {
            fallback: textValue,
            preferredKeys: resolveDetailIdentifierKeys(key) ?? undefined,
          })
        : null;
      const rawIdValue = isIdKey && value !== null && value !== undefined ? String(value) : "";
      const idFallbackValue = isIdKey ? formatResourceValue(rawIdValue, { renderType: "id" }) : null;
      const compactDisplayIdentifier = displayIdentifier?.value
        ? formatDisplayIdentifierValue(displayIdentifier.value)
        : null;
      const displayValue = compactDisplayIdentifier
        ? compactDisplayIdentifier
        : isIdKey
          ? idFallbackValue ?? textValue
          : uuidReferenceValue ?? textValue;
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
