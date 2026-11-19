import { readUrlParam, type UrlParamSource } from './url-params';

export type ConsoleScopeType = 'global' | 'tenant' | 'client' | 'sender' | 'source' | 'resource';

export interface ConsoleScopeOverride {
  scopeType: ConsoleScopeType;
  scopeId: string | null;
}

export interface ConsoleScopeOverrideIdentity {
  user?: {
    access_scope_type?: string | null;
  };
  currentScopeType?: () => string | null | undefined;
}

const CONSOLE_SCOPE_TYPES = new Set<ConsoleScopeType>([
  'global',
  'tenant',
  'client',
  'sender',
  'source',
  'resource',
]);

export function readConsoleScopeOverride(source?: UrlParamSource): ConsoleScopeOverride | null {
  const requestedType = readUrlParam('scope_type', source)?.toLowerCase().trim();
  if (!requestedType || !CONSOLE_SCOPE_TYPES.has(requestedType as ConsoleScopeType)) return null;

  const scopeType = requestedType as ConsoleScopeType;
  if (scopeType === 'global') return { scopeType, scopeId: null };

  const scopeId = readUrlParam('scope_id', source);
  if (!scopeId) return null;
  return { scopeType, scopeId };
}

export function canUseConsoleScopeOverride(identity: ConsoleScopeOverrideIdentity): boolean {
  const currentScopeType =
    typeof identity.currentScopeType === 'function'
      ? identity.currentScopeType()
      : identity.user?.access_scope_type;
  return currentScopeType === 'platform' || identity.user?.access_scope_type === 'platform';
}

export function authorizeConsoleScopeOverride(
  override: ConsoleScopeOverride | null,
  identity: ConsoleScopeOverrideIdentity,
): ConsoleScopeOverride | null {
  if (!override) return null;
  return canUseConsoleScopeOverride(identity) ? override : null;
}

export function readAuthorizedConsoleScopeOverride(
  identity: ConsoleScopeOverrideIdentity,
  source?: UrlParamSource,
): ConsoleScopeOverride | null {
  return authorizeConsoleScopeOverride(readConsoleScopeOverride(source), identity);
}

export function readAuthorizedTenantOrganizationOverride(
  identity: ConsoleScopeOverrideIdentity,
  source?: UrlParamSource,
): string | null {
  if (!canUseConsoleScopeOverride(identity)) return null;
  const value = readUrlParam('organization_id', source)?.trim();
  return value && value.length > 0 ? value : null;
}

export function scopeContextFromOverride(
  override: ConsoleScopeOverride | null,
): Record<string, unknown> | null {
  if (!override) return null;
  if (override.scopeType === 'global') return { global: { id: 'global' } };

  const context: Record<string, unknown> = {
    [override.scopeType]: { id: override.scopeId },
  };
  if (override.scopeType === 'tenant') {
    context.organization_id = override.scopeId;
    context.tenant_id = override.scopeId;
  }
  if (override.scopeType === 'client') context.client_id = override.scopeId;
  if (override.scopeType === 'sender') context.sender_id = override.scopeId;
  if (override.scopeType === 'source') context.source_id = override.scopeId;
  if (override.scopeType === 'resource') context.resource_id = override.scopeId;
  return context;
}
