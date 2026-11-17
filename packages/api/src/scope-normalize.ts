export function normalizeUiScopeType(scopeType?: string | null) {
  const normalized =
    typeof scopeType === "string" ? scopeType.trim().toLowerCase() : "";
  if (!normalized) return null;
  if (normalized === "platform") return "global";
  return normalized;
}

export function normalizeUiScope(params: {
  scopeType?: string | null;
  scopeId?: string | null;
}) {
  const rawType =
    typeof params.scopeType === "string"
      ? params.scopeType.trim().toLowerCase()
      : "";
  const scopeType = normalizeUiScopeType(rawType);
  const scopeIdRaw =
    typeof params.scopeId === "string" ? params.scopeId.trim() : "";
  return {
    scopeType,
    scopeId: rawType === "platform" ? null : scopeIdRaw || null,
  };
}
