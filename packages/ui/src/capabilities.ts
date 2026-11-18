export { WILDCARD_CAPABILITY, hasCapability, resolveCapabilitySet } from "@masarx/api";

import type { UiReadResource } from "@masarx/api";

/** ui_me identity uses null for tenant; policy reads bind to authenticated org. */
export function resolveResourceReadScopeId(scopeType?: string | null, scopeId?: string | null, organizationId?: string | null) {
  if (scopeType === "tenant") return organizationId?.trim() || null;
  return scopeId?.trim() || null;
}

/** Mirrors ui_assert_resource_read_scope_v1; capabilities never override scope. */
export function isResourceReadScopeAllowed(
  resource: UiReadResource | null | undefined,
  scopeType?: string | null,
  scopeId?: string | null,
  organizationId?: string | null,
): boolean {
  if (!resource) return false;
  if (!Object.prototype.hasOwnProperty.call(resource, "read_scope_types")) return true;
  const scopes = resource.read_scope_types;
  if (!Array.isArray(scopes) || scopes.length === 0 ||
      new Set(scopes).size !== scopes.length ||
      scopes.some((scope) => !["tenant", "client", "sender", "platform", "global"].includes(scope))) return false;
  if (!scopeType || !scopes.includes(scopeType)) return false;
  if (["tenant", "client", "sender"].includes(scopeType)) {
    const column = resource.scope_columns?.[scopeType];
    return Boolean(resolveResourceReadScopeId(scopeType, scopeId, organizationId)) && typeof column === "string" && Boolean(column.trim());
  }
  return true;
}
