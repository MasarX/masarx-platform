// zones.tsx — Network · Zones (CLAIM-NETWORK-ZONES, Wave 1, Phase A).
// MAP-FIRST split-view for public.zones / zone_districts / zone_override_requests
// (migration 202512261200_zones_baskets.sql). Reads via useResourceList; all
// visuals reuse existing primitives (zero shared changes).
//
// W56-C SSOT (E2 closure P1 #5) — `<ScopePill scopeType="tenant" .../>`
// uses the literal `"tenant"` because zones resources are tenant-tier per
// the canonical RLS scope contract (`scope_type_registry`, org-scoped).
// The literal IS canonical per-module; the `scopeId` value remains
// identity-derived (`tenantId` from `scope.tenant?.id`).

import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { PageHeader } from '@/components/PageHeader';
import { Chip } from '@/components/Chip';
import { ScopePill } from '@/components/ScopePill';
import { KPICard } from '@/components/KPICard';
import { Button } from '@/components/Button';
import { StateView } from '@/components/StateView';
import { ZoneMap, type ZoneTone, type ZonePolygon, type ZoneMapBounds } from '@/components/ZoneMap';
import {
  useResource,
  useResourceList,
  useResourceListsByFilters,
  useResolveSettings,
  useAssignBranchZone,
  useRestoreZone,
  useSuspendZone,
} from '@/lib/queries';
import { useIdentity, useCapability } from '@/lib/identity';
import { fill, useI18n, useT } from '@/lib/i18n';
import { useDrawer } from '@/hooks/useOverlay';
import { pushToast } from '@/components/toastStore';
// W54-E closure: typed accessor for `zone_performance_metrics` (mirrors
// W34c `resolve_driver_hours_of_service_v1` pattern). Routes through the
// canonical data-source seam instead of a direct seed-raw import — the
// live cutover swaps to `mv_zone_performance_v1` projection without
// changing this consumer call site.
import { lookupRow } from '@/lib/api';
import type { ChipKind } from '@/components/Chip';
import { CAP } from '@/lib/capabilities';
import { useConsoleNavigator } from '@/lib/useConsoleNavigator';
import { readUrlParam } from '@/lib/url-params';
import { zoneCountsAsActive, zoneCountsAsSuspended, zoneStatusOf } from './_zone-status';

// Lazy-mount the heavy modal + drawer body so the entry chunk stays small.
// They only load after the user opens a zone or clicks "New zone". Their
// dependency footprints (DataTable, KvGrid, TimelineLog, Sparkline, Modal)
// are deferred until interaction.
const ZonesCreateModal = lazy(() => import('./zones-create-modal'));
const ZoneDrawerBody = lazy(() => import('./zones-drawer'));

// ────────── Domain types (mirror migration column shapes) ──────────
//
// Phase G1 (Wave 6) — schema-drift alignment per
// `__audit__/SCHEMA-DRIFT/NETWORK.md` §7–§11.
//
// Canonical sources:
//   public.zones                  — migration 202512271540_zones_baskets_*
//   public.zone_districts         — same migration
//   public.zone_override_requests — migration 202604061530_b04_uc062_*
//   public.branch_zones           — migration 202601212340_branches_*
//   public.canonical_districts    — migration 202510110006_domain_tables_*
//
// W17-5 — registry resource key renamed from the legacy alias
// `network_zones` to canonical `zones` (relation: 'zones' in
// `seed-raw/registry.js`). See `__audit__/DECISIONS/REGISTRY-ALIASES.md` §1
// closure. Several FE fields below remain FE-only (resolved via metadata
// jsonb or join projection).
//
// W11-2 + W80 close-out: FE-fictional fields previously inlined on
// `NetworkZoneRow` (`hub_code`, `color_token`, `geometry`) now resolve
// through the canonical `public.v_zone_summary` projection view (registry key:
// `zone_summary`). The FE merges the two shapes by `zone_id` so the side list
// and map keep their existing layout while consuming server-derived
// projections in production. Zone geometry is derived from canonical
// zone_districts -> canonical_districts centroid rows; the base `zones` row
// no longer carries frontend-synthetic polygons.
// W20 — added canonical column shadows for the deferred RENAME items
// (per `__audit__/SCHEMA-DRIFT/NETWORK.md` §7). The FE row interface now
// mirrors canonical `public.zones` columns (`is_active`, `description`,
// `metadata`) alongside the FE aliases (`status`, `notes`). Resolver
// helpers (`zoneIsActiveOf` / `zoneStatusOf` / `zoneNotesOf`) prefer
// canonical when present and fall back to FE aliases. Status multi-state
// (active|draft|suspended|retired) derives from canonical is_active +
// `metadata.lifecycle`. Seed rows now carry both shapes.
type ZoneGeometry = { kind: 'polygon'; paths: Array<[number, number]> } | null;

interface NetworkZoneRow extends Record<string, unknown> {
  id: string;                    // → zones.id
  organization_id: string;       // → zones.organization_id
  name: string;                  // → zones.name
  slug: string;                  // → zones.slug
  /** Canonical is_active boolean (true = operational). */
  is_active?: boolean;
  /** @deprecated FE alias derived from canonical `is_active` plus
   *  `metadata.lifecycle`. Multi-state values:
   *    `active`    ← is_active=true,  metadata.lifecycle in (null, 'active')
   *    `draft`     ← is_active=false, metadata.lifecycle = 'draft'
   *    `suspended` ← is_active=false, metadata.lifecycle = 'suspended'
   *    `retired`   ← is_active=false, metadata.lifecycle = 'retired'
   *  Resolve via `zoneStatusOf(zone)`. */
  status: 'active' | 'draft' | 'suspended' | 'retired' | string;
  /** Canonical description. */
  description?: string | null;
  /** @deprecated FE alias for canonical `description`. Resolve via
   *  `zoneNotesOf(zone)`. */
  notes?: string;
  /** Canonical metadata jsonb (resolves derived values like lifecycle). */
  metadata?: Record<string, unknown>;
  created_at?: string;           // → zones.created_at
  updated_at?: string;           // → zones.updated_at
}

/** v_zone_summary row shape (W11-2). Read-only paired projection.
 *  Source: supabase/migrations/202604301410_v_zone_summary.sql.
 *  Resource registry key: `zone_summary`. */
interface ZoneSummaryRow extends Record<string, unknown> {
  zone_id: string;               // → v_zone_summary.zone_id (PK projection)
  organization_id?: string | null;
  name?: string | null;
  slug?: string | null;
  is_active?: boolean;
  description?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
  /** COUNT DISTINCT branch_zones.branch_id WHERE zone_id matches. */
  branch_count?: number;
  /** COUNT zone_districts WHERE zone_id matches. */
  district_count?: number;
  /** COUNT zone_override_requests WHERE status='pending' for the zone. */
  pending_overrides?: number;
  /** MAX(updated_at) over zone_override_requests for the zone. */
  last_override_at?: string | null;
  /** branches.code projection for the lowest-priority linked branch. */
  hub_code?: string | null;
  /** zones.metadata->>'color_token' projection. */
  color_token?: string | null;
  /** Backend/API-backed map geometry derived from canonical district centroids. */
  geometry?: ZoneGeometry;
}

// W17-2 — `role` dropped from `ZoneDistrictRow`. Canonical
// `public.zone_districts` has no primary/secondary distinction; the table is
// a pure (zone_id, canonical_district_id) link. The drawer body keeps a
// single visual chip ("linked") in lieu of role banding.
//
// W20 — added canonical column shadow for the deferred RENAME item
// (per `__audit__/SCHEMA-DRIFT/NETWORK.md` §8). The FE row interface now
// mirrors canonical `public.zone_districts.canonical_district_id` alongside
// the existing FE alias `district_id`. Resolver helper
// `zoneDistrictIdOf(row)` prefers canonical when present and falls back
// to the FE alias for legacy seeds.
interface ZonePerformanceMetricsRow extends Record<string, unknown> {
  id?: string;
  zone_id: string;
  shipments_today: number;
  shipments_week: number;
  on_time_pct: number | null;
  capacity_saturation_pct: number;
  spark_today: number[];
  spark_week: number[];
}

interface MapPolicyValue {
  tile_provider?: {
    url_template?: string;
    allowed_hosts?: string[];
    usage_tier?: string;
    cache_required?: boolean;
    same_origin_proxy_allowed?: boolean;
    attribution_label?: string;
    attribution_url?: string;
  };
  default_viewport?: ZoneMapBounds;
}

interface ZoneDistrictRow extends Record<string, unknown> {
  zone_id: string;               // → zone_districts.zone_id
  /** Canonical canonical_district_id. */
  canonical_district_id?: string;
  /** @deprecated FE alias for canonical canonical_district_id. Resolve via
   *  `zoneDistrictIdOf(row)`. */
  district_id?: string;
  created_at?: string;           // → zone_districts.created_at
}

// (zoneDistrictIdOf is defined in zones-drawer.tsx where the rows are
// rendered. zones.tsx itself does not consume district_id beyond the count
// path, so the resolver is not duplicated here.)

// W17-2 — `change_kind` dropped from the override row. Canonical
// `public.zone_override_requests` has no top-level `change_kind` column;
// the FE-historical kind label lives in `metadata.change_kind` jsonb (was
// the FE `payload`). Mirrors the W13-1 pattern used for
// ReputationSnapshot.score_breakdown.
//
// W20 — added canonical column shadows for the deferred RENAME items
// (per `__audit__/SCHEMA-DRIFT/NETWORK.md` §9). The FE row interface now
// mirrors canonical `public.zone_override_requests` columns
// (`requested_zone_id`, `requested_by`, `metadata`, `reviewed_at`,
// `reviewed_by`) alongside the FE aliases (`zone_id`, `requested_by_user_id`,
// `payload`, `decision_at`, `decided_by_user_id`). Resolver helpers
// (`overrideZoneIdOf` / `overrideRequestedByOf` / `overrideMetadataOf` /
// `overrideReviewedAtOf` / `overrideReviewedByOf`) prefer canonical when
// present and fall back to FE aliases. Seed rows now carry both shapes.
interface ZoneOverrideRequestRow extends Record<string, unknown> {
  id: string;                    // → zone_override_requests.id
  /** Canonical requested_zone_id. */
  requested_zone_id?: string;
  /** Canonical current_zone_id (the zone the shipment is currently bound to). */
  current_zone_id?: string;
  /** @deprecated FE alias for canonical requested_zone_id (or
   *  current_zone_id). Resolve via `overrideZoneIdOf(o)`. */
  zone_id: string;
  /** Canonical requested_by. */
  requested_by?: string;
  /** @deprecated FE alias for canonical requested_by. Resolve via
   *  `overrideRequestedByOf(o)`. */
  requested_by_user_id: string;
  /** Canonical metadata jsonb. The historical `change_kind` lives inside
   *  this jsonb under the `change_kind` key. */
  metadata?: Record<string, unknown>;
  /** @deprecated FE alias for canonical `metadata`. Resolve via
   *  `overrideMetadataOf(o)`. */
  payload: Record<string, unknown>;
  status: 'pending' | 'approved' | 'denied' | string;  // → zone_override_requests.status
  /** Canonical reviewed_at. */
  reviewed_at?: string | null;
  /** @deprecated FE alias for canonical reviewed_at. Resolve via
   *  `overrideReviewedAtOf(o)`. */
  decision_at: string | null;
  /** Canonical reviewed_by. */
  reviewed_by?: string | null;
  /** @deprecated FE alias for canonical reviewed_by. Resolve via
   *  `overrideReviewedByOf(o)`. */
  decided_by_user_id: string | null;
  created_at: string;            // → zone_override_requests.created_at
}

// (override resolver helpers are defined in zones-drawer.tsx where the
// rows are rendered as a TimelineLog. zones.tsx itself only counts
// pending overrides via the v_zone_summary projection — no per-row
// canonical alias fan-out is needed here.)

// Backwards-compatible alias so legacy call sites keep building. The drawer
// body keeps its own copy of the row interface.
type ZoneOverrideRow = ZoneOverrideRequestRow;

// W17-2 — `role` dropped from `BranchZoneRow`. Canonical `public.branch_zones`
// has no `role` column (priority-ordered only); the drawer body still
// renders a band derived from priority via its own helper.
//
// W20 — `branch_label` projection closed via paired view
// `public.v_branch_zone_directory`
// (supabase/migrations/202604301800_v_branch_zone_directory.sql, registry
// key: `branch_zone_directory`). Each row now carries the canonical join
// projection (branch_label, hub_code, branch_type, zone_label) materialised
// from branch_zones + branches + zones. SSOT remains branch_zones; the
// view is read-only. Closes the deferred §10 projection in
// __audit__/SCHEMA-DRIFT/NETWORK.md (W18-3 deferral).
interface BranchZoneRow extends Record<string, unknown> {
  /** Optional row id when reading through `branch_zone_directory` projection
   *  (canonical `public.branch_zones.id`). */
  id?: string;
  branch_id: string;             // → branch_zones.branch_id
  /** Resolved via canonical paired view `v_branch_zone_directory.branch_label`
   *  (projection of branches.name with branches.code fallback). Optional on
   *  the row interface for legacy callers that pre-date the projection. */
  branch_label: string;
  /** Canonical projection: branches.code via the paired view. */
  hub_code?: string | null;
  /** Canonical projection: branches.branch_type via the paired view. */
  branch_type?: string | null;
  /** Canonical projection: zones.name via the paired view. */
  zone_label?: string | null;
  /** Canonical projection: zones.slug via the paired view. */
  zone_slug?: string | null;
  zone_id: string;               // → branch_zones.zone_id
  priority?: number;             // → branch_zones.priority
}

// W20 — added canonical column shadows for the deferred RENAME items
// (per `__audit__/SCHEMA-DRIFT/NETWORK.md` §11). The FE row interface now
// mirrors canonical `public.canonical_districts` columns
// (`name_canonical`, `name_arabic`) alongside the existing FE aliases
// (`name`, `name_ar`). Resolver helpers (`districtNameOf` /
// `districtNameArOf`) prefer canonical when present and fall back to FE
// aliases for legacy seeds.
interface CanonicalDistrictRow extends Record<string, unknown> {
  id: string;                    // → canonical_districts.id
  /** Resolved via city_id → canonical_cities.name_canonical. Not a column. */
  city_code?: string;
  city_id?: string;
  city_label?: string;
  city_name?: string;
  /** Canonical name_canonical. */
  name_canonical?: string;
  /** @deprecated FE alias for canonical name_canonical. Resolve via
   *  `districtNameOf(d)`. */
  name?: string;
  /** Canonical name_arabic. */
  name_arabic?: string;
  /** @deprecated FE alias for canonical name_arabic. Resolve via
   *  `districtNameArOf(d)`. */
  name_ar?: string;
}

type ZoneDrawerDistrictRow = CanonicalDistrictRow & {
  city_code: string;
  name: string;
};

interface CanonicalCityRow extends Record<string, unknown> {
  id: string;
  code?: string;
  city_code?: string;
  name?: string;
  name_canonical?: string;
  name_arabic?: string;
}

interface BranchCoverageChoiceRow extends Record<string, unknown> {
  id: string;
  name?: string | null;
  code?: string | null;
  slug?: string | null;
}

function firstDisplayString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value.trim().length > 0) return value.trim();
  }
  return null;
}

function canonicalDistrictDisplayName(row: CanonicalDistrictRow): string {
  return firstDisplayString(row.name_canonical, row.name, row.name_arabic, row.name_ar, row.id) ?? row.id;
}

function canonicalCityDisplayName(row: CanonicalCityRow | undefined): string | null {
  if (!row) return null;
  return firstDisplayString(row.name_canonical, row.name, row.city_code, row.code);
}

// ────────── Canonical-tone helpers (parent-side) ──────────
//
// Status / color-token tone palettes are sourced strictly from the
// canonical `lookups` SSOT (`zone_status` + `zone_color_token`).
// AGENTS.md §2 (ZERO HARDCODING) + §4 (SSOT). Missing canonical rows
// surface a danger-toned "missing" chip so the gap is visible to
// operators rather than silently masked by a neutral fallback.
//
// `toMapTone` collapses the canonical-row tone onto the narrower
// `ZoneTone` enum that `<ZoneMap />` accepts (no 'info'). Missing rows
// render as 'danger' so the gap is highlighted on the map.
function toMapTone(token?: string): ZoneTone {
  if (!token) return 'neutral';
  const row = lookupRow('zone_color_token', token);
  if (!row) return 'danger';
  const tone = row.tone as string | undefined;
  if (tone === 'good' || tone === 'warn' || tone === 'danger' || tone === 'neutral') return tone;
  // 'info' (and any other ChipKind) collapses to 'neutral' for map rendering.
  return 'neutral';
}

function CanonicalChip({
  category,
  value,
  className,
  labelOverride,
}: {
  category: string;
  value: string;
  className?: string;
  labelOverride?: string;
}) {
  const t = useT();
  const row = lookupRow(category, value);
  if (!row) {
    return (
      <Chip
        label={fill(t('zones.missing'), { ref: `${category}/${value}` })}
        kind="danger"
        size="xs"
        className={className}
      />
    );
  }
  return (
    <Chip
      label={labelOverride ?? row.label}
      kind={(row.tone as ChipKind | undefined) ?? 'neutral'}
      size="xs"
      className={className}
    />
  );
}

// ────────── Module ──────────
export function ZonesModule() {
  const { scope, currentTenantId } = useIdentity();
  const { t, fmtNumber, fmtDateTime } = useI18n();
  const drawer = useDrawer();
  const openDrawer = drawer.open;
  const isDrawerOpen = drawer.isOpen;
  const go = useConsoleNavigator();
  const canRead = useCapability(CAP.ZONES_READ);
  const canWrite = useCapability(CAP.ZONES_WRITE);
  const tenantId = scope.tenant?.id ?? currentTenantId() ?? null;
  const tenantListOpts = useMemo(
    () => (tenantId ? { filter: { organization_id: tenantId } } : undefined),
    [tenantId],
  );
  const tenantSettingsScope = useMemo(
    () => (tenantId ? { organization_id: tenantId } : undefined),
    [tenantId],
  );

  // W27 Cycle D Network closure (P1 #7): suspended / pendingOverrides KPI
  // tone bands resolve from canonical `zone_backlog_policy` settings
  // policy (sv_470). Replaces inline `<= 2 ? 'warn' : 'danger'` literals.
  // Missing canonical row → tone falls through to neutral via consumer
  // null-checks (no silent FE-literal masking).
  const zoneBacklogPolicy = useResolveSettings('zone_backlog_policy', tenantSettingsScope);
  const zoneBacklogThresholds =
    (zoneBacklogPolicy.data?.value as { warn_max?: number } | undefined) ?? null;

  // W73-Network Cycle F-R-13 closure (P2-5): transient toast auto-hide
  // cadence (used by the bulk-suspend "no active zones" notice path)
  // resolves through canonical `ux_safety_policy.toast_auto_hide_ms`
  // (apps/console-v2/src/lib/seed-raw/policies.js#sv_110). AGENTS.md §2 +
  // §6. Strict no-fallback: when missing the bulk-pending notice stays
  // visible until the next operator action — gap is observable.
  const uxSafetyPolicy = useResolveSettings('ux_safety_policy', tenantSettingsScope);
  const toastAutoHideMs = (
    uxSafetyPolicy.data?.value as { toast_auto_hide_ms?: number } | undefined
  )?.toast_auto_hide_ms;
  const mapPolicy = useResolveSettings('map_policy', tenantSettingsScope);
  const mapPolicyValue = (mapPolicy.data?.value as MapPolicyValue | undefined) ?? null;
  const mapTileProvider = mapPolicyValue?.tile_provider;
  const mapDefaultViewport = mapPolicyValue?.default_viewport;

  const zonesQuery = useResourceList<NetworkZoneRow>('zones', tenantListOpts);
  // W11-2 — paired projection view `public.v_zone_summary`. Drives KPI strip,
  // side-list chip counts, and tone resolution. SSOT remains `public.zones`;
  // this is a read-only projection.
  const zoneSummaryQuery = useResourceList<ZoneSummaryRow>('zone_summary', tenantListOpts);
  const zonePerformanceQuery = useResourceList<ZonePerformanceMetricsRow>(
    'zone_performance_metrics',
    tenantListOpts,
  );
  // W20 — read through paired projection `v_branch_zone_directory` so each
  // row carries the canonical (branch_label, hub_code, branch_type,
  // zone_label, zone_slug) join projection. SSOT remains branch_zones;
  // mutations still go through the canonical RPCs.
  const canonicalDistrictsQuery = useResourceList<CanonicalDistrictRow>(
    'canonical_districts',
    tenantListOpts,
  );
  const canonicalCitiesQuery = useResourceList<CanonicalCityRow>(
    'canonical_cities',
    tenantListOpts,
  );
  const branchesQuery = useResourceList<BranchCoverageChoiceRow>(
    'branches',
    tenantListOpts,
    { enabled: canWrite },
  );

  const zones = useMemo<NetworkZoneRow[]>(
    () => zonesQuery.data?.rows ?? [],
    [zonesQuery.data],
  );
  const focusParam = readUrlParam('focus');
  const focusInRows = focusParam ? zones.some((zone) => zone.id === focusParam) : false;
  const focusedZoneQuery = useResource<NetworkZoneRow>(
    'zones',
    focusParam && !focusInRows ? focusParam : undefined,
  );
  const focusedZone = focusParam
    ? zones.find((zone) => zone.id === focusParam) ?? focusedZoneQuery.data ?? null
    : null;
  const focusTarget =
    focusedZone && (!tenantId || focusedZone.organization_id === tenantId)
      ? focusedZone
      : null;
  const visibleZones = useMemo<NetworkZoneRow[]>(() => {
    if (!focusTarget) return zones;
    return zones.some((zone) => zone.id === focusTarget.id)
      ? zones
      : [focusTarget, ...zones];
  }, [zones, focusTarget]);
  const zoneRelationFilters = useMemo(
    () => visibleZones.map((zone) => ({ zone_id: zone.id })),
    [visibleZones],
  );
  const districtsQuery = useResourceListsByFilters<ZoneDistrictRow>(
    'zone_districts',
    zoneRelationFilters,
    { page_size: 500 },
    { enabled: zoneRelationFilters.length > 0 },
  );
  const overridesQuery = useResourceListsByFilters<ZoneOverrideRow>(
    'zone_override_requests',
    zoneRelationFilters,
    { page_size: 500 },
    { enabled: zoneRelationFilters.length > 0 },
  );
  const branchZonesQuery = useResourceListsByFilters<BranchZoneRow>(
    'branch_zone_directory',
    zoneRelationFilters,
    { page_size: 500 },
    { enabled: zoneRelationFilters.length > 0 },
  );
  const zoneSummaries = useMemo<ZoneSummaryRow[]>(
    () => zoneSummaryQuery.data?.rows ?? [],
    [zoneSummaryQuery.data],
  );
  const summaryByZone = useMemo(() => {
    const map = new Map<string, ZoneSummaryRow>();
    for (const s of zoneSummaries) {
      if (s.zone_id) map.set(s.zone_id, s);
    }
    return map;
  }, [zoneSummaries]);
  const performanceByZone = useMemo(() => {
    const map = new Map<string, ZonePerformanceMetricsRow>();
    for (const row of zonePerformanceQuery.data?.rows ?? []) {
      if (row.zone_id) map.set(row.zone_id, row);
    }
    return map;
  }, [zonePerformanceQuery.data]);
  /** Returns the projected summary row for a zone, or an empty shell so
   *  consumers always have a defined object to read from. */
  function zoneSummaryFor(zoneId: string): ZoneSummaryRow {
    return summaryByZone.get(zoneId) ?? {
      zone_id: zoneId,
      branch_count: 0,
      district_count: 0,
      pending_overrides: 0,
      last_override_at: null,
      hub_code: null,
      color_token: null,
      geometry: null,
    };
  }
  const districts = useMemo<ZoneDistrictRow[]>(
    () => districtsQuery.data?.rows ?? [],
    [districtsQuery.data],
  );
  const overrides = useMemo<ZoneOverrideRow[]>(
    () => overridesQuery.data?.rows ?? [],
    [overridesQuery.data],
  );
  const branchZones = useMemo<BranchZoneRow[]>(
    () => branchZonesQuery.data?.rows ?? [],
    [branchZonesQuery.data],
  );
  const canonicalCities = useMemo<CanonicalCityRow[]>(
    () => canonicalCitiesQuery.data?.rows ?? [],
    [canonicalCitiesQuery.data],
  );
  const branchCoverageChoices = useMemo<BranchCoverageChoiceRow[]>(
    () => branchesQuery.data?.rows ?? [],
    [branchesQuery.data?.rows],
  );
  const cityIndex = useMemo(() => {
    const map = new Map<string, CanonicalCityRow>();
    for (const city of canonicalCities) map.set(city.id, city);
    return map;
  }, [canonicalCities]);
  const canonicalDistricts = useMemo<ZoneDrawerDistrictRow[]>(
    () =>
      (canonicalDistrictsQuery.data?.rows ?? []).map((district) => {
        const cityLabel =
          firstDisplayString(district.city_label, district.city_code, district.city_name)
          ?? canonicalCityDisplayName(
            typeof district.city_id === 'string' ? cityIndex.get(district.city_id) : undefined,
          );
        const displayName = canonicalDistrictDisplayName(district);
        return {
          ...district,
          city_code: cityLabel ?? '',
          name: displayName,
          ...(cityLabel ? { city_label: cityLabel, city_name: cityLabel } : {}),
        };
      }),
    [canonicalDistrictsQuery.data, cityIndex],
  );

  // ────── Indexes (computed once per data tick) ──────
  const districtsByZone = useMemo(() => {
    const map = new Map<string, ZoneDistrictRow[]>();
    for (const d of districts) {
      if (!map.has(d.zone_id)) map.set(d.zone_id, []);
      map.get(d.zone_id)!.push(d);
    }
    return map;
  }, [districts]);

  const branchZonesByZone = useMemo(() => {
    const map = new Map<string, BranchZoneRow[]>();
    for (const b of branchZones) {
      if (!map.has(b.zone_id)) map.set(b.zone_id, []);
      map.get(b.zone_id)!.push(b);
    }
    return map;
  }, [branchZones]);

  const overridesByZone = useMemo(() => {
    const map = new Map<string, ZoneOverrideRow[]>();
    for (const o of overrides) {
      if (!map.has(o.zone_id)) map.set(o.zone_id, []);
      map.get(o.zone_id)!.push(o);
    }
    return map;
  }, [overrides]);

  const districtIndex = useMemo(() => {
    const m = new Map<string, ZoneDrawerDistrictRow>();
    for (const d of canonicalDistricts) m.set(d.id, d);
    return m;
  }, [canonicalDistricts]);

  // ────── KPI strip metrics ──────
  // W20 — counters resolve canonical `is_active` + `metadata.lifecycle`
  // first via `zoneStatusOf()`; FE alias `status` remains a back-compat
  // fallback inside the resolver.
  const totalZones = visibleZones.length;
  // E2 closure (P1 #4) — active/suspended KPI counts derive from canonical
  // `zone_status.metadata.is_active_zone_status` /
  // `zone_status.metadata.is_suspended_zone_status` so adding a new lifecycle
  // status (e.g. 'staging' or 'frozen') is metadata-only. Replaces literal
  // `=== 'active'` / `=== 'suspended'` filters; both KPIs now read through
  // canonical `lookupRow` metadata.
  const activeZones = useMemo(
    () =>
      visibleZones.filter((z) => {
        const meta = lookupRow('zone_status', zoneStatusOf(z))?.metadata as
          | { is_active_zone_status?: boolean }
          | undefined;
        return zoneCountsAsActive(z, meta);
      }).length,
    [visibleZones],
  );
  const suspendedZones = useMemo(
    () =>
      visibleZones.filter((z) => {
        const meta = lookupRow('zone_status', zoneStatusOf(z))?.metadata as
          | { is_suspended_zone_status?: boolean }
          | undefined;
        return zoneCountsAsSuspended(z, meta);
      }).length,
    [visibleZones],
  );
  // Pending overrides total now reads the v_zone_summary projection (W11-2);
  // the canonical view aggregates per-zone counts via SUM(pending_overrides).
  // Falls back to the FE-side overrides filter when the summary is empty so
  // the KPI never goes blank during the first-load racing with summary fetch.
  //
  // E2 closure (P1 #4) — pending derives from canonical
  // `zone_override_status.metadata.is_terminal=false`.
  const pendingOverridesTotal = useMemo(() => {
    if (zoneSummaries.length > 0) {
      return zoneSummaries.reduce(
        (acc, s) => acc + (Number(s.pending_overrides) || 0),
        0,
      );
    }
    return overrides.filter((o) => {
      const meta = lookupRow('zone_override_status', o.status)?.metadata as
        | { is_terminal?: boolean }
        | undefined;
      return meta?.is_terminal === false;
    }).length;
  }, [zoneSummaries, overrides]);

  // ────── Map projection ──────
  // Convert v_zone_summary.geometry into ZoneMap polygon shape; tone derives
  // from the same summary `color_token` projection. The base zones row stays
  // canonical and no longer carries map polygons.
  const mapZones = useMemo<ZonePolygon[]>(() => {
    return visibleZones
      .map((z) => ({ z, summary: zoneSummaryFor(z.id) }))
      .filter((p): p is { z: NetworkZoneRow; summary: ZoneSummaryRow & { geometry: NonNullable<ZoneGeometry> } } => !!p.summary.geometry?.paths?.length)
      .map(({ z, summary }) => ({
        id: z.id,
        name: z.name,
        paths: summary.geometry.paths,
        tone: toMapTone(summary.color_token ?? undefined),
      }));
    // Note: `zoneSummaryFor` reads from `summaryByZone` which is already in the
    // dep set as `zoneSummaries` upstream — adding `summaryByZone` keeps the
    // memo invalidation tight and avoids recomputing on unrelated parent renders.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visibleZones, summaryByZone]);
  const mapBounds = mapZones.length === 0 ? mapDefaultViewport : undefined;

  // ────── Selection (keeps map polygon + side list row in sync) ──────
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [bulkPending, setBulkPending] = useState<string | null>(null);
  const openedFocusRef = useRef<string | null>(null);

  // ────── New-zone modal (lazy-loaded) ──────
  const [createOpen, setCreateOpen] = useState(false);

  // Phase C2 mutation hook (canonical Phase B4 RPC).
  // Audit ref: __audit__/CROSSWALK/NETWORK.md §1.2 + §3.2.
  const suspendZoneMut = useSuspendZone();
  const restoreZoneMut = useRestoreZone();
  const assignBranchZoneMut = useAssignBranchZone();

  // Bulk suspend: iterate active zones and call canonical suspend_zone_v1 per
  // row. Each call auto-invalidates qk.list('zones'); we use Promise.all
  // so the UI reflects the final state once all RPCs resolve.
  function bulkSuspend() {
    if (!canWrite) return;
    // E2 closure (P1 #4) — bulk-suspend targets are derived from canonical
    // `zone_status.metadata.is_active_zone_status=true`. Replaces the literal
    // `=== 'active'` filter so adding a new lifecycle status (e.g. 'staging')
    // is metadata-only.
    const targets = visibleZones.filter((z) => {
      const meta = lookupRow('zone_status', zoneStatusOf(z))?.metadata as
        | { is_active_zone_status?: boolean }
        | undefined;
      return zoneCountsAsActive(z, meta);
    });
    if (targets.length === 0) {
      setBulkPending(t('zones.bulk.noActive'));
      // W73-Network Cycle F-R-13 closure (P2-5): transient toast auto-hide
      // resolves through canonical `ux_safety_policy.toast_auto_hide_ms`.
      // AGENTS.md §2 (ZERO HARDCODING) + §6 (row-driven by configuration).
      // Strict no-fallback: when policy value is missing, the notice
      // stays visible until the next bulk action (operator-visible gap).
      if (typeof toastAutoHideMs === 'number') {
        setTimeout(() => setBulkPending(null), toastAutoHideMs);
      }
      return;
    }
    setBulkPending(fill(t('zones.bulk.suspending'), { n: targets.length }));
    Promise.all(
      targets.map((z) =>
        // E2 closure (P1 #6) — `reason: 'bulk_suspend'` is RPC-canonical;
        // backend `suspend_zone_v1` schema accepts a free-form `reason`
        // string the FE passes through. SSOT is the backend RPC parameter
        // contract, not a FE-side lookup.
        suspendZoneMut.mutateAsync({ zone_id: z.id, reason: 'bulk_suspend' }),
      ),
    )
      .then((results) => {
        const typedResults = results as Array<{ already_processed?: boolean } | null | undefined>;
        const newly = typedResults.filter((r) => !r?.already_processed).length;
        const already = typedResults.length - newly;
        const suspendedKey = already > 0
          ? (newly === 1 ? 'zones.bulk.suspendedAlreadyOne' : 'zones.bulk.suspendedAlreadyOther')
          : (newly === 1 ? 'zones.bulk.suspendedOne' : 'zones.bulk.suspendedOther');
        pushToast(fill(t(suspendedKey), { n: newly, already }), 'good');
        setBulkPending(null);
      })
      .catch(() => {
        pushToast(t('zones.bulk.suspendFailed'), 'danger');
        setBulkPending(null);
      });
  }

  function bulkRestore() {
    if (!canWrite) return;
    const targets = visibleZones.filter((z) => {
      const meta = lookupRow('zone_status', zoneStatusOf(z))?.metadata as
        | { is_suspended_zone_status?: boolean }
        | undefined;
      return zoneCountsAsSuspended(z, meta);
    });
    if (targets.length === 0) {
      setBulkPending(t('zones.bulk.noSuspended'));
      if (typeof toastAutoHideMs === 'number') {
        setTimeout(() => setBulkPending(null), toastAutoHideMs);
      }
      return;
    }
    setBulkPending(fill(t('zones.bulk.restoring'), { n: targets.length }));
    Promise.all(
      targets.map((z) =>
        restoreZoneMut.mutateAsync({ zone_id: z.id, reason: 'bulk_restore' }),
      ),
    )
      .then((results) => {
        const typedResults = results as Array<{ already_processed?: boolean } | null | undefined>;
        const newly = typedResults.filter((r) => !r?.already_processed).length;
        const already = typedResults.length - newly;
        const restoredKey = already > 0
          ? (newly === 1 ? 'zones.bulk.restoredAlreadyOne' : 'zones.bulk.restoredAlreadyOther')
          : (newly === 1 ? 'zones.bulk.restoredOne' : 'zones.bulk.restoredOther');
        pushToast(fill(t(restoredKey), { n: newly, already }), 'good');
        setBulkPending(null);
      })
      .catch(() => {
        pushToast(t('zones.bulk.restoreFailed'), 'danger');
        setBulkPending(null);
      });
  }

  // ────── Drawer body (lazy-loaded) ──────
  const openZone = useCallback(
    (zoneId: string) => {
      const zone = visibleZones.find((z) => z.id === zoneId);
      if (!zone) return;
      setSelectedId(zoneId);

      const linkedDistricts = districtsByZone.get(zoneId) ?? [];
      const linkedBranches = branchZonesByZone.get(zoneId) ?? [];
      const zoneOverrides = overridesByZone.get(zoneId) ?? [];
      const perf = performanceByZone.get(zoneId);
      const summary = zoneSummaryFor(zoneId);
      const projectedZone: NetworkZoneRow = {
        ...zone,
        color_token: summary.color_token ?? undefined,
        hub_code: summary.hub_code ?? undefined,
        geometry: summary.geometry ?? null,
      };

      openDrawer({
        title: fill(t('zones.drawer.title'), { name: zone.name }),
        size: 'lg',
      deepLink: `/network/zones?focus=${encodeURIComponent(zone.id)}`,
        body: (
          <Suspense fallback={<StateView kind="loading" hint={t('zones.loadingZone')} />}>
            <ZoneDrawerBody
              zone={projectedZone}
              linkedDistricts={linkedDistricts}
              linkedBranches={linkedBranches}
              zoneOverrides={zoneOverrides}
              {...(perf ? { perf } : {})}
              districtIndex={districtIndex}
              {...(tenantId ? { tenantId } : {})}
              onTimelineMutate={() => {
                // Re-open with a fresh body to pick up the in-place mutation.
                setTimeout(() => openZone(zoneId), 0);
              }}
              fmtNumber={fmtNumber}
              fmtDateTime={fmtDateTime}
            />
          </Suspense>
        ),
        onClose: () => setSelectedId(null),
      });
    },
    [
      visibleZones,
      districtsByZone,
      branchZonesByZone,
      overridesByZone,
      performanceByZone,
      summaryByZone,
      districtIndex,
      tenantId,
      openDrawer,
      t,
      fmtNumber,
      fmtDateTime,
    ],
  );

  useEffect(() => {
    if (!isDrawerOpen || !selectedId) return;
    if (!visibleZones.some((zone) => zone.id === selectedId)) return;
    openZone(selectedId);
  }, [isDrawerOpen, selectedId, visibleZones, openZone]);

  // ────── Side list rendering ──────
  useEffect(() => {
    if (!focusParam) {
      openedFocusRef.current = null;
      return undefined;
    }
    if (openedFocusRef.current === focusParam) return undefined;
    if (!focusTarget) return undefined;
    const timer = window.setTimeout(() => {
      openZone(focusTarget.id);
      openedFocusRef.current = focusParam;
    }, 100);
    return () => window.clearTimeout(timer);
    // openZone closes over current relation indexes; focus target is the trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusParam, focusTarget]);

  function renderSideList() {
    if (visibleZones.length === 0) {
      return <StateView kind="empty" hint={t('zones.empty')} />;
    }
    return (
      <ul className="zones-side-list" role="list">
        {visibleZones.map((z) => {
          // W11-2: prefer v_zone_summary counts; fall back to FE-side index
          // when the summary stream is still loading or hasn't materialized
          // yet (e.g. demo seed without summary projection).
          const summary = zoneSummaryFor(z.id);
          const linkedD = summary.district_count ?? districtsByZone.get(z.id)?.length ?? 0;
          const linkedB = summary.branch_count ?? branchZonesByZone.get(z.id)?.length ?? 0;
          // E2 closure (P1 #4) — pending derives from canonical
          // `zone_override_status.metadata.is_terminal=false`.
          const pending =
            summary.pending_overrides
              ?? (overridesByZone.get(z.id)?.filter((o) => {
                const meta = lookupRow('zone_override_status', o.status)?.metadata as
                  | { is_terminal?: boolean }
                  | undefined;
                return meta?.is_terminal === false;
              }).length ?? 0);
          const isSelected = z.id === selectedId;
          return (
            <li
              key={z.id}
              className={'zones-side-row' + (isSelected ? ' is-selected' : '')}
            >
              <button
                type="button"
                className="zones-side-row__btn"
                aria-pressed={isSelected}
                aria-label={fill(t('zones.side.open'), { name: z.name })}
                data-zone-row={z.id}
                onClick={() => openZone(z.id)}
              >
                <span
                  className={`zones-side-row__swatch zones-side-row__swatch--${toMapTone(summary.color_token ?? undefined)}`}
                  aria-hidden="true"
                />
                <span className="zones-side-row__body">
                  <span className="zones-side-row__name">{z.name}</span>
                  <span className="zones-side-row__meta mono">
                    {z.slug} · {summary.hub_code ?? '—'}
                  </span>
                </span>
                <span className="zones-side-row__chips">
                  <Chip
                    label={`${linkedD}D`}
                    kind="neutral"
                    size="xs"
                    className="mono"
                    title={fill(t(linkedD === 1 ? 'zones.side.districtOne' : 'zones.side.districtOther'), { n: linkedD })}
                  />
                  <Chip
                    label={`${linkedB}B`}
                    kind="info"
                    size="xs"
                    className="mono"
                    title={fill(t(linkedB === 1 ? 'zones.side.branchOne' : 'zones.side.branchOther'), { n: linkedB })}
                  />
                  {pending > 0 ? (
                    <Chip
                      label={`${pending}!`}
                      kind="danger"
                      size="xs"
                      className="mono"
                      title={fill(t(pending === 1 ? 'zones.side.pendingOne' : 'zones.side.pendingOther'), { n: pending })}
                    />
                  ) : null}
                  <CanonicalChip
                    category="zone_status"
                    value={zoneStatusOf(z)}
                    labelOverride={t(`zones.status.${zoneStatusOf(z)}`, zoneStatusOf(z))}
                  />
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    );
  }

  // ────── Loading / error gates ──────
  const isError =
    zonesQuery.isError ||
    zoneSummaryQuery.isError ||
    zonePerformanceQuery.isError ||
    districtsQuery.isError ||
    overridesQuery.isError ||
    branchZonesQuery.isError;
  const isLoading =
    zonesQuery.isLoading ||
    zoneSummaryQuery.isLoading ||
    zonePerformanceQuery.isLoading ||
    districtsQuery.isLoading ||
    overridesQuery.isLoading ||
    branchZonesQuery.isLoading;

  // ────── Page ──────
  const headerActions: ReactNode[] = [
    <Button
      key="new"
      label={t('zones.actions.newZone')}
      iconName="plus"
      kind="primary"
      capability={CAP.ZONES_WRITE}
      onClick={() => setCreateOpen(true)}
    />,
    <Button
      key="suspend"
      label={t('zones.actions.suspendZone')}
      iconName="pause"
      kind="ghost"
      capability={CAP.ZONES_WRITE}
      onClick={bulkSuspend}
    />,
    <Button
      key="restore"
      label={t('zones.actions.restoreZone')}
      iconName="refresh"
      kind="ghost"
      capability={CAP.ZONES_WRITE}
      onClick={bulkRestore}
    />,
  ];

  if (!canRead) {
    return (
      <div className="page">
        <PageHeader
          moduleKey="network-zones"
          eyebrow={t('nav.network')}
          titleAccent={t('zones.header.accent')}
          titlePlain={t('zones.header.plain')}
        />
        <StateView
          kind="denied"
          capability={CAP.ZONES_READ}
          hint={t('zones.denied')}
        />
      </div>
    );
  }

  return (
    <div className="page">
      <PageHeader
        moduleKey="network-zones"
        eyebrow={t('nav.network')}
        titleAccent={t('zones.header.accent')}
        titlePlain={t('zones.header.plain')}
        pills={[
          <ScopePill key="scope" scopeType="tenant" scopeId={tenantId} />,
          <Chip
            key="src"
            label={<bdi>zones · districts · overrides</bdi>} // i18n-literal-ok: source table names
            kind="neutral"
            size="xs"
            className="mono"
          />,
        ]}
        actions={headerActions}
      />

      {bulkPending ? (
        <div
          role="status"
          className="state__hint"
          style={{
            margin: '4px 0 8px',
            padding: '6px 10px',
            background: 'oklch(from var(--warn) l c h / 0.12)',
            borderLeft: '3px solid var(--warn)',
            fontSize: '12px',
          }}
        >
          {bulkPending}
        </div>
      ) : null}

      {isError ? (
        <StateView kind="error" hint={t('zones.loadError')} />
      ) : isLoading ? (
        <StateView kind="loading" hint={t('zones.loading')} />
      ) : (
        <>
          <div className="kpi-strip" data-testid="zones-kpi-strip">
            <KPICard
              label={t('zones.kpi.total')}
              value={fmtNumber(totalZones)}
              delta={t('zones.kpi.totalDelta')}
              tone="info"
            />
            <KPICard
              label={t('zones.kpi.active')}
              value={fmtNumber(activeZones)}
              delta={fill(t('zones.kpi.activeDelta'), { n: fmtNumber(totalZones - activeZones) })}
              tone={activeZones > 0 ? 'good' : 'warn'}
            />
            {/* W27 Cycle D Network closure (P1 #7): tone bands resolve
                from canonical `zone_backlog_policy` (sv_470). Replaces
                inline `<= 2` magic threshold. Missing policy → neutral
                tone (no silent FE-literal masking). */}
            <KPICard
              label={t('zones.kpi.suspended')}
              value={fmtNumber(suspendedZones)}
              delta={t('zones.kpi.suspendedDelta')}
              tone={
                suspendedZones === 0
                  ? 'good'
                  : zoneBacklogThresholds?.warn_max != null
                    ? suspendedZones <= zoneBacklogThresholds.warn_max
                      ? 'warn'
                      : 'danger'
                    : 'neutral'
              }
            />
            <KPICard
              label={t('zones.kpi.pending')}
              value={fmtNumber(pendingOverridesTotal)}
              delta={
                pendingOverridesTotal === 0
                  ? t('zones.kpi.allClear')
                  : t('zones.kpi.reviewQueue')
              }
              tone={
                pendingOverridesTotal === 0
                  ? 'good'
                  : zoneBacklogThresholds?.warn_max != null
                    ? pendingOverridesTotal <= zoneBacklogThresholds.warn_max
                      ? 'warn'
                      : 'danger'
                    : 'neutral'
              }
            />
          </div>

          <div className="zones-split" data-testid="zones-split">
            <div className="zones-split__map" data-testid="zones-map">
              <ZoneMap
                zones={mapZones}
                selectedId={selectedId ?? undefined}
                onSelect={(id) => openZone(id)}
                height={520}
                bounds={mapBounds}
                tileUrlTemplate={mapTileProvider?.url_template}
                allowedTileHosts={mapTileProvider?.allowed_hosts}
                tileUsageTier={mapTileProvider?.usage_tier}
                tileCacheRequired={mapTileProvider?.cache_required}
                sameOriginProxyAllowed={mapTileProvider?.same_origin_proxy_allowed}
                tileAttributionLabel={mapTileProvider?.attribution_label}
                tileAttributionUrl={mapTileProvider?.attribution_url}
              />
            </div>
            <div className="zones-split__list" data-testid="zones-side-list">
              <div className="section-eyebrow" style={{ marginTop: 0 }}>
                {fill(t('zones.count'), { n: fmtNumber(visibleZones.length) })}
              </div>
              {renderSideList()}
            </div>
          </div>
        </>
      )}

      {drawer.node}

      {createOpen ? (
        <Suspense fallback={null}>
          <ZonesCreateModal
            open={createOpen}
            onClose={() => setCreateOpen(false)}
            onCreated={async (zoneId, context) => {
              if (context?.branchId) {
                await assignBranchZoneMut.mutateAsync({
                  branch_id: context.branchId,
                  zone_id: zoneId,
                  priority: 0,
                });
              }
              setCreateOpen(false);
              go(`/network/zones?focus=${encodeURIComponent(zoneId)}`);
            }}
            tenantId={tenantId ?? undefined}
            canonicalDistricts={canonicalDistricts}
            branchChoices={branchCoverageChoices}
          />
        </Suspense>
      ) : null}
    </div>
  );
}
