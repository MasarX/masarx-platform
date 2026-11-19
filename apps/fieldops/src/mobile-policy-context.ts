import type { UiMe } from "@masarx/api";

function coerceContextText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

export function buildPolicyContextFromMe(me: UiMe | null | undefined): Record<string, unknown> {
  const ctx: Record<string, unknown> = {};
  if (!me) return ctx;

  if (me.org?.id) ctx.organization_id = me.org.id;
  if (me.user?.id) ctx.user_id = me.user.id;

  const scopeType = coerceContextText(me.access_scope?.scope_type);
  const scopeId = coerceContextText(me.access_scope?.scope_id);
  if (scopeType && scopeId) {
    const normalizedType = scopeType.trim().toLowerCase();
    if (normalizedType === "tenant" && !ctx.organization_id) ctx.organization_id = scopeId;
    else if (normalizedType === "client") ctx.client_id = scopeId;
    else if (normalizedType === "sender") ctx.sender_id = scopeId;
    else if (normalizedType === "source") ctx.webhook_source_id = scopeId;
    else if (normalizedType === "resource") ctx.resource_id = scopeId;
  }

  return ctx;
}
