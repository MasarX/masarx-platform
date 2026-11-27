// branches.tsx — Network · Branches (CLAIM-NETWORK-BRANCHES, Wave 1, Phase A).
//
// Operator surface for the canonical branches catalog (depots/hubs/branches/
// drop-off points). Layout choice — **card grid → multi-tab drawer** — was
// picked because operators recognise their branches by name + city + capacity
// at-a-glance, far more readily than scanning rows of identifiers in a flat
// DataTable.
//
// All reads come through the registry-driven `useResourceList` seam, so the
// surface stays one swap away from real backend RPCs (`ui_list_resource_v1`
// against canonical tables `branches`, `branch_zones`, `branch_memberships`,
// `branch_capacity_windows`, `branch_coverage_windows`, plus the W11-2 paired
// projection view `v_branch_summary` for the FE-derived counters). Capability
// gating keys on `branches.read` (catalog read) and `branches.write` (mutating
// actions: New / Mark out of service / Assign zone / Remove staff /
// inline cell-edit on capacity windows). Mirrors RLS in
// supabase/migrations/202601212340_branches_coverage_foundation.sql +
// 202601300340_rbac_branches_write_gates_v1.sql +
// 202604301400_v_branch_summary.sql.
//
// Drawer surfaces 7 tabs: Profile / Coverage / Capacity / Zones / Staff /
// Vehicles / Routes. Each tab reads exactly the seed slice it needs — no
// duplicated joins, no cross-tab refetches, no shared mutable state outside
// the drawer scope.
//
// W56-C SSOT (E2 closure P1 #5) — `<ScopePill scopeType="tenant" .../>`
// uses the literal `"tenant"` because branches resources are tenant-tier
// per the canonical RLS scope contract (`scope_type_registry`,
// org-scoped under `current_user_org_id()`). The literal IS canonical
// per-module: it mirrors the resource's intrinsic partitioning tier, not
// a runtime UX choice. The `scopeId` value remains identity-derived
// (`scope.tenant?.id` from `useIdentity`) so INV-SCOPE compliance holds.

import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { PageHeader } from '@/components/PageHeader';
import { Chip } from '@/components/Chip';
import { ScopePill } from '@/components/ScopePill';
import { KPICard } from '@/components/KPICard';
import { Button } from '@/components/Button';
import { CapabilityLock } from '@/components/CapabilityLock';
import { CapacityGauge } from '@/components/CapacityGauge';
import { CoverageHeatmap, type HeatmapCell } from '@/components/CoverageHeatmap';
import { DataTable, type DataTableColumn } from '@/components/DataTable';
import { KvGrid, type KvRow } from '@/components/KvGrid';
import { ReferencePicker } from '@/components/ReferencePicker';
import { StateView } from '@/components/StateView';
import {
  useResource,
  useResourceList,
  useResourceListsByFilters,
  useCreateBranch,
  useUpdateBranch,
  useMarkBranchOos,
  useAssignBranchZone,
  useAddBranchMember,
  useRemoveBranchMember,
  useSetBranchCapacityWindow,
  useUpsertBranchCoverageWindow,
  useResolveSettings,
} from '@/lib/queries';
import { useIdentity, useCapability } from '@/lib/identity';
import { englishT, fill, useI18n, useT, type Translate } from '@/lib/i18n';
import { CAP } from '@/lib/capabilities';
import { useDrawer, useModal } from '@/hooks/useOverlay';
import { pushToast } from '@/components/toastStore';
import { getLookups, lookupRow } from '@/lib/api';
import type { ChipKind } from '@/components/Chip';
import { useConsoleNavigator } from '@/lib/useConsoleNavigator';
import { readUrlParam } from '@/lib/url-params';
// W27 Cycle D Network closure (P2 #9): shared visual-band helper for the
// priority projection. Identical helper previously inlined in branches.tsx
// + zones-drawer.tsx.
//
// E2 closure (P2 #7) — `DEFAULT_BRANCH_ZONE_BAND_FALLBACK_MIN` removed.
// `priorityToBand` is now fail-closed when the canonical policy is missing
// (returns the `'no_policy'` sentinel band so callers surface an explicit
// error chip rather than silently using a hardcoded baseline).
import { priorityToBand } from './_branch-band';

// ---------- Row shapes (mirror canonical columns) ----------
//
// Phase G1 (Wave 6) — schema-drift alignment per
// `__audit__/SCHEMA-DRIFT/NETWORK.md` §1–§6, §10.
//
// W11-2 + W80 close-out: derived counters previously inlined on `BranchRow`
// (capacity_per_day, booked_today, active_vehicles, active_routes,
// manager_user_id, cutoff_time) now resolve through the canonical
// `public.v_branch_summary` projection view (registry key: `branch_summary`).
// The FE merges the two shapes by `branch_id` so the surface keeps its
// existing card / drawer layout while consuming server-derived projections in
// production.

// W20 — added canonical column shadows for the deferred RENAME items
// (per `__audit__/SCHEMA-DRIFT/NETWORK.md` §1). The FE row interface now
// mirrors canonical `public.branches` columns (`branch_type`, `is_active`)
// alongside the FE aliases (`type`, `status`). Resolver helpers
// (`branchTypeOf` / `isActiveOf` / `branchStatusOf`) prefer canonical when
// present and fall back to the FE alias for legacy seed rows. Seed rows
// now carry both shapes per row so the canonical resolution path always
// hits a defined value while view-saved sorts/filters keep working
// against the FE alias keys.
type BranchAddress = string | Record<string, unknown> | null;
type BranchCoordinates = {
  lat?: unknown;
  lng?: unknown;
  latitude?: unknown;
  longitude?: unknown;
} | null;

interface BranchRow extends Record<string, unknown> {
  id: string;                    // → branches.id
  organization_id?: string;      // → branches.organization_id
  code?: string;                 // → branches.code
  /** @deprecated FE alias for canonical `code`. Canonical `public.branches`
   *  has no `slug` column. Resolve via `slugOf(branch)` (which prefers
   *  `code`); kept on the row interface for back-compat with seed rows
   *  that pre-date the W20 cutover. */
  slug?: string;
  name: string;                  // → branches.name
  /** Canonical branch_type. Values are lookup-driven by `branch_type`. */
  branch_type?: string;
  /** @deprecated FE alias for canonical `branch_type`. Resolve via
   *  `branchTypeOf(branch)`. Seed rows now carry both shapes. */
  type?: string;
  /** → branches.address (canonical column is jsonb; FE flattens to display string).
   *  G1 close-out (W10-4): unused FE-fictional `address_id` FK dropped — branches.address is JSONB, not a relation. */
  address?: BranchAddress;
  /** -> branches.coordinates (PostGIS point). Seed rows expose lat/lng JSON; live projections expose lat/lng. */
  coordinates?: BranchCoordinates;
  lat?: number | string | null;
  lng?: number | string | null;
  latitude?: number | string | null;
  longitude?: number | string | null;
  /** Resolved via address.city (jsonb path). Not a column on branches. */
  city?: string;
  /** Canonical is_active boolean (true = operational, false = OOS). */
  is_active?: boolean;
  /** @deprecated FE display alias derived from canonical `is_active` plus
   *  `metadata.lifecycle`. Multi-state values:
   *    `active`         ← is_active=true,  metadata.lifecycle in (null, 'active')
   *    `reduced`        ← is_active=true,  metadata.lifecycle = 'reduced'
   *    `out_of_service` ← is_active=false
   *    `planned`        ← is_active=true,  metadata.lifecycle = 'planned'
   *  Resolve via `branchStatusOf(branch)`. */
  status?: 'active' | 'reduced' | 'out_of_service' | 'planned';
  /** Canonical metadata jsonb (resolves derived values like lifecycle). */
  metadata?: Record<string, unknown>;
  timezone?: string;             // → branches.timezone
  updated_at?: string;           // → branches.updated_at
}

/** Resolve canonical branch_type for a branch row (W20). Prefers canonical
 *  `branch_type`; falls back to FE alias `type`. Returns 'branch' (the
 *  default branch_type) when neither is set so DataTable lookups stay
 *  deterministic. */
function branchTypeOf(b: BranchRow | undefined | null): string {
  if (!b) return 'branch';
  const c = stringValue(b.branch_type);
  if (c) return c;
  const a = stringValue(b.type);
  if (a) return a;
  return 'branch';
}

/** Resolve canonical is_active boolean (W20). Prefers canonical
 *  `is_active`; derives from FE alias `status` when only the alias is
 *  populated (`out_of_service` → false, anything else → true). */
function isActiveOf(b: BranchRow | undefined | null): boolean {
  if (!b) return false;
  if (typeof b.is_active === 'boolean') return b.is_active;
  return b.status !== 'out_of_service';
}

/** Resolve the multi-state FE status display from canonical `is_active` +
 *  `metadata.lifecycle` (W20). Top-level FE alias `status` kept for
 *  back-compat; this helper is the canonical entry point. */
function branchStatusOf(
  b: BranchRow | undefined | null,
): 'active' | 'reduced' | 'out_of_service' | 'planned' {
  if (!b) return 'active';
  // When canonical is_active=false, surface "out_of_service" regardless of
  // any metadata lifecycle hint (canonical is_active is the SSOT for OOS).
  if (!isActiveOf(b)) return 'out_of_service';
  const lifecycle = b.metadata?.['lifecycle'];
  if (lifecycle === 'reduced' || lifecycle === 'planned' || lifecycle === 'out_of_service' || lifecycle === 'active') {
    return lifecycle;
  }
  // Fall back to the FE alias for legacy seeds that pre-date metadata.lifecycle.
  if (b.status === 'reduced' || b.status === 'planned' || b.status === 'out_of_service' || b.status === 'active') {
    return b.status;
  }
  // Canonical baseline when neither shape is populated.
  return 'active';
}

/** Resolve the FE display slug for a branch (W20). Prefers FE alias
 *  `slug` (legacy seed); falls back to canonical `code`. Used as the
 *  KvGrid Slug-row value + card mono header. */
function slugOf(b: BranchRow | undefined | null): string {
  if (!b) return '';
  if (typeof b.slug === 'string' && b.slug.length > 0) return b.slug;
  if (typeof b.code === 'string' && b.code.length > 0) return b.code;
  return '';
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function numberValue(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function initialBranchCapacityPerDay(branch: BranchRow | undefined | null): number | null {
  const capacity = numberValue(branch?.metadata?.['initial_capacity_per_day']);
  return capacity != null && capacity >= 0 ? capacity : null;
}

function coordinateText(value: number | null): string {
  return value == null ? '' : String(value);
}

function parseCoordinateDraft(
  latitudeText: string,
  longitudeText: string,
  t: Translate = englishT,
): { ok: true; coordinates: { lat: number; lng: number } | null } | { ok: false; message: string } {
  const latRaw = latitudeText.trim();
  const lngRaw = longitudeText.trim();
  if (!latRaw && !lngRaw) return { ok: true, coordinates: null };
  if (!latRaw || !lngRaw) {
    return { ok: false, message: t('branches.coords.bothRequired') };
  }
  const lat = Number(latRaw);
  const lng = Number(lngRaw);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return { ok: false, message: t('branches.coords.notNumbers') };
  }
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    return { ok: false, message: t('branches.coords.outOfBounds') };
  }
  return { ok: true, coordinates: { lat, lng } };
}

function branchCoordinatesOf(
  branch: BranchRow | undefined | null,
  summary?: BranchSummaryRow | null,
): { lat: number; lng: number } | null {
  const direct = branch?.coordinates;
  const lat = numberValue(branch?.lat ?? branch?.latitude ?? direct?.lat ?? direct?.latitude ?? summary?.lat ?? summary?.latitude);
  const lng = numberValue(branch?.lng ?? branch?.longitude ?? direct?.lng ?? direct?.longitude ?? summary?.lng ?? summary?.longitude);
  if (lat == null || lng == null) return null;
  return { lat, lng };
}

function branchAddressTextOf(b: BranchRow | undefined | null): string {
  if (!b) return '';
  const address = b.address;
  if (typeof address === 'string') return address.trim();
  if (address && typeof address === 'object') {
    const formatted =
      stringValue(address.formatted) ||
      stringValue(address.formatted_address) ||
      stringValue(address.line1) ||
      stringValue(address.address_line1);
    if (formatted) return formatted;

    const parts = [
      stringValue(address.district),
      stringValue(address.city),
      stringValue(address.country),
    ].filter(Boolean);
    if (parts.length > 0) return parts.join(', ');
  }
  return stringValue(b.city);
}

function branchCityTextOf(b: BranchRow | undefined | null): string {
  if (!b) return '';
  const direct = stringValue(b.city);
  if (direct) return direct;
  const address = b.address;
  if (address && typeof address === 'object') {
    return stringValue(address.city);
  }
  return '';
}

/** v_branch_summary row shape (W11-2). Read-only paired projection.
 *  Source: supabase/migrations/202604301400_v_branch_summary.sql.
 *  Resource registry key: `branch_summary`. */
interface BranchSummaryRow extends Record<string, unknown> {
  branch_id: string;             // → v_branch_summary.branch_id (PK projection)
  organization_id?: string | null;
  code?: string | null;
  name?: string | null;
  branch_type?: string | null;
  is_active?: boolean;
  timezone?: string | null;
  /** Aggregated from branch_capacity_windows.capacity->>'max_stops'. */
  capacity_per_day?: number;
  /** Count of branch shipments promised for the branch-local current date. */
  booked_today?: number;
  /** COUNT vehicles.branch_id WHERE status='active'. */
  active_vehicles?: number;
  /** COUNT route_runs.branch_id WHERE status IN ('planned','in_progress'). */
  active_routes?: number;
  /** Deterministic MIN(user_id) over active manager memberships. */
  manager_user_id?: string | null;
  /** Projected from branches.operating_hours->>'cutoff_time_local'. */
  cutoff_time?: string | null;
  /** Projected from branches.coordinates for map-ready branch/hub markers. */
  lat?: number | string | null;
  lng?: number | string | null;
  latitude?: number | string | null;
  longitude?: number | string | null;
  updated_at?: string | null;
}

// W17-2 — `role` dropped from `BranchZoneLink`. Canonical `public.branch_zones`
// has no `role` column; precedence is priority-ordered only (0 = highest).
// FE renders priority bands as visual roles via the shared
// `priorityToBand()` helper (W27 Cycle D Network closure: P2 redundancy
// fix; the prior local copy of this helper duplicated zones-drawer.tsx).
interface BranchZoneLink extends Record<string, unknown> {
  id: string;                    // → branch_zones.id
  branch_id: string;             // → branch_zones.branch_id
  zone_id: string;               // → branch_zones.zone_id
  priority?: number;             // → branch_zones.priority
  created_at?: string;           // → branch_zones.created_at
}

// W17-2 — `user_name` dropped from `BranchMember`. Canonical
// `public.branch_memberships` has no display-name column; resolution comes
// from a `users` join. The Staff DataTable now renders `user_id` directly
// (the canonical FK) and the seed retains user_id only — drawers can later
// resolve display names through a paired projection view.
//
// W20 — added canonical column shadows for the deferred RENAME items
// (per `__audit__/SCHEMA-DRIFT/NETWORK.md` §3). The FE row interface now
// mirrors canonical `public.branch_memberships` columns (`role_key`,
// `effective_from`) alongside the FE aliases (`role`, `joined_at`).
// Resolver helpers (`memberRoleOf` / `memberJoinedAtOf`) prefer canonical
// when present and fall back to FE aliases. Seed rows now carry both
// shapes per row.
interface BranchMember extends Record<string, unknown> {
  id: string;                    // → branch_memberships.id
  branch_id: string;             // → branch_memberships.branch_id
  user_id: string;               // → branch_memberships.user_id
  /** Canonical role_key. */
  role_key?: string;
  /** @deprecated FE alias for canonical role_key. Resolve via
   *  `memberRoleOf(member)`. */
  role?: string;
  /** Canonical effective_from. */
  effective_from?: string;
  /** @deprecated FE alias for canonical effective_from. Resolve via
   *  `memberJoinedAtOf(member)`. */
  joined_at?: string;
  /** Canonical effective_to (open-ended when null). */
  effective_to?: string | null;
  is_active?: boolean;           // → branch_memberships.is_active
}

/** Resolve canonical role_key for a branch membership row (W20). Prefers
 *  canonical `role_key`; falls back to FE alias `role`. Returns '' when
 *  neither is set so DataTable lookup chips render '—'. */
function memberRoleOf(m: BranchMember | undefined | null): string {
  if (!m) return '';
  if (typeof m.role_key === 'string' && m.role_key.length > 0) return m.role_key;
  if (typeof m.role === 'string' && m.role.length > 0) return m.role;
  return '';
}

/** Resolve canonical effective_from for a branch membership row (W20).
 *  Prefers canonical `effective_from`; falls back to FE alias `joined_at`. */
function memberJoinedAtOf(m: BranchMember | undefined | null): string | undefined {
  if (!m) return undefined;
  if (typeof m.effective_from === 'string' && m.effective_from.length > 0) return m.effective_from;
  if (typeof m.joined_at === 'string' && m.joined_at.length > 0) return m.joined_at;
  return undefined;
}

interface UserDirectoryRow extends Record<string, unknown> {
  id?: string;
  user_id?: string;
  email?: string | null;
  full_name?: string | null;
  status?: string | null;
}

function userDirectoryIdOf(row: UserDirectoryRow | undefined | null): string {
  if (!row) return '';
  if (typeof row.user_id === 'string' && row.user_id.length > 0) return row.user_id;
  if (typeof row.id === 'string' && row.id.length > 0) return row.id;
  return '';
}

function userDirectoryLabelOf(row: UserDirectoryRow | undefined | null, t: Translate = englishT): string {
  if (!row) return '';
  const name = typeof row.full_name === 'string' ? row.full_name : '';
  const email = typeof row.email === 'string' ? row.email : '';
  if (name && email) return `${name} (${email})`;
  return name || email || t('branches.userAccount');
}

function userDirectoryIsSelectable(row: UserDirectoryRow | undefined | null): boolean {
  if (!row || !userDirectoryIdOf(row)) return false;
  const name = typeof row.full_name === 'string' ? row.full_name.trim() : '';
  const email = typeof row.email === 'string' ? row.email.trim() : '';
  return Boolean(name || email);
}

// W18-3 — `BranchCapacityRow` re-typed as a heatmap cell projection.
// Canonical SSOT is `public.branch_capacity_windows`
// (`(branch_id, zone_id, day_of_week, window_start_local TIME,
// window_end_local TIME, capacity JSONB, …)`). The FE heatmap previously
// read FE-fictional `weekday` / `hour` / `capacity_units` / `booked_units`
// columns directly off the base table. Those fields are now projected
// through paired view `public.v_branch_capacity_heatmap` (registry key:
// `branch_capacity_heatmap`), which fans the
// `[window_start_local, window_end_local)` time range into per-hour cells
// with `(weekday, hour, capacity_units, booked_units)` materialised from
// canonical `day_of_week` + `capacity` jsonb.
//
// Inline-edit on the Capacity tab DataTable still targets the base table
// (RPC `branch_capacity_window_set_v1` accepts `capacity_window_id` +
// convenience `capacity_units`). The seed in dev mode provides one row
// per (branch, weekday, hour) so the projection seam is a typed
// pass-through; in production the live `v_branch_capacity_heatmap` view
// supplies the projection and the inline-edit RPC writes back into the
// underlying window's `capacity` jsonb.
//
// See supabase/migrations/202604301420_v_branch_capacity_heatmap.sql.
interface BranchCapacityRow extends Record<string, unknown> {
  id: string;                    // → v_branch_capacity_heatmap.id (synth: <window>_<hour>)
  /** Resolves to the underlying window id when present (live view). */
  source_window_id?: string;
  branch_id: string;             // → v_branch_capacity_heatmap.branch_id
  /** Projection of canonical day_of_week (0=Sun..6=Sat). */
  weekday: number;
  /** Projection: per-hour fan-out across [window_start_local, window_end_local). */
  hour: number;
  /** Projection: derived from canonical `capacity` jsonb (max_stops/max_units). */
  capacity_units: number;
  /** Projection: NULL until a live "booked-against-window" counter ships. */
  booked_units?: number | null;
}

// W18-3 — `weekday` dropped from `BranchCoverageRow`. Canonical
// `public.branch_coverage_windows` is a continuous range
// (`effective_from`/`effective_to` only — no day-of-week column). The FE
// only uses this row's `branch_id` for KPI counting; it does not render
// `weekday` directly. Dropping the field surfaces canonical schema
// without a projection-view follow-up.
//
// W20 — added canonical column shadows for the deferred RENAME items
// (per `__audit__/SCHEMA-DRIFT/NETWORK.md` §5). The FE row interface now
// mirrors canonical `public.branch_coverage_windows` columns
// (`effective_from`, `effective_to`) alongside the FE aliases
// (`open_at`, `close_at`). Resolver helpers (`openAtOf` / `closeAtOf`)
// prefer canonical when present and fall back to FE aliases. Seed rows
// now carry both shapes per row.
interface BranchCoverageRow extends Record<string, unknown> {
  id: string;                    // → branch_coverage_windows.id
  branch_id: string;             // → branch_coverage_windows.branch_id
  zone_id?: string | null;       // → branch_coverage_windows.zone_id
  priority?: number | null;      // → branch_coverage_windows.priority
  /** Canonical effective_from. */
  effective_from?: string;
  /** @deprecated FE alias for canonical effective_from. Resolve via
   *  `openAtOf(coverage)`. */
  open_at?: string;
  /** Canonical effective_to (null = open-ended). */
  effective_to?: string | null;
  /** @deprecated FE alias for canonical effective_to. Resolve via
   *  `closeAtOf(coverage)`. */
  close_at?: string;
  reason?: string | null;        // → branch_coverage_windows.reason
}

/** Resolve canonical effective_from for a coverage window row (W20).
 *  Prefers canonical `effective_from`; falls back to FE alias `open_at`. */
function openAtOf(c: BranchCoverageRow | undefined | null): string | undefined {
  if (!c) return undefined;
  if (typeof c.effective_from === 'string' && c.effective_from.length > 0) return c.effective_from;
  if (typeof c.open_at === 'string' && c.open_at.length > 0) return c.open_at;
  return undefined;
}

/** Resolve canonical effective_to for a coverage window row (W20). Prefers
 *  canonical `effective_to`; falls back to FE alias `close_at`. */
function closeAtOf(c: BranchCoverageRow | undefined | null): string | undefined {
  if (!c) return undefined;
  if (typeof c.effective_to === 'string' && c.effective_to.length > 0) return c.effective_to;
  if (typeof c.close_at === 'string' && c.close_at.length > 0) return c.close_at;
  return undefined;
}

function coverageReasonLabel(reason?: string | null, t: Translate = englishT): string {
  if (!reason) return t('branches.window.manualUpdate');
  return reason
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/\b\w/g, (match) => match.toUpperCase());
}

const WEEKDAY_KEYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];

function weekdayLabel(dayIndex: number, t: Translate = englishT): string {
  const key = WEEKDAY_KEYS[dayIndex];
  return key ? t(`branches.weekday.${key}`) : fill(t('branches.dayN'), { n: dayIndex + 1 });
}

interface ZoneRow extends Record<string, unknown> {
  id: string;                    // → zones.id
  name: string;                  // → zones.name
  slug?: string;                 // → zones.slug
  /** Resolved via branch_zones join → branches.code. Not a column on zones. */
  hub_code?: string;
  /** FE alias for canonical is_active (boolean). */
  status?: string;
}

interface VehicleRow extends Record<string, unknown> {
  id: string;
  plate?: string;
  plate_number?: string;
  type_name?: string;
  vehicle_type_label?: string | null;
  branch_id?: string | null;
  current_branch_id?: string;
  current_driver_user_id?: string | null;
  status?: string;
  fuel_level?: number;
}

function vehiclePlateOf(v: VehicleRow): string {
  return v.plate_number ?? v.plate ?? v.id;
}

function vehicleTypeOf(v: VehicleRow): string {
  return v.vehicle_type_label ?? v.type_name ?? '—';
}

function BranchVehiclesTable({ branchId }: { branchId: string }) {
  const t = useT();
  const vehiclesQuery = useResourceListsByFilters<VehicleRow>(
    'vehicle_directory',
    [{ current_branch_id: branchId }, { branch_id: branchId }],
    { page_size: 100 },
    { enabled: Boolean(branchId) },
  );

  const cols: Array<DataTableColumn<VehicleRow>> = [
    {
      key: 'plate_number',
      label: t('branches.vehicles.plate'),
      mono: true,
      sortable: true,
      filterable: true,
      render: (_raw, row) => vehiclePlateOf(row),
    },
    {
      key: 'vehicle_type_label',
      label: t('branches.field.type'),
      sortable: true,
      filterable: true,
      render: (_raw, row) => vehicleTypeOf(row),
    },
    {
      key: 'status',
      label: t('branches.field.status'),
      sortable: true,
      filterable: true,
      lookup: 'vehicle_status',
    },
    {
      key: 'fuel_level',
      label: t('branches.vehicles.fuel'),
      align: 'right',
      format: 'percent',
      sortable: true,
    },
  ];

  if (vehiclesQuery.isLoading) {
    return <StateView kind="loading" hint={t('branches.vehicles.loading')} />;
  }
  if (vehiclesQuery.isError) {
    return (
      <StateView
        kind="error"
        title={t('branches.vehicles.failedTitle')}
        hint={vehiclesQuery.error?.message ?? t('branches.vehicles.failedHint')}
      />
    );
  }

  const list = vehiclesQuery.data?.rows ?? [];
  if (list.length === 0) {
    return (
      <StateView
        kind="empty"
        hint={t('branches.vehicles.empty')}
      />
    );
  }
  return (
    <DataTable<VehicleRow>
      columns={cols}
      rows={list}
      viewKey={`branch_vehicles_${branchId}`}
      entityKind="vehicle"
    />
  );
}

interface RouteRunRow extends Record<string, unknown> {
  id: string;
  run_id?: string;
  driver?: string;
  vehicle?: string;
  status?: string;
  stops?: number;
  completed?: number;
  branch_id?: string;
}

// ---------- Small visual helpers (kept inline; no shared primitive churn) ----------
//
// Status / type / role tone + label palettes are sourced strictly from the
// canonical lookups SSOT (`seed-raw/lookups.js` + paired backend
// lookup_values rows). NO inline `*_TONE` / `*_LABEL` Records — modules
// delegate to `lookupRow(category, value)` and surface a danger-toned
// "missing" chip when the (category, value) pair is not seeded so the gap
// is visible to operators rather than silently masked by a neutral
// fallback. AGENTS.md §2 (ZERO HARDCODING) + §4 (SSOT).
function CanonicalChip({
  category,
  value,
  className,
}: {
  category: string;
  value: string;
  className?: string;
}) {
  const t = useT();
  const row = lookupRow(category, value);
  if (!row) {
    return (
      <Chip
        label={fill(t('branches.missingLookup'), { token: `${category}/${value}` })}
        kind="danger"
        size="xs"
        className={className}
      />
    );
  }
  return (
    <Chip
      label={row.label}
      kind={(row.tone as ChipKind | undefined) ?? 'neutral'}
      size="xs"
      className={className}
    />
  );
}

const DRAWER_TABS = [
  { key: 'profile', labelKey: 'branches.tabs.profile' },
  { key: 'coverage', labelKey: 'branches.tabs.coverage' },
  { key: 'capacity', labelKey: 'branches.tabs.capacity' },
  { key: 'zones', labelKey: 'branches.tabs.zones' },
  { key: 'staff', labelKey: 'branches.tabs.staff' },
  { key: 'vehicles', labelKey: 'branches.tabs.vehicles' },
  { key: 'routes', labelKey: 'branches.tabs.routes' },
] as const;

type DrawerTabKey = typeof DRAWER_TABS[number]['key'];

// ---------- Module ----------

export function BranchesModule() {
  const { scope, currentTenantId } = useIdentity();
  const go = useConsoleNavigator();
  const { t, fmtNumber, fmtDateTime } = useI18n();
  const drawer = useDrawer();
  const modal = useModal();
  const canRead = useCapability(CAP.BRANCHES_READ);
  const canWrite = useCapability(CAP.BRANCHES_WRITE);
  const canReadUsers = useCapability(CAP.USERS_READ);
  const tenantId = scope.tenant?.id ?? currentTenantId() ?? null;
  const tenantListOpts = useMemo(
    () => (tenantId ? { filter: { organization_id: tenantId } } : undefined),
    [tenantId],
  );
  const tenantSettingsScope = useMemo(
    () => (tenantId ? { organization_id: tenantId } : undefined),
    [tenantId],
  );

  // Phase C2 mutation hooks (canonical RPCs PENDING; routed via phaseC6Rpc).
  // Audit ref: __audit__/CROSSWALK/NETWORK.md §1.1 + §2.1 + §3.1.
  const createBranchMut = useCreateBranch();
  const updateBranchMut = useUpdateBranch();
  const markOosMut = useMarkBranchOos();
  const assignZoneMut = useAssignBranchZone();
  const addMemberMut = useAddBranchMember();
  const removeMemberMut = useRemoveBranchMember();
  const setCapacityMut = useSetBranchCapacityWindow();
  const upsertCoverageMut = useUpsertBranchCoverageWindow();
  void updateBranchMut; // referenced inline below for Profile-tab edits

  // AGENTS.md §2 (ZERO HARDCODING) + §3 (ROW-DRIVEN): default IANA
  // timezone for the createBranch payload resolves strictly from
  // canonical `tenant_default_timezone.iana` via the settings ladder
  // (W52 closure). NO inline `'Asia/Riyadh'` fallback — a missing
  // canonical row sends an empty string and the backend rejects it
  // with a clear error rather than silently presenting a hardcoded
  // tenant timezone.
  const tenantTimezonePolicy = useResolveSettings('tenant_default_timezone', tenantSettingsScope);
  const tenantTimezoneIana =
    (tenantTimezonePolicy.data?.value as { iana?: string } | undefined)?.iana ?? '';

  // W27 Cycle D Network closure (P1 #5): branch utilization KPI tone
  // resolves from canonical `branch_capacity_policy` settings policy
  // (sv_450). Replaces inline `>= 90 ? 'danger' : 70 ? 'warn' : 'good'`
  // magic numbers. Missing canonical row → KPI tone falls through to
  // neutral via consumer null-checks.
  const branchCapacityPolicy = useResolveSettings('branch_capacity_policy', tenantSettingsScope);
  const branchCapacityThresholds =
    (branchCapacityPolicy.data?.value as
      | { utilization_danger_min?: number; utilization_warn_min?: number }
      | undefined) ?? null;

  // W27 Cycle D Network closure (P2 #9): the `branch_zones.priority` →
  // band threshold resolves from canonical
  // `branch_zone_band_priority_threshold` settings policy (sv_490).
  //
  // E2 closure (P2 #7) — fail-closed when the canonical policy row is
  // missing: `branchZoneBandFallbackMin` is `null | undefined` instead of
  // a hardcoded baseline. The `priorityToBand` helper returns the
  // `'no_policy'` sentinel band when the threshold is missing so
  // `<CanonicalChip category="branch_zone_band" />` renders a fail-loud
  // missing-row chip rather than silently using a hardcoded baseline.
  const branchZoneBandPolicy = useResolveSettings(
    'branch_zone_band_priority_threshold',
    tenantSettingsScope,
  );
  const branchZoneBandFallbackMin =
    (branchZoneBandPolicy.data?.value as { fallback_min?: number } | undefined)
      ?.fallback_min ?? null;

  // Selected card drives the focus ring; activeDrawer keeps the imperative
  // drawer rebuilt from the latest resource readback after branch relation
  // mutations such as Assign zone.
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const activeDrawerRef = useRef<{
    branchId: string;
    tab: DrawerTabKey;
  } | null>(null);
  const openedFocusRef = useRef<string | null>(null);

  const branchesQuery = useResourceList<BranchRow>('branches', tenantListOpts);
  // W11-2 — paired projection view `public.v_branch_summary`. Drives KPI
  // strip, drawer profile snapshot, and per-card capacity + counter chips.
  // SSOT remains `public.branches`; this is a read-only projection.
  const branchSummaryQuery = useResourceList<BranchSummaryRow>('branch_summary', tenantListOpts);

  // Wrap row arrays in useMemo so the downstream `useMemo` indexes don't
  // recompute on every render (the `?? []` fallback would otherwise produce a
  // fresh reference each pass — same pattern as PartnersModule).
  const branches = useMemo<BranchRow[]>(
    () => branchesQuery.data?.rows ?? [],
    [branchesQuery.data?.rows],
  );
  const focusParam = readUrlParam('focus');
  const focusInRows = focusParam ? branches.some((branch) => branch.id === focusParam) : false;
  const focusedBranchQuery = useResource<BranchRow>(
    'branches',
    focusParam && !focusInRows ? focusParam : undefined,
  );
  const focusTarget = focusParam
    ? branches.find((branch) => branch.id === focusParam) ?? focusedBranchQuery.data ?? null
    : null;
  const visibleBranches = useMemo<BranchRow[]>(() => {
    if (!focusTarget) return branches;
    const exists = branches.some((branch) => branch.id === focusTarget.id);
    return exists ? branches : [focusTarget, ...branches];
  }, [branches, focusTarget]);
  const branchRelationFilters = useMemo(
    () => visibleBranches.map((branch) => ({ branch_id: branch.id })),
    [visibleBranches],
  );
  // W18-1 — registry alias `branch_zone_links` was unified into the canonical
  // `branch_zones` entry (closes __audit__/DECISIONS/REGISTRY-ALIASES.md §2).
  const linksQuery = useResourceListsByFilters<BranchZoneLink>(
    'branch_zones',
    branchRelationFilters,
    { page_size: 500 },
    { enabled: branchRelationFilters.length > 0 },
  );
  const membersQuery = useResourceListsByFilters<BranchMember>(
    'branch_memberships',
    branchRelationFilters,
    { page_size: 500 },
    { enabled: branchRelationFilters.length > 0 },
  );
  // W18-3 — capacity heatmap now reads through paired projection view
  // `public.v_branch_capacity_heatmap` (registry key:
  // `branch_capacity_heatmap`). The view fans canonical
  // (day_of_week, [window_start_local, window_end_local)) ranges from
  // `public.branch_capacity_windows` into per-hour cells with
  // (weekday, hour, capacity_units, booked_units). SSOT remains the base
  // table; this is a read-only projection.
  const capacityQuery = useResourceListsByFilters<BranchCapacityRow>(
    'branch_capacity_heatmap',
    branchRelationFilters,
    { page_size: 1000 },
    { enabled: branchRelationFilters.length > 0 },
  );
  const coverageQuery = useResourceListsByFilters<BranchCoverageRow>(
    'branch_coverage_windows',
    branchRelationFilters,
    { page_size: 500 },
    { enabled: branchRelationFilters.length > 0 },
  );
  const zonesQuery = useResourceList<ZoneRow>('zones', tenantListOpts);
  const runsQuery = useResourceList<RouteRunRow>('route_runs', tenantListOpts);
  const usersQuery = useResourceList<UserDirectoryRow>(
    'user_directory',
    tenantListOpts ? { ...tenantListOpts, page_size: 200 } : { page_size: 200 },
    { enabled: canWrite && canReadUsers },
  );
  const branchSummaries = useMemo<BranchSummaryRow[]>(
    () => branchSummaryQuery.data?.rows ?? [],
    [branchSummaryQuery.data?.rows],
  );
  const summaryByBranch = useMemo(() => {
    const map = new Map<string, BranchSummaryRow>();
    for (const s of branchSummaries) {
      if (s.branch_id) map.set(s.branch_id, s);
    }
    return map;
  }, [branchSummaries]);
  /** Returns the projected summary row for a branch, or an empty shell so
   *  consumers always have a defined object to read from. */
  function summaryFor(branch: BranchRow): BranchSummaryRow {
    const projected = summaryByBranch.get(branch.id);
    const initialCapacity = initialBranchCapacityPerDay(branch);
    const projectedCapacity = numberValue(projected?.capacity_per_day);
    const capacityPerDay =
      projectedCapacity && projectedCapacity > 0
        ? projectedCapacity
        : initialCapacity ?? projectedCapacity ?? 0;
    return {
      ...(projected ?? {
        branch_id: branch.id,
        booked_today: 0,
        active_vehicles: 0,
        active_routes: 0,
        manager_user_id: null,
        cutoff_time: null,
      }),
      branch_id: projected?.branch_id ?? branch.id,
      capacity_per_day: capacityPerDay,
    };
  }
  const links = useMemo<BranchZoneLink[]>(
    () => linksQuery.data?.rows ?? [],
    [linksQuery.data?.rows],
  );
  const members = useMemo<BranchMember[]>(
    () => membersQuery.data?.rows ?? [],
    [membersQuery.data?.rows],
  );
  const capacity = useMemo<BranchCapacityRow[]>(
    () => capacityQuery.data?.rows ?? [],
    [capacityQuery.data?.rows],
  );
  const coverage = useMemo<BranchCoverageRow[]>(
    () => coverageQuery.data?.rows ?? [],
    [coverageQuery.data?.rows],
  );
  const zones = useMemo<ZoneRow[]>(
    () => zonesQuery.data?.rows ?? [],
    [zonesQuery.data?.rows],
  );
  const runs = useMemo<RouteRunRow[]>(
    () => runsQuery.data?.rows ?? [],
    [runsQuery.data?.rows],
  );
  const userRows = useMemo<UserDirectoryRow[]>(
    () => usersQuery.data?.rows ?? [],
    [usersQuery.data?.rows],
  );
  const userById = useMemo(() => {
    const map = new Map<string, UserDirectoryRow>();
    for (const row of userRows) {
      const id = userDirectoryIdOf(row);
      if (id) map.set(id, row);
    }
    return map;
  }, [userRows]);
  const selectableUsers = useMemo(
    () => userRows.filter((row) => userDirectoryIsSelectable(row)),
    [userRows],
  );
  const branchTypeOptions = getLookups('branch_type');
  const branchStatusOptions = getLookups('branch_status');
  const branchMemberRoleOptions = getLookups('branch_member_role');

  // ----- Indexes (memoized so card grid + drawer share work) -----

  const linksByBranch = useMemo(() => {
    const map = new Map<string, BranchZoneLink[]>();
    for (const l of links) {
      if (!map.has(l.branch_id)) map.set(l.branch_id, []);
      map.get(l.branch_id)!.push(l);
    }
    return map;
  }, [links]);

  const membersByBranch = useMemo(() => {
    const map = new Map<string, BranchMember[]>();
    for (const m of members) {
      if (!map.has(m.branch_id)) map.set(m.branch_id, []);
      map.get(m.branch_id)!.push(m);
    }
    return map;
  }, [members]);

  // route_runs in seed don't carry a `branch_id` column — derive from the
  // attached vehicle's current_branch_id so the surface still resolves until
  // the canonical column lands.
  const runsByBranch = useMemo(() => {
    const map = new Map<string, RouteRunRow[]>();
    for (const r of runs) {
      const explicit = (r.branch_id as string | undefined) ?? null;
      if (!explicit) continue;
      if (!map.has(explicit)) map.set(explicit, []);
      map.get(explicit)!.push(r);
    }
    return map;
  }, [runs]);

  const zoneById = useMemo(() => {
    const map = new Map<string, ZoneRow>();
    for (const z of zones) map.set(z.id, z);
    return map;
  }, [zones]);

  const capacityByBranch = useMemo(() => {
    const map = new Map<string, BranchCapacityRow[]>();
    for (const r of capacity) {
      if (!map.has(r.branch_id)) map.set(r.branch_id, []);
      map.get(r.branch_id)!.push(r);
    }
    return map;
  }, [capacity]);

  const coverageByBranch = useMemo(() => {
    const map = new Map<string, BranchCoverageRow[]>();
    for (const r of coverage) {
      if (!map.has(r.branch_id)) map.set(r.branch_id, []);
      map.get(r.branch_id)!.push(r);
    }
    return map;
  }, [coverage]);

  // ----- KPI tiles -----

  const totalBranches = visibleBranches.length;
  // W20 — KPI counters resolve through canonical `branch_type` shadow first
  // (FE alias `type` remains a back-compat fallback inside `branchTypeOf`).
  //
  // E2 closure (P1 #4) — KPI bucket membership derives from canonical
  // `branch_type.metadata.kpi_card_key` so adding a new branch_type (e.g.
  // 'pickup_locker') auto-routes to its KPI tile via metadata. Replaces the
  // literal `=== 'hub' / 'depot' / 'dropoff_point'` filters.
  function countByKpiKey(kpiKey: string): number {
    return visibleBranches.filter((b) => {
      const typeKey = branchTypeOf(b);
      const meta = lookupRow('branch_type', typeKey)?.metadata as { kpi_card_key?: string } | undefined;
      return meta?.kpi_card_key === kpiKey;
    }).length;
  }
  const hubsCount = countByKpiKey('hubs');
  const depotsCount = countByKpiKey('depots');
  const dropoffsCount = countByKpiKey('dropoffs');
  // Capacity utilization reads both capacity_per_day and booked_today from
  // the v_branch_summary projection. Missing/zero capacity returns null so
  // the KPI displays "—" rather than implying a denominator.
  const utilization = useMemo(() => {
    let cap = 0;
    let used = 0;
    for (const b of visibleBranches) {
      const s = summaryFor(b);
      cap += Number(s?.capacity_per_day) || 0;
      used += Number(s?.booked_today) || 0;
    }
    if (!cap) return null;
    return Math.round((used / cap) * 100);
  }, [visibleBranches, summaryByBranch]);
  // W27 Cycle D Network closure (P1 #5): tone resolves through the
  // canonical `branch_capacity_policy` settings ladder. Missing policy →
  // neutral tone (no silent FE-literal masking).
  const utilizationTone: 'good' | 'warn' | 'danger' | 'neutral' = (() => {
    if (utilization == null) return 'neutral';
    const dangerMin = branchCapacityThresholds?.utilization_danger_min;
    const warnMin = branchCapacityThresholds?.utilization_warn_min;
    if (dangerMin == null || warnMin == null) return 'neutral';
    if (utilization >= dangerMin) return 'danger';
    if (utilization >= warnMin) return 'warn';
    return 'good';
  })();

  const isLoading =
    branchesQuery.isLoading ||
    linksQuery.isLoading ||
    membersQuery.isLoading ||
    capacityQuery.isLoading ||
    coverageQuery.isLoading ||
    branchSummaryQuery.isLoading ||
    zonesQuery.isLoading ||
    runsQuery.isLoading;
  const isError =
    branchesQuery.isError ||
    linksQuery.isError ||
    membersQuery.isError ||
    capacityQuery.isError ||
    coverageQuery.isError ||
    branchSummaryQuery.isError ||
    zonesQuery.isError ||
    runsQuery.isError;
  const readError =
    branchesQuery.error ??
    linksQuery.error ??
    membersQuery.error ??
    capacityQuery.error ??
    coverageQuery.error ??
    branchSummaryQuery.error ??
    zonesQuery.error ??
    runsQuery.error;

  function defaultBranchStatus(): string {
    return branchStatusOptions.find((row) => row.is_default)?.value ?? '';
  }

  function branchStatusActiveFlag(status: string): boolean | undefined {
    const activeFlag = lookupRow('branch_status', status)?.metadata?.['is_active_branch_status'];
    return typeof activeFlag === 'boolean' ? activeFlag : undefined;
  }

  function branchMemberRoleLabel(roleKey: string): string {
    return lookupRow('branch_member_role', roleKey)?.label ?? roleKey;
  }

  function branchMemberDisplayLabel(member: BranchMember, index: number): string {
    return userDirectoryLabelOf(userById.get(member.user_id), t) || fill(t('branches.staff.memberN'), { n: index + 1 });
  }

  function openCreateBranchForm() {
    function NewBranchForm() {
      const [draft, setDraft] = useState({
        name: '',
        code: '',
        branch_type: '',
        city: '',
        address: '',
        latitude: '',
        longitude: '',
        capacity_per_day: '',
        cutoff_time: '',
        status: defaultBranchStatus(),
      });

      async function submit(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        const name = draft.name.trim();
        const branchType = draft.branch_type.trim();
        const status = draft.status.trim();
        if (!name) {
          pushToast(t('branches.create.nameRequired'), 'warn');
          return;
        }
        if (!branchType) {
          pushToast(t('branches.create.typeRequired'), 'warn');
          return;
        }
        if (!status) {
          pushToast(t('branches.create.statusRequired'), 'warn');
          return;
        }

        const payload: Record<string, unknown> & { name: string } = {
          name,
          branch_type: branchType,
          timezone: tenantTimezoneIana,
        };
        if (tenantId) payload.organization_id = tenantId;
        const code = draft.code.trim();
        if (code) payload.code = code;

        const address: Record<string, unknown> = {};
        const city = draft.city.trim();
        const addressLine = draft.address.trim();
        if (city) address.city = city;
        if (addressLine) address.formatted = addressLine;
        if (Object.keys(address).length > 0) payload.address = address;

        const coordinatesResult = parseCoordinateDraft(draft.latitude, draft.longitude, t);
        if (!coordinatesResult.ok) {
          pushToast(coordinatesResult.message, 'warn');
          return;
        }
        if (coordinatesResult.coordinates) payload.coordinates = coordinatesResult.coordinates;

        const operatingHours: Record<string, unknown> = {};
        const cutoff = draft.cutoff_time.trim();
        if (cutoff) operatingHours.cutoff_time_local = cutoff;
        if (Object.keys(operatingHours).length > 0) payload.operating_hours = operatingHours;

        const metadata: Record<string, unknown> = { lifecycle: status };
        const capacityText = draft.capacity_per_day.trim();
        if (capacityText) {
          const capacity = Number(capacityText);
          if (!Number.isFinite(capacity) || capacity < 0) {
            pushToast(t('branches.create.capacityInvalid'), 'warn');
            return;
          }
          metadata.initial_capacity_per_day = capacity;
        }
        const isActive = branchStatusActiveFlag(status);
        if (typeof isActive === 'boolean') payload.is_active = isActive;
        payload.metadata = metadata;

        try {
          const res = await createBranchMut.mutateAsync(payload);
          const id = (res as { branch_id?: string }).branch_id ?? '';
          modal.close();
          pushToast(id ? fill(t('branches.create.createdWithId'), { name, id }) : fill(t('branches.create.created'), { name }), 'good');
          if (id) {
            go(`/network/branches?focus=${encodeURIComponent(id)}`);
          }
        } catch {
          pushToast(t('branches.create.failed'), 'danger');
        }
      }

      return (
        <form onSubmit={submit}>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: '140px 1fr',
              gap: '8px',
              alignItems: 'center',
              padding: '0 4px',
            }}
          >
            <label className="mono" htmlFor="new-branch-name">{t('branches.field.name')}</label>
            <input
              id="new-branch-name"
              className="dt-inline-input"
              value={draft.name}
              onChange={(e) => setDraft((s) => ({ ...s, name: e.target.value }))}
              autoFocus
            />
            <label className="mono" htmlFor="new-branch-code">{t('branches.field.code')}</label>
            <input
              id="new-branch-code"
              className="dt-inline-input"
              value={draft.code}
              onChange={(e) => setDraft((s) => ({ ...s, code: e.target.value }))}
            />
            <label className="mono" htmlFor="new-branch-type">{t('branches.field.type')}</label>
            {branchTypeOptions.length > 0 ? (
              <select
                id="new-branch-type"
                className="dt-inline-input"
                value={draft.branch_type}
                onChange={(e) => setDraft((s) => ({ ...s, branch_type: e.target.value }))}
              >
                <option value="">{t('branches.create.selectType')}</option>
                {branchTypeOptions.map((row) => (
                  <option key={row.value} value={row.value}>{row.label}</option>
                ))}
              </select>
            ) : (
              <input
                id="new-branch-type"
                className="dt-inline-input"
                value={draft.branch_type}
                onChange={(e) => setDraft((s) => ({ ...s, branch_type: e.target.value }))}
              />
            )}
            <label className="mono" htmlFor="new-branch-city">{t('branches.field.city')}</label>
            <input
              id="new-branch-city"
              className="dt-inline-input"
              value={draft.city}
              onChange={(e) => setDraft((s) => ({ ...s, city: e.target.value }))}
            />
            <label className="mono" htmlFor="new-branch-address">{t('branches.field.address')}</label>
            <input
              id="new-branch-address"
              className="dt-inline-input"
              value={draft.address}
              onChange={(e) => setDraft((s) => ({ ...s, address: e.target.value }))}
            />
            <label className="mono" htmlFor="new-branch-latitude">{t('branches.field.latitude')}</label>
            <input
              id="new-branch-latitude"
              className="dt-inline-input"
              type="number"
              step="any"
              min="-90"
              max="90"
              value={draft.latitude}
              onChange={(e) => setDraft((s) => ({ ...s, latitude: e.target.value }))}
            />
            <label className="mono" htmlFor="new-branch-longitude">{t('branches.field.longitude')}</label>
            <input
              id="new-branch-longitude"
              className="dt-inline-input"
              type="number"
              step="any"
              min="-180"
              max="180"
              value={draft.longitude}
              onChange={(e) => setDraft((s) => ({ ...s, longitude: e.target.value }))}
            />
            <label className="mono" htmlFor="new-branch-capacity">{t('branches.field.dailyCapacity')}</label>
            <input
              id="new-branch-capacity"
              className="dt-inline-input"
              type="number"
              min="0"
              value={draft.capacity_per_day}
              onChange={(e) => setDraft((s) => ({ ...s, capacity_per_day: e.target.value }))}
            />
            <label className="mono" htmlFor="new-branch-cutoff">{t('branches.field.cutoffTime')}</label>
            <input
              id="new-branch-cutoff"
              className="dt-inline-input"
              type="time"
              value={draft.cutoff_time}
              onChange={(e) => setDraft((s) => ({ ...s, cutoff_time: e.target.value }))}
            />
            <label className="mono" htmlFor="new-branch-status">{t('branches.field.status')}</label>
            {branchStatusOptions.length > 0 ? (
              <select
                id="new-branch-status"
                className="dt-inline-input"
                value={draft.status}
                onChange={(e) => setDraft((s) => ({ ...s, status: e.target.value }))}
              >
                <option value="">{t('branches.create.selectStatus')}</option>
                {branchStatusOptions.map((row) => (
                  <option key={row.value} value={row.value}>{row.label}</option>
                ))}
              </select>
            ) : (
              <input
                id="new-branch-status"
                className="dt-inline-input"
                value={draft.status}
                onChange={(e) => setDraft((s) => ({ ...s, status: e.target.value }))}
              />
            )}
          </div>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '14px' }}>
            <Button label={t('common.cancel')} kind="ghost" onClick={() => modal.close()} />
            <Button
              label={createBranchMut.isPending ? t('branches.create.creating') : t('branches.create.submit')}
              kind="primary"
              capability={CAP.BRANCHES_WRITE}
              disabled={createBranchMut.isPending}
              type="submit"
            />
          </div>
        </form>
      );
    }

    modal.open({ title: t('branches.create.title'), body: <NewBranchForm /> });
  }

  function openBranchCoordinatesForm(branch: BranchRow) {
    const current = branchCoordinatesOf(branch, summaryFor(branch));

    function BranchCoordinatesForm() {
      const [draft, setDraft] = useState({
        latitude: coordinateText(current?.lat ?? null),
        longitude: coordinateText(current?.lng ?? null),
      });

      async function submit(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        const coordinatesResult = parseCoordinateDraft(draft.latitude, draft.longitude, t);
        if (!coordinatesResult.ok) {
          pushToast(coordinatesResult.message, 'warn');
          return;
        }
        if (!coordinatesResult.coordinates) {
          pushToast(t('branches.coords.requiredForMap'), 'warn');
          return;
        }

        try {
          await updateBranchMut.mutateAsync({
            branch_id: branch.id,
            patch: { coordinates: coordinatesResult.coordinates },
          });
          const patchedBranch: BranchRow = {
            ...branch,
            coordinates: coordinatesResult.coordinates,
            lat: coordinatesResult.coordinates.lat,
            lng: coordinatesResult.coordinates.lng,
            latitude: coordinatesResult.coordinates.lat,
            longitude: coordinatesResult.coordinates.lng,
          };
          modal.close();
          openBranchDrawer(patchedBranch, 'profile');
          pushToast(fill(t('branches.coords.updated'), { name: branch.name }), 'good');
        } catch {
          pushToast(t('branches.coords.failed'), 'danger');
        }
      }

      return (
        <form onSubmit={submit}>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: '140px 1fr',
              gap: '8px',
              alignItems: 'center',
              padding: '0 4px',
            }}
          >
            <label className="mono" htmlFor="branch-coordinate-latitude">{t('branches.field.latitude')}</label>
            <input
              id="branch-coordinate-latitude"
              className="dt-inline-input"
              type="number"
              step="any"
              min="-90"
              max="90"
              value={draft.latitude}
              onChange={(e) => setDraft((s) => ({ ...s, latitude: e.target.value }))}
              autoFocus
            />
            <label className="mono" htmlFor="branch-coordinate-longitude">{t('branches.field.longitude')}</label>
            <input
              id="branch-coordinate-longitude"
              className="dt-inline-input"
              type="number"
              step="any"
              min="-180"
              max="180"
              value={draft.longitude}
              onChange={(e) => setDraft((s) => ({ ...s, longitude: e.target.value }))}
            />
          </div>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '14px' }}>
            <Button label={t('common.cancel')} kind="ghost" onClick={() => modal.close()} />
            <Button
              label={updateBranchMut.isPending ? t('branches.coords.saving') : t('branches.coords.save')}
              kind="primary"
              capability={CAP.BRANCHES_WRITE}
              disabled={updateBranchMut.isPending}
              type="submit"
            />
          </div>
        </form>
      );
    }

    modal.open({ title: fill(t('branches.coords.dialogTitle'), { name: branch.name }), body: <BranchCoordinatesForm /> });
  }

  function openAddStaffForm(branch: BranchRow) {
    function AddStaffForm() {
      const [draft, setDraft] = useState({ user_id: '', role_key: '' });

      async function submit(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        if (selectableUsers.length === 0) {
          pushToast(t('branches.addStaff.directoryRequired'), 'warn');
          return;
        }
        const userId = draft.user_id.trim();
        const roleKey = draft.role_key.trim();
        if (!userId) {
          pushToast(t('branches.addStaff.userRequired'), 'warn');
          return;
        }
        if (!roleKey) {
          pushToast(t('branches.addStaff.roleRequired'), 'warn');
          return;
        }
        try {
          await addMemberMut.mutateAsync({
            branch_id: branch.id,
            user_id: userId,
            role_key: roleKey,
          });
          modal.close();
          pushToast(fill(t('branches.addStaff.added'), { name: branch.name }), 'good');
        } catch {
          pushToast(t('branches.addStaff.failed'), 'danger');
        }
      }

      return (
        <form onSubmit={submit}>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: '140px 1fr',
              gap: '8px',
              alignItems: 'center',
              padding: '0 4px',
            }}
          >
            <label className="mono" htmlFor="add-branch-staff-user">{t('branches.field.user')}</label>
            {selectableUsers.length > 0 ? (
              <select
                id="add-branch-staff-user"
                className="dt-inline-input"
                value={draft.user_id}
                onChange={(e) => setDraft((s) => ({ ...s, user_id: e.target.value }))}
              >
                <option value="">{t('branches.addStaff.selectUser')}</option>
                {selectableUsers.map((row) => {
                  const id = userDirectoryIdOf(row);
                  return (
                    <option key={id} value={id}>{userDirectoryLabelOf(row, t)}</option>
                  );
                })}
              </select>
            ) : (
              <select
                id="add-branch-staff-user"
                className="dt-inline-input"
                value=""
                disabled
              >
                <option value="">{t('branches.addStaff.directoryUnavailable')}</option>
              </select>
            )}
            <label className="mono" htmlFor="add-branch-staff-role">{t('branches.field.role')}</label>
            {branchMemberRoleOptions.length > 0 ? (
              <select
                id="add-branch-staff-role"
                className="dt-inline-input"
                value={draft.role_key}
                onChange={(e) => setDraft((s) => ({ ...s, role_key: e.target.value }))}
              >
                <option value="">{t('branches.addStaff.selectRole')}</option>
                {branchMemberRoleOptions.map((row) => (
                  <option key={row.value} value={row.value}>{row.label}</option>
                ))}
              </select>
            ) : (
              <input
                id="add-branch-staff-role"
                className="dt-inline-input"
                value={draft.role_key}
                onChange={(e) => setDraft((s) => ({ ...s, role_key: e.target.value }))}
              />
            )}
          </div>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '14px' }}>
            <Button label={t('common.cancel')} kind="ghost" onClick={() => modal.close()} />
            <Button
              label={addMemberMut.isPending ? t('branches.addStaff.adding') : t('branches.addStaff.submit')}
              kind="primary"
              capability={CAP.BRANCHES_WRITE}
              disabled={addMemberMut.isPending || selectableUsers.length === 0}
              type="submit"
            />
          </div>
        </form>
      );
    }

    modal.open({ title: fill(t('branches.addStaff.dialogTitle'), { name: branch.name }), body: <AddStaffForm /> });
  }

  function openRemoveStaffForm(branch: BranchRow, staff: BranchMember[]) {
    const activeStaff = staff.filter((member) => member.is_active !== false);
    if (activeStaff.length === 0) {
      pushToast(t('branches.removeStaff.noneActive'), 'info');
      return;
    }

    function RemoveStaffForm() {
      const [membershipId, setMembershipId] = useState('');
      const selected = activeStaff.find((member) => member.id === membershipId);

      async function submit(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        if (!selected) {
          pushToast(t('branches.removeStaff.selectRequired'), 'warn');
          return;
        }
        try {
          await removeMemberMut.mutateAsync({ membership_id: selected.id });
          modal.close();
          pushToast(t('branches.removeStaff.removed'), 'warn');
        } catch {
          pushToast(t('branches.removeStaff.failed'), 'danger');
        }
      }

      return (
        <form onSubmit={submit}>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: '140px 1fr',
              gap: '8px',
              alignItems: 'center',
              padding: '0 4px',
            }}
          >
            <label className="mono" htmlFor="remove-branch-staff-membership">{t('branches.field.staff')}</label>
            <select
              id="remove-branch-staff-membership"
              className="dt-inline-input"
              value={membershipId}
              onChange={(e) => setMembershipId(e.target.value)}
            >
              <option value="">{t('branches.removeStaff.selectStaff')}</option>
              {activeStaff.map((member, index) => {
                const userLabel = branchMemberDisplayLabel(member, index);
                const roleLabel = branchMemberRoleLabel(memberRoleOf(member));
                return (
                  <option key={member.id} value={member.id}>
                    {userLabel} - {roleLabel}
                  </option>
                );
              })}
            </select>
          </div>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '14px' }}>
            <Button label={t('common.cancel')} kind="ghost" onClick={() => modal.close()} />
            <Button
              label={removeMemberMut.isPending ? t('branches.removeStaff.removing') : t('branches.removeStaff.submit')}
              kind="danger"
              capability={CAP.BRANCHES_WRITE}
              disabled={removeMemberMut.isPending}
              type="submit"
            />
          </div>
        </form>
      );
    }

    modal.open({ title: fill(t('branches.removeStaff.dialogTitle'), { name: branch.name }), body: <RemoveStaffForm /> });
  }

  function openMarkBranchOutOfServiceForm(branch: BranchRow) {
    if (!isActiveOf(branch)) {
      pushToast(fill(t('branches.oos.already'), { name: branch.name }), 'info');
      return;
    }

    function MarkBranchOutOfServiceForm() {
      const [reason, setReason] = useState(t('branches.oos.defaultReason'));

      async function submit(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        try {
          const res = await markOosMut.mutateAsync({
            branch_ids: [branch.id],
            reason: 'branch_profile_oos',
            metadata: {
              operator_reason: reason.trim() || t('branches.oos.defaultReason'),
              source: 'console_v2_branch_profile',
            },
          });
          modal.close();
          pushToast(
            fill(t('branches.oos.marked'), { n: (res as { affected?: number }).affected ?? 1 }),
            'warn',
          );
        } catch {
          pushToast(t('branches.oos.failed'), 'danger');
        }
      }

      return (
        <form onSubmit={submit}>
          <div style={{ display: 'grid', gap: '10px', padding: '0 4px' }}>
            <p style={{ margin: 0, color: 'var(--ink-2)' }}>
              {t('branches.oos.bodyBefore')} <bdi>{branch.name}</bdi> {t('branches.oos.bodyAfter')}
            </p>
            <label className="mono" htmlFor="mark-branch-oos-reason">{t('branches.field.reason')}</label>
            <input
              id="mark-branch-oos-reason"
              className="dt-inline-input"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          </div>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '14px' }}>
            <Button label={t('common.cancel')} kind="ghost" onClick={() => modal.close()} />
            <Button
              label={markOosMut.isPending ? t('branches.oos.marking') : t('branches.oos.confirm')}
              kind="danger"
              capability={CAP.BRANCHES_WRITE}
              disabled={markOosMut.isPending}
              type="submit"
            />
          </div>
        </form>
      );
    }

    modal.open({
      title: fill(t('branches.oos.dialogTitle'), { name: branch.name }),
      body: <MarkBranchOutOfServiceForm />,
    });
  }

  function openCoverageWindowForm(branch: BranchRow) {
    const coverageRowsForBranch = coverageByBranch.get(branch.id) ?? [];
    const linkedZoneIds = new Set((linksByBranch.get(branch.id) ?? []).map((link) => link.zone_id));
    const zoneOptions = zones.filter((zone) => linkedZoneIds.size === 0 || linkedZoneIds.has(zone.id));
    const fallbackZoneId = zoneOptions[0]?.id ?? coverageRowsForBranch[0]?.zone_id ?? '';

    function toDateTimeLocal(value?: string | null): string {
      if (!value) return '';
      const date = new Date(value);
      if (Number.isNaN(date.getTime())) return '';
      return new Date(date.getTime() - date.getTimezoneOffset() * 60_000)
        .toISOString()
        .slice(0, 16);
    }

    function zoneLabel(zoneId?: string | null): string {
      if (!zoneId) return t('branches.window.selectZone');
      return zoneById.get(zoneId)?.name ?? zoneId;
    }

    function CoverageWindowForm() {
      const nowLocal = new Date(Date.now() - new Date().getTimezoneOffset() * 60_000)
        .toISOString()
        .slice(0, 16);
      const [draft, setDraft] = useState({
        coverage_window_id: coverageRowsForBranch[0]?.id ?? 'new',
        zone_id: coverageRowsForBranch[0]?.zone_id ?? fallbackZoneId,
        effective_from: coverageRowsForBranch[0] ? toDateTimeLocal(openAtOf(coverageRowsForBranch[0])) : nowLocal,
        effective_to: coverageRowsForBranch[0] ? toDateTimeLocal(closeAtOf(coverageRowsForBranch[0])) : '',
        priority: String(coverageRowsForBranch[0]?.priority ?? 0),
        reason: coverageRowsForBranch[0]?.reason ?? t('branches.window.manualUpdate'),
      });

      async function submit(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        const isUpdate = draft.coverage_window_id !== 'new';
        const zoneId = draft.zone_id.trim();
        if (!draft.effective_from) {
          pushToast(t('branches.window.startRequired'), 'warn');
          return;
        }
        if (!isUpdate && !zoneId) {
          pushToast(t('branches.window.zoneRequired'), 'warn');
          return;
        }
        const priority = Number(draft.priority);
        try {
          await upsertCoverageMut.mutateAsync({
            branch_id: branch.id,
            coverage_window_id: isUpdate ? draft.coverage_window_id : undefined,
            zone_id: zoneId || undefined,
            effective_from: new Date(draft.effective_from).toISOString(),
            effective_to: draft.effective_to ? new Date(draft.effective_to).toISOString() : undefined,
            priority: Number.isFinite(priority) ? priority : 0,
            reason: draft.reason.trim() || t('branches.window.manualUpdate'),
            metadata: {
              source: 'console_v2_branch_coverage_form',
            },
          });
          modal.close();
          pushToast(fill(t('branches.window.updated'), { name: branch.name }), 'good');
        } catch {
          pushToast(t('branches.window.failed'), 'danger');
        }
      }

      return (
        <form onSubmit={submit}>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: '140px 1fr',
              gap: '8px',
              alignItems: 'center',
              padding: '0 4px',
            }}
          >
            <label className="mono" htmlFor="coverage-window-id">{t('branches.window.field')}</label>
            <select
              id="coverage-window-id"
              className="dt-inline-input"
              value={draft.coverage_window_id}
              onChange={(e) => {
                const nextId = e.target.value;
                const selectedWindow = coverageRowsForBranch.find((row) => row.id === nextId);
                setDraft((s) => ({
                  ...s,
                  coverage_window_id: nextId,
                  zone_id: selectedWindow?.zone_id ?? (nextId === 'new' ? fallbackZoneId : s.zone_id),
                  effective_from: selectedWindow ? toDateTimeLocal(openAtOf(selectedWindow)) : nowLocal,
                  effective_to: selectedWindow ? toDateTimeLocal(closeAtOf(selectedWindow)) : '',
                  priority: String(selectedWindow?.priority ?? 0),
                  reason: selectedWindow?.reason ?? t('branches.window.manualUpdate'),
                }));
              }}
            >
              {coverageRowsForBranch.map((row) => (
                <option key={row.id} value={row.id}>
                  {zoneLabel(row.zone_id)} · {openAtOf(row) ? fmtDateTime(openAtOf(row)!) : t('branches.window.scheduled')}
                </option>
              ))}
              <option value="new">{t('branches.window.newWindow')}</option>
            </select>
            <label className="mono" htmlFor="coverage-window-zone">{t('branches.field.zone')}</label>
            <select
              id="coverage-window-zone"
              className="dt-inline-input"
              value={draft.zone_id}
              onChange={(e) => setDraft((s) => ({ ...s, zone_id: e.target.value }))}
            >
              <option value="">{t('branches.window.selectZone')}</option>
              {zoneOptions.map((zone) => (
                <option key={zone.id} value={zone.id}>{zone.name}</option>
              ))}
              {draft.zone_id && !zoneOptions.some((zone) => zone.id === draft.zone_id) ? (
                <option value={draft.zone_id}>{zoneLabel(draft.zone_id)}</option>
              ) : null}
            </select>
            <label className="mono" htmlFor="coverage-window-start">{t('branches.field.starts')}</label>
            <input
              id="coverage-window-start"
              className="dt-inline-input"
              type="datetime-local"
              value={draft.effective_from}
              onChange={(e) => setDraft((s) => ({ ...s, effective_from: e.target.value }))}
            />
            <label className="mono" htmlFor="coverage-window-end">{t('branches.field.ends')}</label>
            <input
              id="coverage-window-end"
              className="dt-inline-input"
              type="datetime-local"
              value={draft.effective_to}
              onChange={(e) => setDraft((s) => ({ ...s, effective_to: e.target.value }))}
            />
            <label className="mono" htmlFor="coverage-window-priority">{t('branches.field.priority')}</label>
            <input
              id="coverage-window-priority"
              className="dt-inline-input"
              type="number"
              min={0}
              value={draft.priority}
              onChange={(e) => setDraft((s) => ({ ...s, priority: e.target.value }))}
            />
            <label className="mono" htmlFor="coverage-window-reason">{t('branches.field.reason')}</label>
            <input
              id="coverage-window-reason"
              className="dt-inline-input"
              value={draft.reason}
              onChange={(e) => setDraft((s) => ({ ...s, reason: e.target.value }))}
            />
          </div>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '14px' }}>
            <Button label={t('common.cancel')} kind="ghost" onClick={() => modal.close()} />
            <Button
              label={upsertCoverageMut.isPending ? t('branches.window.saving') : t('branches.window.save')}
              kind="primary"
              capability={CAP.BRANCHES_WRITE}
              disabled={upsertCoverageMut.isPending}
              type="submit"
            />
          </div>
        </form>
      );
    }

    modal.open({ title: fill(t('branches.window.dialogTitle'), { name: branch.name }), body: <CoverageWindowForm /> });
  }

  // ---------- Drawer logic ----------

  function closeBranchDrawer() {
    activeDrawerRef.current = null;
    setSelectedId(null);
  }

  function openBranchDrawer(branch: BranchRow, tab: DrawerTabKey = 'profile') {
    const nextDrawer = { branchId: branch.id, tab };
    activeDrawerRef.current = nextDrawer;
    setSelectedId(branch.id);
    drawer.open({
      title: fill(t('branches.drawer.title'), { name: branch.name }),
      size: 'lg',
        deepLink: `/network/branches?focus=${encodeURIComponent(branch.id)}`,
      body: renderDrawerBody(branch, tab),
      onClose: closeBranchDrawer,
    });
  }

  // Tabs swap by re-opening the drawer with the new tab key. Because
  // `drawer.open(...)` rebuilds the body each call, this stays consistent
  // with the imperative overlay model used across the app.
  function switchTab(branch: BranchRow, next: DrawerTabKey) {
    const nextDrawer = { branchId: branch.id, tab: next };
    activeDrawerRef.current = nextDrawer;
    drawer.open({
      title: fill(t('branches.drawer.title'), { name: branch.name }),
      size: 'lg',
        deepLink: `/network/branches?focus=${encodeURIComponent(branch.id)}`,
      body: renderDrawerBody(branch, next),
      onClose: closeBranchDrawer,
    });
  }

  useEffect(() => {
    if (!focusParam) {
      openedFocusRef.current = null;
      return undefined;
    }
    if (openedFocusRef.current === focusParam) return undefined;
    if (!focusTarget) return undefined;
    const timer = window.setTimeout(() => {
      openBranchDrawer(focusTarget);
      openedFocusRef.current = focusParam;
    }, 100);
    return () => window.clearTimeout(timer);
    // openBranchDrawer closes over current resource indexes; focus target is the trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusParam, focusTarget]);

  useEffect(() => {
    const currentDrawer = activeDrawerRef.current;
    if (!currentDrawer || !drawer.isOpen) return;
    const branch = visibleBranches.find((row) => row.id === currentDrawer.branchId);
    if (!branch) return;
    drawer.open({
      title: fill(t('branches.drawer.title'), { name: branch.name }),
      size: 'lg',
      deepLink: `/network/branches?focus=${encodeURIComponent(branch.id)}`,
      body: renderDrawerBody(branch, currentDrawer.tab),
      onClose: closeBranchDrawer,
    });
    // The imperative drawer stores a rendered body. Rebuild it when the
    // resource indexes feeding the open branch change so post-mutation
    // backend readback is visible without forcing the operator to close it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    linksByBranch,
    membersByBranch,
    capacityByBranch,
    coverageByBranch,
    zoneById,
    summaryByBranch,
    branchZoneBandFallbackMin,
  ]);

  function renderDrawerBody(branch: BranchRow, tab: DrawerTabKey): ReactNode {
    return (
      <div>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '6px',
            margin: '0 14px 8px',
            flexWrap: 'wrap',
          }}
        >
          <ScopePill scopeType="tenant" scopeId={tenantId} />
          <CanonicalChip
            category="branch_type"
            value={branchTypeOf(branch)}
            className="mono"
          />
          <CanonicalChip
            category="branch_status"
            value={branchStatusOf(branch)}
          />
          {summaryFor(branch).cutoff_time ? (
            <Chip
              label={fill(t('branches.drawer.cutoff'), { time: String(summaryFor(branch).cutoff_time) })}
              kind="info"
              size="xs"
              className="mono"
            />
          ) : null}
        </div>

        {/* Tab strip — same pattern as geocoding.tsx for parity. */}
        <div
          className="tabs"
          role="tablist"
          aria-label={t('branches.drawer.tabsLabel')}
          style={{ margin: '0 14px 6px' }}
        >
          {DRAWER_TABS.map((tabDef) => (
            <button
              key={tabDef.key}
              type="button"
              role="tab"
              aria-selected={tab === tabDef.key}
              className={`tabs__tab ${tab === tabDef.key ? 'is-active' : ''}`}
              onClick={() => switchTab(branch, tabDef.key)}
            >
              {t(tabDef.labelKey)}
            </button>
          ))}
        </div>

        <div style={{ padding: '0 14px 12px' }}>
          {tab === 'profile' ? renderProfileTab(branch) : null}
          {tab === 'coverage' ? renderCoverageTab(branch) : null}
          {tab === 'capacity' ? renderCapacityTab(branch) : null}
          {tab === 'zones' ? renderZonesTab(branch) : null}
          {tab === 'staff' ? renderStaffTab(branch) : null}
          {tab === 'vehicles' ? renderVehiclesTab(branch) : null}
          {tab === 'routes' ? renderRoutesTab(branch) : null}
        </div>
      </div>
    );
  }

  // -- Tab 1: Profile (KvGrid)
  function renderProfileTab(branch: BranchRow): ReactNode {
    const linked = linksByBranch.get(branch.id) ?? [];
    const staff = membersByBranch.get(branch.id) ?? [];
    const summary = summaryFor(branch);
    const coordinates = branchCoordinatesOf(branch, summary);
    // W20 — KvGrid rows resolve canonical column shadows first, then fall
    // back to FE aliases. The 'code' / 'branch_type' / 'is_active' keys
    // mirror canonical column names; the legacy 'slug' / 'type' / 'status'
    // keys remain in the row interface for back-compat but are not
    // surfaced as separate KvGrid rows (they would be redundant).
    const rows: KvRow[] = [
      { key: 'name', label: t('branches.field.name'), value: branch.name },
      { key: 'code', label: t('branches.field.code'), value: slugOf(branch) || '—', mono: true },
      {
        key: 'branch_type',
        label: t('branches.field.type'),
        value: branchTypeOf(branch),
        lookup: 'branch_type',
        capability: CAP.BRANCHES_WRITE,
      },
      { key: 'address', label: t('branches.field.address'), value: branchAddressTextOf(branch) || '—' },
      { key: 'city', label: t('branches.field.city'), value: branchCityTextOf(branch) || '—' },
      { key: 'latitude', label: t('branches.field.latitude'), value: coordinates?.lat ?? '-', mono: true, editable: false },
      { key: 'longitude', label: t('branches.field.longitude'), value: coordinates?.lng ?? '-', mono: true, editable: false },
      // Cutoff time and capacity_per_day come from v_branch_summary (W11-2);
      // both are read-only here. Capacity is mutated via the Capacity tab
      // (canonical RPC: branch_capacity_window_set_v1).
      { key: 'cutoff_time', label: t('branches.field.cutoffTime'), value: summary.cutoff_time ?? '—', mono: true },
      {
        key: 'capacity_per_day',
        label: t('branches.field.capacityPerDay'),
        value: summary.capacity_per_day != null ? fmtNumber(Number(summary.capacity_per_day)) : '—',
        mono: true,
      },
      {
        key: 'status',
        label: t('branches.field.status'),
        value: branchStatusOf(branch),
        lookup: 'branch_status',
        capability: CAP.BRANCHES_WRITE,
      },
      {
        key: 'updated_at',
        label: t('branches.field.updated'),
        value: branch.updated_at ? fmtDateTime(branch.updated_at) : '—',
      },
    ];
    return (
      <div>
        <div className="section-eyebrow" style={{ padding: '0 0 6px' }}>
          {t('branches.profile.posture')}
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-start', gap: '8px', padding: '0 14px 8px' }}>
          <Button
            label={isActiveOf(branch) ? t('branches.oos.action') : t('branches.oos.alreadyAction')}
            iconName="alert"
            kind="ghost"
            capability={CAP.BRANCHES_WRITE}
            disabled={!isActiveOf(branch) || markOosMut.isPending}
            onClick={() => openMarkBranchOutOfServiceForm(branch)}
          />
          <Button
            label={t('branches.coords.edit')}
            iconName="pin"
            kind="ghost"
            capability={CAP.BRANCHES_WRITE}
            disabled={updateBranchMut.isPending}
            onClick={() => openBranchCoordinatesForm(branch)}
          />
        </div>
        <KvGrid
          rows={rows}
          onEdit={async (key, nextValue) => {
            // Wires Profile-tab inline edits through canonical branch_update_v1.
            // The canonical RPC is pending; phaseC6Rpc keeps the envelope stable.
            try {
              await updateBranchMut.mutateAsync({
                branch_id: branch.id,
                patch: { [String(key)]: nextValue ?? null },
              });
              pushToast(fill(t('branches.profile.fieldUpdated'), { key: String(key), name: branch.name }), 'good');
            } catch {
              pushToast(fill(t('branches.profile.fieldFailed'), { key: String(key) }), 'danger');
            }
          }}
        />

        <div className="section-eyebrow">{t('branches.profile.snapshot')}</div>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: '120px 1fr',
            gap: '14px',
            alignItems: 'center',
            padding: '4px 14px 0',
          }}
        >
          <CapacityGauge
            used={Number(summary.booked_today) || 0}
            total={Number(summary.capacity_per_day) || 1}
            size="md"
            label={t('branches.profile.today')}
          />
          <div style={{ display: 'grid', gap: '4px' }}>
            <Chip
              label={fill(t('branches.profile.zonesServed'), { n: fmtNumber(linked.length) })}
              kind="info"
              size="xs"
            />
            <Chip
              label={fill(t('branches.profile.staffOnRoster'), { n: fmtNumber(staff.length) })}
              kind="neutral"
              size="xs"
            />
            <Chip
              label={fill(t('branches.card.vehiclesRoutes'), { vehicles: fmtNumber(summary.active_vehicles ?? 0), routes: fmtNumber(summary.active_routes ?? 0) })}
              kind="neutral"
              size="xs"
              className="mono"
            />
          </div>
        </div>

        <div className="section-eyebrow">{t('branches.profile.quickLinks')}</div>
        <div
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            gap: '6px',
            padding: '0 14px',
          }}
        >
          <Button
            label={t('branches.profile.routePlans')}
            iconName="layers"
            kind="ghost"
            onClick={() => {
              go(`/operate/route-plans?branch=${encodeURIComponent(
                branch.id,
              )}`);
            }}
          />
          <Button
            label={t('branches.profile.dispatch')}
            iconName="right"
            kind="ghost"
            onClick={() => {
              go(`/operate/dispatch?branch=${encodeURIComponent(branch.id)}`);
            }}
          />
          <Button
            label={t('branches.tabs.vehicles')}
            iconName="truck"
            kind="ghost"
            onClick={() => {
              go(`/operate/fleet/vehicles?branch=${encodeURIComponent(
                branch.id,
              )}`);
            }}
          />
        </div>
      </div>
    );
  }

  // -- Tab 2: Coverage windows (heatmap)
  function renderCoverageTab(branch: BranchRow): ReactNode {
    const cap = capacityByBranch.get(branch.id) ?? [];
    // W20 — surface canonical effective_from / effective_to coverage windows
    // through the resolver helpers below the heatmap. The coverage list is
    // intentionally compact (no DataTable) — operators primarily steer
    // through the heatmap.
    const coverageRows = coverageByBranch.get(branch.id) ?? [];
    const coverageEditAction = canWrite ? (
      <Button
        label={t('branches.window.edit')}
        kind="ghost"
        iconName="edit"
        capability={CAP.BRANCHES_WRITE}
        onClick={() => openCoverageWindowForm(branch)}
      />
    ) : (
      <CapabilityLock capability={CAP.BRANCHES_WRITE} />
    );
    if (cap.length === 0) {
      return (
        <div>
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              gap: '8px',
              padding: '0 0 8px',
            }}
          >
            <span className="section-eyebrow" style={{ padding: 0 }}>
              {fill(t('branches.coverage.windowsCount'), { n: fmtNumber(coverageRows.length) })}
            </span>
            {coverageEditAction}
          </div>
          <StateView
            kind="empty"
            hint={fill(t('branches.coverage.noWindowsHeatmap'), { name: branch.name })}
          />
        </div>
      );
    }
    // W18-3 — Build heatmap cells from the paired projection view
    // `v_branch_capacity_heatmap`. `capacity_units` is projected from
    // canonical `capacity` jsonb (max_stops fallback to max_units);
    // `booked_units` remains NULL until the live counter ships, so we
    // treat null/0 as "no live load" (intensity 0).
    const cells: HeatmapCell[] = cap.map((row) => {
      const denom = Number(row.capacity_units) || 1;
      const booked = Number(row.booked_units ?? 0) || 0;
      const intensity = Math.max(0, Math.min(1, booked / denom));
      return { dayIndex: row.weekday, hourIndex: row.hour, intensity };
    });
    return (
      <div>
        <div className="section-eyebrow" style={{ padding: '0 0 6px' }}>
          {t('branches.coverage.heatmapTitle')}
        </div>
        <p className="state__hint" style={{ margin: '0 0 6px' }}>
          {t('branches.coverage.heatmapHint')}
        </p>
        <CoverageHeatmap
          cells={cells}
          onCellClick={(d, h) => {
            const row = cap.find((c) => c.weekday === d && c.hour === h);
            if (!row) return;
            // W18-3 — booked_units may be null on the projection until the
            // live counter ships; render "—" instead of "null" in that case.
            const booked = row.booked_units == null ? '—' : String(row.booked_units);
            pushToast(
              `${branch.name} · ${weekdayLabel(d, t)} · ${String(h).padStart(2, '0')}:00 → ${booked}/${row.capacity_units}`,
              'info',
            );
          }}
        />
        <div
          style={{
            display: 'flex',
            justifyContent: 'flex-start',
            padding: '8px 0 0',
          }}
        >
          {coverageEditAction}
        </div>
        {coverageRows.length > 0 ? (
          <div style={{ paddingTop: '8px' }}>
            <div className="section-eyebrow" style={{ padding: '0 0 4px' }}>
              {fill(t('branches.coverage.windowsCount'), { n: fmtNumber(coverageRows.length) })}
            </div>
            <ul
              role="list"
              style={{
                margin: 0,
                padding: 0,
                listStyle: 'none',
                display: 'grid',
                gap: '4px',
                fontSize: '12px',
              }}
            >
              {coverageRows.map((row) => {
                // W20 — resolve canonical effective_from / effective_to first;
                // FE aliases open_at / close_at remain back-compat for legacy seeds.
                const from = openAtOf(row);
                const to = closeAtOf(row);
                return (
                  <li
                    key={row.id}
                    className="mono"
                    style={{
                      display: 'flex',
                      gap: '8px',
                      alignItems: 'center',
                      color: 'var(--ink-3)',
                    }}
                  >
                    <span>{from ? fmtDateTime(from) : '—'}</span>
                    <span>→</span>
                    <span>{to ? fmtDateTime(to) : t('branches.coverage.openEnded')}</span>
                    {row.reason ? (
                      <Chip label={coverageReasonLabel(row.reason, t)} kind="info" size="xs" />
                    ) : null}
                  </li>
                );
              })}
            </ul>
          </div>
        ) : null}
      </div>
    );
  }

  // -- Tab 3: Capacity windows (DataTable, inline edit on capacity_units)
  function renderCapacityTab(branch: BranchRow): ReactNode {
    const cap = capacityByBranch.get(branch.id) ?? [];
    const cols: Array<DataTableColumn<BranchCapacityRow>> = [
      { key: 'weekday', label: t('branches.capacity.day'), mono: true, sortable: true, type: 'number', align: 'right' },
      { key: 'hour', label: t('branches.capacity.hour'), mono: true, sortable: true, type: 'number', align: 'right' },
      {
        key: 'capacity_units',
        label: t('branches.tabs.capacity'),
        mono: true,
        sortable: true,
        type: 'number',
        align: 'right',
        editable: canWrite,
      },
      {
        key: 'booked_units',
        label: t('branches.capacity.booked'),
        mono: true,
        sortable: true,
        type: 'number',
        align: 'right',
      },
    ];
    if (cap.length === 0) {
      return (
        <StateView
          kind="empty"
          hint={fill(t('branches.capacity.noWindows'), { name: branch.name })}
        />
      );
    }
    return (
      <DataTable<BranchCapacityRow>
        columns={cols}
        rows={cap}
        viewKey={`branch_capacity_${branch.id}`}
        entityKind="capacity_window"
        onCellEdit={async (row, key, newValue, dryRun) => {
          // Inline-edit on `capacity_units`; canonical RPC is
          // `branch_capacity_window_set_v1` (capacity_window_id +
          // capacity_units convenience arg merges into capacity.max_units).
          // W18-3 — rows now come through `v_branch_capacity_heatmap`
          // (registry: branch_capacity_heatmap). Prefer the projected
          // `source_window_id` for the RPC target; fall back to `row.id`
          // for back-compat with seed shapes that pre-date the projection.
          // Audit ref: __audit__/CROSSWALK/NETWORK.md §1.1 row 4.
          if (key !== 'capacity_units') return { ok: false, error: 'unsupported_field' };
          if (dryRun) return { ok: true };
          try {
            const targetId = row.source_window_id ?? row.id;
            await setCapacityMut.mutateAsync({
              capacity_window_id: targetId,
              capacity_units: Number(newValue ?? row.capacity_units ?? 0),
            });
            pushToast(fill(t('branches.capacity.updated'), { id: String(targetId) }), 'good');
            return { ok: true };
          } catch (err) {
            pushToast(t('branches.capacity.failed'), 'danger');
            return { ok: false, error: (err as Error)?.message ?? 'capacity_edit_failed' };
          }
        }}
      />
    );
  }

  // -- Tab 4: Zones served
  function renderZonesTab(branch: BranchRow): ReactNode {
    const linked = linksByBranch.get(branch.id) ?? [];
    return (
      <div>
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            padding: '0 0 6px',
          }}
        >
          <span className="section-eyebrow" style={{ padding: 0 }}>
            {fill(t('branches.zones.served'), { n: fmtNumber(linked.length) })}
          </span>
          <Button
            label={t('branches.zones.assign')}
            iconName="plus"
            kind="ghost"
            capability={CAP.BRANCHES_WRITE}
            onClick={() => {
              if (!canWrite) return;
              const drawerContext = drawer; // capture before nested overlay
              // Use the imperative ReferencePicker-as-modal path: open another
              // modal inside the drawer body via a lightweight portal.
              // For demo simplicity we reuse Palette through ReferencePicker
              // mounted inline.
              openZonePicker(branch);
              void drawerContext; // silence unused in non-mutation path
            }}
          />
        </div>
        {linked.length === 0 ? (
          <StateView
            kind="empty"
            hint={t('branches.zones.empty')}
          />
        ) : (
          <div
            style={{
              display: 'flex',
              flexWrap: 'wrap',
              gap: '8px',
              padding: '4px 0',
            }}
          >
            {linked.map((l) => {
              const zone = zoneById.get(l.zone_id);
              const zoneLabel = zone?.name ?? l.zone_id;
              // W27 Cycle D Network closure (P1 #2): chip category
              // switched from non-canonical `branch_role` to canonical
              // `branch_zone_band` lookup (primary/secondary/fallback)
              // so the band tone resolves through the SSOT lookup ladder.
              // Threshold resolves from `branch_zone_band_priority_threshold`
              // settings policy via `branchZoneBandFallbackMin`.
              const band = priorityToBand(l.priority, branchZoneBandFallbackMin);
              return (
                <button
                  key={l.id}
                  type="button"
                  className="chip chip--neutral"
                  style={{
                    display: 'inline-flex',
                    gap: '4px',
                    alignItems: 'center',
                    cursor: 'pointer',
                  }}
                  onClick={() => {
                    drawer.close();
                    setTimeout(() => {
                      go(`/network/zones?focus=${encodeURIComponent(
                        l.zone_id,
                      )}`);
                    }, 0);
                  }}
                  title={fill(t('branches.zones.open'), { name: zoneLabel })}
                >
                  <span className="mono">{zoneLabel}</span>
                  <CanonicalChip
                    category="branch_zone_band"
                    value={band}
                    className="mono"
                  />
                </button>
              );
            })}
          </div>
        )}
      </div>
    );
  }

  // Zone picker stays controlled at the module root so it can mount above the
  // drawer (Radix Dialog's escape stack handles the layering).
  const [zonePickerFor, setZonePickerFor] = useState<BranchRow | null>(null);
  function openZonePicker(branch: BranchRow) {
    setZonePickerFor(branch);
  }

  // -- Tab 5: Staff (DataTable + Add staff)
  function renderStaffTab(branch: BranchRow): ReactNode {
    const staff = membersByBranch.get(branch.id) ?? [];
    const cols: Array<DataTableColumn<BranchMember>> = [
      // W17-2 — DataTable surfaces canonical `user_id` (was FE-fictional
      // `user_name`). Display-name resolution moves to a paired projection view.
      // W20 — Role / Joined columns resolve through canonical column shadows
      // first (`role_key` / `effective_from`), with FE-alias fallback inside
      // the resolver helpers. Column keys remain stable so view-saved sorts
      // / filters continue to address the FE alias key.
      {
        key: 'user_id',
        label: t('branches.staff.member'),
        sortable: true,
        filterable: true,
        render: (_raw, row) => branchMemberDisplayLabel(row, 0),
      },
      {
        key: 'role',
        label: t('branches.field.role'),
        sortable: true,
        filterable: true,
        lookup: 'branch_member_role',
        render: (_raw, row) => memberRoleOf(row) || '—',
      },
      {
        key: 'joined_at',
        label: t('branches.staff.joined'),
        format: 'datetime',
        sortable: true,
        render: (_raw, row) => {
          const v = memberJoinedAtOf(row);
          return v ? fmtDateTime(v) : '—';
        },
      },
      { key: 'is_active', label: t('branches.staff.active'), sortable: true, filterable: true },
    ];
    return (
      <div>
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            padding: '0 0 6px',
          }}
        >
          <span className="section-eyebrow" style={{ padding: 0 }}>
            {fill(t('branches.staff.count'), { n: fmtNumber(staff.length) })}
          </span>
          <div style={{ display: 'flex', gap: '6px' }}>
            <Button
              label={t('branches.addStaff.submit')}
              iconName="plus"
              kind="ghost"
              capability={CAP.BRANCHES_WRITE}
              onClick={() => openAddStaffForm(branch)}
            />
            <Button
              label={t('branches.removeStaff.submit')}
              iconName="trash"
              kind="ghost"
              capability={CAP.BRANCHES_WRITE}
              onClick={() => openRemoveStaffForm(branch, staff)}
            />
          </div>
        </div>
        {staff.length === 0 ? (
          <StateView
            kind="empty"
            hint={t('branches.staff.empty')}
          />
        ) : (
          <DataTable<BranchMember>
            columns={cols}
            rows={staff}
            viewKey={`branch_staff_${branch.id}`}
            entityKind="branch_member"
          />
        )}
      </div>
    );
  }

  // -- Tab 6: Active vehicles (read-only)
  function renderVehiclesTab(branch: BranchRow): ReactNode {
    return <BranchVehiclesTable branchId={branch.id} />;
  }

  // -- Tab 7: Active routes (read-only)
  function renderRoutesTab(branch: BranchRow): ReactNode {
    const list = runsByBranch.get(branch.id) ?? [];
    const cols: Array<DataTableColumn<RouteRunRow>> = [
      { key: 'run_id', label: t('branches.routes.run'), mono: true, sortable: true, filterable: true },
      { key: 'driver', label: t('branches.routes.driver'), sortable: true, filterable: true },
      { key: 'vehicle', label: t('branches.routes.vehicle'), mono: true, sortable: true, filterable: true },
      {
        key: 'status',
        label: t('branches.field.status'),
        sortable: true,
        filterable: true,
        lookup: 'route_run_status',
      },
      { key: 'stops', label: t('branches.routes.stops'), align: 'right', mono: true, sortable: true, type: 'number' },
      {
        key: 'completed',
        label: t('branches.routes.done'),
        align: 'right',
        mono: true,
        sortable: true,
        type: 'number',
      },
    ];
    if (list.length === 0) {
      return (
        <StateView
          kind="empty"
          hint={t('branches.routes.empty')}
        />
      );
    }
    return (
      <DataTable<RouteRunRow>
        columns={cols}
        rows={list}
        viewKey={`branch_routes_${branch.id}`}
        entityKind="route_run"
      />
    );
  }

  // ---------- Card grid render ----------

  if (!canRead) {
    return (
      <div className="page">
        <PageHeader
          moduleKey="branches"
          eyebrow={t('nav.network')}
          titleAccent={t('branches.title')}
          titlePlain={t('branches.titlePlain')}
        />
        <StateView
          kind="denied"
          capability={CAP.BRANCHES_READ}
          hint={t('branches.denied')}
        />
      </div>
    );
  }

  return (
    <div className="page">
      <PageHeader
        moduleKey="branches"
        eyebrow={t('nav.network')}
        titleAccent={t('branches.title')}
        titlePlain={t('branches.titlePlain')}
        pills={[
          <ScopePill key="scope" scopeType="tenant" scopeId={tenantId} />,
          <Chip
            key="src"
            label={t('branches.sourceChip')}
            kind="neutral"
            size="xs"
          />,
        ]}
        actions={[
          <Button
            key="new"
            label={t('branches.create.title')}
            iconName="plus"
            kind="primary"
            capability={CAP.BRANCHES_WRITE}
            onClick={openCreateBranchForm}
          />,
        ]}
      />

      {isError ? (
        <StateView
          kind="error"
          hint={(readError as Error | null)?.message ?? t('branches.loadError')}
        />
      ) : isLoading ? (
        <StateView kind="loading" hint={t('branches.loading')} />
      ) : (
        <>
          {/* E2 closure (P1 #3 / P1 #4) — KPI tones resolve from canonical
            `branch_type.metadata.kpi_card_tone` (semantic-categorical, not
            threshold-derived). Hubs=info because they are the primary
            topology nodes; Depots=neutral because they are transitional;
            Drop-offs=good because they expand reach. The "Branches" total
            tone remains 'info' (operator-domain semantic for "primary
            topology total"). Adding a new branch_type only requires
            extending the canonical lookup row metadata; no FE edit. */}
          <div className="kpi-strip">
            <KPICard
              label={t('branches.title')}
              value={fmtNumber(totalBranches)}
              delta={fill(t('branches.kpi.withCoverage'), { n: fmtNumber(coverageByBranch.size) })}
              tone="info"
            />
            <KPICard
              label={t('modules.hubs.accent')}
              value={fmtNumber(hubsCount)}
              delta={t('branches.kpi.hubsDelta')}
              tone={(lookupRow('branch_type', 'hub')?.metadata?.['kpi_card_tone'] as 'good' | 'warn' | 'danger' | 'info' | 'neutral' | undefined) ?? 'neutral'}
            />
            <KPICard
              label={t('branches.kpi.depots')}
              value={fmtNumber(depotsCount)}
              delta={t('branches.kpi.depotsDelta')}
              tone={(lookupRow('branch_type', 'depot')?.metadata?.['kpi_card_tone'] as 'good' | 'warn' | 'danger' | 'info' | 'neutral' | undefined) ?? 'neutral'}
            />
            <KPICard
              label={t('branches.kpi.dropoff')}
              value={fmtNumber(dropoffsCount)}
              delta={t('branches.kpi.dropoffDelta')}
              tone={(lookupRow('branch_type', 'dropoff_point')?.metadata?.['kpi_card_tone'] as 'good' | 'warn' | 'danger' | 'info' | 'neutral' | undefined) ?? 'neutral'}
            />
            <KPICard
              label={t('branches.kpi.utilization')}
              value={utilization == null ? '—' : `${utilization}%`}
              delta={t('branches.kpi.utilizationDelta')}
              tone={utilizationTone}
            />
          </div>

          <div
            className="branches-grid"
            data-testid="branches-grid"
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
              gap: '14px',
              padding: '12px 16px',
            }}
            role="list"
            aria-label={t('branches.title')}
          >
            {visibleBranches.map((b) => {
              const linked = linksByBranch.get(b.id) ?? [];
              const isFocused = b.id === selectedId;
              const cardSummary = summaryFor(b);
              const totalDay = Number(cardSummary.capacity_per_day) || 0;
              const usedDay = Number(cardSummary.booked_today) || 0;
              const card = (
                <article
                  key={b.id}
                  role="listitem"
                  className={`card ${isFocused ? 'card--raise' : ''}`.trim()}
                  data-testid={`branch-card-${b.id}`}
                  aria-current={isFocused ? 'true' : undefined}
                  tabIndex={0}
                  onClick={() => openBranchDrawer(b)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      openBranchDrawer(b);
                    }
                  }}
                  style={{
                    cursor: 'pointer',
                    display: 'grid',
                    gridTemplateRows: 'auto auto auto 1fr',
                    gap: '10px',
                    minHeight: '184px',
                  }}
                >
                  <header
                    style={{
                      display: 'flex',
                      gap: '6px',
                      alignItems: 'center',
                      flexWrap: 'wrap',
                    }}
                  >
                    <span
                      className="mono"
                      style={{ fontSize: '11px', color: 'var(--ink-3)' }}
                    >
                      {slugOf(b) || '—'}
                    </span>
                    <CanonicalChip
                      category="branch_type"
                      value={branchTypeOf(b)}
                      className="mono"
                    />
                    <CanonicalChip
                      category="branch_status"
                      value={branchStatusOf(b)}
                    />
                  </header>

                  <h3
                    style={{
                      margin: 0,
                      fontFamily: 'var(--font-display, var(--font-sans))',
                      fontSize: '17px',
                      lineHeight: '1.18',
                      letterSpacing: '-0.01em',
                    }}
                  >
                    {b.name}
                  </h3>
                  <p
                    style={{
                      margin: 0,
                      fontSize: '12px',
                      color: 'var(--ink-3)',
                      whiteSpace: 'nowrap',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                    }}
                    title={branchAddressTextOf(b) || undefined}
                  >
                    {branchAddressTextOf(b) || '—'}
                  </p>

                  <div
                    style={{
                      display: 'grid',
                      gridTemplateColumns: '64px 1fr',
                      gap: '10px',
                      alignItems: 'center',
                    }}
                  >
                    <CapacityGauge used={usedDay} total={totalDay || 1} size="sm" />
                    <div
                      style={{
                        display: 'grid',
                        gap: '3px',
                        fontSize: '11px',
                        lineHeight: 1.32,
                      }}
                    >
                      <span className="mono">
                        {fill(t('branches.card.stops'), { used: fmtNumber(usedDay), total: fmtNumber(totalDay) })}
                      </span>
                      <span className="mono" style={{ color: 'var(--ink-3)' }}>
                        {fill(t('branches.card.vehiclesRoutes'), {
                          vehicles: fmtNumber(cardSummary.active_vehicles ?? 0),
                          routes: fmtNumber(cardSummary.active_routes ?? 0),
                        })}
                      </span>
                      <span className="mono" style={{ color: 'var(--ink-3)' }}>
                        {fill(t('branches.card.zones'), { n: fmtNumber(linked.length) })}
                      </span>
                    </div>
                  </div>
                </article>
              );
              return card;
            })}
          </div>
        </>
      )}

      {drawer.node}
      {modal.node}

      {zonePickerFor ? (
        <ReferencePicker
          open
          title={t('branches.zones.assign')}
          source={{
            kind: 'reference',
            items: zones,
            display: (z) => (z as ZoneRow).name ?? (z as ZoneRow).id,
            value: (z) => (z as ZoneRow).id,
            sub: (z) => (z as ZoneRow).hub_code,
            section: t('branches.tabs.zones'),
          }}
          onClose={() => setZonePickerFor(null)}
          onPick={(value, item) => {
            const branch = zonePickerFor;
            setZonePickerFor(null);
            if (!branch || !value) return;
            // W17-2 — `role` dropped from canonical branch_zones; the new-link
            // request uses priority 0 (primary band) instead.
            assignZoneMut
              .mutateAsync({
                branch_id: branch.id,
                zone_id: String(value),
                priority: 0,
              })
              .then(() =>
                pushToast(
                  fill(t('branches.zones.linked'), { zone: String((item?.raw as ZoneRow | undefined)?.name ?? value), name: branch.name }),
                  'good',
                ),
              )
              .catch(() => pushToast(t('branches.zones.assignFailed'), 'danger'));
          }}
        />
      ) : null}
    </div>
  );
}
