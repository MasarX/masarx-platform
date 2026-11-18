import type { UiScopeOption } from "@masarx/api";

import { labelFromKey } from "./resource-query";
import { formatReferenceValue } from "./resource-utils";

export type NormalizedScopeOption = UiScopeOption & {
  optionKey: string;
  typeLabel: string;
  primaryLabel: string;
  summaryLabel: string;
  referenceLabel: string;
};

export function resolveScopeTypeLabel(scopeType?: string | null) {
  const normalized = scopeType?.trim().toLowerCase() ?? "";
  if (!normalized) return "";
  if (normalized === "tenant") return "Organization";
  return labelFromKey(normalized);
}

export function resolveScopeReferenceLabel(scopeId?: string | null) {
  const normalized = scopeId?.trim() ?? "";
  if (!normalized) return "";
  return formatReferenceValue(normalized);
}

export function resolveScopeOptionKey(
  scopeType?: string | null,
  scopeId?: string | null
) {
  const normalizedType = scopeType?.trim().toLowerCase() ?? "";
  if (!normalizedType) return "";
  const normalizedId = scopeId?.trim() ?? "";
  return `${normalizedType}::${normalizedId}`;
}

export function resolveScopePrimaryLabel(params: {
  scopeLabel?: string | null;
  scopeId?: string | null;
}) {
  const normalizedLabel = params.scopeLabel?.trim() ?? "";
  if (normalizedLabel) return normalizedLabel;
  return resolveScopeReferenceLabel(params.scopeId);
}

export function resolveScopeSummaryLabel(
  scopeType?: string | null,
  scopeLabel?: string | null,
  scopeId?: string | null
) {
  const typeLabel = resolveScopeTypeLabel(scopeType);
  const primaryLabel = resolveScopePrimaryLabel({ scopeLabel, scopeId });
  if (!typeLabel) return primaryLabel;
  if (!primaryLabel) return typeLabel;
  return `${typeLabel}: ${primaryLabel}`;
}

export function normalizeScopeOptions(
  options?: UiScopeOption[] | null
): NormalizedScopeOption[] {
  if (!Array.isArray(options)) return [];

  const normalized = new Map<string, NormalizedScopeOption>();
  for (const option of options) {
    if (!option?.scope_type) continue;
    const optionKey = resolveScopeOptionKey(option.scope_type, option.scope_id);
    if (!optionKey || normalized.has(optionKey)) continue;

    const typeLabel = resolveScopeTypeLabel(option.scope_type);
    const primaryLabel = resolveScopePrimaryLabel({
      scopeLabel: option.scope_label,
      scopeId: option.scope_id,
    });
    const referenceLabel = resolveScopeReferenceLabel(option.scope_id);
    normalized.set(optionKey, {
      ...option,
      optionKey,
      typeLabel,
      primaryLabel,
      summaryLabel: resolveScopeSummaryLabel(
        option.scope_type,
        option.scope_label,
        option.scope_id
      ),
      referenceLabel,
    });
  }

  return Array.from(normalized.values());
}

export function filterScopeOptions(
  options: NormalizedScopeOption[],
  scopeType?: string | null
) {
  const normalizedType = scopeType?.trim().toLowerCase() ?? "";
  if (!normalizedType) return [];
  return options.filter(
    (option) => option.scope_type.trim().toLowerCase() === normalizedType
  );
}

export function findScopeOption(
  options: NormalizedScopeOption[],
  scopeType?: string | null,
  scopeId?: string | null
) {
  const optionKey = resolveScopeOptionKey(scopeType, scopeId);
  if (!optionKey) return null;
  return options.find((option) => option.optionKey === optionKey) ?? null;
}
