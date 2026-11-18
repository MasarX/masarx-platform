// geocoding-canonical.js — Phase C2 NETWORK gap fill.
//
// Mirrors `public.canonical_cities` and `public.geocoding_attempts` from
//   • supabase/migrations/202510110006_domain_tables_partitioned.sql:386 (cities)
//   • supabase/migrations/202511130011_geocoding_attempts_table.sql:7 (attempts)
//
// Without these resource-map keys, `geocoding.tsx` silently degrades the
// Canonical and Policy tabs (audit ref: __audit__/CROSSWALK/NETWORK.md §2.3).

export const canonical_cities = [
  { id: 'cc_ruh', name_canonical: 'Riyadh', name_arabic: 'الرياض', province: 'Riyadh', country_code: 'SA', alternate_names: ['Ar-Riyadh'], is_active: true },
  { id: 'cc_jed', name_canonical: 'Jeddah', name_arabic: 'جدة', province: 'Makkah', country_code: 'SA', alternate_names: ['Jiddah'], is_active: true },
  { id: 'cc_dmm', name_canonical: 'Dammam', name_arabic: 'الدمام', province: 'Eastern', country_code: 'SA', alternate_names: [], is_active: true },
  { id: 'cc_kho', name_canonical: 'Khobar', name_arabic: 'الخبر', province: 'Eastern', country_code: 'SA', alternate_names: ['Al-Khobar'], is_active: true },
  { id: 'cc_mec', name_canonical: 'Mecca', name_arabic: 'مكة المكرمة', province: 'Makkah', country_code: 'SA', alternate_names: ['Makkah'], is_active: true },
  { id: 'cc_mad', name_canonical: 'Madinah', name_arabic: 'المدينة المنورة', province: 'Madinah', country_code: 'SA', alternate_names: ['Medina'], is_active: true },
];

const _PROVIDERS = ['google', 'here', 'mapbox'];
const _STATUSES = ['succeeded', 'succeeded', 'succeeded', 'in_progress', 'queued', 'failed'];
const _ATTEMPT_TYPES = ['initial', 'refresh', 'retry'];

// Synthetic attempt ledger — drives the Recent geocoding attempts panel.
// Time-windowed across the past 36 hours so the 24h KPI lights up.
export const geocoding_attempts = Array.from({ length: 24 }, (_, i) => {
  const minutesAgo = i * 90 + (i % 5) * 7;
  const created = new Date(Date.now() - minutesAgo * 60_000).toISOString();
  // W13-1 — `attempt_type` lives only in `metadata` per canonical
  // public.geocoding_attempts (no top-level column). FE resolves the
  // display via `attemptTypeOf(row)` reading metadata.attempt_type.
  return {
    id: `gca_${5000 + i}`,
    address_id: `addr_${4700 + (i % 12)}`,
    organization_id: 'org_rashed',
    provider_name: _PROVIDERS[i % _PROVIDERS.length],
    status: _STATUSES[i % _STATUSES.length],
    confidence: 0.6 + ((i * 11) % 35) / 100,
    duration_ms: 120 + (i * 33) % 480,
    created_at: created,
    metadata: { attempt_type: _ATTEMPT_TYPES[i % _ATTEMPT_TYPES.length] },
  };
});
