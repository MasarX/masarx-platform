// geocoding.tsx — Network · Geocoding & addresses (4-tab inspection surface).
//
// Operator surface for address quality, geocode coverage, canonical references,
// and resolved policy snapshots. Tabs:
//   1. Addresses    — useResourceList('addresses')
//   2. Geocodes     — useResourceList('geocodes')
//   3. Canonical    — canonical_cities + canonical_districts
//   4. Policy       — useResolveSettings('map_policy') +
//                     useResolveSettings('address_policy') +
//                     useResolveSettings('address_resolution_policy') +
//                     useResolveSettings('geocoding_policy') +
//                     useResourceList('geocoding_attempts') (recent ledger)
//
// Canonical write affordance is limited to linked-shipment geocode requeue:
// `shipments.update_geocode` -> `api.ui_execute_shipment_update_geocode_v1`
// starts `shipment_update_geocode_v1` through workflow runtime. Direct
// address/geocode table writes stay out of this module.
//
// W56-C SSOT (E2 closure P1 #5) — `<ScopePill scopeType="tenant" .../>`
// uses the literal `"tenant"` because the addresses / geocodes / canonical
// reference resources are tenant-tier per the canonical RLS scope contract
// (`scope_type_registry`). The literal IS canonical per-module; the
// `scopeId` value remains identity-derived (`tenantId` from
// `scope.tenant?.id`).

import { useMemo, useState, type ReactNode } from 'react';
import { PageHeader } from '@/components/PageHeader';
import { Chip } from '@/components/Chip';
import { ScopePill } from '@/components/ScopePill';
import { KPICard } from '@/components/KPICard';
import { Button } from '@/components/Button';
import { DataTable, type DataTableColumn } from '@/components/DataTable';
import { KvGrid, type KvRow } from '@/components/KvGrid';
import { StateView } from '@/components/StateView';
import { GeoPointMap, type GeoPoint, type GeoPointTone } from '@/components/GeoPointMap';
import {
  SettingsChangeForm,
  type SettingsChangePreviewResult,
  type SettingsScopeTypeRegistryRow,
} from '@/components/SettingsChangeForm';
import { pushToast } from '@/components/toastStore';
import {
  useApplySettingsValue,
  useProposeSettingsChange,
  useRequeueShipmentGeocode,
  useResourceList,
  useResolveSettings,
} from '@/lib/queries';
import { useIdentity, useCapability } from '@/lib/identity';
import { englishT, fill, useI18n, useT, type Translate } from '@/lib/i18n';
import { useDrawer, useModal } from '@/hooks/useOverlay';
import { CAP } from '@/lib/capabilities';
import type { ScopeType, SettingsResolution } from '@/types/domain';
import { getSettingsCategories, lookupRow, type ShipmentUpdateGeocodeResult } from '@/lib/api';
import type { ChipKind } from '@/components/Chip';
import { useConsoleNavigator } from '@/lib/useConsoleNavigator';

type TabKey = 'addresses' | 'geocodes' | 'canonical' | 'policy';

// Phase G1 (Wave 6) — schema-drift alignment per
// `__audit__/SCHEMA-DRIFT/NETWORK.md` §12 (AddressRow):
// Canonical `public.addresses` (id, organization_id, client_id, raw_input,
// normalized_line1, normalized_line2, district, city, province, postal_code,
// country, building_number, additional_directions, validation_status,
// correction_count, last_corrected_at, is_pii, created_at, updated_at).
//
// W20 — added canonical column shadow for the deferred RENAME item
// (per `__audit__/SCHEMA-DRIFT/NETWORK.md` §12). The FE row interface now
// mirrors canonical `public.addresses.normalized_line1` alongside the FE
// alias `street`. Resolver helper `addressStreetOf(addr)` prefers
// canonical when present and falls back to FE alias for legacy seeds.
interface AddressRow extends Record<string, unknown> {
  id: string;                    // → addresses.id
  /** Canonical normalized_line1. */
  normalized_line1?: string;
  /** @deprecated FE alias for canonical normalized_line1. Resolve via
   *  `addressStreetOf(addr)`. */
  street?: string;
  district?: string;             // → addresses.district
  city?: string;                 // → addresses.city
  country?: string;              // → addresses.country
  postal_code?: string;          // → addresses.postal_code
  validation_status?: string;    // → addresses.validation_status
}

/** Resolve canonical normalized_line1 for an address row (W20). Prefers
 *  canonical column; falls back to FE alias `street`. */
function addressStreetOf(a: AddressRow | undefined | null): string | undefined {
  if (!a) return undefined;
  if (typeof a.normalized_line1 === 'string' && a.normalized_line1.length > 0) return a.normalized_line1;
  if (typeof a.street === 'string' && a.street.length > 0) return a.street;
  return undefined;
}

// Mirror canonical `public.geocodes` columns from
// supabase/migrations/202510110006_domain_tables_partitioned.sql:326.
// Phase C2 audit (NETWORK §2.4): FE used `provider`/`confidence`/`cached_at`,
// canonical is `provider_name`/`confidence_score`/`geocoded_at`. Both legacy
// keys remain in the row shape so seed-only fallbacks render unchanged.
interface GeocodeRow extends Record<string, unknown> {
  id: string;
  address_id?: string;
  provider_name?: string;
  /** Legacy seed alias for `provider_name`. Kept until seed migrates. */
  provider?: string;
  lat?: number;
  lng?: number;
  confidence_score?: number;
  /** Legacy seed alias for `confidence_score`. Kept until seed migrates. */
  confidence?: number;
  geocoded_at?: string;
  /** Legacy seed alias for `geocoded_at`. */
  cached_at?: string;
}

// Mirror canonical `public.canonical_cities` columns (name_canonical, name_arabic,
// country_code, alternate_names). Legacy seed aliases are accepted via fall-throughs.
interface CanonicalCityRow extends Record<string, unknown> {
  id: string;
  name_canonical?: string;
  name_arabic?: string;
  country_code?: string;
  alternate_names?: string[];
  // Legacy seed aliases (kept for older fixtures):
  code?: string;
  name?: string;
  country?: string;
  alt_names?: string[];
}

// Mirror `public.canonical_districts` columns (name_canonical, name_arabic, city_id).
interface CanonicalDistrictRow extends Record<string, unknown> {
  id: string;
  name_canonical?: string;
  name_arabic?: string;
  city_id?: string;
  // Legacy aliases:
  code?: string;
  name?: string;
  city_code?: string;
}

// Phase G1 (Wave 6) — schema-drift alignment per
// `__audit__/SCHEMA-DRIFT/NETWORK.md` §16 (GeocodingAttemptRow):
// Canonical `public.geocoding_attempts` (id, organization_id, client_id,
// address_id, provider_name, status, confidence, duration_ms, metadata, created_at).
//
// W13-1 close-out: dropped FE-fictional `attempt_type` column reference.
// Canonical lives in `metadata.attempt_type` (jsonb); the seed mirrors both
// shapes, but the FE row interface no longer surfaces the top-level alias —
// table render resolves the value through `metadata.attempt_type` via a
// dedicated DataTableColumn render so the column UX is unchanged.
interface GeocodingAttemptRow extends Record<string, unknown> {
  id: string;                    // → geocoding_attempts.id
  status?: string;               // → geocoding_attempts.status
  provider_name?: string;        // → geocoding_attempts.provider_name
  duration_ms?: number;          // → geocoding_attempts.duration_ms
  created_at?: string;           // → geocoding_attempts.created_at
  address_id?: string;           // → geocoding_attempts.address_id
  /** Canonical metadata jsonb (resolves derived values like attempt_type). */
  metadata?: Record<string, unknown>;
}

interface ShipmentGeocodeRow extends Record<string, unknown> {
  id: string;
  tracking_number?: string;
  destination_address_id?: string | null;
  created_at?: string;
}

interface GeocodingThresholds {
  verified_pct_good_min?: number;
  verified_pct_warn_min?: number;
  confidence_good_min?: number;
  confidence_warn_min?: number;
}

interface MapPolicyValue {
  tile_provider?: {
    engine?: string;
    provider?: string;
    data_provider?: string;
    url_template?: string;
    allowed_hosts?: string[];
    usage_tier?: string;
    cache_required?: boolean;
    same_origin_proxy_allowed?: boolean;
    attribution_label?: string;
    attribution_url?: string;
    license?: string;
  };
  default_viewport?: {
    minLat: number;
    maxLat: number;
    minLng: number;
    maxLng: number;
  };
  logistics_stack?: {
    spatial_source_of_truth?: string;
    routing_engine?: string;
    optimization_engine?: string;
  };
}

interface PolicyFieldResolution {
  name?: string;
  sources?: string[];
  fallback?: string;
}

interface AddressResolutionPolicyValue {
  fields?: PolicyFieldResolution[];
}

interface GeocodingPolicyValue extends GeocodingThresholds {
  provider_priority?: string[];
  matching_plugins?: Array<{
    name?: string;
    enabled?: boolean;
    params?: Record<string, unknown>;
  }>;
  coordinate_handling?: {
    country_boundary?: string;
    use_provided_coordinates?: boolean;
    validate_bounds?: boolean;
  };
  provider_agreement_rules?: {
    if_disagree?: string;
  };
  metadata?: {
    external_provider_default?: string;
    provider_strategy?: string;
    open_geocoding_stack?: {
      map_engine?: string;
      map_data?: string;
      geospatial_source_of_truth?: string;
      routing_engine?: string;
      optimization_engine?: string;
    };
  };
  decision_workflow_id?: string;
}

type PolicyCategoryKey =
  | 'map_policy'
  | 'address_policy'
  | 'address_resolution_policy'
  | 'geocoding_policy';

interface SettingsCategoryRow extends Record<string, unknown> {
  category?: string;
  allowed_scopes?: unknown;
  scopes?: unknown;
  side_effecting?: boolean;
  approval_required?: boolean;
  requires_approval?: boolean;
}

interface PolicyMutationReadback {
  category: PolicyCategoryKey;
  settingsVersionId: string;
  settingsResolutionId: string;
  scopeType: string;
  scopeId: string | null;
  version?: number;
  justification?: string;
}

interface GeocodeExecutionReadback {
  status: string;
  workflowRunId: string;
  geocodeWorkflowStatus?: string;
  geocodeWorkflowRunId?: string;
  geocodingAttemptId?: string;
  geocodeId?: string;
  manualReviewTaskId?: string;
  failureReason?: string;
}

/** Resolve `attempt_type` from canonical `metadata` jsonb (W13-1).
 *  Top-level FE alias dropped; seed migrated to canonical metadata-only shape. */
function attemptTypeOf(row: GeocodingAttemptRow): string | undefined {
  const fromMetadata = row.metadata?.['attempt_type'];
  return typeof fromMetadata === 'string' ? fromMetadata : undefined;
}

function metadataString(row: GeocodingAttemptRow, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = row.metadata?.[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

function firstRecordString(record: Record<string, unknown> | null | undefined, keys: readonly string[]): string | undefined {
  if (!record) return undefined;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  return undefined;
}

function firstExecutionString(result: ShipmentUpdateGeocodeResult, keys: readonly string[]): string | undefined {
  const direct = firstRecordString(result, keys);
  if (direct) return direct;
  for (const item of result.items ?? []) {
    const value = firstRecordString(item, keys);
    if (value) return value;
  }
  return undefined;
}

function buildGeocodeExecutionReadback(result: ShipmentUpdateGeocodeResult): GeocodeExecutionReadback {
  return {
    status: firstExecutionString(result, ['status']) ?? 'workflow_started',
    workflowRunId: result.workflow_run_id,
    geocodeWorkflowStatus: firstExecutionString(result, [
      'geocode_workflow_status',
      'nested_geocode_workflow_status',
      'nested_workflow_status',
    ]),
    geocodeWorkflowRunId: firstExecutionString(result, [
      'geocode_workflow_run_id',
      'nested_geocode_workflow_run_id',
      'nested_workflow_run_id',
    ]),
    geocodingAttemptId: firstExecutionString(result, ['geocoding_attempt_id', 'attempt_id']),
    geocodeId: firstExecutionString(result, ['geocode_id']),
    manualReviewTaskId: firstExecutionString(result, [
      'manual_review_task_id',
      'review_task_id',
      'task_id',
    ]),
    failureReason: firstExecutionString(result, [
      'geocode_failure_reason',
      'failure_reason',
      'failure_code',
      'error',
      'message',
    ]),
  };
}

function isManualReviewExecution(status: string | undefined, taskId: string | undefined): boolean {
  if (taskId) return true;
  return status === 'manual_review' || status === 'requires_review';
}

function isFailureExecution(status: string | undefined, failureReason: string | undefined): boolean {
  if (failureReason) return true;
  const row = status ? lookupRow('geocoding_attempt_status', status) : null;
  return row?.tone === 'danger' || status === 'failed' || status === 'failure';
}

function confidenceOf(row: GeocodeRow): number | null {
  const raw = row.confidence_score ?? row.confidence;
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : null;
}

function geocodePointTone(confidence: number | null, thresholds: GeocodingThresholds | null): GeoPointTone {
  if (confidence == null) return 'neutral';
  if (thresholds?.confidence_good_min == null || thresholds.confidence_warn_min == null) return 'info';
  if (confidence >= thresholds.confidence_good_min) return 'good';
  if (confidence >= thresholds.confidence_warn_min) return 'warn';
  return 'danger';
}

function buildGeocodePoint(
  row: GeocodeRow,
  addressById: ReadonlyMap<string, AddressRow>,
  thresholds: GeocodingThresholds | null,
  t: Translate = englishT,
): GeoPoint | null {
  const lat = Number(row.lat);
  const lng = Number(row.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  const parent = row.address_id ? addressById.get(row.address_id) : undefined;
  const providerToken = row.provider_name ?? row.provider;
  const provider = providerToken ? policyDisplayLabel(providerToken, t) : t('geocoding.value.providerPending');
  const confidence = confidenceOf(row);
  const addressLabel = parent
    ? [addressStreetOf(parent), parent.city].filter(Boolean).join(' · ')
    : row.address_id ?? row.id;
  return {
    id: row.id,
    lat,
    lng,
    label: addressLabel || row.id,
    detail: `${provider}${confidence == null ? '' : ` · ${(confidence * 100).toFixed(1)}%`}`,
    tone: geocodePointTone(confidence, thresholds),
  };
}

function titleCaseToken(value: string | undefined, t: Translate = englishT): string {
  if (!value) return t('geocoding.value.mapEngineMissing');
  const known: Record<string, string> = {
    maplibre: 'MapLibre',
    openstreetmap: 'OpenStreetMap',
    postgis: 'PostGIS',
    valhalla: 'Valhalla',
    vroom: 'VROOM',
  };
  const normalized = value.toLowerCase().replace(/[_\s-]+/g, '');
  if (known[normalized]) return known[normalized];
  return value
    .split(/[_\s-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function recordValue(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function boolValue(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

function stringArrayValue(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => stringValue(entry))
    .filter((entry): entry is string => Boolean(entry));
}

// Policy tokens with a catalog label under `geocoding.token.<token>`; others are title-cased data.
const KNOWN_POLICY_TOKENS = new Set([
  'address_policy',
  'address_resolution_policy',
  'geocode_cache',
  'geocoding_policy',
  'manual_review',
  'map_policy',
  'national_address_lookup',
  'osm_nominatim',
  'postgis_short_code',
  'production_cached',
  'provided_payload',
  'provider_timeout',
  'retry',
  'sa_short_code',
  'short_code',
  'short_code_registry',
]);

function policyDisplayLabel(value: string | null | undefined, t: Translate = englishT): string {
  const normalized = value?.trim();
  if (!normalized) return t('geocoding.value.notConfigured');
  return KNOWN_POLICY_TOKENS.has(normalized) ? t(`geocoding.token.${normalized}`) : titleCaseToken(normalized);
}

function pluginByName(policy: GeocodingPolicyValue | null, name: string) {
  return policy?.matching_plugins?.find((plugin) => plugin?.name === name) ?? null;
}

function fieldResolutionByName(policy: AddressResolutionPolicyValue | null, name: string) {
  return policy?.fields?.find((field) => field?.name === name) ?? null;
}

function describePlugin(plugin: ReturnType<typeof pluginByName>, fallback: string, t: Translate = englishT): string {
  const label = titleCaseToken(fallback);
  if (!plugin) return fill(t('geocoding.plugin.needsSetup'), { label });
  return fill(plugin.enabled === false ? t('geocoding.plugin.off') : t('geocoding.plugin.on'), { label });
}

const POLICY_CATEGORY_ORDER: Array<{
  key: PolicyCategoryKey;
  labelKey: string;
  summaryKey: string;
  signalKeys: string[];
  /** Product/brand names shown as-is. */
  techSignals?: string[];
}> = [
  {
    key: 'map_policy',
    labelKey: 'geocoding.policy.map.label',
    summaryKey: 'geocoding.policy.map.summary',
    signalKeys: [],
    techSignals: ['MapLibre / OSM', 'PostGIS / Valhalla / VROOM'], // i18n-literal-ok: product names
  },
  {
    key: 'address_policy',
    labelKey: 'geocoding.policy.address.label',
    summaryKey: 'geocoding.policy.address.summary',
    signalKeys: ['geocoding.signal.shortNationalAddress', 'geocoding.signal.coordinates'],
  },
  {
    key: 'address_resolution_policy',
    labelKey: 'geocoding.policy.addressResolution.label',
    summaryKey: 'geocoding.policy.addressResolution.summary',
    signalKeys: ['geocoding.signal.shortCodeRegistry', 'geocoding.signal.manualReviewFallback'],
  },
  {
    key: 'geocoding_policy',
    labelKey: 'geocoding.policy.geocoding.label',
    summaryKey: 'geocoding.policy.geocoding.summary',
    signalKeys: ['geocoding.signal.shortCodePlugin', 'geocoding.signal.fuzzyPlugin', 'geocoding.signal.manualReview'],
  },
];

function policyCategoryLabel(category: PolicyCategoryKey, t: Translate = englishT): string {
  const policy = POLICY_CATEGORY_ORDER.find((entry) => entry.key === category);
  return policy ? t(policy.labelKey) : titleCaseToken(category);
}

const TABS: Array<{ key: TabKey; labelKey: string }> = [
  { key: 'addresses', labelKey: 'geocoding.tabs.addresses' },
  { key: 'geocodes', labelKey: 'geocoding.tabs.geocodes' },
  { key: 'canonical', labelKey: 'geocoding.tabs.canonical' },
  { key: 'policy', labelKey: 'geocoding.tabs.policy' },
];

// ────────── Canonical-tone chip helper ──────────
//
// Validation / geocoding-attempt tone palettes are sourced strictly from
// the canonical `lookups` SSOT (`address_validation_status` +
// `geocoding_attempt_status`). AGENTS.md §2 (ZERO HARDCODING) + §4 (SSOT).
// Missing canonical rows render a danger-toned "missing" chip so the gap
// is visible to operators rather than silently masked by a neutral
// fallback.
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
        label={fill(t('geocoding.chip.missing'), { category, value })}
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

function AddressGeocodeAction({
  address,
  organizationId,
}: {
  address: AddressRow;
  organizationId: string | null;
}) {
  const go = useConsoleNavigator();
  const t = useT();
  const requeueGeocode = useRequeueShipmentGeocode();
  const [readback, setReadback] = useState<GeocodeExecutionReadback | null>(null);
  const [executionError, setExecutionError] = useState<string | null>(null);
  const shipmentQueryOpts = useMemo(
    () => ({
      filter: {
        destination_address_id: address.id,
        ...(organizationId ? { organization_id: organizationId } : {}),
      },
      sort: { key: 'created_at', dir: 'desc' as const },
      page_size: 5,
    }),
    [address.id, organizationId],
  );
  const shipmentsQuery = useResourceList<ShipmentGeocodeRow>('shipments', shipmentQueryOpts, {
    retry: false,
  });
  const linkedShipments = shipmentsQuery.data?.rows ?? [];
  const targetShipment = linkedShipments[0];
  const isBusy = shipmentsQuery.isLoading || requeueGeocode.isPending;
  const isUnavailable = shipmentsQuery.isError || !targetShipment;
  const title = shipmentsQuery.isError
    ? t('geocoding.action.linkedUnavailable')
    : targetShipment?.tracking_number
      ? fill(t('geocoding.action.shipment'), { tracking: String(targetShipment.tracking_number) })
      : t('geocoding.action.noLinkedFound');

  return (
    <div
      style={{
        display: 'flex',
        gap: '6px',
        padding: '0 14px',
        flexWrap: 'wrap',
        alignItems: 'center',
      }}
    >
      <Button
        label={requeueGeocode.isPending ? t('geocoding.action.requeueing') : t('geocoding.action.requeue')}
        iconName="refresh"
        kind="primary"
        capability={CAP.SHIPMENTS_WRITE}
        disabled={isBusy || isUnavailable}
        title={title}
        onClick={() => {
          setReadback(null);
          setExecutionError(null);
          if (!targetShipment) {
            pushToast(t('geocoding.action.noLinkedFound'), 'warn');
            return;
          }
          requeueGeocode.mutate(
            {
              shipment_id: targetShipment.id,
              address_id: address.id,
              destination_address_id: address.id,
            },
            {
              onSuccess: (res) => {
                const executionReadback = buildGeocodeExecutionReadback(res);
                setReadback(executionReadback);
                pushToast(t('geocoding.toast.updateRequested'), 'good');
              },
              onError: (err) => {
                const message = err instanceof Error ? err.message : t('geocoding.toast.requeueFailed');
                setExecutionError(message);
                pushToast(message, 'danger');
              },
            },
          );
        }}
      />
      {shipmentsQuery.isLoading ? (
        <Chip label={t('geocoding.readback.checking')} kind="neutral" size="xs" />
      ) : shipmentsQuery.isError ? (
        <Chip label={t('geocoding.readback.linkUnavailable')} kind="warn" size="xs" />
      ) : targetShipment?.tracking_number ? (
        <Chip label={targetShipment.tracking_number} kind="info" size="xs" className="mono" />
      ) : (
        <Chip label={t('geocoding.readback.noLinked')} kind="neutral" size="xs" />
      )}
      {readback ? (
        <div
          data-testid="geocode-execution-readback"
          aria-label={t('geocoding.readback.aria')}
          style={{
            border: '1px solid var(--line)',
            borderRadius: '8px',
            display: 'flex',
            flexBasis: '100%',
            flexWrap: 'wrap',
            gap: '6px',
            marginTop: '6px',
            padding: '8px',
          }}
        >
          <span className="mono" style={{ color: 'var(--ink-3)', fontSize: '11px' }}>
            {t('geocoding.readback.title')}
          </span>
          <Chip label={t('geocoding.readback.updateRequested')} kind="good" size="xs" />
          <Chip label={fill(t('geocoding.readback.status'), { status: titleCaseToken(readback.status) })} kind="info" size="xs" />
          {readback.geocodeWorkflowStatus ? (
            <Chip
              label={fill(t('geocoding.readback.geocode'), { status: titleCaseToken(readback.geocodeWorkflowStatus) })}
              kind={isFailureExecution(readback.geocodeWorkflowStatus, readback.failureReason) ? 'danger' : 'info'}
              size="xs"
            />
          ) : null}
          {readback.geocodeWorkflowRunId ? (
            <Chip label={t('geocoding.readback.followUp')} kind="neutral" size="xs" />
          ) : null}
          {readback.geocodingAttemptId ? (
            <Chip label={t('geocoding.readback.addressCheck')} kind="info" size="xs" />
          ) : null}
          {readback.geocodeId ? (
            <Chip label={t('geocoding.readback.coordinateSaved')} kind="good" size="xs" />
          ) : null}
          {readback.manualReviewTaskId ? (
            <Chip label={t('geocoding.readback.reviewQueued')} kind="warn" size="xs" />
          ) : null}
          {readback.failureReason ? (
            <Chip label={fill(t('geocoding.readback.reason'), { reason: titleCaseToken(readback.failureReason) })} kind="danger" size="xs" />
          ) : null}
          {isManualReviewExecution(readback.geocodeWorkflowStatus ?? readback.status, readback.manualReviewTaskId) ? (
            <Button
              label={t('geocoding.action.openReviewQueue')}
              iconName="audit"
              kind="ghost"
              size="sm"
              onClick={() => {
                const focus = readback.manualReviewTaskId
                  ? `?focus=${encodeURIComponent(readback.manualReviewTaskId)}`
                  : '';
                go(`/workflows/review-queue${focus}`);
              }}
            />
          ) : null}
        </div>
      ) : null}
      {executionError ? (
        <div
          data-testid="geocode-execution-error"
          style={{
            border: '1px solid var(--danger)',
            borderRadius: '8px',
            flexBasis: '100%',
            marginTop: '6px',
            padding: '8px',
          }}
        >
          <span className="mono" style={{ color: 'var(--danger)', fontSize: '11px' }}>
            {t('geocoding.readback.failed')}
          </span>
          <div className="state__hint">{executionError}</div>
        </div>
      ) : null}
    </div>
  );
}

export function GeocodingModule() {
  const { scope, currentTenantId } = useIdentity();
  const go = useConsoleNavigator();
  const { t, fmtNumber, fmtDateTime } = useI18n();
  const drawer = useDrawer();
  const modal = useModal();
  const canRead = useCapability(CAP.NETWORK_READ);
  const proposeSettings = useProposeSettingsChange();
  const applySettings = useApplySettingsValue();
  const [active, setActive] = useState<TabKey>('addresses');
  const [policyMutationReadback, setPolicyMutationReadback] = useState<PolicyMutationReadback | null>(null);
  const tenantId = scope.tenant?.id ?? currentTenantId() ?? null;
  const tenantListOpts = useMemo(
    () => (tenantId ? { filter: { organization_id: tenantId } } : undefined),
    [tenantId],
  );
  const tenantSettingsScope = useMemo(
    () => (tenantId ? { organization_id: tenantId } : undefined),
    [tenantId],
  );

  const addressesQuery = useResourceList<AddressRow>('addresses', tenantListOpts);
  const geocodesQuery = useResourceList<GeocodeRow>('geocodes', tenantListOpts);
  const citiesQuery = useResourceList<CanonicalCityRow>('canonical_cities');
  const districtsQuery = useResourceList<CanonicalDistrictRow>('canonical_districts');

  // Optional / inspection reads — degrade gracefully when not seeded.
  const attemptsQuery = useResourceList<GeocodingAttemptRow>('geocoding_attempts', {
    ...(tenantListOpts ?? {}),
    page_size: 50,
    sort: { key: 'created_at', dir: 'desc' },
  });
  const addressPolicyQuery = useResolveSettings('address_policy', tenantSettingsScope);
  const addressResolutionPolicyQuery = useResolveSettings('address_resolution_policy', tenantSettingsScope);
  const geocodingPolicyQuery = useResolveSettings('geocoding_policy', tenantSettingsScope);
  const mapPolicyQuery = useResolveSettings('map_policy', tenantSettingsScope);
  const policyCategoryRegistryQuery = useResourceList<SettingsCategoryRow>('settings_category_registry', {
    page_size: 500,
    sort: { key: 'category', dir: 'asc' },
  });
  const scopeRegistryQuery = useResourceList<SettingsScopeTypeRegistryRow>('scope_type_registry');
  const mapPolicyValue = (mapPolicyQuery.data?.value as MapPolicyValue | undefined) ?? null;
  const mapTileProvider = mapPolicyValue?.tile_provider;
  const mapDefaultViewport = mapPolicyValue?.default_viewport ?? null;
  const mapStackLabel = `${titleCaseToken(mapTileProvider?.engine, t)} · ${titleCaseToken(
    mapTileProvider?.data_provider ?? mapTileProvider?.provider,
    t,
  )}`;

  // W27 Cycle D closure (P1 #4): KPI tone thresholds resolve strictly via
  // the canonical `geocoding_policy` settings ladder. The same query is
  // reused so the Policy snapshot card and the KPI strip share one fetch.
  // Missing canonical row → tone falls through to neutral via consumer
  // null-checks; NO inline numeric literals.
  const geocodingThresholds =
    (geocodingPolicyQuery.data?.value as GeocodingPolicyValue | undefined) ?? null;
  const addressResolutionPolicy =
    (addressResolutionPolicyQuery.data?.value as AddressResolutionPolicyValue | undefined) ?? null;

  const canonicalScopeOrder = useMemo<ScopeType[]>(() => {
    const rows = scopeRegistryQuery.data?.rows ?? [];
    return rows
      .slice()
      .sort((a, b) => a.ladder_rank - b.ladder_rank)
      .map((row) => row.scope_type as ScopeType);
  }, [scopeRegistryQuery.data]);

  const policyCategoryRows = useMemo<SettingsCategoryRow[]>(() => {
    const liveRows = policyCategoryRegistryQuery.data?.rows ?? [];
    return liveRows.length
      ? liveRows
      : ((getSettingsCategories() as SettingsCategoryRow[] | undefined) ?? []);
  }, [policyCategoryRegistryQuery.data]);

  // Wrap fall-back arrays in useMemo so identity stays stable across renders
  // and downstream useMemo dependencies don't churn (lint: react-hooks/exhaustive-deps).
  const addresses = useMemo<AddressRow[]>(
    () => addressesQuery.data?.rows ?? [],
    [addressesQuery.data]
  );
  const geocodes = useMemo<GeocodeRow[]>(
    () => geocodesQuery.data?.rows ?? [],
    [geocodesQuery.data]
  );
  const cities = useMemo<CanonicalCityRow[]>(
    () => citiesQuery.data?.rows ?? [],
    [citiesQuery.data]
  );
  const districts = useMemo<CanonicalDistrictRow[]>(
    () => districtsQuery.data?.rows ?? [],
    [districtsQuery.data]
  );
  const attempts = useMemo<GeocodingAttemptRow[]>(
    () => attemptsQuery.data?.rows ?? [],
    [attemptsQuery.data]
  );

  const addressById = useMemo(() => {
    const map = new Map<string, AddressRow>();
    for (const a of addresses) map.set(a.id, a);
    return map;
  }, [addresses]);

  const geocodesByAddress = useMemo(() => {
    const map = new Map<string, GeocodeRow[]>();
    for (const g of geocodes) {
      if (!g.address_id) continue;
      if (!map.has(g.address_id)) map.set(g.address_id, []);
      map.get(g.address_id)!.push(g);
    }
    return map;
  }, [geocodes]);

  const geocodePoints = useMemo<GeoPoint[]>(
    () =>
      geocodes
        .map((row) => buildGeocodePoint(row, addressById, geocodingThresholds, t))
        .filter((point): point is GeoPoint => point != null),
    [addressById, geocodes, geocodingThresholds, t],
  );
  const missingCoordinateCount = geocodes.length - geocodePoints.length;

  // KPIs
  // W27 closure (P1 #1): canonical `address_validation_status` values are
  // valid/invalid/requires_review/pending. Earlier this comparison used
  // 'verified' (a non-canonical literal) so the KPI counted 0 even when the
  // seed contained valid rows.
  // W65 closure (Cycle F-R-5 P1): the literal compare on the canonical
  // value is replaced with a metadata-driven resolution. `valid` rows in
  // `address_validation_status` carry `metadata.is_valid_validation_status`,
  // so the KPI is row-driven and survives canonical row changes without
  // touching this module.
  const validCount = useMemo(
    () =>
      addresses.filter(
        (a) =>
          lookupRow('address_validation_status', String(a.validation_status ?? ''))?.metadata
            ?.is_valid_validation_status === true,
      ).length,
    [addresses]
  );
  const validPct = addresses.length
    ? Math.round((validCount / addresses.length) * 100)
    : 0;
  // Average confidence reads canonical `confidence_score` (with `confidence`
  // legacy fallback) — see canonical column rename in interface above.
  const avgConfidence = useMemo(() => {
    if (!geocodes.length) return null;
    const valid = geocodes.filter(
      (g) => typeof (g.confidence_score ?? g.confidence) === 'number',
    );
    if (!valid.length) return null;
    const sum = valid.reduce(
      (acc, g) => acc + Number(g.confidence_score ?? g.confidence ?? 0),
      0,
    );
    return sum / valid.length;
  }, [geocodes]);
  const attempts24h = useMemo(() => {
    if (attemptsQuery.isError) return null;
    if (!attempts.length) return 0;
    // E2 closure (P2 #8) — RFC-acceptable time-unit conversion (24h × 60min ×
    // 60s × 1000ms). This is the operator-domain "last 24 hours" KPI window;
    // the literal is a time-unit identity, not a tunable threshold (the KPI
    // tile label is hardcoded "Attempts (24h)" so the window is part of the
    // tile contract). Tunable windows would render multiple tiles labeled by
    // canonical KPI definitions; this single-window tile uses the
    // identity-conversion form.
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    return attempts.filter((a) => {
      const time = a.created_at ? new Date(a.created_at as string).getTime() : NaN;
      return Number.isFinite(time) && time >= cutoff;
    }).length;
  }, [attempts, attemptsQuery.isError]);

  const policyCategoryMeta = (category: PolicyCategoryKey) => {
    const row = policyCategoryRows.find((entry) => entry.category === category);
    const metadata = recordValue(row?.metadata);
    const rawScopes = row?.allowed_scopes ?? row?.scopes ?? metadata?.allowed_scopes ?? metadata?.scopes;
    const allowedScopes = stringArrayValue(rawScopes)
      .map((value) => value as ScopeType)
      .filter((value) => canonicalScopeOrder.includes(value));
    const scopes = allowedScopes.length ? allowedScopes : canonicalScopeOrder;
    return {
      allowedScopes: scopes,
      approvalRequired:
        row?.side_effecting === true ||
        row?.approval_required === true ||
        row?.requires_approval === true ||
        metadata?.approval_required === true ||
        metadata?.requires_approval === true,
    };
  };

  const currentPolicyValue = (category: PolicyCategoryKey): unknown => {
    switch (category) {
      case 'map_policy':
        return mapPolicyQuery.data?.value;
      case 'address_policy':
        return addressPolicyQuery.data?.value;
      case 'address_resolution_policy':
        return addressResolutionPolicyQuery.data?.value;
      case 'geocoding_policy':
        return geocodingPolicyQuery.data?.value;
      default:
        return undefined;
    }
  };

  const refetchPolicyCategory = async (category: PolicyCategoryKey) => {
    switch (category) {
      case 'map_policy':
        await mapPolicyQuery.refetch();
        break;
      case 'address_policy':
        await addressPolicyQuery.refetch();
        break;
      case 'address_resolution_policy':
        await addressResolutionPolicyQuery.refetch();
        break;
      case 'geocoding_policy':
        await geocodingPolicyQuery.refetch();
        break;
      default:
        break;
    }
  };

  const scopeIdForType = (scopeType: ScopeType): string => {
    switch (scopeType) {
      case 'global':
        return 'global';
      case 'tenant':
        return tenantId ?? '';
      case 'client':
        return scope.client?.id ?? '';
      case 'sender':
        return scope.sender?.id ?? '';
      case 'source':
        return scope.source?.id ?? '';
      case 'resource':
        return scope.resource?.id ?? '';
      default:
        return '';
    }
  };

  const policyScopePayload = (scopeType: ScopeType): { scope: Record<string, { id: string }>; scopeId: string | null } | null => {
    const scopeId = scopeIdForType(scopeType);
    if (scopeType !== 'global' && !scopeId) return null;
    return {
      scope: { [scopeType]: { id: scopeId } },
      scopeId: scopeType === 'global' ? null : scopeId,
    };
  };

  const openPolicyEditor = (category: PolicyCategoryKey) => {
    const policy = POLICY_CATEGORY_ORDER.find((entry) => entry.key === category);
    const meta = policyCategoryMeta(category);
    const allowedScopes = meta.allowedScopes;
    const defaultScopeType =
      allowedScopes.includes('tenant') ? 'tenant' : allowedScopes[0];
    if (!defaultScopeType) {
      pushToast(fill(t('geocoding.toast.cannotEdit'), { label: policyCategoryLabel(category, t) }), 'warn');
      return;
    }

    modal.open({
      title: fill(t('geocoding.policy.configure'), { label: policy ? t(policy.labelKey) : category }),
      body: (
        <SettingsChangeForm
          category={category}
          allowedScopes={allowedScopes}
          defaultScopeType={defaultScopeType}
          initialValue={currentPolicyValue(category)}
          canAutoApply={!meta.approvalRequired}
          onClose={() => modal.close()}
          onSubmit={async ({ scopeType, value, justification, dryRun }) => {
            try {
              const parsed = JSON.parse(value);
              const policyScope = policyScopePayload(scopeType);
              if (!policyScope) {
                pushToast(fill(t('geocoding.toast.scopeUnavailable'), { scope: titleCaseToken(scopeType) }), 'warn');
                return undefined;
              }
              const result = (await proposeSettings.mutateAsync({
                category,
                scope: policyScope.scope,
                value: parsed,
                dryRun,
                justification,
              })) as SettingsChangePreviewResult;
              pushToast(dryRun ? t('geocoding.toast.previewReady') : t('geocoding.toast.submitted'), 'good');
              if (!dryRun) modal.close();
              return result;
            } catch {
              pushToast(
                t('geocoding.toast.prepareFailed'),
                'danger',
              );
              return undefined;
            }
          }}
          onApply={async ({ scopeType, value, justification }) => {
            try {
              const parsed = JSON.parse(value);
              const policyScope = policyScopePayload(scopeType);
              if (!policyScope) {
                pushToast(fill(t('geocoding.toast.scopeUnavailable'), { scope: titleCaseToken(scopeType) }), 'warn');
                return undefined;
              }
              const result = await applySettings.mutateAsync({
                category,
                scope: policyScope.scope,
                value: parsed,
                justification,
              });
              setPolicyMutationReadback({
                category,
                settingsVersionId: result.settings_version_id,
                settingsResolutionId: result.settings_resolution_id,
                scopeType: result.scope_type,
                scopeId: result.scope_id ?? policyScope.scopeId,
                version: result.settings_version_number,
                justification,
              });
              await refetchPolicyCategory(category);
              pushToast(
                fill(t('geocoding.toast.saved'), { label: policyCategoryLabel(category, t) }),
                'good',
              );
              modal.close();
              return result;
            } catch {
              pushToast(
                t('geocoding.toast.saveFailed'),
                'danger',
              );
              return undefined;
            }
          }}
        />
      ),
    });
  };

  const addressColumns = useMemo<Array<DataTableColumn<AddressRow>>>(
    () => [
      // W20 — Street column resolves canonical normalized_line1 first via
      // `addressStreetOf()`; FE alias `street` remains a back-compat fallback.
      // Column key stays stable so view-saved sorts/filters keep working.
      {
        key: 'street',
        label: t('geocoding.field.street'),
        sortable: true,
        filterable: true,
        render: (_raw, row) => addressStreetOf(row) ?? '—',
      },
      { key: 'district', label: t('geocoding.field.district'), sortable: true, filterable: true },
      { key: 'city', label: t('geocoding.field.city'), sortable: true, filterable: true },
      { key: 'country', label: t('geocoding.field.country'), sortable: true, filterable: true },
      { key: 'postal_code', label: t('geocoding.field.postal'), mono: true, sortable: true },
      {
        key: 'validation_status',
        label: t('geocoding.field.status'),
        sortable: true,
        filterable: true,
        render: (raw) => {
          const v = raw == null ? null : String(raw);
          return v ? (
            <CanonicalChip category="address_validation_status" value={v} labelOverride={policyDisplayLabel(v, t)} />
          ) : (
            <span>—</span>
          );
        },
      },
      {
        key: '__geocodes__',
        label: t('geocoding.field.geocodes'),
        align: 'right',
        sortable: false,
        filterable: false,
        render: (_raw, row) => {
          const n = geocodesByAddress.get(row.id)?.length ?? 0;
          return n === 0 ? '—' : fmtNumber(n);
        },
      },
    ],
    [geocodesByAddress, fmtNumber, t]
  );

  const geocodeColumns = useMemo<Array<DataTableColumn<GeocodeRow>>>(
    () => [
      {
        key: 'address_id',
        label: t('geocoding.field.address'),
        sortable: true,
        filterable: true,
        render: (raw) => {
          const address = raw ? addressById.get(String(raw)) : null;
          return address ? [addressStreetOf(address), address.city].filter(Boolean).join(' · ') : t('geocoding.value.linkedAddress');
        },
      },
      // Canonical column is `provider_name`; seed alias `provider` is also
      // accepted via the row's render closure so legacy seeds keep rendering.
      {
        key: 'provider_name',
        label: t('geocoding.field.provider'),
        sortable: true,
        filterable: true,
        render: (raw, row) => policyDisplayLabel(String(raw ?? row.provider ?? ''), t),
      },
      { key: 'lat', label: t('geocoding.field.lat'), mono: true, align: 'right', sortable: true, type: 'number' },
      { key: 'lng', label: t('geocoding.field.lng'), mono: true, align: 'right', sortable: true, type: 'number' },
      {
        key: 'confidence_score',
        label: t('geocoding.field.confidence'),
        align: 'right',
        sortable: true,
        format: 'percent',
        type: 'number',
        render: (raw, row) => {
          const v = raw == null ? row.confidence : raw;
          return v == null ? '—' : `${(Number(v) * 100).toFixed(1)}%`;
        },
      },
      {
        key: 'geocoded_at',
        label: t('geocoding.field.cached'),
        format: 'datetime',
        sortable: true,
        render: (raw, row) => {
          const v = (raw ?? row.cached_at) as string | undefined;
          return v ? fmtDateTime(v) : '—';
        },
      },
    ],
    [addressById, fmtDateTime, t]
  );

  const cityColumns = useMemo<Array<DataTableColumn<CanonicalCityRow>>>(
    () => [
      // Canonical key is `name_canonical`; we still surface a Code column for
      // legacy seed compatibility (falls through to `id` when absent).
      {
        key: 'id',
        label: t('geocoding.field.code'),
        mono: true,
        sortable: true,
        filterable: true,
        render: (raw, row) => String(row.code ?? raw ?? '—'),
      },
      {
        key: 'name_canonical',
        label: t('geocoding.field.name'),
        sortable: true,
        filterable: true,
        render: (raw, row) => String(raw ?? row.name ?? '—'),
      },
      {
        key: 'country_code',
        label: t('geocoding.field.country'),
        sortable: true,
        filterable: true,
        render: (raw, row) => String(raw ?? row.country ?? '—'),
      },
    ],
    [t]
  );

  const districtColumns = useMemo<Array<DataTableColumn<CanonicalDistrictRow>>>(
    () => [
      {
        key: 'id',
        label: t('geocoding.field.code'),
        mono: true,
        sortable: true,
        filterable: true,
        render: (raw, row) => String(row.code ?? raw ?? '—'),
      },
      {
        key: 'name_canonical',
        label: t('geocoding.field.name'),
        sortable: true,
        filterable: true,
        render: (raw, row) => String(raw ?? row.name ?? '—'),
      },
      {
        key: 'city_id',
        label: t('geocoding.field.city'),
        mono: true,
        sortable: true,
        filterable: true,
        reference: {
          items: cities,
          display: (c) => {
            const city = c as CanonicalCityRow;
            const code = city.code ?? city.id;
            const name = city.name_canonical ?? city.name ?? '';
            return `${code} · ${name}`;
          },
          value: (c) => (c as CanonicalCityRow).id,
        },
      },
    ],
    [cities, t]
  );

  const attemptColumns = useMemo<Array<DataTableColumn<GeocodingAttemptRow>>>(
    () => [
      { key: 'created_at', label: t('geocoding.field.when'), format: 'datetime', sortable: true },
      {
        key: 'provider_name',
        label: t('geocoding.field.provider'),
        sortable: true,
        filterable: true,
        render: (raw) => policyDisplayLabel(String(raw ?? ''), t),
      },
      // W13-1 — `attempt_type` resolves through metadata.attempt_type (no column). Sort/filter
      // operate on the projected key via the cell render below; per-projection key
      // keeps React key uniqueness across columns.
      {
        key: 'metadata.attempt_type',
        label: t('geocoding.field.type'),
        sortable: false,
        filterable: false,
        render: (_raw, row) => {
          const type = attemptTypeOf(row);
          return type ? <span>{policyDisplayLabel(type, t)}</span> : <span>—</span>;
        },
      },
      {
        key: 'status',
        label: t('geocoding.field.status'),
        sortable: true,
        filterable: true,
        render: (raw) => {
          const v = raw == null ? null : String(raw);
          return v ? (
            <CanonicalChip category="geocoding_attempt_status" value={v} labelOverride={policyDisplayLabel(v, t)} />
          ) : (
            <span>—</span>
          );
        },
      },
      {
        key: 'duration_ms',
        label: t('geocoding.field.duration'),
        align: 'right',
        sortable: true,
        format: 'ms',
        type: 'number',
      },
      {
        key: 'address_id',
        label: t('geocoding.field.address'),
        sortable: true,
        render: (raw) => {
          const address = raw ? addressById.get(String(raw)) : null;
          return address ? [addressStreetOf(address), address.city].filter(Boolean).join(' · ') : t('geocoding.value.linkedAddress');
        },
      },
    ],
    [addressById, t]
  );

  function openAddress(addr: AddressRow) {
    const linkedGeocodes = geocodesByAddress.get(addr.id) ?? [];
    const linkedGeocodePoints = linkedGeocodes
      .map((row) => buildGeocodePoint(row, addressById, geocodingThresholds, t))
      .filter((point): point is GeoPoint => point != null);
    const rows: KvRow[] = [
      // W20 — Street row resolves canonical `normalized_line1` first via
      // `addressStreetOf()`; FE alias `street` remains a back-compat fallback.
      { key: 'street', label: t('geocoding.field.street'), value: addressStreetOf(addr) ?? '—' },
      { key: 'district', label: t('geocoding.field.district'), value: addr.district ?? '—' },
      { key: 'city', label: t('geocoding.field.city'), value: addr.city ?? '—' },
      { key: 'country', label: t('geocoding.field.country'), value: addr.country ?? '—' },
      {
        key: 'postal_code',
        label: t('geocoding.field.postal'),
        value: addr.postal_code ?? '—',
        mono: true,
      },
      {
        key: 'validation_status',
        label: t('geocoding.field.status'),
        value: addr.validation_status ? policyDisplayLabel(addr.validation_status, t) : '—',
      },
      {
        key: 'geocodes_count',
        label: t('geocoding.field.geocodesCached'),
        value: linkedGeocodes.length === 0 ? '—' : fmtNumber(linkedGeocodes.length),
        mono: true,
      },
    ];

    drawer.open({
      title: fill(t('geocoding.drawer.address'), { address: addressStreetOf(addr) ?? addr.id }),
      size: 'md',
      deepLink: `/network/geocoding?focus=${encodeURIComponent(addr.id)}`,
      body: (
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
            {addr.validation_status ? (
              <CanonicalChip
                category="address_validation_status"
                value={addr.validation_status}
                labelOverride={policyDisplayLabel(addr.validation_status, t)}
              />
            ) : null}
          </div>
          <KvGrid rows={rows} />

          <div className="section-eyebrow">{t('geocoding.section.locationMap')}</div>
          <div style={{ padding: '0 14px 12px' }}>
            <GeoPointMap
              points={linkedGeocodePoints}
              bounds={mapDefaultViewport}
              height={220}
              title={t('geocoding.map.addressTitle')}
              emptyLabel={t('geocoding.map.addressEmpty')}
              tileUrlTemplate={mapTileProvider?.url_template}
              allowedTileHosts={mapTileProvider?.allowed_hosts}
              tileUsageTier={mapTileProvider?.usage_tier}
              tileCacheRequired={mapTileProvider?.cache_required}
              sameOriginProxyAllowed={mapTileProvider?.same_origin_proxy_allowed}
              tileAttributionLabel={mapTileProvider?.attribution_label}
              tileAttributionUrl={mapTileProvider?.attribution_url}
            />
          </div>

          <div className="section-eyebrow">{t('geocoding.section.addressGeocodes')}</div>
          {linkedGeocodes.length === 0 ? (
            <StateView
              kind="empty"
              hint={t('geocoding.state.noGeocodeCached')}
            />
          ) : (
            <DataTable<GeocodeRow>
              columns={geocodeColumns}
              rows={linkedGeocodes}
              viewKey={`address_geocodes_${addr.id}`}
              entityKind="geocode"
              allowSelection={false}
            />
          )}

          <div className="section-eyebrow">{t('geocoding.section.workflowAction')}</div>
          <AddressGeocodeAction address={addr} organizationId={tenantId} />

          <div className="section-eyebrow">{t('geocoding.section.reviewSettings')}</div>
          <div
            style={{
              display: 'flex',
              gap: '6px',
              padding: '0 14px',
              flexWrap: 'wrap',
            }}
          >
            <Button
              label={t('geocoding.action.addressSettings')}
              iconName="settings"
              kind="ghost"
              onClick={() => {
                drawer.close();
                setActive('policy');
              }}
            />
            <Button
              label={t('geocoding.action.activityHistory')}
              iconName="audit"
              kind="ghost"
              onClick={() => {
                go('/insights/resolutions?category=address_policy');
              }}
            />
          </div>
        </div>
      ),
    });
  }

  function openGeocode(g: GeocodeRow) {
    const parent = g.address_id ? addressById.get(g.address_id) : undefined;
    const provider = g.provider_name ?? g.provider ?? '—';
    const providerLabel = provider === '—' ? provider : policyDisplayLabel(provider, t);
    const confidence = g.confidence_score ?? g.confidence;
    const cachedAt = g.geocoded_at ?? g.cached_at;
    const point = buildGeocodePoint(g, addressById, geocodingThresholds, t);
    const rows: KvRow[] = [
      { key: 'provider_name', label: t('geocoding.field.provider'), value: providerLabel },
      { key: 'lat', label: t('geocoding.field.lat'), value: g.lat != null ? String(g.lat) : '—', mono: true },
      { key: 'lng', label: t('geocoding.field.lng'), value: g.lng != null ? String(g.lng) : '—', mono: true },
      {
        key: 'confidence_score',
        label: t('geocoding.field.confidence'),
        value:
          confidence != null
            ? `${(Number(confidence) * 100).toFixed(1)}%`
            : '—',
        mono: true,
      },
      {
        key: 'geocoded_at',
        label: t('geocoding.field.cached'),
        value: cachedAt ? fmtDateTime(cachedAt as string) : '—',
        mono: true,
      },
    ];

    drawer.open({
      title: fill(t('geocoding.drawer.geocode'), {
        provider: providerLabel !== '—' ? providerLabel : t('geocoding.drawer.selectedCoordinate'),
      }),
      size: 'md',
      body: (
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
            {providerLabel !== '—' ? (
              <Chip label={providerLabel} kind="info" size="xs" />
            ) : null}
          </div>
          <KvGrid rows={rows} />
          <div className="section-eyebrow">{t('geocoding.section.locationMap')}</div>
          <div style={{ padding: '0 14px 12px' }}>
            <GeoPointMap
              points={point ? [point] : []}
              selectedId={point?.id}
              bounds={mapDefaultViewport}
              height={220}
              title={t('geocoding.map.geocodeTitle')}
              emptyLabel={t('geocoding.map.geocodeEmpty')}
              tileUrlTemplate={mapTileProvider?.url_template}
              allowedTileHosts={mapTileProvider?.allowed_hosts}
              tileUsageTier={mapTileProvider?.usage_tier}
              tileCacheRequired={mapTileProvider?.cache_required}
              sameOriginProxyAllowed={mapTileProvider?.same_origin_proxy_allowed}
              tileAttributionLabel={mapTileProvider?.attribution_label}
              tileAttributionUrl={mapTileProvider?.attribution_url}
            />
          </div>
          <div className="section-eyebrow">{t('geocoding.section.linkedAddress')}</div>
          {parent ? (
            <KvGrid
              rows={[
                {
                  key: 'street',
                  label: t('geocoding.field.street'),
                  // W20 — resolves canonical normalized_line1 first.
                  value: addressStreetOf(parent) ?? '—',
                },
                { key: 'city', label: t('geocoding.field.city'), value: parent.city ?? '—' },
                {
                  key: 'country',
                  label: t('geocoding.field.country'),
                  value: parent.country ?? '—',
                },
                {
                  key: 'status',
                  label: t('geocoding.field.status'),
                  value: parent.validation_status ? policyDisplayLabel(parent.validation_status, t) : '—',
                },
              ]}
            />
          ) : (
            <StateView
              kind="empty"
              hint={t('geocoding.state.addressNotInPage')}
            />
          )}
        </div>
      ),
    });
  }

  function openAttempt(attempt: GeocodingAttemptRow) {
    const type = attemptTypeOf(attempt);
    const workflowRunId = metadataString(
      attempt,
      'workflow_run_id',
      'geocode_workflow_run_id',
      'nested_workflow_run_id',
    );
    const manualReviewTaskId = metadataString(
      attempt,
      'manual_review_task_id',
      'review_task_id',
      'task_id',
    );
    const failureReason = metadataString(attempt, 'geocode_failure_reason', 'failure_reason', 'failure_code', 'error', 'message');
    const rows: KvRow[] = [
      { key: 'created_at', label: t('geocoding.field.when'), value: attempt.created_at ? fmtDateTime(attempt.created_at) : '—', mono: true },
      { key: 'provider_name', label: t('geocoding.field.provider'), value: policyDisplayLabel(attempt.provider_name, t) },
      { key: 'status', label: t('geocoding.field.status'), value: policyDisplayLabel(attempt.status, t) },
      { key: 'attempt_type', label: t('geocoding.field.type'), value: policyDisplayLabel(type, t) },
      { key: 'duration_ms', label: t('geocoding.field.duration'), value: attempt.duration_ms != null ? fill(t('geocoding.value.ms'), { n: attempt.duration_ms }) : '—', mono: true },
      { key: 'address_id', label: t('geocoding.field.address'), value: attempt.address_id ? t('geocoding.value.linkedAddress') : '—' },
      { key: 'workflow_run_id', label: t('geocoding.field.workflow'), value: workflowRunId ? t('geocoding.value.workflowRecorded') : '—' },
      { key: 'manual_review_task_id', label: t('geocoding.field.reviewTask'), value: manualReviewTaskId ? t('geocoding.value.reviewTaskReady') : '—' },
      { key: 'failure_reason', label: t('geocoding.field.failure'), value: failureReason ? policyDisplayLabel(failureReason, t) : '—' },
    ];
    const showReviewQueue = isManualReviewExecution(type ?? attempt.status, manualReviewTaskId);

    drawer.open({
      title: fill(t('geocoding.drawer.attempt'), { provider: policyDisplayLabel(attempt.provider_name, t) }),
      size: 'md',
      body: (
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
            {attempt.status ? (
              <CanonicalChip
                category="geocoding_attempt_status"
                value={attempt.status}
                labelOverride={attempt.status}
              />
            ) : null}
            {type ? (
              <CanonicalChip
                category="geocoding_attempt_type"
                value={type}
                labelOverride={type}
              />
            ) : null}
          </div>
          <KvGrid rows={rows} />
          <div className="section-eyebrow">{t('geocoding.section.executionRouting')}</div>
          <div style={{ display: 'flex', gap: '6px', padding: '0 14px', flexWrap: 'wrap' }}>
            {attempt.address_id && addressById.has(attempt.address_id) ? (
              <Button
                label={t('geocoding.action.openAddress')}
                iconName="pin"
                kind="ghost"
                onClick={() => openAddress(addressById.get(attempt.address_id!)!)}
              />
            ) : null}
            {showReviewQueue ? (
              <Button
                label={t('geocoding.action.openReviewQueue')}
                iconName="audit"
                kind="ghost"
                onClick={() => {
                  const focus = manualReviewTaskId
                    ? `?focus=${encodeURIComponent(manualReviewTaskId)}`
                    : '';
                  go(`/workflows/review-queue${focus}`);
                }}
              />
            ) : null}
            {failureReason ? (
              <Chip label={fill(t('geocoding.value.failureReason'), { reason: policyDisplayLabel(failureReason, t) })} kind="danger" size="xs" />
            ) : null}
          </div>
        </div>
      ),
    });
  }

  function renderAddressesTab(): ReactNode {
    if (addressesQuery.isError)
      return <StateView kind="error" hint={t('geocoding.state.addressesError')} />;
    if (addressesQuery.isLoading || !addressesQuery.data)
      return <StateView kind="loading" hint={t('geocoding.state.addressesLoading')} />;
    if (!addresses.length)
      return (
        <StateView
          kind="empty"
          title={t('geocoding.state.addressesEmpty')}
          hint={t('geocoding.state.addressesEmptyHint')}
        />
      );
    return (
      <DataTable<AddressRow>
        columns={addressColumns}
        rows={addresses}
        viewKey="addresses"
        entityKind="address"
        onRowClick={openAddress}
        rowDeepLink={(r) =>
        `/network/geocoding?focus=${encodeURIComponent(r.id)}`
        }
      />
    );
  }

  function renderGeocodesTab(): ReactNode {
    if (geocodesQuery.isError)
      return <StateView kind="error" hint={t('geocoding.state.geocodesError')} />;
    if (geocodesQuery.isLoading || !geocodesQuery.data)
      return <StateView kind="loading" hint={t('geocoding.state.geocodesLoading')} />;
    if (!geocodes.length)
      return (
        <StateView
          kind="empty"
          title={t('geocoding.state.geocodesEmpty')}
          hint={t('geocoding.state.geocodesEmptyHint')}
        />
      );
    return (
      <DataTable<GeocodeRow>
        columns={geocodeColumns}
        rows={geocodes}
        viewKey="geocodes"
        entityKind="geocode"
        onRowClick={openGeocode}
      />
    );
  }

  function renderCanonicalTab(): ReactNode {
    if (citiesQuery.isError || districtsQuery.isError)
      return (
        <StateView
          kind="error"
          hint={t('geocoding.state.canonicalError')}
        />
      );
    if (citiesQuery.isLoading || districtsQuery.isLoading)
      return (
        <StateView kind="loading" hint={t('geocoding.state.canonicalLoading')} />
      );
    if (!cities.length && !districts.length)
      return (
        <StateView
          kind="empty"
          title={t('geocoding.state.canonicalEmpty')}
          hint={t('geocoding.state.canonicalEmptyHint')}
        />
      );
    return (
      <>
        <div className="section-eyebrow">{t('geocoding.section.cities')}</div>
        {cities.length ? (
          <DataTable<CanonicalCityRow>
            columns={cityColumns}
            rows={cities}
            viewKey="canonical_cities"
            entityKind="canonical_city"
          />
        ) : (
          <StateView kind="empty" hint={t('geocoding.state.noCities')} />
        )}
        <div className="section-eyebrow">{t('geocoding.section.districts')}</div>
        {districts.length ? (
          <DataTable<CanonicalDistrictRow>
            columns={districtColumns}
            rows={districts}
            viewKey="canonical_districts"
            entityKind="canonical_district"
          />
        ) : (
          <StateView kind="empty" hint={t('geocoding.state.noDistricts')} />
        )}
      </>
    );
  }

  function renderPolicyTab(): ReactNode {
    return (
      <div>
        {canonicalScopeOrder.length > 0 ? (
          <PolicyWorkflowControls
            readback={policyMutationReadback}
            onConfigure={openPolicyEditor}
          />
        ) : scopeRegistryQuery.isPending ? (
          <StateView kind="loading" hint={t('modules.geocoding.scopeTypes.loading', 'Loading scope types…')} />
        ) : scopeRegistryQuery.isError ? (
          <StateView kind="error" hint={t('modules.geocoding.scopeTypes.error', 'Could not load scope types.')} />
        ) : (
          <StateView
            kind="empty"
            title={t('modules.geocoding.scopeTypes.emptyTitle', 'No scope types registered')}
            hint={t(
              'modules.geocoding.scopeTypes.emptyHint',
              'The scope type registry has no rows, so geocoding policies cannot be configured at any scope. Ask a platform administrator to register scope types.',
            )}
          />
        )}
        <PolicyCapabilitySummary
          mapPolicy={mapPolicyValue}
          addressResolutionPolicy={addressResolutionPolicy}
          geocodingPolicy={geocodingThresholds}
        />
        <GeocodeAttemptVariantSummary
          attempts={attempts}
          onOpenAttempt={openAttempt}
        />
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))',
            gap: '12px',
            padding: '0 0 12px',
          }}
        >
          <PolicySnapshot
            label={t('geocoding.snapshot.map')}
            query={mapPolicyQuery}
          />
          <PolicySnapshot
            label={t('geocoding.snapshot.address')}
            query={addressPolicyQuery}
          />
          <PolicySnapshot
            label={t('geocoding.snapshot.addressResolution')}
            query={addressResolutionPolicyQuery}
          />
          <PolicySnapshot
            label={t('geocoding.snapshot.geocoding')}
            query={geocodingPolicyQuery}
          />
        </div>

        <div className="section-eyebrow">{t('geocoding.section.recentAttempts')}</div>
        {attemptsQuery.isError ? (
          <StateView
            kind="empty"
            hint={t('geocoding.state.attemptsUnavailable')}
          />
        ) : attemptsQuery.isLoading ? (
          <StateView kind="loading" hint={t('geocoding.state.attemptsLoading')} />
        ) : attempts.length === 0 ? (
          <StateView
            kind="empty"
            title={t('geocoding.state.attemptsEmpty')}
            hint={t('geocoding.state.attemptsEmptyHint')}
          />
        ) : (
          <DataTable<GeocodingAttemptRow>
            columns={attemptColumns}
            rows={attempts}
            viewKey="geocoding_attempts"
            entityKind="geocoding_attempt"
            onRowClick={openAttempt}
          />
        )}
      </div>
    );
  }

  // City breadth — inform the canonical KPI when present
  const districtCoverage = useMemo(() => {
    if (!districts.length || !cities.length) return null;
    const used = new Set<string>();
    for (const d of districts) {
      if (d.city_id) used.add(d.city_id);
    }
    const covered = cities.filter((c) => used.has(c.id)).length;
    return Math.round((covered / cities.length) * 100);
  }, [cities, districts]);

  if (!canRead) {
    return (
      <div className="page">
        <PageHeader
          moduleKey="geocoding"
        />
        <StateView
          kind="denied"
          capability={CAP.NETWORK_READ}
          hint={t('geocoding.state.denied')}
        />
      </div>
    );
  }

  return (
    <div className="page">
      <PageHeader
        moduleKey="geocoding"
        pills={[
          <ScopePill key="scope" scopeType="tenant" scopeId={tenantId} />,
          <Chip
            key="src"
            label="addresses · geocodes · attempts" // i18n-literal-ok: resource keys
            kind="neutral"
            size="xs"
            className="mono"
          />,
        ]}
        actions={[]}
      />

      {/* W27 Cycle D closure (P1 #4): KPI tone thresholds resolve from
          canonical `geocoding_policy` settings policy (sv_440). Replaces
          inline 80/50 + 0.8/0.5 magic numbers. Missing canonical row →
          neutral tone (no silent FE-literal masking). */}
      <div className="kpi-strip">
        <KPICard
          label={t('geocoding.kpi.addresses')}
          value={fmtNumber(addresses.length)}
          delta={t('geocoding.kpi.acrossSenders')}
          tone="neutral"
        />
        <KPICard
          label={t('geocoding.kpi.validPct')}
          value={`${validPct}%`}
          delta={t('geocoding.kpi.validationStatus')}
          tone={
            geocodingThresholds?.verified_pct_good_min != null &&
            geocodingThresholds?.verified_pct_warn_min != null
              ? validPct >= geocodingThresholds.verified_pct_good_min
                ? 'good'
                : validPct >= geocodingThresholds.verified_pct_warn_min
                  ? 'warn'
                  : 'danger'
              : 'neutral'
          }
        />
        <KPICard
          label={t('geocoding.kpi.geocodesCached')}
          value={fmtNumber(geocodes.length)}
          delta={t('geocoding.kpi.multiProvider')}
          tone="info"
        />
        <KPICard
          label={t('geocoding.kpi.avgConfidence')}
          value={
            avgConfidence == null
              ? '—'
              : `${(avgConfidence * 100).toFixed(1)}%`
          }
          delta={avgConfidence == null ? t('geocoding.kpi.noGeocodes') : t('geocoding.kpi.rollingMean')}
          tone={
            avgConfidence == null
              ? 'neutral'
              : geocodingThresholds?.confidence_good_min != null &&
                  geocodingThresholds?.confidence_warn_min != null
                ? avgConfidence >= geocodingThresholds.confidence_good_min
                  ? 'good'
                  : avgConfidence >= geocodingThresholds.confidence_warn_min
                    ? 'warn'
                    : 'danger'
                : 'neutral'
          }
        />
        <KPICard
          label={t('geocoding.kpi.attempts24h')}
          value={attempts24h == null ? '—' : fmtNumber(attempts24h)}
          delta={
            attempts24h == null
              ? t('geocoding.kpi.feedUnavailable')
              : districtCoverage != null
              ? fill(t('geocoding.kpi.districtCoverage'), { pct: districtCoverage })
              : t('geocoding.kpi.rolling24h')
          }
          tone={attempts24h == null ? 'neutral' : 'info'}
        />
      </div>

      <div className="card" style={{ padding: '12px', marginBottom: '12px' }}>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: '12px',
            marginBottom: '10px',
            flexWrap: 'wrap',
          }}
        >
          <div>
            <div className="section-eyebrow" style={{ padding: 0 }}>{t('geocoding.map.coverage')}</div>
            <div className="state__hint">
              {fill(t('geocoding.map.plotted'), { n: fmtNumber(geocodePoints.length) })}
              {missingCoordinateCount > 0
                ? fill(t('geocoding.map.missing'), { n: fmtNumber(missingCoordinateCount) })
                : ''}
            </div>
          </div>
          <Chip
            label={mapStackLabel}
            kind="info"
            size="xs"
            className="mono"
          />
        </div>
        <GeoPointMap
          points={geocodePoints}
          bounds={mapDefaultViewport}
          height={300}
          title={t('geocoding.map.coverage')}
          tileUrlTemplate={mapTileProvider?.url_template}
          allowedTileHosts={mapTileProvider?.allowed_hosts}
          tileUsageTier={mapTileProvider?.usage_tier}
          tileCacheRequired={mapTileProvider?.cache_required}
          sameOriginProxyAllowed={mapTileProvider?.same_origin_proxy_allowed}
          tileAttributionLabel={mapTileProvider?.attribution_label}
          tileAttributionUrl={mapTileProvider?.attribution_url}
        />
      </div>

      <div className="tabs" role="tablist" aria-label={t('geocoding.tabs.aria')}>
        {TABS.map((tab) => (
          <button
            key={tab.key}
            type="button"
            role="tab"
            aria-selected={active === tab.key}
            className={`tabs__tab ${active === tab.key ? 'is-active' : ''}`}
            onClick={() => setActive(tab.key)}
          >
            {t(tab.labelKey)}
          </button>
        ))}
      </div>

      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
        {active === 'addresses' ? renderAddressesTab() : null}
        {active === 'geocodes' ? renderGeocodesTab() : null}
        {active === 'canonical' ? renderCanonicalTab() : null}
        {active === 'policy' ? renderPolicyTab() : null}
      </div>

      {drawer.node}
      {modal.node}
    </div>
  );
}

// ---------- Local helper components ----------

interface PolicySnapshotProps {
  label: string;
  query: {
    data?: SettingsResolution;
    isLoading: boolean;
    isError: boolean;
  };
}

function PolicySignal({
  label,
  value,
  kind = 'neutral',
}: {
  label: string;
  value: string;
  kind?: ChipKind;
}) {
  return (
    <div
      style={{
        border: '1px solid var(--line)',
        borderRadius: '6px',
        padding: '8px',
        minWidth: '180px',
        background: 'var(--bg-2, transparent)',
      }}
    >
      <div className="mono" style={{ color: 'var(--ink-3)', fontSize: '10.5px', marginBottom: '4px' }}>
        {label}
      </div>
      <Chip label={value} kind={kind} size="xs" className="mono" />
    </div>
  );
}

function GeocodeAttemptVariantSummary({
  attempts,
  onOpenAttempt,
}: {
  attempts: GeocodingAttemptRow[];
  onOpenAttempt: (attempt: GeocodingAttemptRow) => void;
}) {
  const t = useT();
  const latest = attempts[0];
  const manualReview = attempts.find((attempt) =>
    isManualReviewExecution(
      attemptTypeOf(attempt) ?? attempt.status,
      metadataString(attempt, 'manual_review_task_id', 'review_task_id', 'task_id'),
    ),
  );
  const failure = attempts.find((attempt) =>
    isFailureExecution(
      attempt.status,
      metadataString(attempt, 'failure_reason', 'failure_code', 'error', 'message'),
    ),
  );
  const providerCount = new Set(
    attempts.map((attempt) => attempt.provider_name).filter((provider): provider is string => !!provider),
  ).size;
  const latestStatus = latest?.status ?? attemptTypeOf(latest ?? ({} as GeocodingAttemptRow));
  const latestTaskId = latest
    ? metadataString(latest, 'manual_review_task_id', 'review_task_id', 'task_id')
    : undefined;
  const latestFailure = latest
    ? metadataString(latest, 'failure_reason', 'failure_code', 'error', 'message')
    : undefined;
  const latestKind: ChipKind = isFailureExecution(latestStatus, latestFailure)
    ? 'danger'
    : isManualReviewExecution(latestStatus, latestTaskId)
      ? 'warn'
      : latest
        ? 'info'
        : 'neutral';

  return (
    <div className="card" data-testid="geocode-attempt-variants" style={{ padding: '12px', marginBottom: '12px' }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: '12px',
          marginBottom: '10px',
          flexWrap: 'wrap',
        }}
      >
        <div>
          <div className="section-eyebrow" style={{ padding: 0 }}>{t('geocoding.variants.title')}</div>
          <div className="state__hint">{t('geocoding.variants.hint')}</div>
        </div>
        <Chip
          label="geocoding_attempts" // i18n-literal-ok: resource key
          kind="info"
          size="xs"
          className="mono"
        />
      </div>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
          gap: '8px',
        }}
      >
        <PolicySignal
          label={t('geocoding.variants.latest')}
          value={latest ? `${policyDisplayLabel(latest.status, t)} / ${policyDisplayLabel(attemptTypeOf(latest), t)}` : t('geocoding.value.noneYet')}
          kind={latestKind}
        />
        <PolicySignal
          label={t('geocoding.variants.providerMix')}
          value={providerCount ? fill(t('geocoding.variants.providers'), { n: providerCount }) : t('geocoding.value.noneYet')}
          kind={providerCount > 1 ? 'good' : providerCount === 1 ? 'info' : 'neutral'}
        />
        <PolicySignal
          label={t('geocoding.variants.manualReview')}
          value={
            manualReview
              ? t('geocoding.value.reviewTaskReady')
              : t('geocoding.variants.noReview')
          }
          kind={manualReview ? 'warn' : 'neutral'}
        />
        <PolicySignal
          label={t('geocoding.variants.failure')}
          value={
            failure
              ? policyDisplayLabel(metadataString(failure, 'failure_reason', 'failure_code', 'error', 'message') ?? failure.status, t)
              : t('geocoding.variants.noFailures')
          }
          kind={failure ? 'danger' : 'neutral'}
        />
      </div>
      {manualReview || failure ? (
        <div
          style={{
            borderTop: '1px solid var(--line)',
            marginTop: '10px',
            paddingTop: '10px',
            display: 'flex',
            flexWrap: 'wrap',
            gap: '6px',
            justifyContent: 'flex-end',
          }}
        >
          {manualReview ? (
            <Button
              label={t('geocoding.variants.inspectReview')}
              iconName="audit"
              kind="ghost"
              size="sm"
              testId="inspect-geocode-manual-review"
              onClick={() => onOpenAttempt(manualReview)}
            />
          ) : null}
          {failure ? (
            <Button
              label={t('geocoding.variants.inspectFailure')}
              iconName="alert"
              kind="ghost"
              size="sm"
              testId="inspect-geocode-failure"
              onClick={() => onOpenAttempt(failure)}
            />
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function PolicyWorkflowControls({
  readback,
  onConfigure,
}: {
  readback: PolicyMutationReadback | null;
  onConfigure: (category: PolicyCategoryKey) => void;
}) {
  const t = useT();
  return (
    <div className="card" style={{ padding: '12px', marginBottom: '12px' }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: '12px',
          marginBottom: '10px',
          flexWrap: 'wrap',
        }}
      >
        <div>
          <div className="section-eyebrow" style={{ padding: 0 }}>{t('geocoding.updates.title')}</div>
          <div className="state__hint">{t('geocoding.updates.hint')}</div>
        </div>
        <Chip label={t('geocoding.updates.savePath')} kind="info" size="xs" />
      </div>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
          gap: '10px',
        }}
      >
        {POLICY_CATEGORY_ORDER.map((policy) => (
          <div
            key={policy.key}
            style={{
              border: '1px solid var(--line)',
              borderRadius: '8px',
              padding: '10px',
              display: 'flex',
              minHeight: '154px',
              flexDirection: 'column',
              gap: '8px',
              background: 'var(--bg-2, transparent)',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' }}>
              <span className="mono" style={{ fontWeight: 700, fontSize: '12px' }}>
                {t(policy.labelKey)}
              </span>
              <Chip label={t('geocoding.updates.tenantEditable')} kind="neutral" size="xs" />
            </div>
            <div className="state__hint" style={{ flex: 1 }}>{t(policy.summaryKey)}</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px' }}>
              {(policy.techSignals ?? []).map((signal) => (
                <Chip key={signal} label={signal} kind="info" size="xs" />
              ))}
              {policy.signalKeys.map((signalKey) => (
                <Chip key={signalKey} label={t(signalKey)} kind="info" size="xs" />
              ))}
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
              <Button
                label={fill(t('geocoding.policy.configure'), { label: t(policy.labelKey) })}
                iconName="settings"
                kind="ghost"
                anyCapabilities={[CAP.SETTINGS_WRITE, CAP.SYSTEM_WRITE]}
                onClick={() => onConfigure(policy.key)}
              />
            </div>
          </div>
        ))}
      </div>
      {readback ? (
        <div
          style={{
            borderTop: '1px solid var(--line)',
            marginTop: '12px',
            paddingTop: '10px',
            display: 'flex',
            flexWrap: 'wrap',
            gap: '6px',
            alignItems: 'center',
          }}
        >
          <span className="mono" style={{ color: 'var(--ink-3)', fontSize: '11px' }}>
            {t('geocoding.updates.readback')}
          </span>
          <Chip label={policyCategoryLabel(readback.category, t)} kind="good" size="xs" />
          <Chip label={readback.scopeType === 'tenant' ? t('geocoding.updates.tenantScope') : titleCaseToken(readback.scopeType)} kind="info" size="xs" />
          <Chip label={t('geocoding.updates.settingsSaved')} kind="info" size="xs" />
          <Chip label={t('geocoding.updates.refreshed')} kind="info" size="xs" />
          {readback.version ? (
            <Chip label={`v${readback.version}`} kind="good" size="xs" className="mono" />
          ) : null}
          {readback.justification ? (
            <Chip label={fill(t('geocoding.readback.reason'), { reason: readback.justification.slice(0, 48) })} kind="neutral" size="xs" />
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function PolicyCapabilitySummary({
  mapPolicy,
  addressResolutionPolicy,
  geocodingPolicy,
}: {
  mapPolicy: MapPolicyValue | null;
  addressResolutionPolicy: AddressResolutionPolicyValue | null;
  geocodingPolicy: GeocodingPolicyValue | null;
}) {
  const t = useT();
  const tile = mapPolicy?.tile_provider;
  const stack = mapPolicy?.logistics_stack ?? geocodingPolicy?.metadata?.open_geocoding_stack;
  const stackRecord = recordValue(stack);
  const fuzzy = pluginByName(geocodingPolicy, 'fuzzy');
  const shortCode = pluginByName(geocodingPolicy, 'short_code');
  const shortCodeParams = recordValue(shortCode?.params);
  const coordinateHandling = geocodingPolicy?.coordinate_handling;
  const providerPriority = geocodingPolicy?.provider_priority ?? [];
  const shortCodeResolution = fieldResolutionByName(addressResolutionPolicy, 'sa_short_code');
  const coordinateResolution = fieldResolutionByName(addressResolutionPolicy, 'coordinates');
  const manualReviewRule = stringValue(geocodingPolicy?.provider_agreement_rules?.if_disagree) ?? 'manual_review';
  const sourceSummary = (field: PolicyFieldResolution | null) => {
    const sources = stringArrayValue(field?.sources);
    return sources.length
      ? sources.slice(0, 3).map((source) => policyDisplayLabel(source, t)).join(' > ')
      : t('geocoding.capability.sourcesMissing');
  };
  const tierLabel = tile?.usage_tier != null ? policyDisplayLabel(tile.usage_tier, t) : t('geocoding.capability.tierMissing');
  const boundary = stringValue(coordinateHandling?.country_boundary);
  const boundaryLabel = boundary === 'SA'
    ? t('geocoding.capability.saudiArabia')
    : boundary
      ? policyDisplayLabel(boundary, t)
      : t('geocoding.capability.country');

  return (
    <div className="card" style={{ padding: '12px', marginBottom: '12px' }}>
      <div className="section-eyebrow" style={{ padding: 0, marginBottom: '8px' }}>
        {t('geocoding.capability.title')}
      </div>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
          gap: '8px',
        }}
      >
        <PolicySignal
          label={t('geocoding.capability.mapProvider')}
          value={`${titleCaseToken(tile?.engine, t)} / ${titleCaseToken(tile?.data_provider ?? tile?.provider, t)}`}
          kind={tile?.engine === 'maplibre' && (tile?.data_provider ?? tile?.provider) === 'openstreetmap' ? 'good' : 'warn'}
        />
        <PolicySignal
          label={t('geocoding.capability.tileDelivery')}
          value={boolValue(tile?.cache_required) === true ? fill(t('geocoding.capability.enabled'), { label: tierLabel }) : tierLabel}
          kind={boolValue(tile?.cache_required) === true ? 'good' : 'warn'}
        />
        <PolicySignal
          label={t('geocoding.capability.geoStack')}
          value={[
            stringValue(stackRecord?.spatial_source_of_truth) ?? stringValue(stackRecord?.geospatial_source_of_truth),
            stringValue(stackRecord?.routing_engine),
            stringValue(stackRecord?.optimization_engine),
          ].filter(Boolean).map((value) => titleCaseToken(String(value))).join(' / ') || t('geocoding.capability.stackMissing')}
          kind={stackRecord ? 'good' : 'warn'}
        />
        <PolicySignal
          label={t('geocoding.capability.shortAddress')}
          value={`${describePlugin(shortCode, 'short_code', t)} ${policyDisplayLabel(stringValue(shortCodeParams?.code_type) ?? 'sa_short_code', t)}`}
          kind={shortCode?.enabled === false || !shortCode ? 'warn' : 'good'}
        />
        <PolicySignal
          label={t('geocoding.capability.shortCodeSources')}
          value={sourceSummary(shortCodeResolution)}
          kind={shortCodeResolution ? 'good' : 'warn'}
        />
        <PolicySignal
          label={t('geocoding.capability.coordinates')}
          value={`${boundaryLabel} ${coordinateHandling?.validate_bounds === false ? t('geocoding.capability.unbounded') : t('geocoding.capability.boundsChecked')}`}
          kind={coordinateHandling?.use_provided_coordinates === false ? 'warn' : 'good'}
        />
        <PolicySignal
          label={t('geocoding.capability.coordinateSources')}
          value={sourceSummary(coordinateResolution)}
          kind={coordinateResolution ? 'good' : 'warn'}
        />
        <PolicySignal
          label={t('geocoding.capability.fuzzy')}
          value={describePlugin(fuzzy, 'fuzzy', t)}
          kind={fuzzy?.enabled === false || !fuzzy ? 'warn' : 'good'}
        />
        <PolicySignal
          label={t('geocoding.capability.reviewFallback')}
          value={policyDisplayLabel(manualReviewRule, t)}
          kind={manualReviewRule === 'manual_review' ? 'good' : 'warn'}
        />
        <PolicySignal
          label={t('geocoding.capability.externalProviders')}
          value={providerPriority.length ? providerPriority.map((provider) => policyDisplayLabel(provider, t)).join(', ') : t('geocoding.capability.explicitOnly')}
          kind={providerPriority.length ? 'info' : 'good'}
        />
      </div>
    </div>
  );
}

function PolicySnapshot({ label, query }: PolicySnapshotProps) {
  const t = useT();
  return (
    <div className="card" style={{ padding: '12px', minHeight: '180px' }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
          marginBottom: '8px',
        }}
      >
        <span className="mono" style={{ fontWeight: 600, fontSize: '12px' }}>
          {label}
        </span>
        {query.data?.resolved_from ? (
          <ScopePill
            scopeType={query.data.resolved_from}
            scopeId={undefined}
          />
        ) : null}
        <Chip label={t('geocoding.snapshot.resolved')} kind="info" size="xs" />
      </div>
      {query.isError ? (
        <StateView
          kind="empty"
          hint={fill(t('geocoding.snapshot.noRow'), { label })}
        />
      ) : query.isLoading || !query.data ? (
        <StateView kind="loading" hint={t('geocoding.state.resolving')} />
      ) : (
        <PolicyValueBlock value={query.data.value} />
      )}
      {query.data?.ladder_path?.length ? (
        <div
          style={{
            marginTop: '8px',
            paddingTop: '8px',
            borderTop: '1px solid var(--line)',
          }}
        >
          <div
            className="mono"
            style={{ color: 'var(--ink-3)', fontSize: '10.5px', marginBottom: '4px' }}
          >
            {t('geocoding.snapshot.ladder')}
          </div>
          <div
            style={{
              display: 'flex',
              flexWrap: 'wrap',
              gap: '4px',
            }}
          >
            {query.data.ladder_path.map((step) => (
              <Chip
                key={`${step.scope_type}-${step.rank}`}
                label={`${step.scope_type}${
                  step.has_value ? ' ✓' : ''
                }`}
                kind={step.has_value ? 'good' : 'neutral'}
                size="xs"
              />
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function PolicyValueBlock({ value }: { value: unknown }) {
  const t = useT();
  if (value == null) {
    return <StateView kind="empty" hint={t('geocoding.state.nullValue')} />;
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>);
    const summary = entries.slice(0, 6).map(([key, entry]) => {
      const label = policyDisplayLabel(key, t);
      if (Array.isArray(entry)) return fill(t('geocoding.valueBlock.items'), { label, n: entry.length });
      if (entry && typeof entry === 'object') return fill(t('geocoding.valueBlock.settings'), { label, n: Object.keys(entry).length });
      if (typeof entry === 'boolean') return `${label}: ${entry ? t('geocoding.valueBlock.enabled') : t('geocoding.valueBlock.off')}`;
      if (typeof entry === 'string') return `${label}: ${policyDisplayLabel(entry, t)}`;
      if (entry == null) return `${label}: ${t('geocoding.value.notConfigured')}`;
      return `${policyDisplayLabel(key, t)}: ${String(entry)}`;
    });
    return (
      <div
        style={{
          background: 'var(--bg-2, transparent)',
          borderRadius: '6px',
          padding: '8px',
        }}
      >
        <div className="state__hint" style={{ marginBottom: '6px' }}>
          {fill(t('geocoding.valueBlock.saved'), { n: entries.length })}
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px' }}>
          {summary.map((entry) => (
            <Chip key={entry} label={entry} kind="neutral" size="xs" />
          ))}
        </div>
        <details style={{ marginTop: '8px' }}>
          <summary className="state__hint" style={{ cursor: 'pointer' }}>
            {t('geocoding.valueBlock.showDetails')}
          </summary>
          <pre
            className="mono"
            style={{
              fontSize: '11px',
              lineHeight: 1.6,
              overflow: 'auto',
              maxHeight: '160px',
              margin: '8px 0 0',
            }}
          >
            {JSON.stringify(value, null, 2)}
          </pre>
        </details>
      </div>
    );
  }
  return (
    <span className="mono" style={{ fontSize: '12px' }}>
      {String(value)}
    </span>
  );
}
