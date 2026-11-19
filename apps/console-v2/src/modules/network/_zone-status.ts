type ZoneStatusRow = {
  is_active?: boolean;
  status?: string | null;
  metadata?: Record<string, unknown> | null;
};

type ZoneStatusMetadata = {
  is_active_zone_status?: boolean;
  is_suspended_zone_status?: boolean;
} | null | undefined;

const VALID_ZONE_STATUSES = new Set(['active', 'draft', 'suspended', 'retired']);

function validZoneStatus(value: unknown): 'active' | 'draft' | 'suspended' | 'retired' | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  return VALID_ZONE_STATUSES.has(normalized)
    ? (normalized as 'active' | 'draft' | 'suspended' | 'retired')
    : null;
}

export function zoneIsActiveOf(z: ZoneStatusRow | undefined | null): boolean {
  if (!z) return false;
  if (typeof z.is_active === 'boolean') return z.is_active;
  return validZoneStatus(z.status) === 'active';
}

export function zoneStatusOf(
  z: ZoneStatusRow | undefined | null,
): 'active' | 'draft' | 'suspended' | 'retired' {
  if (!z) return 'active';

  const lifecycle = validZoneStatus(z.metadata?.lifecycle);
  if (lifecycle) return lifecycle;

  const legacyStatus = validZoneStatus(z.status);
  if (typeof z.is_active === 'boolean') {
    if (z.is_active) return 'active';
    return legacyStatus && legacyStatus !== 'active' ? legacyStatus : 'suspended';
  }

  return legacyStatus ?? 'active';
}

export function zoneCountsAsActive(
  z: ZoneStatusRow | undefined | null,
  metadata?: ZoneStatusMetadata,
): boolean {
  if (typeof metadata?.is_active_zone_status === 'boolean') {
    return metadata.is_active_zone_status;
  }
  return zoneIsActiveOf(z);
}

export function zoneCountsAsSuspended(
  z: ZoneStatusRow | undefined | null,
  metadata?: ZoneStatusMetadata,
): boolean {
  if (typeof metadata?.is_suspended_zone_status === 'boolean') {
    return metadata.is_suspended_zone_status;
  }
  return zoneStatusOf(z) === 'suspended';
}
