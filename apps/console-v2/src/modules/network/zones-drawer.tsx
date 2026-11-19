// zones-drawer.tsx — CLAIM-NETWORK-ZONES.
// Multi-tab drawer body for an opened zone. Extracted out of zones.tsx so the
// entry chunk stays under the 16 KB raw budget; this body only mounts when a
// polygon or side-list row is clicked.
//
// W56-C SSOT (E2 closure P1 #5) — `<ScopePill scopeType="tenant" .../>`
// uses the literal `"tenant"` because zones (parent surface) is tenant-tier
// per the canonical RLS scope contract. The literal IS canonical
// per-module; the `scopeId` value remains identity-derived (`tenantId`).

import { useState, type ReactNode } from 'react';
import { Chip } from '@/components/Chip';
import { ScopePill } from '@/components/ScopePill';
import { KPICard } from '@/components/KPICard';
import { Button } from '@/components/Button';
import { DataTable, type DataTableColumn } from '@/components/DataTable';
import { KvGrid, type KvRow } from '@/components/KvGrid';
import { StateView } from '@/components/StateView';
import { TimelineLog, type TimelineEvent, type TimelineTone } from '@/components/TimelineLog';
import { Sparkline } from '@/components/Sparkline';
import { useCapability, useIdentity } from '@/lib/identity';
import { CAP } from '@/lib/capabilities';
import {
  useExecuteZoneOverrideRequest,
  useAddZoneDistrict,
  useDeleteZone,
  useRemoveZoneDistrict,
  useResolveSettings,
  useUpdateZone,
} from '@/lib/queries';
import { pushToast } from '@/components/toastStore';
import { lookupRow } from '@/lib/api';
import type { ChipKind } from '@/components/Chip';
import { zoneStatusOf } from './_zone-status';
// W27 Cycle D Network closure (P2 #9): shared visual-band helper for the
// priority projection. Identical helper previously inlined in branches.tsx
// + zones-drawer.tsx.
//
// E2 closure (P2 #7) — `DEFAULT_BRANCH_ZONE_BAND_FALLBACK_MIN` removed.
// `priorityToBand` is now fail-closed when the canonical policy row is
// missing.
import { priorityToBand } from './_branch-band';

// ─── Domain shapes (kept loose to avoid a tight coupling with the parent) ───
//
// Phase G1 (Wave 6) — schema-drift alignment per
// `__audit__/SCHEMA-DRIFT/NETWORK.md`. These shapes mirror those in
// `network/zones.tsx`; canonical-source provenance per FE field is
// documented there.
//
// W11-2 close-out: `color_token` and `hub_code` were dropped from the
// canonical `NetworkZoneRow` in zones.tsx and now resolve through the
// `public.v_zone_summary` paired projection view. The drawer still
// accepts them on the `zone` prop for backward compatibility (the seed
// still populates them inline) but they are read off the zone summary
// when not present on the zone row itself. See branchSummary in
// branches.tsx for the analogous pattern.
//
// Field-level FE→canonical mapping:
//   NetworkZoneRow.color_token   → v_zone_summary.color_token (W11-2)
//   NetworkZoneRow.status        → zones.is_active (boolean alias)
//   NetworkZoneRow.geometry      → v_zone_summary.geometry (district-centroid projection)
//   NetworkZoneRow.hub_code      → v_zone_summary.hub_code (W11-2)
//   NetworkZoneRow.notes         → zones.description
//   ZoneDistrictRow.district_id  → zone_districts.canonical_district_id
//   ZoneOverrideRow.zone_id      → zone_override_requests.requested_zone_id
//   ZoneOverrideRow.payload      → zone_override_requests.metadata
//   ZoneOverrideRow.decision_at  → zone_override_requests.reviewed_at
//   ZoneOverrideRow.decided_by_user_id → zone_override_requests.reviewed_by
//   BranchZoneRow.branch_label   → branches.code/name (FE join projection)
// W20 — drawer-side interfaces aligned with W20 zones.tsx canonical column
// shadows. All canonical fields are optional and the FE aliases now also
// accept undefined so legacy seeds + new canonical-shape rows both flow
// through. Resolver helpers re-implemented inline below.
interface NetworkZoneRow extends Record<string, unknown> {
  id: string;
  name: string;
  slug: string;
  /** Resolved via v_zone_summary.color_token (W11-2). Optional on the
   *  parent `NetworkZoneRow`; the drawer still reads it when present from
   *  seed/legacy callers. */
  color_token?: string;
  /** Canonical is_active boolean (W20). */
  is_active?: boolean;
  /** @deprecated FE alias derived from canonical is_active + metadata.lifecycle.
   *  Resolve via `zoneStatusOf(zone)`. */
  status?: string;
  /** Resolved via v_zone_summary.hub_code (W11-2). Optional on the parent
   *  `NetworkZoneRow`. */
  hub_code?: string;
  /** Canonical description (W20). */
  description?: string | null;
  /** @deprecated FE alias for canonical description. */
  notes?: string;
  /** Canonical metadata jsonb (W20). */
  metadata?: Record<string, unknown>;
  updated_at?: string;
  /** API-backed geometry projection derived from canonical district centroids. */
  geometry?: { kind: 'polygon'; paths: Array<[number, number]> } | null;
}
// W17-2 — `role` dropped from ZoneDistrictRow + BranchZoneRow.
// `change_kind` dropped from the override row (resolved via
// `metadata.change_kind` jsonb, which the FE accesses via `payload`).
//
// W20 — added canonical column shadows for the deferred RENAME items.
// Both shapes are accepted; resolver helpers prefer canonical when present.
interface ZoneDistrictRow extends Record<string, unknown> {
  zone_id: string;
  /** @deprecated FE alias for canonical canonical_district_id (W20). */
  district_id?: string;
  /** Canonical canonical_district_id (W20). */
  canonical_district_id?: string;
  created_at?: string;
  /** Optional surrogate id (zone_districts has no PK other than the composite
   *  zone_id + canonical_district_id; the seed inlines an id for FE keying). */
  id?: string;
}
interface ZoneOverrideRow extends Record<string, unknown> {
  id: string;
  /** @deprecated FE alias for canonical requested_zone_id (W20). */
  zone_id?: string;
  /** Canonical requested_zone_id (W20). */
  requested_zone_id?: string;
  /** Canonical current_zone_id (W20). */
  current_zone_id?: string;
  /** @deprecated FE alias for canonical requested_by (W20). */
  requested_by_user_id?: string;
  /** Canonical requested_by (W20). */
  requested_by?: string;
  /** @deprecated FE alias for canonical metadata. The historical `change_kind`
   *  lives inside this jsonb under the `change_kind` key. */
  payload?: Record<string, unknown>;
  /** Canonical metadata jsonb (W20). */
  metadata?: Record<string, unknown>;
  status: string;
  /** @deprecated FE alias for canonical reviewed_at (W20). */
  decision_at?: string | null;
  /** Canonical reviewed_at (W20). */
  reviewed_at?: string | null;
  /** @deprecated FE alias for canonical reviewed_by (W20). */
  decided_by_user_id?: string | null;
  /** Canonical reviewed_by (W20). */
  reviewed_by?: string | null;
  created_at: string;
}

// (overrideZoneIdOf — drawer scope is per-zone, the parent's zonesByZone
// index already keys overrides by zone, so the drawer renders pre-filtered
// rows. The helper would be a no-op duplicate here.)

/** Resolve canonical requested_by for an override row (W20). */
function overrideRequestedByOf(o: ZoneOverrideRow | undefined | null): string {
  if (!o) return '';
  if (typeof o.requested_by === 'string' && o.requested_by.length > 0) return o.requested_by;
  if (typeof o.requested_by_user_id === 'string') return o.requested_by_user_id;
  return '';
}

/** Resolve canonical metadata jsonb for an override row (W20). */
function overrideMetadataOf(o: ZoneOverrideRow | undefined | null): Record<string, unknown> {
  if (!o) return {};
  if (o.metadata && typeof o.metadata === 'object') return o.metadata;
  if (o.payload && typeof o.payload === 'object') return o.payload;
  return {};
}

/** Resolve canonical reviewed_at for an override row (W20). */
function overrideReviewedAtOf(o: ZoneOverrideRow | undefined | null): string | null {
  if (!o) return null;
  if (typeof o.reviewed_at === 'string' && o.reviewed_at.length > 0) return o.reviewed_at;
  if (typeof o.decision_at === 'string' && o.decision_at.length > 0) return o.decision_at;
  return null;
}

/** Resolve canonical reviewed_by for an override row (W20). */
function overrideReviewedByOf(o: ZoneOverrideRow | undefined | null): string | null {
  if (!o) return null;
  if (typeof o.reviewed_by === 'string' && o.reviewed_by.length > 0) return o.reviewed_by;
  if (typeof o.decided_by_user_id === 'string' && o.decided_by_user_id.length > 0) return o.decided_by_user_id;
  return null;
}

/** Resolve canonical canonical_district_id for a zone district row (W20). */
function zoneDistrictIdOf(row: ZoneDistrictRow | undefined | null): string {
  if (!row) return '';
  if (typeof row.canonical_district_id === 'string' && row.canonical_district_id.length > 0) {
    return row.canonical_district_id;
  }
  if (typeof row.district_id === 'string' && row.district_id.length > 0) return row.district_id;
  return '';
}

function zoneDistrictSelectionKeyOf(row: ZoneDistrictRow | undefined | null): string {
  if (!row) return '';
  const districtId = zoneDistrictIdOf(row);
  if (!districtId) return '';
  const rowId = typeof row.id === 'string' ? row.id : '';
  return rowId || `${row.zone_id}:${districtId}`;
}
interface BranchZoneRow extends Record<string, unknown> {
  /** W20 — `branch_zone_directory` projection rows carry an `id` from
   *  canonical `public.branch_zones.id`. Optional on the drawer interface
   *  for legacy callers that pre-date the projection. */
  id?: string;
  branch_id: string;
  /** Canonical paired-view projection: branches.name with code fallback. */
  branch_label: string;
  /** Canonical paired-view projection: branches.code (W20). */
  hub_code?: string | null;
  /** Canonical paired-view projection: branches.branch_type (W20). */
  branch_type?: string | null;
  /** Canonical paired-view projection: zones.name (W20). */
  zone_label?: string | null;
  /** Canonical paired-view projection: zones.slug (W20). */
  zone_slug?: string | null;
  zone_id: string;
  priority?: number;
}

/** Resolve the override-request kind from canonical `metadata` jsonb (W17-2).
 *  W20 — reads now flow through `overrideMetadataOf()` so canonical
 *  `metadata` is preferred over the FE alias `payload`. */
function changeKindOf(o: ZoneOverrideRow | undefined | null): string {
  if (!o) return '';
  const fromMeta = overrideMetadataOf(o)['change_kind'];
  if (typeof fromMeta === 'string') return fromMeta;
  return '';
}

// W27 Cycle D Network closure (P2 #9): the priorityToBand helper was
// extracted to `./_branch-band.ts` and is imported above. The drawer
// resolves the canonical `branch_zone_band_priority_threshold` settings
// policy at the body root so all band renders flow through the shared
// helper with a row-driven threshold.
interface CanonicalDistrictRow extends Record<string, unknown> {
  id: string;
  city_code: string;
  name: string;
}

interface PerfMetrics {
  shipments_today: number;
  shipments_week: number;
  on_time_pct: number | null;
  capacity_saturation_pct: number;
  spark_today: number[];
  spark_week: number[];
}

// ────────── Canonical-tone chip helper ──────────
//
// Status / color-token / override-status palettes are sourced strictly
// from the canonical `lookups` SSOT — no inline `*_TONE` / `*_LABEL`
// Records. AGENTS.md §2 (ZERO HARDCODING) + §4 (SSOT). Missing canonical
// rows render a danger-toned "missing" chip so the gap is visible to
// operators rather than silently masked by a neutral fallback.
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
  const row = lookupRow(category, value);
  if (!row) {
    return (
      <Chip
        label={`${category}/${value} (missing)`}
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

function geometryExtent(geom: NetworkZoneRow['geometry']): string {
  if (!geom || !Array.isArray(geom.paths) || geom.paths.length === 0) return '—';
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const [x, y] of geom.paths) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  const fmt = (n: number) => n.toFixed(3);
  return `(${fmt(minX)}, ${fmt(minY)}) → (${fmt(maxX)}, ${fmt(maxY)})`;
}

export interface ZoneDrawerBodyProps {
  zone: NetworkZoneRow;
  linkedDistricts: ZoneDistrictRow[];
  linkedBranches: BranchZoneRow[];
  zoneOverrides: ZoneOverrideRow[];
  perf?: PerfMetrics;
  districtIndex: Map<string, CanonicalDistrictRow>;
  tenantId?: string;
  onTimelineMutate: () => void;
  fmtNumber: (n: number, opts?: Intl.NumberFormatOptions) => string;
  fmtDateTime: (iso: string | number | Date) => string;
}

export function ZoneDrawerBody(props: ZoneDrawerBodyProps) {
  const {
    zone,
    linkedDistricts,
    linkedBranches,
    zoneOverrides,
    perf,
    districtIndex,
    tenantId,
    onTimelineMutate,
    fmtNumber,
    fmtDateTime,
  } = props;
  const fmtPct = (v: number, digits = 0) =>
    fmtNumber(v, { style: 'percent', maximumFractionDigits: digits });
  const canWrite = useCapability(CAP.ZONES_WRITE);
  const { user } = useIdentity();
  const reviewerId = user?.id ?? null;

  // W27 Cycle D Network closure (P1 #6): performance KPI tone thresholds
  // resolve from canonical `zone_performance_policy` settings policy
  // (sv_460). Replaces inline 0.9/0.8/0.85/0.7 magic numbers in the
  // KPI strip below. Missing canonical row → KPI tone falls through to
  // neutral via consumer null-checks.
  const zonePerformancePolicy = useResolveSettings('zone_performance_policy', undefined);
  const zonePerformanceThresholds =
    (zonePerformancePolicy.data?.value as
      | {
          on_time_good_min?: number;
          on_time_warn_min?: number;
          saturation_danger_min?: number;
          saturation_warn_min?: number;
        }
      | undefined) ?? null;

  // W27 Cycle D Network closure (P2 #9): the `branch_zones.priority` →
  // band threshold resolves from canonical
  // `branch_zone_band_priority_threshold` settings policy (sv_490).
  //
  // E2 closure (P2 #7) — fail-closed when the canonical policy row is
  // missing: `branchZoneBandFallbackMin` is `null | undefined` instead of
  // a hardcoded baseline. `priorityToBand` returns the `'no_policy'`
  // sentinel band so the chip renders a fail-loud missing-row marker.
  const branchZoneBandPolicy = useResolveSettings(
    'branch_zone_band_priority_threshold',
    undefined,
  );
  const branchZoneBandFallbackMin =
    (branchZoneBandPolicy.data?.value as { fallback_min?: number } | undefined)
      ?.fallback_min ?? null;

  // Phase C2 mutation hooks (canonical Phase B4 RPCs).
  // Audit ref: __audit__/CROSSWALK/NETWORK.md §2.1 (P0 gap 2) + §1.2 #6.
  const executeOverrideMut = useExecuteZoneOverrideRequest();
  const addDistrictMut = useAddZoneDistrict();
  const deleteZoneMut = useDeleteZone();
  const removeDistrictMut = useRemoveZoneDistrict();
  const updateZoneMut = useUpdateZone();

  const [tab, setTab] = useState<
    'profile' | 'districts' | 'branches' | 'overrides' | 'performance'
  >('profile');
  const [selectedDistrictKey, setSelectedDistrictKey] = useState<string | null>(null);

  const kvRows: KvRow[] = [
    { key: 'name', label: 'Name', value: zone.name, capability: CAP.ZONES_WRITE },
    { key: 'slug', label: 'Slug', value: zone.slug, mono: true, capability: CAP.ZONES_WRITE },
    {
      key: 'description',
      label: 'Description',
      value: zone.description ?? zone.notes ?? '',
      capability: CAP.ZONES_WRITE,
    },
    // color_token / hub_code: W11-2 — these now resolve through v_zone_summary
    // on the parent surface; the drawer still displays whatever the parent
    // chose to forward (seed populates them inline today).
    {
      key: 'color_token',
      label: 'Color token',
      value: zone.color_token ?? 'neutral',
      lookup: 'zone_color_token',
      capability: CAP.ZONES_WRITE,
    },
    { key: 'status', label: 'Status', value: zoneStatusOf(zone), mono: true, editable: false },
    { key: 'hub_code', label: 'Hub', value: zone.hub_code ?? '—', mono: true, editable: false },
    { key: 'updated_at', label: 'Updated', value: zone.updated_at ? fmtDateTime(zone.updated_at) : '—', mono: true, editable: false },
    { key: 'extent', label: 'Geometry extent', value: geometryExtent(zone.geometry), mono: true, editable: false },
    { key: 'districts', label: 'Districts', value: fmtNumber(linkedDistricts.length), mono: true, editable: false },
    { key: 'branches', label: 'Branches serving', value: fmtNumber(linkedBranches.length), mono: true, editable: false },
  ];

  async function handleProfileEdit(key: string, value: unknown) {
    const next = typeof value === 'string' ? value.trim() : value;
    const patch =
      key === 'description'
        ? { description: next }
        : key === 'color_token'
          ? { color_token: next }
          : { [key]: next };
    try {
      await updateZoneMut.mutateAsync({ zone_id: zone.id, patch });
      pushToast(`Updated zone ${zone.name}.`, 'good');
      onTimelineMutate();
    } catch (error) {
      pushToast(`Zone update failed: ${(error as Error).message}`, 'danger');
    }
  }

  async function retireZone() {
    try {
      await deleteZoneMut.mutateAsync({
        zone_id: zone.id,
        reason: 'console_v2_zone_retire',
        metadata: { source: 'console_v2_zones_drawer' },
      });
      pushToast(`Retired zone ${zone.name}.`, 'warn');
      onTimelineMutate();
    } catch (error) {
      pushToast(`Zone retire failed: ${(error as Error).message}`, 'danger');
    }
  }

  const districtColumns: Array<DataTableColumn<ZoneDistrictRow>> = [
    {
      key: '_selected',
      label: 'Select',
      width: '64px',
      render: (_raw, row) => {
        const key = zoneDistrictSelectionKeyOf(row);
        const did = zoneDistrictIdOf(row);
        const name = did ? districtIndex.get(did)?.name : undefined;
        const label = name ? `${name} ${did}` : did || key || 'district';
        return (
          <input
            type="radio"
            name={`zone-district-${zone.id}`}
            aria-label={`Select district ${label}`}
            checked={key.length > 0 && selectedDistrictKey === key}
            onClick={(event) => event.stopPropagation()}
            onChange={() => {
              if (key) setSelectedDistrictKey(key);
            }}
          />
        );
      },
    },
    {
      key: 'district_id',
      label: 'District',
      mono: true,
      sortable: true,
      filterable: true,
      render: (_raw, row) => {
        // W20 — resolves canonical canonical_district_id first via
        // `zoneDistrictIdOf()`; FE alias `district_id` remains a back-compat
        // fallback inside the resolver.
        const did = zoneDistrictIdOf(row);
        const name = did ? districtIndex.get(did)?.name : undefined;
        return name ? `${name} · ${did}` : (did || '—');
      },
    },
    // W17-2 — `role` column removed (no canonical analog). Linked-at remains
    // as the SSOT timestamp signal for the row.
    { key: 'created_at', label: 'Linked', format: 'datetime', sortable: true },
  ];

  const branchColumns: Array<DataTableColumn<BranchZoneRow>> = [
    { key: 'branch_id', label: 'Branch', mono: true, sortable: true, filterable: true },
    { key: 'branch_label', label: 'Label', sortable: true, filterable: true },
    // W17-2 — `role` derived from canonical `priority` via `priorityToBand()`.
    // W27 Cycle D Network closure (P1 #2): chip routes through canonical
    // `branch_zone_band` lookup (primary/secondary/fallback) so tone
    // resolution flows from the SSOT lookup ladder rather than an inline
    // `band === 'primary' ? 'good' : 'info'` ternary.
    {
      key: 'priority',
      label: 'Band',
      sortable: true,
      filterable: true,
      render: (_raw, row) => {
        const band = priorityToBand(row.priority, branchZoneBandFallbackMin);
        return <CanonicalChip category="branch_zone_band" value={band} />;
      },
    },
  ];

  const overrideEvents: TimelineEvent[] = zoneOverrides.map((o) => {
    // W17-2 — change kind sourced from canonical metadata jsonb.
    // W20 — actor / metadata / reviewer fields resolved through canonical
    // column shadows via overrideRequestedByOf / overrideMetadataOf /
    // overrideReviewedAtOf / overrideReviewedByOf helpers.
    const kind = changeKindOf(o);
    const actor = overrideRequestedByOf(o);
    const meta = overrideMetadataOf(o);
    const reviewedBy = overrideReviewedByOf(o);
    const reviewedAt = overrideReviewedAtOf(o);
    // Canonical SSOT: zone_change_kind lookup category. Missing rows fall
    // through to a `<category>/<value> (missing)` label to surface the
    // unseeded gap to operators (TimelineLog renders the type as a plain
    // string, so the missing key is visible inline rather than as a chip).
    const kindRow = lookupRow('zone_change_kind', kind);
    const kindLabel = kindRow?.label ?? `zone_change_kind/${kind} (missing)`;
    // Canonical SSOT: zone_override_status lookup category. The
    // TimelineLog `tone` enum is a strict subset of ChipKind
    // ('good' | 'warn' | 'danger' | 'info' | 'neutral') — missing rows
    // surface as 'danger' so the gap is visible.
    //
    // E2 closure (P1 #1) — status-derived UX (summary line, button gating,
    // pending counter) resolves through canonical
    // `zone_override_status.metadata` (`summary_kind` + `allowed_actions` +
    // `is_terminal`). Replaces inline `o.status === 'pending'` /
    // `=== 'approved'` literals at zones-drawer.tsx (lines previously 446,
    // 448, 470, 520). Missing canonical row → buttons hidden, summary
    // shows the canonical "(missing)" marker.
    const statusRow = lookupRow('zone_override_status', o.status);
    const statusMeta = (statusRow?.metadata ?? {}) as {
      allowed_actions?: string[];
      summary_kind?: string;
      is_terminal?: boolean;
    };
    const overrideTone: TimelineTone = statusRow
      ? ((statusRow.tone as TimelineTone | undefined) ?? 'neutral')
      : 'danger';
    const allowedActions = statusMeta.allowed_actions ?? [];
    const summaryKind = statusMeta.summary_kind;
    const summaryLine =
      summaryKind === 'pending'
        ? `Pending review · ${JSON.stringify(meta)}`
        : summaryKind === 'approved'
          ? `Approved by ${reviewedBy ?? '—'} on ${reviewedAt ? fmtDateTime(reviewedAt) : '—'}`
          : summaryKind === 'denied'
            ? `Denied by ${reviewedBy ?? '—'} on ${reviewedAt ? fmtDateTime(reviewedAt) : '—'}`
            : `zone_override_status/${o.status} (missing canonical metadata)`;
    return {
    id: o.id,
    at: o.created_at,
    type: kindLabel,
    actor,
    summary: summaryLine,
    detail: (
      <div style={{ padding: '8px 14px' }}>
        <div className="state__hint" style={{ fontSize: '11px', marginBottom: '6px' }}>
          <span className="mono">metadata</span> · canonical jsonb
        </div>
        <pre
          className="mono"
          style={{
            fontSize: '11px',
            margin: 0,
            padding: '6px 8px',
            background: 'var(--surface-2, rgba(0,0,0,0.04))',
            borderRadius: '4px',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-all',
          }}
        >
          {JSON.stringify(meta, null, 2)}
        </pre>
        {allowedActions.length > 0 ? (
          <div style={{ display: 'flex', gap: '6px', marginTop: '8px' }}>
            {allowedActions.includes('approve') ? (
              <Button
                label="Approve"
                iconName="check"
                kind="primary"
                size="sm"
                capability={CAP.ZONES_WRITE}
                onClick={() => {
                  executeOverrideMut
                    .mutateAsync({
                      request_id: o.id,
                      // E2 closure (P1 #6) — RPC-canonical decision values
                      // ('approve' / 'deny') match the backend
                      // `execute_zone_override_request_v1` RPC parameter
                      // schema (canonical at the backend; FE passes through).
                      decision: 'approve',
                      ...(reviewerId ? { reviewed_by: reviewerId } : {}),
                    })
                    .then(() => {
                      pushToast(`Approved override ${o.id}`, 'good');
                      onTimelineMutate();
                    })
                    .catch(() => pushToast('Approve failed — see audit log.', 'danger'));
                }}
              />
            ) : null}
            {allowedActions.includes('deny') ? (
              <Button
                label="Deny"
                iconName="x"
                kind="danger"
                size="sm"
                capability={CAP.ZONES_WRITE}
                onClick={() => {
                  executeOverrideMut
                    .mutateAsync({
                      request_id: o.id,
                      // E2 closure (P1 #6) — RPC-canonical decision value.
                      decision: 'deny',
                      ...(reviewerId ? { reviewed_by: reviewerId } : {}),
                    })
                    .then(() => {
                      pushToast(`Denied override ${o.id}`, 'warn');
                      onTimelineMutate();
                    })
                    .catch(() => pushToast('Deny failed — see audit log.', 'danger'));
                }}
              />
            ) : null}
          </div>
        ) : null}
      </div>
    ),
    tone: overrideTone,
  };
  });

  // E2 closure (P1 #4) — pending count derives from canonical
  // `zone_override_status.metadata.is_terminal=false` so adding a new
  // non-terminal status (e.g. 'in_review') is metadata-only.
  const pendingCount = zoneOverrides.filter((o) => {
    const meta = lookupRow('zone_override_status', o.status)?.metadata as
      | { is_terminal?: boolean }
      | undefined;
    return meta?.is_terminal === false;
  }).length;

  const performanceNode: ReactNode = perf ? (
    <div style={{ padding: '0 14px' }}>
      <div className="kpi-strip" style={{ marginTop: '4px' }}>
        <KPICard
          label="Shipments today"
          value={fmtNumber(perf.shipments_today)}
          delta={`${fmtNumber(perf.shipments_week)} this week`}
          tone={perf.shipments_today > 0 ? 'info' : 'neutral'}
          spark={perf.spark_today}
        />
        {/* W27 Cycle D Network closure (P1 #6): KPI tone thresholds
            resolve from canonical `zone_performance_policy` (sv_460).
            Replaces inline 0.9/0.8/0.85/0.7 magic numbers. Missing
            policy → neutral tone via consumer null-checks. */}
        <KPICard
          label="On-time"
          value={perf.on_time_pct == null ? '—' : fmtPct(perf.on_time_pct, 0)}
          delta="rolling 7-day"
          tone={
            perf.on_time_pct == null
              ? 'neutral'
              : zonePerformanceThresholds?.on_time_good_min != null &&
                  zonePerformanceThresholds?.on_time_warn_min != null
                ? perf.on_time_pct >= zonePerformanceThresholds.on_time_good_min
                  ? 'good'
                  : perf.on_time_pct >= zonePerformanceThresholds.on_time_warn_min
                    ? 'warn'
                    : 'danger'
                : 'neutral'
          }
          spark={perf.spark_week}
        />
        <KPICard
          label="Capacity saturation"
          value={fmtPct(perf.capacity_saturation_pct, 0)}
          delta="vs declared cap"
          tone={
            zonePerformanceThresholds?.saturation_danger_min != null &&
            zonePerformanceThresholds?.saturation_warn_min != null
              ? perf.capacity_saturation_pct >= zonePerformanceThresholds.saturation_danger_min
                ? 'danger'
                : perf.capacity_saturation_pct >= zonePerformanceThresholds.saturation_warn_min
                  ? 'warn'
                  : 'good'
              : 'neutral'
          }
        />
      </div>

      <div className="section-eyebrow">Today · hourly</div>
      <div style={{ padding: '6px 6px 12px' }}>
        <Sparkline values={perf.spark_today} width={300} height={48} />
      </div>
      <div className="section-eyebrow">Last 7 days</div>
      <div style={{ padding: '6px 6px 12px' }}>
        <Sparkline values={perf.spark_week} width={300} height={48} />
      </div>
    </div>
  ) : (
    <StateView kind="empty" hint="No performance metrics found for this zone yet." />
  );

  const tabBtn = (
    id: 'profile' | 'districts' | 'branches' | 'overrides' | 'performance',
    label: string,
    count?: number,
  ) => (
    <button
      type="button"
      className={'rail-tab' + (tab === id ? ' is-active' : '')}
      role="tab"
      aria-selected={tab === id}
      onClick={() => setTab(id)}
    >
      <span>{label}</span>
      {count != null ? <span className="rail-tab__count mono">{String(count)}</span> : null}
    </button>
  );

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
          category="zone_status"
          value={zoneStatusOf(zone)}
          labelOverride={`status: ${zoneStatusOf(zone)}`}
          className="mono"
        />
        {zone.color_token ? (
          <CanonicalChip
            category="zone_color_token"
            value={String(zone.color_token)}
            labelOverride={`color: ${zone.color_token}`}
            className="mono"
          />
        ) : (
          <Chip label="color: —" kind="neutral" size="xs" className="mono" />
        )}
        {pendingCount > 0 ? (
          <Chip
            label={`${pendingCount} pending override${pendingCount > 1 ? 's' : ''}`}
            kind="danger"
            size="xs"
          />
        ) : null}
      </div>

      <div className="rail-tabs" role="tablist" style={{ padding: '0 14px' }}>
        {tabBtn('profile', 'Profile')}
        {tabBtn('districts', 'Districts', linkedDistricts.length)}
        {tabBtn('branches', 'Branches', linkedBranches.length)}
        {tabBtn('overrides', 'Overrides', zoneOverrides.length)}
        {tabBtn('performance', 'Performance')}
      </div>

      <div className="rail-body">
        {tab === 'profile' ? (
          <div>
            {zone.notes ? (
              <p
                className="state__hint"
                style={{ margin: '4px 14px 8px', fontSize: '12px' }}
              >
                {zone.notes}
              </p>
            ) : null}
            <KvGrid rows={kvRows} onEdit={handleProfileEdit} />
            <div style={{ display: 'flex', justifyContent: 'flex-end', padding: '8px 14px 0' }}>
              <Button
                label="Retire zone"
                iconName="trash"
                kind="danger"
                size="sm"
                capability={CAP.ZONES_WRITE}
                disabled={!canWrite || zoneStatusOf(zone) === 'retired'}
                onClick={() => void retireZone()}
              />
            </div>
          </div>
        ) : null}

        {tab === 'districts' ? (
          linkedDistricts.length === 0 ? (
            <StateView kind="empty" hint="No districts linked. Triage in operations." />
          ) : (
            <div>
              <div
                style={{
                  display: 'flex',
                  gap: '6px',
                  padding: '6px 14px 4px',
                  flexWrap: 'wrap',
                }}
              >
                <Button
                  label="Add district"
                  iconName="plus"
                  kind="primary"
                  size="sm"
                  capability={CAP.ZONES_WRITE}
                  onClick={() => {
                    // Pick the first canonical district NOT already linked.
                    // W20 — resolves canonical canonical_district_id first via
                    // `zoneDistrictIdOf()`; FE alias `district_id` remains a
                    // back-compat fallback inside the resolver.
                    const linkedIds = new Set(
                      linkedDistricts.map((d) => zoneDistrictIdOf(d)).filter((s) => s.length > 0),
                    );
                    const candidate = [...districtIndex.values()].find((d) => !linkedIds.has(d.id));
                    if (!candidate) {
                      pushToast('All canonical districts are already linked.', 'info');
                      return;
                    }
                    addDistrictMut
                      .mutateAsync({
                        zone_id: zone.id,
                        canonical_district_id: candidate.id,
                      })
                      .then(() => {
                        pushToast(`Linked ${candidate.name} to ${zone.name}.`, 'good');
                        onTimelineMutate();
                      })
                      .catch(() => pushToast('Add district failed — see audit log.', 'danger'));
                  }}
                />
                <Button
                  label="Remove selected"
                  iconName="trash"
                  kind="ghost"
                  size="sm"
                  capability={CAP.ZONES_WRITE}
                  onClick={() => {
                    // Remove the row explicitly selected by the operator.
                    const target = linkedDistricts.find(
                      (d) => zoneDistrictSelectionKeyOf(d) === selectedDistrictKey,
                    );
                    if (!target) {
                      pushToast('Select a linked district to remove.', 'info');
                      return;
                    }
                    const districtId = zoneDistrictIdOf(target);
                    if (!districtId) {
                      pushToast('Linked district missing canonical district id - cannot remove.', 'warn');
                      return;
                    }
                    removeDistrictMut
                      .mutateAsync({
                        zone_district_id: typeof target.id === 'string' ? target.id : undefined,
                        zone_id: target.zone_id,
                        canonical_district_id: districtId,
                      })
                      .then(() => {
                        setSelectedDistrictKey(null);
                        pushToast(`Unlinked district ${districtId}.`, 'warn');
                        onTimelineMutate();
                      })
                      .catch(() => pushToast('Remove district failed — see audit log.', 'danger'));
                  }}
                />
              </div>
              <DataTable<ZoneDistrictRow>
                columns={districtColumns}
                rows={linkedDistricts}
                viewKey={`zone_districts_${zone.id}`}
                entityKind="zone_district"
                allowSelection={false}
                onRowClick={(row) => {
                  const key = zoneDistrictSelectionKeyOf(row);
                  if (key) setSelectedDistrictKey(key);
                }}
                getRowClass={(row) =>
                  zoneDistrictSelectionKeyOf(row) === selectedDistrictKey ? 'is-selected' : undefined
                }
              />
            </div>
          )
        ) : null}

        {tab === 'branches' ? (
          linkedBranches.length === 0 ? (
            <StateView kind="empty" hint="No branches reference this zone yet." />
          ) : (
            <DataTable<BranchZoneRow>
              columns={branchColumns}
              rows={linkedBranches}
              viewKey={`branch_zones_${zone.id}`}
              entityKind="branch_zone"
              allowSelection={false}
            />
          )
        ) : null}

        {tab === 'overrides' ? (
          overrideEvents.length === 0 ? (
            <StateView kind="empty" hint="No override requests filed against this zone." />
          ) : (
            <div data-testid="zone-override-timeline">
              <TimelineLog
                events={overrideEvents}
                initiallyExpanded={overrideEvents
                  .filter((e) => e.tone === 'warn')
                  .map((e) => e.id)}
              />
            </div>
          )
        ) : null}

        {tab === 'performance' ? performanceNode : null}
      </div>
    </div>
  );
}

export default ZoneDrawerBody;
