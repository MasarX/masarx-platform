import { normalizeUiScopeType } from "./scope-normalize";
import type { UiSettingsChangeRequest } from "./index";

type RpcFn = <T>(fn: string, args?: Record<string, unknown>) => Promise<T>;

type AccessPolicyChangeParams = {
  scopeType?: string | null;
  scopeId?: string | null;
  value: unknown;
  changeReason?: string | null;
  effectiveFrom?: string | null;
};

type SettingsChangeParams = AccessPolicyChangeParams & {
  category: string;
};

function normalizeErrorText(error: unknown) {
  if (!error) return "";
  if (typeof error === "string") return error.toLowerCase();
  if (error instanceof Error) return error.message.toLowerCase();
  if (typeof error !== "object") return "";

  const typed = error as {
    message?: unknown;
    details?: unknown;
    hint?: unknown;
    error?: unknown;
    error_description?: unknown;
  };

  return [
    typed.message,
    typed.details,
    typed.hint,
    typed.error,
    typed.error_description,
  ]
    .map((value) => String(value ?? "").trim().toLowerCase())
    .filter(Boolean)
    .join(" ");
}

function normalizeErrorCode(error: unknown) {
  if (!error || typeof error !== "object") return null;
  const code = (error as { code?: unknown }).code;
  if (code === null || code === undefined) return null;
  const normalized = String(code).trim().toUpperCase();
  return normalized || null;
}

function isSchemaCacheFunctionMiss(error: unknown, functionName: string) {
  const normalizedMessage = normalizeErrorText(error);
  if (!normalizedMessage) return false;
  if (!normalizedMessage.includes(functionName.toLowerCase())) return false;

  const schemaCacheMiss =
    normalizedMessage.includes("could not find the function") ||
    normalizedMessage.includes("schema cache");
  if (!schemaCacheMiss) return false;

  const code = normalizeErrorCode(error);
  return code === "PGRST202" || schemaCacheMiss;
}

async function callWithLegacyArgsFallback({
  rpc,
  functionName,
  argCandidates,
}: {
  rpc: RpcFn;
  functionName: string;
  argCandidates: Array<Record<string, unknown>>;
}) {
  const seen = new Set<string>();
  const dedupedCandidates = argCandidates.filter((candidate) => {
    const key = JSON.stringify(
      Object.keys(candidate)
        .sort()
        .reduce<Record<string, unknown>>((acc, item) => {
          acc[item] = candidate[item];
          return acc;
        }, {})
    );
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  let lastSchemaCacheError: unknown = null;
  for (let index = 0; index < dedupedCandidates.length; index += 1) {
    const args = dedupedCandidates[index];
    try {
      return await rpc<UiSettingsChangeRequest>(functionName, args);
    } catch (error) {
      const canFallback = isSchemaCacheFunctionMiss(error, functionName);
      if (!canFallback) throw error;
      lastSchemaCacheError = error;
    }
  }

  if (lastSchemaCacheError) throw lastSchemaCacheError;
  throw new Error(`No RPC argument candidates configured for ${functionName}.`);
}

export function requestAccessPolicyChangeWithCompat(
  rpc: RpcFn,
  params: AccessPolicyChangeParams
) {
  const normalizedScopeType = normalizeUiScopeType(params.scopeType);
  const primaryArgs = {
    p_scope_type: normalizedScopeType,
    p_scope_id: params.scopeId ?? null,
    p_value: params.value,
    p_change_reason: params.changeReason ?? null,
    p_effective_from: params.effectiveFrom ?? null,
  };
  const midArgs = {
    p_scope_type: normalizedScopeType,
    p_scope_id: params.scopeId ?? null,
    p_value: params.value,
    p_change_reason: params.changeReason ?? null,
  };
  const legacyArgs = {
    p_scope_type: normalizedScopeType,
    p_scope_id: params.scopeId ?? null,
    p_value: params.value,
  };

  return callWithLegacyArgsFallback({
    rpc,
    functionName: "ui_request_access_policy_change_v1",
    argCandidates: [primaryArgs, midArgs, legacyArgs],
  });
}

export function requestSettingsChangeWithCompat(
  rpc: RpcFn,
  params: SettingsChangeParams
) {
  const normalizedScopeType = normalizeUiScopeType(params.scopeType);
  const primaryArgs = {
    p_category: params.category,
    p_scope_type: normalizedScopeType,
    p_scope_id: params.scopeId ?? null,
    p_value: params.value,
    p_change_reason: params.changeReason ?? null,
    p_effective_from: params.effectiveFrom ?? null,
  };
  const midArgs = {
    p_category: params.category,
    p_scope_type: normalizedScopeType,
    p_scope_id: params.scopeId ?? null,
    p_value: params.value,
    p_change_reason: params.changeReason ?? null,
  };
  const legacyArgs = {
    p_category: params.category,
    p_scope_type: normalizedScopeType,
    p_scope_id: params.scopeId ?? null,
    p_value: params.value,
  };

  return callWithLegacyArgsFallback({
    rpc,
    functionName: "request_settings_change_v1",
    argCandidates: [primaryArgs, midArgs, legacyArgs],
  });
}
