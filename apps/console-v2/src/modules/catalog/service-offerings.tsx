// service-offerings.tsx — Catalog · Service offerings (CLAIM-CATALOG-OFFERINGS,
// Wave 2, Phase B).
//
// Card catalog grid (Stripe products / Vercel pricing parity) → multi-tab
// drawer for the canonical service catalog. Reads via `useResourceList`
// against the registry-driven service catalog directory projections declared in
// seed-raw/registry.js.
//
// Backend SSOT:
//   • public.service_levels      — supabase/migrations/202601212700_branch_capacity_catalog.sql:68
//   • public.service_offerings   — supabase/migrations/202601212700_branch_capacity_catalog.sql:98
//   • RBAC write policy          — supabase/migrations/202601300120_rbac_catalog_coverage_write_gates_v1.sql
//                                  (canonical write gate: agreements.write;
//                                  surface alias: service_offerings.write)
//   • Subscriptions cross-link   — public.subscriptions.service_offering_id.
//                                  When the registry key is unavailable the
//                                  drawer surfaces an unavailable state and
//                                  never falls back to metadata counts.
//
// All operator-visible facets (price/currency/sla/included_features/max_weight/
// pricing_breakpoints/coverage_summary) live inside canonical `metadata` jsonb
// — no fictional columns added. The surface reads from `metadata.*` so the
// same payload shape lands when the backend supplies real rows.

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { PageHeader } from '@/components/PageHeader';
import { Chip, type ChipKind } from '@/components/Chip';
import { ScopePill } from '@/components/ScopePill';
import { KPICard } from '@/components/KPICard';
import { Button } from '@/components/Button';
import { CapabilityLock } from '@/components/CapabilityLock';
import { KvGrid, type KvRow } from '@/components/KvGrid';
import { StateView } from '@/components/StateView';
import {
  useResource,
  useResourceList,
  useResolveSettings,
  useCreateServiceOffering,
  useUpdateServiceOffering,
  useArchiveServiceOffering,
  useToggleServiceOffering,
  useCreateServiceLevel,
  useUpdateServiceLevel,
  useCreateBranch,
  useCreateZone,
  useAssignBranchZone,
} from '@/lib/queries';
import { useIdentity, useCapability } from '@/lib/identity';
import { englishT, fill, useI18n, type Translate } from '@/lib/i18n';
import { useDrawer, useModal } from '@/hooks/useOverlay';
import { pushToast } from '@/components/toastStore';
import { CAP } from '@/lib/capabilities';
import { getLookups, lookupRow } from '@/lib/api';
import { readUrlParam } from '@/lib/url-params';
import { ProductContextSetupForm } from './product-context-setup';
import type {
  BranchRow,
  ProductContextSetupReadback,
  ServiceLevelRow,
  ServiceOfferingRow,
  ZoneRow,
} from './service-offerings.types';

// ---------- Row shapes (mirror canonical migration columns + metadata) ----------

interface ServiceLevelMetadata {
  tier?: string;
  priority_rank?: number;
  sla_minutes?: number;
  sla_label?: string;
  color_token?: string;
  // W50 closure — canonical chip tone token persisted on the
  // service_level row. Replaces the inline `tierTone(rank)` magic-number
  // ladder (>= 50/40/30/20). Backed by backend migration
  // `202605020900_w51_service_levels_metadata_tone.sql`.
  tone?: ChipKind;
}

export function serviceOfferingDisplay(
  offering: ServiceOfferingRow,
  level?: ServiceLevelRow,
  branch?: BranchRow,
  t: Translate = englishT,
): { name: string; slug: string } {
  const display = offering.metadata?.display;
  const name = display?.name?.trim()
    || [level?.name, branch?.name].filter(Boolean).join(' · ')
    || t('catalogServiceOfferings.serviceOfferingDisplay.serviceOfferingDisplayPending');
  const slug = display?.slug?.trim()
    || [level?.name, branch?.city ?? branch?.name].filter(Boolean).join(' · ')
    || t('catalogServiceOfferings.serviceOfferingDisplay.displaySlugPending');
  return { name, slug };
}

// W17-1 — canonical `public.subscriptions` has no top-level
// `service_offering_id` column. The pointer lives in `metadata.service_offering_id`
// (resolved via `service_offerings.plan_key === subscriptions.plan_key`).
// Read via `serviceOfferingIdOf(row)` helper below.
interface SubscriptionRow extends Record<string, unknown> {
  id: string;
  status?: string;
  metadata?: Record<string, unknown>;
}

/** Resolve service_offering_id from canonical metadata jsonb (W17-1). */
function serviceOfferingIdOf(row: SubscriptionRow): string | null {
  const v = row.metadata?.['service_offering_id'];
  return typeof v === 'string' ? v : null;
}

// ---------- Helpers ----------

// W50 closure — strict canonical-tone resolver. `service_levels.metadata.tone`
// is the SSOT (seed: catalog-offerings.js; backend mirror: migration
// 202605020900_w51_service_levels_metadata_tone.sql). Missing canonical row
// → null so consumer call-sites surface a `danger` chip with `(missing)`
// marker rather than a silent neutral default. Removes the inline
// `>= 50/40/30/20` magic-number ladder. AGENTS.md §2 (ZERO HARDCODING) +
// §4 (SSOT).
function tierTone(level: ServiceLevelRow | undefined): ChipKind | null {
  return level?.metadata?.tone ?? null;
}

function serviceLevelChipTone(level: ServiceLevelRow | undefined): ChipKind {
  if (!level) return 'danger';
  return tierTone(level) ?? 'warn';
}

function serviceLevelChipLabel(level: ServiceLevelRow | undefined, fallback: string): string {
  return level?.name ?? `${fallback} (missing)`;
}

function serviceLevelChipTitle(level: ServiceLevelRow | undefined, label: string, t: Translate): string {
  if (!level) return fill(t('catalogServiceOfferings.serviceLevelChipTitle.serviceLevelLabelNotLinked'), { label });
  return tierTone(level)
    ? fill(t('catalogServiceOfferings.serviceLevelChipTitle.serviceLevelLabel'), { label: String(label) })
    : fill(t('catalogServiceOfferings.serviceLevelChipTitle.serviceLevelLabelIs'), { label: String(label) });
}

// AGENTS.md §2 + §4 (W34c): status chip tone resolves strictly from
// canonical `service_offering_status` lookup_values.metadata.tone via
// `lookupRow` (seed: catalog-offerings.js#service_offering_status).
// Missing canonical row → null so consumer renders danger `(missing)` chip.
function statusTone(status?: string): ChipKind | undefined {
  if (!status) return undefined;
  return lookupRow('service_offering_status', status)?.tone as ChipKind | undefined;
}

function lookupDisplayLabel(category: string, value?: string | null): string {
  if (!value) return '—';
  const row = lookupRow(category, value);
  if (row?.label) return row.label;
  return value
    .split(/[_-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

// W56-A closure: STRICT canonical-source consumption. The default offering
// status comes from the canonical `service_offering_status` lookup category
// (`is_default: true` row, seed: catalog-offerings.js). Missing canonical
// default row returns null so the caller surfaces a fail-loud StateView
// (no inline `'active'` literal).
function defaultOfferingStatus(): string | null {
  const list =
    (getLookups('service_offering_status') as Array<{ value: string; is_default?: boolean }>
      | undefined) ?? [];
  return list.find((r) => r.is_default)?.value ?? null;
}

// W61-Catalog+Customers closure: canonical lifecycle resolvers.
// Each lookup row in `service_offering_status` / `service_level_status` /
// `subscription_status` carries `metadata.lifecycle` as the SSOT for
// active/terminal/paused/pending grouping. These helpers replace inline
// `=== 'active'` / `=== 'archived'` / `is_active ? 'active' : 'archived'`
// literal compares throughout the surface. AGENTS.md §2 (ZERO HARDCODING)
// + §6 (row-driven by configuration). Missing rows return false / null
// so the surface fails loud (no silent default lifecycle).
function lookupLifecycle(category: string, value: string | undefined): string | null {
  if (!value) return null;
  const meta = lookupRow(category, value)?.metadata as
    | { lifecycle?: string }
    | undefined;
  return meta?.lifecycle ?? null;
}

function isOfferingActive(row: ServiceOfferingRow): boolean {
  return lookupLifecycle('service_offering_status', effectiveStatus(row)) === 'active';
}

function isOfferingTerminal(row: ServiceOfferingRow): boolean {
  return lookupLifecycle('service_offering_status', effectiveStatus(row)) === 'terminal';
}

// Default `service_offering_status` row whose canonical
// `metadata.lifecycle === 'terminal'`. Used as the archived-status fallback
// when `metadata.display.status` is absent and `is_active=false`. Replaces the
// previous "first non-default row" heuristic with a strict canonical lookup so
// adding/reordering rows in the seed cannot silently change FE behavior.
function defaultOfferingStatusForLifecycle(lifecycle: string): string | null {
  const list =
    (getLookups('service_offering_status') as Array<{ value: string }> | undefined) ?? [];
  for (const r of list) {
    if (lookupLifecycle('service_offering_status', r.value) === lifecycle) return r.value;
  }
  return null;
}

// Default `service_level_status` row by canonical `metadata.lifecycle`.
// Used by the boolean→key mapping in the Manage-levels chip rendering so
// `is_active ? 'active' : 'archived'` literals are removed (W61 P2-3).
function defaultServiceLevelStatusForLifecycle(lifecycle: string): string | null {
  const list =
    (getLookups('service_level_status') as Array<{ value: string }> | undefined) ?? [];
  for (const r of list) {
    if (lookupLifecycle('service_level_status', r.value) === lifecycle) return r.value;
  }
  return null;
}

// Effective offering status: prefer metadata.display.status (so the seed can
// render archived offerings even when is_active=false), fall back to is_active
// using the canonical default. The allow-list comes from the canonical
// `service_offering_status` lookup category (not a hardcoded 3-value union),
// so adding a new status enum row in the seed propagates to the FE without
// code changes. Return type is `string` to honor row-driven enum extension.
//
// W61-Catalog+Customers closure (P2-4): the archived fallback is now resolved
// via canonical `metadata.lifecycle === 'terminal'` rather than a "first
// non-default row" heuristic, so adding a `draft` (or other non-terminal)
// row before `archived` cannot silently swap the rendered status.
function effectiveStatus(row: ServiceOfferingRow): string {
  const allowed = (
    (getLookups('service_offering_status') as Array<{ value: string }> | undefined) ?? []
  ).map((r) => r.value);
  const m = row.metadata?.display?.status;
  if (m && allowed.includes(m)) {
    const lifecycle = lookupLifecycle('service_offering_status', m);
    if (!row.is_active && lifecycle === 'active') {
      const archived = defaultOfferingStatusForLifecycle('terminal');
      return archived ?? m;
    }
    if (row.is_active && lifecycle === 'terminal') return defaultOfferingStatus() ?? m;
    return m;
  }
  const def = defaultOfferingStatus();
  if (row.is_active) return def ?? '';
  const archived = defaultOfferingStatusForLifecycle('terminal');
  return archived ?? def ?? '';
}

function formatSla(
  minutes: number | undefined,
  fmtNumber: ReturnType<typeof useI18n>['fmtNumber'],
): string {
  if (minutes == null) return '—';
  if (minutes >= 1440 && minutes % 1440 === 0) {
    return fmtNumber(minutes / 1440, { style: 'unit', unit: 'day', unitDisplay: 'long' });
  }
  if (minutes >= 60) {
    return fmtNumber(minutes / 60, { style: 'unit', unit: 'hour', unitDisplay: 'narrow', maximumFractionDigits: 1 });
  }
  return fmtNumber(minutes, { style: 'unit', unit: 'minute', unitDisplay: 'narrow' });
}

function serviceLevelOptionLabel(level: ServiceLevelRow, t: Translate): string {
  const slaLabel =
    typeof level.sla_label === 'string' && level.sla_label.trim()
      ? level.sla_label.trim()
      : typeof level.metadata?.sla_label === 'string' && level.metadata.sla_label.trim()
        ? level.metadata.sla_label.trim()
        : null;
  return [level.name, slaLabel ? fill(t('catalogServiceOfferings.serviceLevelOptionLabel.slaSlalabel'), { slaLabel: String(slaLabel) }) : null].filter(Boolean).join(' · ');
}

function serviceLevelKeyFromName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 64);
}

// ---------- Module ----------

interface NewOfferingDraft {
  service_level_id: string;
  branch_id: string;
  zone_id: string;
  priority: string;
  base_price: string;
  currency: string;
  display_name: string;
  display_slug: string;
  max_weight_kg: string;
}

interface EditPriceDraft {
  base_price: string;
  currency: string;
}

export function ServiceOfferingsModule() {
  const { scope, currentTenantId } = useIdentity();
  const { t, fmtNumber, fmtCurrency, fmtDateTime } = useI18n();
  const drawer = useDrawer();
  const modal = useModal();
  const canRead = useCapability(CAP.SERVICE_OFFERINGS_READ);
  const canWrite = useCapability(CAP.SERVICE_OFFERINGS_WRITE);
  const canWriteBranches = useCapability(CAP.BRANCHES_WRITE);
  const canWriteZones = useCapability(CAP.ZONES_WRITE);
  // AGENTS.md §2 (ZERO HARDCODING) + §3 (ROW-DRIVEN): default currency
  // resolves strictly from canonical `tenant_currency.iso_code` via the
  // settings ladder. NO inline `'SAR'` fallback — a missing canonical row
  // means the seed is broken; the surface displays `'—'` (or renders an
  // error chip) instead of silently presenting a hardcoded ISO code.
  const tenantCurrencyPolicy = useResolveSettings('tenant_currency', undefined);
  const tenantCurrencyIso =
    (tenantCurrencyPolicy.data?.value as { iso_code?: string } | undefined)?.iso_code ?? null;
  // W54-E closure: KPI tone thresholds are row-driven via canonical
  // `catalog_kpi_thresholds` settings policy (seed: policies.js). Replaces
  // the inline `activeOfferings > 0 ? 'good' : 'warn'` / `archivedOfferings === 0 ? 'good' : 'neutral'`
  // magic numbers. Missing canonical rows fall through to null so consumers
  // can render the chip without silent FE-literal masking.
  const catalogKpiThresholdsPolicy = useResolveSettings('catalog_kpi_thresholds', undefined);
  const catalogKpiThresholds =
    (catalogKpiThresholdsPolicy.data?.value as
      | {
          active_offerings_min?: number;
          archived_offerings_max?: number;
          // W58-Catalog+Customers REDO closure: canonical chip cap for the
          // card grid — replaces the inline `features.slice(0, 3)` UX
          // literal. Fail-closed: a missing row collapses the chip strip
          // instead of silently using a hardcoded value.
          card_feature_chips_max?: number;
          // W64-Catalog+Customers Cycle F-R-4 closure: canonical
          // auto-dismiss window (ms) for the bulk-action banner. Replaces
          // the duplicated inline `4500` setTimeout literals in
          // bulkToggleAvailability + bulkArchive. Fail-closed: a missing
          // row keeps the banner visible until the next user action
          // instead of silently using a hardcoded value.
          bulk_pending_dismiss_ms?: number;
        }
      | undefined) ?? null;
  // W64-Catalog+Customers Cycle F-R-4 closure: extract the canonical
  // bulk-banner dismiss window once so the two bulk-action callsites
  // below stay row-driven (no inline magic numbers).
  const bulkPendingDismissMs = catalogKpiThresholds?.bulk_pending_dismiss_ms ?? null;
  // Canonical write capability for service_levels is `agreements.write` per
  // supabase/migrations/202601300120_rbac_catalog_coverage_write_gates_v1.sql
  // (service_levels_write_policy uses `user_has_permission_v1('agreements.write', ...)`).
  // We surface the canonical capability directly on the "Manage levels" affordance
  // so the gate matches backend RLS exactly (no surface-alias indirection).
  const canWriteLevels = useCapability(CAP.AGREEMENTS_WRITE);
  const createMut = useCreateServiceOffering();
  const updateMut = useUpdateServiceOffering();
  const archiveMut = useArchiveServiceOffering();
  const toggleMut = useToggleServiceOffering();
  const createLevelMut = useCreateServiceLevel();
  const updateLevelMut = useUpdateServiceLevel();
  const createBranchMut = useCreateBranch();
  const createZoneMut = useCreateZone();
  const assignBranchZoneMut = useAssignBranchZone();

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [bulkPending, setBulkPending] = useState<string | null>(null);
  const openedFocusRef = useRef<string | null>(null);

  const offeringsQuery = useResourceList<ServiceOfferingRow>('service_offering_directory');
  const levelsQuery = useResourceList<ServiceLevelRow>('service_level_directory');
  const branchesQuery = useResourceList<BranchRow>('branches');
  const zonesQuery = useResourceList<ZoneRow>('zones');
  // Subscriptions is owned by CLAIM-FINANCE-BILLING; if its registry is not
  // available the surface still renders fail-closed without synthetic counts.
  const subsQuery = useResourceList<SubscriptionRow>('subscriptions');

  const offerings = useMemo<ServiceOfferingRow[]>(
    () => offeringsQuery.data?.rows ?? [],
    [offeringsQuery.data?.rows],
  );
  const focusParam = readUrlParam('focus');
  const focusInRows = focusParam
    ? offerings.some((offering) => offering.id === focusParam)
    : false;
  const focusedOfferingQuery = useResource<ServiceOfferingRow>(
    'service_offering_directory',
    focusParam && !focusInRows ? focusParam : undefined,
  );
  const focusTarget = focusParam
    ? offerings.find((offering) => offering.id === focusParam) ?? focusedOfferingQuery.data ?? null
    : null;
  const levels = useMemo<ServiceLevelRow[]>(
    () => levelsQuery.data?.rows ?? [],
    [levelsQuery.data?.rows],
  );
  const branches = useMemo<BranchRow[]>(
    () => branchesQuery.data?.rows ?? [],
    [branchesQuery.data?.rows],
  );
  const zones = useMemo<ZoneRow[]>(
    () => zonesQuery.data?.rows ?? [],
    [zonesQuery.data?.rows],
  );
  const subscriptions = useMemo<SubscriptionRow[]>(
    () => subsQuery.data?.rows ?? [],
    [subsQuery.data?.rows],
  );
  const activeTenantId = currentTenantId();
  const tenantSettingsScope = useMemo(
    () => (activeTenantId ? { organization_id: activeTenantId } : undefined),
    [activeTenantId],
  );
  const tenantTimezonePolicy = useResolveSettings('tenant_default_timezone', tenantSettingsScope);
  const tenantTimezoneIana =
    (tenantTimezonePolicy.data?.value as { iana?: string } | undefined)?.iana ?? '';

  const subsRegistryAvailable = !subsQuery.isError;

  // ---------- Indexes ----------
  const levelById = useMemo(() => {
    const m = new Map<string, ServiceLevelRow>();
    for (const lv of levels) m.set(lv.id, lv);
    return m;
  }, [levels]);
  const branchById = useMemo(() => {
    const m = new Map<string, BranchRow>();
    for (const b of branches) m.set(b.id, b);
    return m;
  }, [branches]);
  const zoneById = useMemo(() => {
    const m = new Map<string, ZoneRow>();
    for (const z of zones) m.set(z.id, z);
    return m;
  }, [zones]);
  const liveSubsByOffering = useMemo(() => {
    const m = new Map<string, number>();
    for (const s of subscriptions) {
      // W17-1 — service_offering_id resolves via metadata jsonb (no top-level column).
      const oid = serviceOfferingIdOf(s);
      if (!oid) continue;
      // W61-Catalog+Customers closure: prefer status-active subs via canonical
      // `subscription_status.metadata.lifecycle === 'active'` (seed:
      // finance-billing.js) instead of inline `s.status !== 'active'` literal.
      // When `s.status` is unset, count all rows (matches prior semantics).
      if (s.status && lookupLifecycle('subscription_status', s.status) !== 'active') continue;
      m.set(oid, (m.get(oid) ?? 0) + 1);
    }
    return m;
  }, [subscriptions]);

  // ---------- KPI strip ----------
  // W61-Catalog+Customers closure: KPI status filtering resolves via
  // canonical `service_offering_status.metadata.lifecycle` (seed:
  // catalog-offerings.js) through `isOfferingActive` / `isOfferingTerminal`
  // helpers instead of inline `=== 'active'` / `=== 'archived'` literal
  // compares. AGENTS.md §2 (ZERO HARDCODING) + §6 (row-driven).
  const totalOfferings = offerings.length;
  const activeOfferings = useMemo(
    () => offerings.filter((o) => isOfferingActive(o)).length,
    [offerings],
  );
  const archivedOfferings = useMemo(
    () => offerings.filter((o) => isOfferingTerminal(o)).length,
    [offerings],
  );

  const priceRange = useMemo<{ min: number; max: number; ccy: string } | null>(() => {
    const pricedActive = offerings
      .filter((o) => isOfferingActive(o))
      .map((o) => o.metadata?.base_price)
      .filter((n): n is number => typeof n === 'number');
    if (!pricedActive.length) return null;
    const ccy = offerings.find((o) => isOfferingActive(o))?.metadata?.currency ?? tenantCurrencyIso ?? '—';
    return {
      min: Math.min(...pricedActive),
      max: Math.max(...pricedActive),
      ccy,
    };
  }, [offerings, tenantCurrencyIso]);

  // Service-level distribution → mini "donut" chips (counts per level).
  // W50 closure — `level` is carried so `tierTone(level)` reads the canonical
  // `metadata.tone` (no priority_rank-based fallback in the consumer).
  const distribution = useMemo(() => {
    const buckets = new Map<string, number>();
    for (const o of offerings) {
      if (!isOfferingActive(o)) continue;
      buckets.set(o.service_level_id, (buckets.get(o.service_level_id) ?? 0) + 1);
    }
    const total = Array.from(buckets.values()).reduce((s, n) => s + n, 0) || 1;
    return Array.from(buckets.entries()).map(([levelId, count]) => {
      const lv = levelById.get(levelId);
      return {
        id: levelId,
        label: lv?.name ?? t('catalogServiceOfferings.serviceOfferingsModule.serviceLevelNotLinked'),
        rank: lv?.metadata?.priority_rank,
        level: lv,
        count,
        pct: Math.round((count / total) * 100),
      };
    }).sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0));
  }, [offerings, levelById, t]);

  const tenantId = scope.tenant?.id;
  const isLoading = offeringsQuery.isLoading || levelsQuery.isLoading;
  const isError = offeringsQuery.isError || levelsQuery.isError;

  async function refetchOfferingForReadback(
    offeringId: string,
    validate?: (row: ServiceOfferingRow) => boolean,
  ): Promise<ServiceOfferingRow> {
    const [offeringsResult] = await Promise.all([
      offeringsQuery.refetch(),
      levelsQuery.refetch(),
      branchesQuery.refetch(),
      zonesQuery.refetch(),
    ]);
    const refreshed = offeringsResult.data?.rows.find((row) => row.id === offeringId);
    if (!refreshed || (validate && !validate(refreshed))) {
      throw new Error(t('catalogServiceOfferings.serviceOfferingsModule.theUpdatedServiceOffering'));
    }
    return refreshed;
  }

  async function refetchOfferingsForBulkReadback(
    offeringIds: string[],
    validate: (row: ServiceOfferingRow) => boolean,
  ): Promise<ServiceOfferingRow[]> {
    const [offeringsResult] = await Promise.all([
      offeringsQuery.refetch(),
      levelsQuery.refetch(),
      branchesQuery.refetch(),
      zonesQuery.refetch(),
    ]);
    const rows = offeringsResult.data?.rows ?? [];
    const refreshed = offeringIds.map((id) => rows.find((row) => row.id === id));
    if (refreshed.some((row) => !row || !validate(row))) {
      throw new Error(t('catalogServiceOfferings.serviceOfferingsModule.theUpdatedServiceOffering'));
    }
    return refreshed as ServiceOfferingRow[];
  }

  async function refetchProductContextSetupReadback({
    levelId,
    branchId,
    zoneId,
    offeringId,
  }: {
    levelId: string;
    branchId: string;
    zoneId: string | null;
    offeringId: string;
  }): Promise<ProductContextSetupReadback> {
    const [levelsResult, branchesResult, zonesResult, offeringsResult] = await Promise.all([
      levelsQuery.refetch(),
      branchesQuery.refetch(),
      zonesQuery.refetch(),
      offeringsQuery.refetch(),
    ]);
    const level = levelsResult.data?.rows.find((row) => row.id === levelId);
    const branch = branchesResult.data?.rows.find((row) => row.id === branchId);
    const zone = zoneId
      ? zonesResult.data?.rows.find((row) => row.id === zoneId) ?? null
      : null;
    const offering = offeringsResult.data?.rows.find((row) => row.id === offeringId);
    if (!level) throw new Error(t('catalogServiceOfferings.serviceOfferingsModule.theServiceLevelWas'));
    if (!branch) throw new Error(t('catalogServiceOfferings.serviceOfferingsModule.theBranchWasNot'));
    if (zoneId && !zone) throw new Error(t('catalogServiceOfferings.serviceOfferingsModule.theZoneWasNot'));
    if (!offering) throw new Error(t('catalogServiceOfferings.serviceOfferingsModule.theServiceOfferingWas'));
    return { level, branch, zone, offering };
  }

  function openProductContextSetup() {
    if (!canWrite || !canWriteLevels || !canWriteBranches) return;
    modal.open({
      title: t('catalogServiceOfferings.serviceOfferingsModule.productContextSetup'),
      body: (
        <ProductContextSetupForm
          levels={levels}
          branches={branches}
          zones={zones}
          offerings={offerings}
          activeTenantId={activeTenantId}
          tenantTimezoneIana={tenantTimezoneIana}
          tenantCurrencyIso={tenantCurrencyIso}
          canWriteZones={canWriteZones}
          createServiceLevel={(args) => createLevelMut.mutateAsync(args)}
          createBranch={(args) => createBranchMut.mutateAsync(args)}
          createZone={(args) => createZoneMut.mutateAsync(args)}
          assignBranchZone={(args) => assignBranchZoneMut.mutateAsync(args)}
          createOffering={(args) => createMut.mutateAsync(args)}
          refetchReadback={refetchProductContextSetupReadback}
          serviceLevelOptionLabel={(level) => serviceLevelOptionLabel(level, t)}
          serviceLevelKeyFromName={serviceLevelKeyFromName}
          isOfferingActive={isOfferingActive}
          offeringStatusDefault={defaultOfferingStatus()}
          onCancel={() => modal.close()}
          onReady={(readback) => {
            modal.close();
            openOfferingDrawer(readback.offering, 'profile', {
              level: readback.level,
              branch: readback.branch,
              zone: readback.zone,
            });
          }}
        />
      ),
    });
  }

  // ---------- Bulk actions (canonical Phase B6 RPCs) ----------
  // W64-Catalog+Customers Cycle F-R-4 closure: ZERO REDUNDANCY helper for the
  // bulk-action banner auto-dismiss. Both bulk callsites share the same
  // canonical (`catalog_kpi_thresholds.bulk_pending_dismiss_ms`)-driven
  // schedule. Fail-closed: when the canonical row is missing, the banner
  // persists until the next user action instead of silently consuming an FE
  // literal.
  function scheduleBulkBannerDismiss() {
    if (bulkPendingDismissMs == null) return;
    setTimeout(() => setBulkPending(null), bulkPendingDismissMs);
  }
  async function bulkToggleAvailability() {
    if (!canWrite || offerings.length === 0) return;
    setBulkPending(fill(t('catalogServiceOfferings.serviceOfferingsModule.togglingAvailabilityAcross'), { count: String(offerings.length) }));
    try {
      // Each toggle is its own canonical RPC call (matches backend semantics).
      const results = await Promise.allSettled(
        offerings.map((o) => toggleMut.mutateAsync({ service_offering_id: o.id, is_active: !o.is_active })),
      );
      const ok = results.filter((r) => r.status === 'fulfilled').length;
      const fail = results.length - ok;
      const fulfilledIds = results
        .map((result, index) => (result.status === 'fulfilled' ? offerings[index]?.id : null))
        .filter((id): id is string => Boolean(id));
      if (fulfilledIds.length) {
        await refetchOfferingsForBulkReadback(
          fulfilledIds,
          (row) => {
            const previous = offerings.find((offering) => offering.id === row.id);
            return previous
              ? row.is_active !== previous.is_active && isOfferingActive(row) !== isOfferingActive(previous)
              : false;
          },
        );
      }
      setBulkPending(fill(t(fail ? 'catalogServiceOfferings.serviceOfferingsModule.toggledOfferingsWithFailures' : 'catalogServiceOfferings.serviceOfferingsModule.toggledOfferings'), { ok: String(ok), count: String(offerings.length), fail: String(fail) }));
      pushToast(fill(t('catalogServiceOfferings.serviceOfferingsModule.toggledAvailabilityOkLength'), { ok: String(ok), length: String(offerings.length) }), fail ? 'warn' : 'good');
    } catch (err) {
      pushToast((err as Error).message, 'danger');
    }
    scheduleBulkBannerDismiss();
  }
  async function bulkArchive() {
    if (!canWrite) return;
    // W61-Catalog+Customers closure: archive targets resolve via canonical
    // `service_offering_status.metadata.lifecycle === 'active'` (seed:
    // catalog-offerings.js) instead of inline literal compare.
    const targets = offerings.filter((o) => isOfferingActive(o));
    if (targets.length === 0) {
      pushToast(t('catalogServiceOfferings.serviceOfferingsModule.noActiveOfferingsTo'), 'info');
      return;
    }
    setBulkPending(fill(t('catalogServiceOfferings.serviceOfferingsModule.archivingActiveOfferings'), { count: String(targets.length) }));
    try {
      const results = await Promise.allSettled(
        targets.map((o) => archiveMut.mutateAsync({ service_offering_id: o.id, reason: 'bulk_archive' })),
      );
      const ok = results.filter((r) => r.status === 'fulfilled').length;
      const fail = results.length - ok;
      const fulfilledIds = results
        .map((result, index) => (result.status === 'fulfilled' ? targets[index]?.id : null))
        .filter((id): id is string => Boolean(id));
      if (fulfilledIds.length) {
        await refetchOfferingsForBulkReadback(
          fulfilledIds,
          (row) => !isOfferingActive(row),
        );
      }
      setBulkPending(fill(t(fail ? 'catalogServiceOfferings.serviceOfferingsModule.archivedOfferingsWithFailures' : 'catalogServiceOfferings.serviceOfferingsModule.archivedOfferings'), { ok: String(ok), count: String(targets.length), fail: String(fail) }));
      pushToast(fill(t('catalogServiceOfferings.serviceOfferingsModule.archivedOkLength'), { ok: String(ok), length: String(targets.length) }), fail ? 'warn' : 'good');
    } catch (err) {
      pushToast((err as Error).message, 'danger');
    }
    scheduleBulkBannerDismiss();
  }
  // ---------- Manage service levels (Phase D2 close-out) ----------
  // Opens the master-list modal listing canonical `public.service_levels` rows.
  // From there operators can pick a row to Edit (canonical RPC
  // service_level_update_v1) or click "New" to land in the Create composer
  // (canonical RPC service_level_create_v1). "Edit" supports flipping
  // is_active=false as the soft-archive verb (the migration carries no
  // explicit archive RPC; backend semantics route through update_v1 with
  // is_active=false). Capability gate: `agreements.write` (canonical SSOT).
  function openManageLevels() {
    if (!canWriteLevels) return;

    function ManageLevelsBody() {
      return (
        <div data-testid="manage-levels-body">
          <p className="state__hint">
            {t('catalogServiceOfferings.serviceOfferingsModule.listsServiceTiersUsed')}
          </p>
          <div
            style={{
              display: 'grid',
              gap: '6px',
              padding: '0 4px',
              marginTop: 8,
              maxHeight: '50vh',
              overflowY: 'auto',
            }}
            role="list"
            aria-label={t('catalogServiceOfferings.serviceOfferingsModule.serviceLevels')}
          >
            {levels.length === 0 ? (
              <span className="state__hint" style={{ fontSize: '12px' }}>
                {t('catalogServiceOfferings.serviceOfferingsModule.noServiceLevelsCreate')}
              </span>
            ) : (
              levels.map((lv) => (
                <div
                  key={lv.id}
                  role="listitem"
                  data-testid={`manage-level-row-${lv.id}`}
                  style={{
                    display: 'grid',
                    gridTemplateColumns: '1fr auto',
                    alignItems: 'center',
                    gap: '8px',
                    padding: '6px 8px',
                    background: 'var(--surface-2)',
                    borderRadius: 4,
                  }}
                >
                  <div style={{ display: 'grid', gap: 2, minWidth: 0 }}>
                    <span style={{ fontSize: 13, fontWeight: 600 }}>{lv.name}</span>
                    <span className="mono" style={{ fontSize: 11, color: 'var(--ink-3)' }}>
                      {fill(t('catalogServiceOfferings.serviceOfferingsModule.rankAndSla'), {
                        rank: lv.metadata?.priority_rank == null ? '?' : fmtNumber(lv.metadata.priority_rank),
                        duration: formatSla(lv.metadata?.sla_minutes, fmtNumber),
                      })}
                    </span>
                  </div>
                  <div style={{ display: 'flex', gap: '4px', alignItems: 'center' }}>
                    {(() => {
                      // W54-E closure: row-driven status chip via canonical
                      // `service_level_status` lookup (SSOT: catalog-offerings.js).
                      // W61-Catalog+Customers closure (P2-3): boolean→key
                      // mapping resolves via canonical
                      // `service_level_status.metadata.lifecycle` so the FE
                      // never depends on the literal row keys `'active'` /
                      // `'archived'`. NO inline `'good'/'neutral'` ternary —
                      // missing canonical row renders a fail-loud
                      // `(missing)` danger chip.
                      const statusValue = lv.is_active
                        ? defaultServiceLevelStatusForLifecycle('active')
                        : defaultServiceLevelStatusForLifecycle('terminal');
                      const row = statusValue ? lookupRow('service_level_status', statusValue) : null;
                      if (!row) {
                        return (
                          <Chip
                            label={fill(t('catalogServiceOfferings.serviceOfferingsModule.serviceLevelStatusMissing'), {
                              status: statusValue ?? 'missing-lifecycle',
                            })}
                            kind="danger"
                            size="xs"
                          />
                        );
                      }
                      return (
                        <Chip
                          label={row.label}
                          kind={row.tone as ChipKind}
                          size="xs"
                        />
                      );
                    })()}
                    <Button
                      label={t('catalogServiceOfferings.serviceOfferingsModule.edit')}
                      kind="ghost"
                      size="sm"
                      capability={CAP.AGREEMENTS_WRITE}
                      onClick={() => openEditLevel(lv)}
                    />
                  </div>
                </div>
              ))
            )}
          </div>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '14px' }}>
            <Button label={t('catalogServiceOfferings.serviceOfferingsModule.close')} kind="ghost" onClick={() => modal.close()} />
            <Button
              label={t('catalogServiceOfferings.serviceOfferingsModule.newLevel')}
              iconName="plus"
              kind="primary"
              capability={CAP.AGREEMENTS_WRITE}
              onClick={openCreateLevel}
            />
          </div>
        </div>
      );
    }
    modal.open({ title: t('catalogServiceOfferings.serviceOfferingsModule.manageServiceLevels'), body: <ManageLevelsBody /> });
  }

  interface NewLevelDraft {
    name: string;
    description: string;
    tier: string;
    priority_rank: string;
    sla_minutes: string;
    sla_label: string;
  }

  function openCreateLevel() {
    if (!canWriteLevels) return;
    function NewLevelForm() {
      const [draft, setDraft] = useState<NewLevelDraft>({
        name: '',
        description: '',
        tier: '',
        priority_rank: '',
        sla_minutes: '',
        sla_label: '',
      });
      return (
        <div>
          <p className="state__hint">
            {t('catalogServiceOfferings.serviceOfferingsModule.createsAServiceTier')}
          </p>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: '140px 1fr',
              gap: '8px',
              alignItems: 'center',
              padding: '0 4px',
              marginTop: 8,
            }}
          >
            <label className="mono" htmlFor="new-lv-name">{t('catalogServiceOfferings.serviceOfferingsModule.name')}</label>
            <input
              id="new-lv-name"
              className="dt-inline-input"
              placeholder={t('catalogServiceOfferings.serviceOfferingsModule.eGPremium')}
              value={draft.name}
              onChange={(e) => setDraft((s) => ({ ...s, name: e.target.value }))}
            />
            <label className="mono" htmlFor="new-lv-desc">{t('catalogServiceOfferings.serviceOfferingsModule.description')}</label>
            <input
              id="new-lv-desc"
              className="dt-inline-input"
              placeholder={t('catalogServiceOfferings.serviceOfferingsModule.optional')}
              value={draft.description}
              onChange={(e) => setDraft((s) => ({ ...s, description: e.target.value }))}
            />
            <label className="mono" htmlFor="new-lv-tier">{t('catalogServiceOfferings.serviceOfferingsModule.tier')}</label>
            <input
              id="new-lv-tier"
              className="dt-inline-input"
              placeholder={t('catalogServiceOfferings.serviceOfferingsModule.eGPremium2')}
              value={draft.tier}
              onChange={(e) => setDraft((s) => ({ ...s, tier: e.target.value }))}
            />
            <label className="mono" htmlFor="new-lv-rank">{t('catalogServiceOfferings.serviceOfferingsModule.priorityRank')}</label>
            <input
              id="new-lv-rank"
              type="number"
              className="dt-inline-input"
              placeholder={fill(t('catalogServiceOfferings.serviceOfferingsModule.exampleNumber'), { value: fmtNumber(30) })}
              value={draft.priority_rank}
              onChange={(e) => setDraft((s) => ({ ...s, priority_rank: e.target.value }))}
            />
            <label className="mono" htmlFor="new-lv-sla-min">{t('catalogServiceOfferings.serviceOfferingsModule.slaMinutes')}</label>
            <input
              id="new-lv-sla-min"
              type="number"
              className="dt-inline-input"
              placeholder={fill(t('catalogServiceOfferings.serviceOfferingsModule.exampleNumber'), { value: fmtNumber(1440, { useGrouping: false }) })}
              value={draft.sla_minutes}
              onChange={(e) => setDraft((s) => ({ ...s, sla_minutes: e.target.value }))}
            />
            <label className="mono" htmlFor="new-lv-sla-label">{t('catalogServiceOfferings.serviceOfferingsModule.slaLabel')}</label>
            <input
              id="new-lv-sla-label"
              className="dt-inline-input"
              placeholder={fill(t('catalogServiceOfferings.serviceOfferingsModule.exampleSlaLabel'), {
                duration: fmtNumber(24, { style: 'unit', unit: 'hour', unitDisplay: 'narrow' }),
              })}
              value={draft.sla_label}
              onChange={(e) => setDraft((s) => ({ ...s, sla_label: e.target.value }))}
            />
          </div>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '14px' }}>
            <Button label={t('catalogServiceOfferings.serviceOfferingsModule.cancel')} kind="ghost" onClick={() => modal.close()} />
            <Button
              label={t('catalogServiceOfferings.serviceOfferingsModule.create')}
              kind="primary"
              capability={CAP.AGREEMENTS_WRITE}
              onClick={async () => {
                const name = draft.name.trim();
                const key = serviceLevelKeyFromName(name);
                if (!name || !key) {
                  pushToast(t('catalogServiceOfferings.serviceOfferingsModule.nameIsRequired'), 'warn');
                  return;
                }
                const metadata: Record<string, unknown> = {};
                if (draft.tier.trim()) metadata.tier = draft.tier.trim();
                const rankNum = Number(draft.priority_rank);
                if (Number.isFinite(rankNum) && rankNum > 0) metadata.priority_rank = rankNum;
                const slaNum = Number(draft.sla_minutes);
                if (Number.isFinite(slaNum) && slaNum > 0) metadata.sla_minutes = slaNum;
                if (draft.sla_label.trim()) metadata.sla_label = draft.sla_label.trim();
                try {
                  await createLevelMut.mutateAsync({
                    key,
                    name,
                    description: draft.description.trim() || undefined,
                    organization_id: activeTenantId || undefined,
                    metadata,
                  });
                  modal.close();
                  pushToast(t('catalogServiceOfferings.serviceOfferingsModule.serviceLevelCreated'), 'good');
                } catch (err) {
                  pushToast((err as Error).message, 'danger');
                }
              }}
            />
          </div>
        </div>
      );
    }
    modal.open({ title: t('catalogServiceOfferings.serviceOfferingsModule.newServiceLevel'), body: <NewLevelForm /> });
  }

  interface EditLevelDraft {
    name: string;
    description: string;
    is_active: boolean;
    tier: string;
    priority_rank: string;
    sla_minutes: string;
    sla_label: string;
  }

  function openEditLevel(level: ServiceLevelRow) {
    if (!canWriteLevels) return;
    const lm = level.metadata ?? {};
    function EditLevelForm() {
      const [draft, setDraft] = useState<EditLevelDraft>({
        name: level.name,
        description: level.description ?? '',
        is_active: level.is_active,
        tier: lm.tier ?? '',
        priority_rank: lm.priority_rank != null ? String(lm.priority_rank) : '',
        sla_minutes: lm.sla_minutes != null ? String(lm.sla_minutes) : '',
        sla_label: lm.sla_label ?? '',
      });
      return (
        <div>
          <p className="state__hint">
            {t('catalogServiceOfferings.serviceOfferingsModule.updatesThisServiceTier')}
          </p>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: '140px 1fr',
              gap: '8px',
              alignItems: 'center',
              padding: '0 4px',
              marginTop: 8,
            }}
          >
            <label className="mono" htmlFor="edit-lv-name">{t('catalogServiceOfferings.serviceOfferingsModule.name')}</label>
            <input
              id="edit-lv-name"
              className="dt-inline-input"
              value={draft.name}
              onChange={(e) => setDraft((s) => ({ ...s, name: e.target.value }))}
            />
            <label className="mono" htmlFor="edit-lv-desc">{t('catalogServiceOfferings.serviceOfferingsModule.description')}</label>
            <input
              id="edit-lv-desc"
              className="dt-inline-input"
              value={draft.description}
              onChange={(e) => setDraft((s) => ({ ...s, description: e.target.value }))}
            />
            <label className="mono" htmlFor="edit-lv-active">{t('catalogServiceOfferings.serviceOfferingsModule.active')}</label>
            <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <input
                id="edit-lv-active"
                type="checkbox"
                checked={draft.is_active}
                onChange={(e) => setDraft((s) => ({ ...s, is_active: e.target.checked }))}
              />
              <span style={{ fontSize: 11, color: 'var(--ink-3)' }}>
                {t('catalogServiceOfferings.serviceOfferingsModule.uncheckingArchivesThisLevel')}
              </span>
            </label>
            <label className="mono" htmlFor="edit-lv-tier">{t('catalogServiceOfferings.serviceOfferingsModule.tier')}</label>
            <input
              id="edit-lv-tier"
              className="dt-inline-input"
              value={draft.tier}
              onChange={(e) => setDraft((s) => ({ ...s, tier: e.target.value }))}
            />
            <label className="mono" htmlFor="edit-lv-rank">{t('catalogServiceOfferings.serviceOfferingsModule.priorityRank')}</label>
            <input
              id="edit-lv-rank"
              type="number"
              className="dt-inline-input"
              value={draft.priority_rank}
              onChange={(e) => setDraft((s) => ({ ...s, priority_rank: e.target.value }))}
            />
            <label className="mono" htmlFor="edit-lv-sla-min">{t('catalogServiceOfferings.serviceOfferingsModule.slaMinutes')}</label>
            <input
              id="edit-lv-sla-min"
              type="number"
              className="dt-inline-input"
              value={draft.sla_minutes}
              onChange={(e) => setDraft((s) => ({ ...s, sla_minutes: e.target.value }))}
            />
            <label className="mono" htmlFor="edit-lv-sla-label">{t('catalogServiceOfferings.serviceOfferingsModule.slaLabel')}</label>
            <input
              id="edit-lv-sla-label"
              className="dt-inline-input"
              value={draft.sla_label}
              onChange={(e) => setDraft((s) => ({ ...s, sla_label: e.target.value }))}
            />
          </div>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '14px' }}>
            <Button label={t('catalogServiceOfferings.serviceOfferingsModule.cancel')} kind="ghost" onClick={() => modal.close()} />
            <Button
              label={t('catalogServiceOfferings.serviceOfferingsModule.save')}
              kind="primary"
              capability={CAP.AGREEMENTS_WRITE}
              onClick={async () => {
                const name = draft.name.trim();
                if (!name) {
                  pushToast(t('catalogServiceOfferings.serviceOfferingsModule.nameIsRequired'), 'warn');
                  return;
                }
                const metadata: Record<string, unknown> = {};
                if (draft.tier.trim()) metadata.tier = draft.tier.trim();
                const rankNum = Number(draft.priority_rank);
                if (Number.isFinite(rankNum) && rankNum > 0) metadata.priority_rank = rankNum;
                const slaNum = Number(draft.sla_minutes);
                if (Number.isFinite(slaNum) && slaNum > 0) metadata.sla_minutes = slaNum;
                if (draft.sla_label.trim()) metadata.sla_label = draft.sla_label.trim();
                try {
                  await updateLevelMut.mutateAsync({
                    service_level_id: level.id,
                    name,
                    description: draft.description.trim() || undefined,
                    is_active: draft.is_active,
                    metadata,
                  });
                  modal.close();
                  pushToast(fill(t('catalogServiceOfferings.serviceOfferingsModule.serviceLevelUpdatedName'), { name: String(name) }), 'good');
                } catch (err) {
                  pushToast((err as Error).message, 'danger');
                }
              }}
            />
          </div>
        </div>
      );
    }
    modal.open({ title: fill(t('catalogServiceOfferings.serviceOfferingsModule.editLevelName'), { name: String(level.name) }), body: <EditLevelForm /> });
  }

  function openCreate() {
    if (!canWrite) return;
    if (levels.length === 0 || branches.length === 0) {
      openProductContextSetup();
      return;
    }
    function NewOfferingForm() {
      // W56-A closure: STRICT canonical-source consumption. The default
      // offering status seeds from the canonical `service_offering_status`
      // lookup category (`is_default: true` row) — no inline `'active'`
      // literal in the create payload. Missing canonical row surfaces a
      // fail-loud StateView so the operator seeds it instead of silently
      // persisting a hardcoded status.
      const offeringStatusDefault = useMemo<string | null>(() => defaultOfferingStatus(), []);
      const [draft, setDraft] = useState<NewOfferingDraft>({
        service_level_id: levels[0]?.id ?? '',
        branch_id: branches[0]?.id ?? '',
        zone_id: '',
        priority: '0',
        base_price: '',
        currency: tenantCurrencyIso ?? '',
        display_name: '',
        display_slug: '',
        max_weight_kg: '',
      });
      if (offeringStatusDefault === null) {
        return (
          <div>
            <StateView
              kind="error"
              title={t('catalogServiceOfferings.serviceOfferingsModule.defaultOfferingStatusIs')}
              hint={t('catalogServiceOfferings.serviceOfferingsModule.addTheDefaultService')}
            />
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '14px' }}>
              <Button label={t('catalogServiceOfferings.serviceOfferingsModule.close')} kind="ghost" onClick={() => modal.close()} />
            </div>
          </div>
        );
      }
      return (
        <div>
          <p className="state__hint">
            {t('catalogServiceOfferings.serviceOfferingsModule.createsAnOperatorFacing')}
          </p>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: '140px 1fr',
              gap: '8px',
              alignItems: 'center',
              padding: '0 4px',
              marginTop: 8,
            }}
          >
            <label className="mono" htmlFor="new-of-level">{t('catalogServiceOfferings.serviceOfferingsModule.serviceLevel')}</label>
            <select
              id="new-of-level"
              className="dt-inline-input"
              value={draft.service_level_id}
              onChange={(e) => setDraft((s) => ({ ...s, service_level_id: e.target.value }))}
            >
              {levels.map((lv) => (
                <option key={lv.id} value={lv.id}>{serviceLevelOptionLabel(lv, t)}</option>
              ))}
            </select>
            <label className="mono" htmlFor="new-of-branch">{t('catalogServiceOfferings.serviceOfferingsModule.branch')}</label>
            <select
              id="new-of-branch"
              className="dt-inline-input"
              value={draft.branch_id}
              onChange={(e) => setDraft((s) => ({ ...s, branch_id: e.target.value }))}
            >
              {branches.map((b) => (
                <option key={b.id} value={b.id}>{b.name}</option>
              ))}
            </select>
            <label className="mono" htmlFor="new-of-zone">{t('catalogServiceOfferings.serviceOfferingsModule.zoneOptional')}</label>
            <select
              id="new-of-zone"
              className="dt-inline-input"
              value={draft.zone_id}
              onChange={(e) => setDraft((s) => ({ ...s, zone_id: e.target.value }))}
            >
              <option value="">{t('catalogServiceOfferings.serviceOfferingsModule.allBranchZones')}</option>
              {zones.map((z) => (
                <option key={z.id} value={z.id}>{z.name}</option>
              ))}
            </select>
            <label className="mono" htmlFor="new-of-priority">{t('catalogServiceOfferings.serviceOfferingsModule.priority')}</label>
            <input
              id="new-of-priority"
              type="number"
              className="dt-inline-input"
              value={draft.priority}
              onChange={(e) => setDraft((s) => ({ ...s, priority: e.target.value }))}
            />
            <label className="mono" htmlFor="new-of-name">{t('catalogServiceOfferings.serviceOfferingsModule.displayName')}</label>
            <input
              id="new-of-name"
              className="dt-inline-input"
              placeholder={t('catalogServiceOfferings.serviceOfferingsModule.eGSameDay')}
              value={draft.display_name}
              onChange={(e) => setDraft((s) => ({ ...s, display_name: e.target.value }))}
            />
            <label className="mono" htmlFor="new-of-slug">{t('catalogServiceOfferings.serviceOfferingsModule.displaySlug')}</label>
            <input
              id="new-of-slug"
              className="dt-inline-input"
              placeholder={t('catalogServiceOfferings.serviceOfferingsModule.eGSameDay2')}
              value={draft.display_slug}
              onChange={(e) => setDraft((s) => ({ ...s, display_slug: e.target.value }))}
            />
            <label className="mono" htmlFor="new-of-price">{t('catalogServiceOfferings.serviceOfferingsModule.basePrice')}</label>
            <input
              id="new-of-price"
              type="number"
              className="dt-inline-input"
              placeholder={fill(t('catalogServiceOfferings.serviceOfferingsModule.exampleNumber'), { value: fmtNumber(35) })}
              value={draft.base_price}
              onChange={(e) => setDraft((s) => ({ ...s, base_price: e.target.value }))}
            />
            <label className="mono" htmlFor="new-of-currency">{t('catalogServiceOfferings.serviceOfferingsModule.currency')}</label>
            <input
              id="new-of-currency"
              className="dt-inline-input"
              value={draft.currency}
              onChange={(e) => setDraft((s) => ({ ...s, currency: e.target.value.toUpperCase() }))}
            />
            <label className="mono" htmlFor="new-of-weight">{t('catalogServiceOfferings.serviceOfferingsModule.maxWeightKg')}</label>
            <input
              id="new-of-weight"
              type="number"
              className="dt-inline-input"
              placeholder={fill(t('catalogServiceOfferings.serviceOfferingsModule.exampleNumber'), { value: fmtNumber(30) })}
              value={draft.max_weight_kg}
              onChange={(e) => setDraft((s) => ({ ...s, max_weight_kg: e.target.value }))}
            />
          </div>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '14px' }}>
            <Button label={t('catalogServiceOfferings.serviceOfferingsModule.cancel')} kind="ghost" onClick={() => modal.close()} />
            <Button
              label={t('catalogServiceOfferings.serviceOfferingsModule.create')}
              kind="primary"
              capability={CAP.SERVICE_OFFERINGS_WRITE}
              onClick={async () => {
                if (!draft.service_level_id) {
                  pushToast(t('catalogServiceOfferings.serviceOfferingsModule.serviceLevelIsRequired'), 'warn');
                  return;
                }
                // W56-A closure: branch is REQUIRED for offering create. The
                // canonical RPC accepts null `branch_id` only for system rows;
                // the FE create surface must guard the operator path so an
                // empty `<select>` does not silently submit a null branch.
                if (!draft.branch_id) {
                  pushToast(t('catalogServiceOfferings.serviceOfferingsModule.branchIsRequired'), 'warn');
                  return;
                }
                if (!draft.display_name.trim() || !draft.display_slug.trim()) {
                  pushToast(t('catalogServiceOfferings.serviceOfferingsModule.displayNameAndSlug'), 'warn');
                  return;
                }
                const metadata: Record<string, unknown> = {
                  display: {
                    name: draft.display_name.trim(),
                    slug: draft.display_slug.trim(),
                    // W56-A closure: NO inline 'active' literal. The default
                    // offering status comes from canonical
                    // `service_offering_status` `is_default: true`; the form is
                    // gated behind a fail-loud StateView when missing.
                    status: offeringStatusDefault,
                  },
                  currency: draft.currency || tenantCurrencyIso || '',
                };
                const priceNum = Number(draft.base_price);
                if (Number.isFinite(priceNum) && priceNum > 0) metadata.base_price = priceNum;
                const weightNum = Number(draft.max_weight_kg);
                if (Number.isFinite(weightNum) && weightNum > 0) metadata.max_weight_kg = weightNum;
                try {
                  const result = await createMut.mutateAsync({
                    service_level_id: draft.service_level_id,
                    branch_id: draft.branch_id,
                    zone_id: draft.zone_id || null,
                    priority: Number(draft.priority) || 0,
                    metadata,
                  });
                  const displayName = draft.display_name.trim();
                  const displaySlug = draft.display_slug.trim();
                  const refreshed = await refetchOfferingForReadback(
                    result.service_offering_id,
                    (row) =>
                      row.service_level_id === draft.service_level_id
                      && row.branch_id === draft.branch_id
                      && row.metadata?.display?.name === displayName
                      && row.metadata?.display?.slug === displaySlug,
                  );
                  modal.close();
                  openOfferingDrawer(refreshed);
                  pushToast(fill(t('catalogServiceOfferings.serviceOfferingsModule.offeringCreatedDisplayname'), { displayName: String(displayName) }), 'good');
                } catch (err) {
                  pushToast((err as Error).message, 'danger');
                }
              }}
            />
          </div>
        </div>
      );
    }
    modal.open({ title: t('catalogServiceOfferings.serviceOfferingsModule.newServiceOffering'), body: <NewOfferingForm /> });
  }
  function openEditPrice(offering: ServiceOfferingRow) {
    if (!canWrite) return;
    const m = offering.metadata ?? {};
    function EditPriceForm() {
      const [draft, setDraft] = useState<EditPriceDraft>({
        base_price: m.base_price != null ? String(m.base_price) : '',
        currency: m.currency ?? tenantCurrencyIso ?? '',
      });
      return (
        <div>
          <p className="state__hint">
            {t('catalogServiceOfferings.serviceOfferingsModule.updatesThePriceAnd')}
          </p>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: '140px 1fr',
              gap: '8px',
              alignItems: 'center',
              padding: '0 4px',
              marginTop: 8,
            }}
          >
            <label className="mono" htmlFor="edit-price-amount">{t('catalogServiceOfferings.serviceOfferingsModule.basePrice')}</label>
            <input
              id="edit-price-amount"
              type="number"
              className="dt-inline-input"
              value={draft.base_price}
              onChange={(e) => setDraft((s) => ({ ...s, base_price: e.target.value }))}
            />
            <label className="mono" htmlFor="edit-price-currency">{t('catalogServiceOfferings.serviceOfferingsModule.currency')}</label>
            <input
              id="edit-price-currency"
              className="dt-inline-input"
              value={draft.currency}
              onChange={(e) => setDraft((s) => ({ ...s, currency: e.target.value.toUpperCase() }))}
            />
          </div>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '14px' }}>
            <Button label={t('catalogServiceOfferings.serviceOfferingsModule.cancel')} kind="ghost" onClick={() => modal.close()} />
            <Button
              label={t('catalogServiceOfferings.serviceOfferingsModule.save')}
              kind="primary"
              capability={CAP.SERVICE_OFFERINGS_WRITE}
              onClick={async () => {
                const priceNum = Number(draft.base_price);
                if (!Number.isFinite(priceNum) || priceNum <= 0) {
                  pushToast(t('catalogServiceOfferings.serviceOfferingsModule.basePriceMustBe'), 'warn');
                  return;
                }
                try {
                  const currency = draft.currency || tenantCurrencyIso || '';
                  const result = await updateMut.mutateAsync({
                    service_offering_id: offering.id,
                    price: { base_price: priceNum, currency },
                  });
                  const refreshed = await refetchOfferingForReadback(
                    result.service_offering_id,
                    (row) =>
                      row.metadata?.base_price === priceNum
                      && row.metadata?.currency === currency
                      && row.metadata?.display?.name === m.display?.name,
                  );
                  modal.close();
                  openOfferingDrawer(refreshed, 'pricing');
                  pushToast(fill(t('catalogServiceOfferings.serviceOfferingsModule.priceUpdatedValue'), { value: String(offering.metadata?.display?.name ?? t('catalogServiceOfferings.serviceOfferingsModule.serviceOffering')) }), 'good');
                } catch (err) {
                  pushToast((err as Error).message, 'danger');
                }
              }}
            />
          </div>
        </div>
      );
    }
    modal.open({
      title: fill(t('catalogServiceOfferings.serviceOfferingsModule.editPriceValue'), { value: String(offering.metadata?.display?.name ?? t('catalogServiceOfferings.serviceOfferingsModule.serviceOffering')) }),
      body: <EditPriceForm />,
    });
  }

  // ---------- Drawer (multi-tab) ----------
  function openOfferingDrawer(
    offering: ServiceOfferingRow,
    tab: DrawerTabKey = 'profile',
    related?: Partial<ProductContextSetupReadback>,
  ) {
    setSelectedId(offering.id);
    drawer.open({
      title: fill(t('catalogServiceOfferings.serviceOfferingsModule.offeringValue'), { value: String(offering.metadata?.display?.name ?? t('catalogServiceOfferings.serviceOfferingsModule.serviceOffering')) }),
      size: 'lg',
      deepLink: `/catalog/service-offerings?focus=${encodeURIComponent(offering.id)}`,
      body: renderDrawerBody(offering, tab, related),
      onClose: () => setSelectedId(null),
    });
  }
  function switchTab(offering: ServiceOfferingRow, next: DrawerTabKey) {
    drawer.open({
      title: fill(t('catalogServiceOfferings.serviceOfferingsModule.offeringValue'), { value: String(offering.metadata?.display?.name ?? t('catalogServiceOfferings.serviceOfferingsModule.serviceOffering')) }),
      size: 'lg',
      deepLink: `/catalog/service-offerings?focus=${encodeURIComponent(offering.id)}`,
      body: renderDrawerBody(offering, next),
      onClose: () => setSelectedId(null),
    });
  }

  useEffect(() => {
    if (!focusParam) {
      openedFocusRef.current = null;
      return undefined;
    }
    if (openedFocusRef.current === focusParam) return undefined;
    if (!focusTarget) return undefined;
    const frame = window.requestAnimationFrame(() => {
      openOfferingDrawer(focusTarget);
      openedFocusRef.current = focusParam;
    });
    return () => window.cancelAnimationFrame(frame);
    // openOfferingDrawer closes over current catalog indexes; the next frame follows grid layout.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusParam, focusTarget]);

  function renderDrawerBody(
    offering: ServiceOfferingRow,
    tab: DrawerTabKey,
    related?: Partial<ProductContextSetupReadback>,
  ): ReactNode {
    const lv = related?.level ?? levelById.get(offering.service_level_id);
    const branch = related?.branch ?? branchById.get(offering.branch_id);
    const zone = related?.zone !== undefined
      ? related.zone
      : offering.zone_id ? zoneById.get(offering.zone_id) ?? null : null;
    const status = effectiveStatus(offering);
    const m = offering.metadata ?? {};

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
          {(() => {
            // Strict canonical resolver — `service_levels.metadata.tone` is
            // the SSOT. Missing canonical row surfaces a `danger` chip with
            // `(missing)` marker so operators see the gap rather than a
            // silent neutral default.
            const lvLabel = lv?.name ?? t('catalogServiceOfferings.serviceOfferingsModule.serviceLevelNotLinked');
            return (
              <Chip
                label={serviceLevelChipLabel(lv, lvLabel)}
                kind={serviceLevelChipTone(lv)}
                size="xs"
                className="mono"
                title={serviceLevelChipTitle(lv, lvLabel, t)}
              />
            );
          })()}
          <Chip label={lookupDisplayLabel('service_offering_status', status)} kind={statusTone(status)} size="xs" />
          <Chip
            label={
              <span className="mono">{`${m.base_price ?? '—'} ${m.currency ?? tenantCurrencyIso ?? '—'}`}</span>
            }
            kind="neutral"
            size="xs"
          />
        </div>

        <div
          role="tablist"
          aria-label={t('catalogServiceOfferings.serviceOfferingsModule.offeringDetails')}
          data-testid="offering-drawer-tabs"
          style={{
            display: 'flex',
            gap: '4px',
            margin: '0 14px 6px',
            borderBottom: '1px solid var(--line)',
            paddingBottom: '4px',
            flexWrap: 'wrap',
          }}
        >
          {drawerTabs(t).map((entry) => {
            const isActive = entry.key === tab;
            return (
              <button
                key={entry.key}
                type="button"
                role="tab"
                aria-selected={isActive}
                data-testid={`offering-tab-${entry.key}`}
                className={`btn btn--sm ${isActive ? 'btn--primary' : 'btn--ghost'}`}
                style={{ fontSize: '12px' }}
                onClick={() => switchTab(offering, entry.key)}
              >
                {entry.label}
              </button>
            );
          })}
        </div>

        <div style={{ padding: '6px 14px 16px' }}>
          {tab === 'profile' ? (
            <ProfileTab
              offering={offering}
              level={lv}
              branch={branch}
              zone={zone}
              fmtDateTime={fmtDateTime}
              tenantCurrencyIso={tenantCurrencyIso}
            />
          ) : tab === 'pricing' ? (
            <PricingTab
              offering={offering}
              fmtCurrency={fmtCurrency}
              canWrite={canWrite}
              onEditPrice={() => openEditPrice(offering)}
              tenantCurrencyIso={tenantCurrencyIso}
            />
          ) : tab === 'sla' ? (
            <SlaTab offering={offering} level={lv} fmtDateTime={fmtDateTime} />
          ) : tab === 'coverage' ? (
            <CoverageTab offering={offering} branch={branch} zone={zone} />
          ) : (
            <SubscriptionsTab
              offering={offering}
              registryAvailable={subsRegistryAvailable}
              liveCount={liveSubsByOffering.get(offering.id)}
              fmtNumber={fmtNumber}
            />
          )}
        </div>
      </div>
    );
  }

  // ---------- Page ----------
  const headerActions: ReactNode[] = [
    <Button
      key="setup"
      label={t('catalogServiceOfferings.serviceOfferingsModule.productSetup')}
      iconName="settings"
      kind="ghost"
      capabilities={[CAP.SERVICE_OFFERINGS_WRITE, CAP.AGREEMENTS_WRITE, CAP.BRANCHES_WRITE]}
      onClick={openProductContextSetup}
    />,
    <Button
      key="new"
      label={t('catalogServiceOfferings.serviceOfferingsModule.newOffering')}
      iconName="plus"
      kind="primary"
      capability={CAP.SERVICE_OFFERINGS_WRITE}
      onClick={openCreate}
    />,
    <Button
      key="manage-levels"
      label={t('catalogServiceOfferings.serviceOfferingsModule.manageLevels')}
      iconName="edit"
      kind="ghost"
      capability={CAP.AGREEMENTS_WRITE}
      onClick={openManageLevels}
    />,
    <Button
      key="toggle"
      label={t('catalogServiceOfferings.serviceOfferingsModule.toggleAvailability')}
      iconName="rotate"
      kind="ghost"
      capability={CAP.SERVICE_OFFERINGS_WRITE}
      onClick={bulkToggleAvailability}
    />,
    <Button
      key="archive"
      label={t('catalogServiceOfferings.serviceOfferingsModule.archive')}
      iconName="trash"
      kind="ghost"
      capability={CAP.SERVICE_OFFERINGS_WRITE}
      onClick={bulkArchive}
    />,
  ];

  if (!canRead) {
    return (
      <div className="page">
        <PageHeader
          eyebrow={t('catalogServiceOfferings.serviceOfferingsModule.catalog')}
          titleAccent={t('catalogServiceOfferings.serviceOfferingsModule.service')}
          titlePlain={t('catalogServiceOfferings.serviceOfferingsModule.offeringsPricingSlaCatalog')}
        />
        <StateView
          kind="denied"
          capability={CAP.SERVICE_OFFERINGS_READ}
          hint={t('catalogServiceOfferings.serviceOfferingsModule.youDoNotHave')}
        />
      </div>
    );
  }

  return (
    <div className="page">
      <PageHeader
        eyebrow={t('catalogServiceOfferings.serviceOfferingsModule.catalog')}
        titleAccent={t('catalogServiceOfferings.serviceOfferingsModule.service')}
        titlePlain={t('catalogServiceOfferings.serviceOfferingsModule.offeringsPricingSlaCatalog')}
        pills={[
          <ScopePill key="scope" scopeType="tenant" scopeId={tenantId} />,
          <Chip
            key="src"
            label={t('catalogServiceOfferings.serviceOfferingsModule.serviceTiersServiceOptions')}
            kind="neutral"
            size="xs"
            className="mono"
          />,
          <Chip
            key="cap"
            label={t('catalogServiceOfferings.serviceOfferingsModule.catalogAccessCatalogUpdate')}
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
        <StateView kind="error" hint={t('catalogServiceOfferings.serviceOfferingsModule.couldNotLoadService')} />
      ) : isLoading ? (
        <StateView kind="loading" hint={t('catalogServiceOfferings.serviceOfferingsModule.loadingOfferings')} />
      ) : (
        <>
          <div className="kpi-strip" data-testid="offerings-kpi-strip">
            <KPICard
              label={t('catalogServiceOfferings.serviceOfferingsModule.totalOfferings')}
              value={fmtNumber(totalOfferings)}
              delta={t('catalogServiceOfferings.serviceOfferingsModule.acrossAllTiers')}
              tone="info"
            />
            <KPICard
              label={t('catalogServiceOfferings.serviceOfferingsModule.active')}
              value={fmtNumber(activeOfferings)}
              delta={fill(t('catalogServiceOfferings.serviceOfferingsModule.nonActiveOfferingCount'), {
                count: fmtNumber(totalOfferings - activeOfferings),
              })}
              tone={
                catalogKpiThresholds?.active_offerings_min != null
                  ? activeOfferings >= catalogKpiThresholds.active_offerings_min
                    ? 'good'
                    : 'warn'
                  : 'neutral'
              }
            />
            <KPICard
              label={t('catalogServiceOfferings.serviceOfferingsModule.archived')}
              value={fmtNumber(archivedOfferings)}
              delta={t('catalogServiceOfferings.serviceOfferingsModule.historicalRoster')}
              tone={
                catalogKpiThresholds?.archived_offerings_max != null
                  ? archivedOfferings <= catalogKpiThresholds.archived_offerings_max
                    ? 'good'
                    : 'neutral'
                  : 'neutral'
              }
            />
            <KPICard
              label={t('catalogServiceOfferings.serviceOfferingsModule.priceRange')}
              value={
                priceRange
                  ? `${fmtCurrency(priceRange.min, priceRange.ccy)} – ${fmtCurrency(priceRange.max, priceRange.ccy)}`
                  : '—'
              }
              delta={t('catalogServiceOfferings.serviceOfferingsModule.activeOfferings')}
              tone="neutral"
            />
          </div>

          {/* Service-level distribution (mini-donut as labeled chip cluster).
              Each chip shows the level count + a pct of the active total —
              row-driven, no per-tier branching in the JSX. */}
          <div
            className="section"
            data-testid="offerings-distribution"
            style={{ padding: '0 16px 6px' }}
          >
            <div className="section-eyebrow" style={{ marginTop: '6px' }}>
              {t('catalogServiceOfferings.serviceOfferingsModule.serviceLevelDistribution')}
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', marginTop: '4px' }}>
              {distribution.length === 0 ? (
                <span className="state__hint" style={{ fontSize: '12px' }}>
                  {t('catalogServiceOfferings.serviceOfferingsModule.noActiveOfferingsYet')}
                </span>
              ) : (
                distribution.map((d) => {
                  // Strict canonical resolver — `service_levels.metadata.tone`
                  // is the SSOT. Missing row → `danger` chip + `(missing)`
                  // marker.
                  const dTone = serviceLevelChipTone(d.level);
                  return (
                    <Chip
                      key={d.id}
                      label={
                        <span className="mono">
                          {serviceLevelChipLabel(d.level, d.label)} · {fmtNumber(d.count)} ({d.pct}%)
                        </span>
                      }
                      kind={dTone}
                      size="xs"
                      title={fill(t('catalogServiceOfferings.serviceOfferingsModule.valueCountActiveOfferings'), { value: String(serviceLevelChipTitle(d.level, d.label, t)), count: String(d.count) })}
                    />
                  );
                })
              )}
            </div>
          </div>

          <div
            className="offerings-grid"
            data-testid="offerings-grid"
            role="list"
            aria-label={t('catalogServiceOfferings.serviceOfferingsModule.serviceOfferings')}
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
              gap: '14px',
              padding: '12px 16px',
            }}
          >
            {offerings.map((o) => {
              const lv = levelById.get(o.service_level_id);
              const branch = branchById.get(o.branch_id);
              const status = effectiveStatus(o);
              const m = o.metadata ?? {};
              const display = serviceOfferingDisplay(o, lv, branch, t);
              const isFocused = o.id === selectedId;
              const features = m.included_features ?? [];
              // Strict canonical resolver — `service_levels.metadata.tone`
              // is the SSOT. Missing canonical row surfaces a `danger` chip
              // with `(missing)` marker rather than a silent default.
              const lvLabel = lv?.name ?? t('catalogServiceOfferings.serviceOfferingsModule.serviceLevelNotLinked');
              return (
                <article
                  key={o.id}
                  role="listitem"
                  className={`card ${isFocused ? 'card--raise' : ''}`.trim()}
                  data-testid={`offering-card-${o.id}`}
                  aria-current={isFocused ? 'true' : undefined}
                  tabIndex={0}
                  onClick={() => openOfferingDrawer(o)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      openOfferingDrawer(o);
                    }
                  }}
                  style={{
                    cursor: 'pointer',
                    display: 'grid',
                    gridTemplateRows: 'auto auto auto auto 1fr auto',
                    gap: '8px',
                    minHeight: '230px',
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
                    <span className="mono" style={{ fontSize: '11px', color: 'var(--ink-3)' }}>
                      {display.slug}
                    </span>
                    <Chip
                      label={serviceLevelChipLabel(lv, lvLabel)}
                      kind={serviceLevelChipTone(lv)}
                      size="xs"
                      className="mono"
                      title={serviceLevelChipTitle(lv, lvLabel, t)}
                    />
                    <Chip label={lookupDisplayLabel('service_offering_status', status)} kind={statusTone(status)} size="xs" />
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
                    {display.name}
                  </h3>

                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'baseline',
                      gap: '6px',
                      flexWrap: 'wrap',
                    }}
                  >
                    <span
                      className="mono"
                      data-testid={`offering-price-${o.id}`}
                      style={{
                        fontSize: '20px',
                        fontWeight: 600,
                        letterSpacing: '-0.01em',
                      }}
                    >
                      {m.base_price != null ? fmtCurrency(m.base_price, m.currency ?? tenantCurrencyIso ?? '') : '—'}
                    </span>
                    <span className="mono" style={{ fontSize: '11px', color: 'var(--ink-3)' }}>
                      {fill(t('catalogServiceOfferings.serviceOfferingsModule.baseWeightLimit'), {
                        weight: m.max_weight_kg == null ? '?' : fmtNumber(m.max_weight_kg),
                      })}
                    </span>
                  </div>

                  <div
                    style={{
                      display: 'flex',
                      gap: '4px',
                      flexWrap: 'wrap',
                      alignContent: 'flex-start',
                    }}
                  >
                    <Chip
                      label={
                        <span className="mono">
                          {lv
                            ? fill(t('catalogServiceOfferings.serviceOfferingsModule.slaDuration'), {
                                duration: formatSla(lv.metadata?.sla_minutes, fmtNumber),
                              })
                            : t('catalogServiceOfferings.serviceOfferingsModule.slaLevelMissing')}
                        </span>
                      }
                      kind={serviceLevelChipTone(lv)}
                      size="xs"
                      title={lv?.metadata?.sla_label ?? t('catalogServiceOfferings.serviceOfferingsModule.noSlaTargetSet')}
                    />
                    {(() => {
                      // W58-Catalog+Customers REDO closure: chip cap is
                      // policy-driven via canonical
                      // `catalog_kpi_thresholds.card_feature_chips_max`. If
                      // the canonical row is missing (or the cap is not a
                      // positive number) the strip fails-closed (no chips)
                      // instead of silently consuming an FE literal.
                      const featureCap = catalogKpiThresholds?.card_feature_chips_max;
                      const chipsMax =
                        typeof featureCap === 'number' && featureCap > 0 ? featureCap : 0;
                      const visible = features.slice(0, chipsMax);
                      const remainder = features.slice(chipsMax);
                      return (
                        <>
                          {visible.map((f, i) => (
                            <Chip
                              key={`${o.id}-feat-${i}`}
                              label={<span style={{ fontSize: '10px' }}>{f}</span>}
                              kind="neutral"
                              size="xs"
                              title={f}
                            />
                          ))}
                          {remainder.length > 0 ? (
                            <Chip
                              label={<span className="mono">+{remainder.length}</span>}
                              kind="info"
                              size="xs"
                              title={remainder.join(' · ')}
                            />
                          ) : null}
                        </>
                      );
                    })()}
                  </div>

                  <footer
                    style={{
                      display: 'flex',
                      gap: '6px',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      paddingTop: '6px',
                      borderTop: '1px solid var(--line)',
                      fontSize: '11px',
                      color: 'var(--ink-3)',
                    }}
                  >
                    <span className="mono" title={branch?.name ?? t('catalogServiceOfferings.serviceOfferingsModule.branchNotLinked')}>
                      {branch?.city ?? branch?.name ?? t('catalogServiceOfferings.serviceOfferingsModule.branchNotLinked')}
                    </span>
                    {!canWrite ? (
                      <CapabilityLock capability={CAP.SERVICE_OFFERINGS_WRITE} />
                    ) : (
                      <span className="mono">{fill(t('catalogServiceOfferings.serviceOfferingsModule.priorityPriority'), { priority: String(o.priority) })}</span>
                    )}
                  </footer>
                </article>
              );
            })}
          </div>

          {offerings.length === 0 ? (
            <div>
              <StateView
                kind="empty"
                hint={t('catalogServiceOfferings.serviceOfferingsModule.noServiceOfferingsConfigured')}
              />
              <div style={{ display: 'flex', justifyContent: 'center', marginTop: 10 }}>
                <Button
                  label={t('catalogServiceOfferings.serviceOfferingsModule.productSetup')}
                  iconName="settings"
                  kind="primary"
                  capabilities={[CAP.SERVICE_OFFERINGS_WRITE, CAP.AGREEMENTS_WRITE, CAP.BRANCHES_WRITE]}
                  onClick={openProductContextSetup}
                />
              </div>
            </div>
          ) : null}
        </>
      )}

      {drawer.node}
      {modal.node}
    </div>
  );
}

// ---------- Drawer tabs ----------

function drawerTabs(t: Translate) {
  return [
  { key: 'profile', label: t('catalogServiceOfferings.drawerTabs.profile') },
  { key: 'pricing', label: t('catalogServiceOfferings.drawerTabs.pricing') },
  { key: 'sla', label: t('catalogServiceOfferings.drawerTabs.slaTerms') },
  { key: 'coverage', label: t('catalogServiceOfferings.drawerTabs.coverageZones') },
  { key: 'subscriptions', label: t('catalogServiceOfferings.drawerTabs.activeSubscriptions') },
  ] as const;
}

type DrawerTabKey = ReturnType<typeof drawerTabs>[number]['key'];

interface ProfileTabProps {
  offering: ServiceOfferingRow;
  level: ServiceLevelRow | undefined;
  branch: BranchRow | undefined;
  zone: ZoneRow | null;
  fmtDateTime: (iso: string | number | Date) => string;
  /**
   * Tenant default currency resolved by the parent module from the canonical
   * `tenant_currency.iso_code` settings ladder. Pass `null` when the canonical
   * row is unseeded — ProfileTab falls through to '—' display rather than
   * silently presenting a hardcoded ISO code (W34 closure of audit-flagged
   * ReferenceError; the constant was previously read from outside the
   * function's closure scope).
   */
  tenantCurrencyIso: string | null;
}

function ProfileTab({ offering, level, branch, zone, fmtDateTime, tenantCurrencyIso }: ProfileTabProps) {
  const { t, fmtNumber } = useI18n();
  const m = offering.metadata ?? {};
  const display = serviceOfferingDisplay(offering, level, branch, t);
  const displayStatus = lookupDisplayLabel('service_offering_status', effectiveStatus(offering));
  const rows: KvRow[] = [
    { key: 'name', label: t('catalogServiceOfferings.profileTab.name'), value: display.name },
    { key: 'slug', label: t('catalogServiceOfferings.profileTab.slug'), value: display.slug, mono: true },
    {
      key: 'service_level',
      label: t('catalogServiceOfferings.profileTab.serviceLevel'),
      value: level?.name ?? t('catalogServiceOfferings.profileTab.serviceLevelNotLinked'),
    },
    { key: 'branch', label: t('catalogServiceOfferings.profileTab.branch'), value: branch?.name ?? t('catalogServiceOfferings.profileTab.branchNotLinked'), mono: Boolean(branch) },
    {
      key: 'zone',
      label: t('catalogServiceOfferings.profileTab.zone'),
      value: zone ? `${zone.name}${zone.slug ? ` (${zone.slug})` : ''}` : t('catalogServiceOfferings.profileTab.allBranchZones'),
      mono: true,
    },
    {
      key: 'base_price',
      label: t('catalogServiceOfferings.profileTab.basePrice'),
      value: m.base_price != null ? `${m.base_price} ${m.currency ?? tenantCurrencyIso ?? '—'}` : '—',
      mono: true,
    },
    { key: 'currency', label: t('catalogServiceOfferings.profileTab.currency'), value: m.currency ?? '—', mono: true },
    {
      key: 'sla_minutes',
      label: t('catalogServiceOfferings.profileTab.sla'),
      value: level?.metadata?.sla_minutes != null
        ? fill(t('catalogServiceOfferings.profileTab.slaDuration'), {
            duration: formatSla(level.metadata.sla_minutes, fmtNumber),
            minutes: fmtNumber(level.metadata.sla_minutes),
          })
        : '—',
      mono: true,
    },
    { key: 'max_weight_kg', label: t('catalogServiceOfferings.profileTab.maxWeightKg'), value: m.max_weight_kg ?? '—', mono: true },
    {
      key: 'effective',
      label: t('catalogServiceOfferings.profileTab.effective'),
      value: `${fmtDateTime(offering.effective_from)} → ${
        offering.effective_to ? fmtDateTime(offering.effective_to) : t('catalogServiceOfferings.profileTab.noEnd')
      }`,
      mono: true,
    },
    { key: 'priority', label: t('catalogServiceOfferings.profileTab.priority'), value: offering.priority, mono: true },
    { key: 'is_active', label: t('catalogServiceOfferings.profileTab.active'), value: offering.is_active ? t('catalogServiceOfferings.profileTab.yes') : t('catalogServiceOfferings.profileTab.no') },
    { key: 'status', label: t('catalogServiceOfferings.profileTab.status'), value: displayStatus },
  ];
  return <KvGrid rows={rows} />;
}

interface PricingTabProps {
  offering: ServiceOfferingRow;
  fmtCurrency: (n: number, ccy?: string) => string;
  canWrite: boolean;
  onEditPrice: () => void;
  /**
   * Tenant default currency resolved by the parent module. Same scoping
   * contract as ProfileTab — `null` falls through to `'—'` display when the
   * canonical `tenant_currency.iso_code` row is unseeded. (W34c closure of
   * audit-flagged ReferenceError; the constant was previously read from
   * outside this function's closure scope.)
   */
  tenantCurrencyIso: string | null;
}

function PricingTab({ offering, fmtCurrency, canWrite, onEditPrice, tenantCurrencyIso }: PricingTabProps) {
  const { t } = useI18n();
  const m = offering.metadata ?? {};
  const breakpoints = m.pricing_breakpoints ?? [];
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap', marginBottom: '8px' }}>
        <Chip
          label={
            <span className="mono">
              {fill(t('catalogServiceOfferings.pricingTab.basePriceValue'), {
                price: m.base_price != null ? fmtCurrency(m.base_price, m.currency ?? tenantCurrencyIso ?? '') : '—',
              })}
            </span>
          }
          kind="info"
          size="xs"
        />
        <Chip
          label={
            <span className="mono">
              {fill(t('catalogServiceOfferings.pricingTab.currencyValue'), { currency: m.currency ?? tenantCurrencyIso ?? '—' })}
            </span>
          }
          kind="neutral"
          size="xs"
        />
        <div style={{ flex: 1 }} />
        <Button
          label={t('catalogServiceOfferings.pricingTab.editPrice')}
          iconName="edit"
          kind="primary"
          capability={CAP.SERVICE_OFFERINGS_WRITE}
          onClick={onEditPrice}
          disabled={!canWrite}
          size="sm"
        />
      </div>
      <div className="section-eyebrow" style={{ marginTop: '8px' }}>
        {t('catalogServiceOfferings.pricingTab.pricingBreakpoints')}
      </div>
      {breakpoints.length === 0 ? (
        <StateView kind="empty" hint={t('catalogServiceOfferings.pricingTab.noWeightTierBreakpoints')} />
      ) : (
        <ul style={{ listStyle: 'none', padding: 0, margin: '6px 0 0', display: 'grid', gap: '4px' }}>
          {breakpoints.map((bp, i) => (
            <li
              key={`${offering.id}-bp-${i}`}
              data-testid={`offering-pricing-bp-${i}`}
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                gap: '8px',
                padding: '6px 8px',
                background: 'var(--surface-2)',
                borderRadius: 4,
                fontSize: '12px',
              }}
            >
              <span className="mono">{fill(t('catalogServiceOfferings.pricingTab.upToUpTo'), { up_to_kg: String(bp.up_to_kg) })}</span>
              <span className="mono" style={{ fontWeight: 600 }}>
                {fmtCurrency(bp.price, m.currency ?? tenantCurrencyIso ?? '')}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

interface SlaTabProps {
  offering: ServiceOfferingRow;
  level: ServiceLevelRow | undefined;
  fmtDateTime: (iso: string | number | Date) => string;
}

function SlaTab({ offering, level, fmtDateTime }: SlaTabProps) {
  const { t, fmtNumber } = useI18n();
  if (!level) {
    return <StateView kind="empty" hint={t('catalogServiceOfferings.slaTab.serviceTierDetailsAre')} />;
  }
  const lm = level.metadata ?? {};
  const slaRows: KvRow[] = [
    { key: 'tier', label: t('catalogServiceOfferings.slaTab.tier'), value: lookupDisplayLabel('service_level_tier', lm.tier), mono: true },
    {
      key: 'sla_minutes',
      label: t('catalogServiceOfferings.slaTab.slaPromise'),
      value: lm.sla_minutes != null
        ? fill(t('catalogServiceOfferings.slaTab.slaDuration'), {
            duration: formatSla(lm.sla_minutes, fmtNumber),
            minutes: fmtNumber(lm.sla_minutes),
          })
        : '—',
      mono: true,
    },
    { key: 'sla_label', label: t('catalogServiceOfferings.slaTab.slaLabel'), value: lm.sla_label ?? '—' },
    { key: 'priority_rank', label: t('catalogServiceOfferings.slaTab.priorityRank'), value: lm.priority_rank ?? '—', mono: true },
  ];
  const lvRows: KvRow[] = [
    { key: 'name', label: t('catalogServiceOfferings.slaTab.name'), value: level.name },
    { key: 'description', label: t('catalogServiceOfferings.slaTab.description'), value: level.description ?? '—' },
    { key: 'is_active', label: t('catalogServiceOfferings.slaTab.active'), value: level.is_active ? t('catalogServiceOfferings.slaTab.yes') : t('catalogServiceOfferings.slaTab.no') },
    {
      key: 'updated_at',
      label: t('catalogServiceOfferings.slaTab.updated'),
      value: level.updated_at ? fmtDateTime(level.updated_at) : '—',
      mono: true,
    },
  ];
  return (
    <div>
      <div className="section-eyebrow" style={{ marginTop: 0, marginBottom: '4px' }}>
        {t('catalogServiceOfferings.slaTab.slaPromise')}
      </div>
      <KvGrid rows={slaRows} />
      <div className="section-eyebrow" style={{ marginTop: '12px', marginBottom: '4px' }}>
        {t('catalogServiceOfferings.slaTab.serviceLevel')}
      </div>
      <KvGrid rows={lvRows} />
    </div>
  );
}

interface CoverageTabProps {
  offering: ServiceOfferingRow;
  branch: BranchRow | undefined;
  zone: ZoneRow | null;
}

function CoverageTab({ offering, branch, zone }: CoverageTabProps) {
  const { t } = useI18n();
  const m = offering.metadata ?? {};
  const summary = m.coverage_summary;
  return (
    <div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', marginBottom: '8px' }}>
        <Chip
          label={<span className="mono">{fill(t('catalogServiceOfferings.coverageTab.branchName'), { name: branch?.name ?? t('catalogServiceOfferings.coverageTab.branchNotLinked') })}</span>}
          kind="info"
          size="xs"
        />
        {zone ? (
          <Chip
            label={<span className="mono">{fill(t('catalogServiceOfferings.coverageTab.zoneName'), { name: String(zone.name) })}</span>}
            kind="good"
            size="xs"
          />
        ) : (
          <Chip
            label={<span className="mono">{t('catalogServiceOfferings.coverageTab.allBranchZones')}</span>}
            kind="neutral"
            size="xs"
          />
        )}
      </div>
      {summary ? (
        <p style={{ margin: '6px 0', fontSize: '12px' }}>{summary}</p>
      ) : null}
      <div className="state__hint" style={{ marginTop: '8px', fontSize: '12px' }}>
        Coverage tracked at zone level — see{' '}
        <a href="/network/zones" className="link" data-testid="offering-coverage-zones-link">
          /network/zones
        </a>
        .
      </div>
    </div>
  );
}

interface SubscriptionsTabProps {
  offering: ServiceOfferingRow;
  registryAvailable: boolean;
  liveCount: number | undefined;
  fmtNumber: (n: number) => string;
}

function SubscriptionsTab({
  offering,
  registryAvailable,
  liveCount,
  fmtNumber,
}: SubscriptionsTabProps) {
  const { t } = useI18n();
  const showLive = registryAvailable && liveCount != null;
  const value = showLive ? liveCount : undefined;
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: '8px', flexWrap: 'wrap' }}>
        <span
          className="mono"
          data-testid="offering-subscriptions-count"
          style={{ fontSize: '24px', fontWeight: 600 }}
        >
          {value != null ? fmtNumber(value) : '—'}
        </span>
        <span className="mono" style={{ fontSize: '12px', color: 'var(--ink-3)' }}>
          {t('catalogServiceOfferings.subscriptionsTab.activeSubscriptions')}
        </span>
        {!registryAvailable ? (
          <Chip
            label={t('catalogServiceOfferings.subscriptionsTab.unavailable')}
            kind="danger"
            size="xs"
            title={t('catalogServiceOfferings.subscriptionsTab.liveSubscriptionCountIs')}
          />
        ) : null}
      </div>
      <p className="state__hint" style={{ marginTop: '8px', fontSize: '12px' }}>
        {registryAvailable
          ? t('catalogServiceOfferings.subscriptionsTab.liveCountDerivedFrom')
          : t('catalogServiceOfferings.subscriptionsTab.liveSubscriptionCountIs2')}
      </p>
    </div>
  );
}
