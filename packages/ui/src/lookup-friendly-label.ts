import { labelFromKey } from "./resource-query";
import { formatReferenceValue, isUuidValue } from "./resource-utils";

export function normalizeLookupText(value: unknown) {
  return String(value ?? "").trim();
}

export function buildLookupFallbackValue(value: unknown) {
  const normalizedValue = normalizeLookupText(value);
  if (!normalizedValue) return "";
  if (isUuidValue(normalizedValue)) {
    return formatReferenceValue(normalizedValue);
  }
  const humanizedValue = normalizeLookupText(labelFromKey(normalizedValue));
  if (humanizedValue && humanizedValue.toLowerCase() !== normalizedValue.toLowerCase()) {
    return humanizedValue;
  }
  return formatReferenceValue(normalizedValue);
}

export function buildLookupFriendlyLabel(kind: string, value: unknown) {
  const kindLabel = normalizeLookupText(labelFromKey(kind)) || normalizeLookupText(kind);
  const normalizedValue = normalizeLookupText(value);
  if (!normalizedValue) return "";
  if (isUuidValue(normalizedValue)) {
    return `${kindLabel} ${formatReferenceValue(normalizedValue)}`;
  }
  const fallbackValue = buildLookupFallbackValue(normalizedValue);
  if (fallbackValue && fallbackValue.toLowerCase() !== formatReferenceValue(normalizedValue).toLowerCase()) {
    return fallbackValue;
  }
  return `${kindLabel} ${fallbackValue}`;
}

export function isRawLookupReferenceLabel(value: unknown) {
  const normalizedValue = normalizeLookupText(value);
  return Boolean(normalizedValue && isUuidValue(normalizedValue));
}

export function resolveLookupOptionLabel(value: unknown, label?: unknown) {
  const normalizedValue = normalizeLookupText(value);
  const normalizedLabel = normalizeLookupText(label);
  if (!normalizedValue) return normalizedLabel;
  if (
    normalizedLabel &&
    normalizedLabel !== normalizedValue &&
    !isRawLookupReferenceLabel(normalizedLabel)
  ) {
    return normalizedLabel;
  }
  if (isUuidValue(normalizedValue)) return buildLookupFallbackValue(normalizedValue);
  if (/^[A-Z0-9]{2,6}$/.test(normalizedValue)) return normalizedValue;
  const humanizedValue = normalizeLookupText(labelFromKey(normalizedValue));
  if (humanizedValue && humanizedValue !== normalizedValue) return humanizedValue;
  return buildLookupFallbackValue(normalizedValue) || normalizedLabel || normalizedValue;
}
