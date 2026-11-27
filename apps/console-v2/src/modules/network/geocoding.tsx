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
import { useI18n } from '@/lib/i18n';
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
): GeoPoint | null {
  const lat = Number(row.lat);
  const lng = Number(row.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  const parent = row.address_id ? addressById.get(row.address_id) : undefined;
  const provider = policyDisplayLabel(row.provider_name ?? row.provider ?? 'provider pending');
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

function titleCaseToken(value: string | undefined): string {
  if (!value) return 'Map engine missing';
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

function policyDisplayLabel(value: string | null | undefined): string {
  const normalized = value?.trim();
  if (!normalized) return 'Not configured';
  const known: Record<string, string> = {
    address_policy: 'Address policy',
    address_resolution_policy: 'Address resolution policy',
    geocode_cache: 'Geocode cache',
    geocoding_policy: 'Geocoding policy',
    manual_review: 'Manual review',
    map_policy: 'Map policy',
    national_address_lookup: 'National address lookup',
    osm_nominatim: 'OSM Nominatim',
    postgis_short_code: 'PostGIS short-code',
    production_cached: 'Production cache',
    provided_payload: 'Submitted address',
    provider_timeout: 'Provider timeout',
    retry: 'Retry',
    sa_short_code: 'Saudi short code',
    short_code: 'Short code',
    short_code_registry: 'Short-code registry',
  };
  return known[normalized] ?? titleCaseToken(normalized);
}

function pluginByName(policy: GeocodingPolicyValue | null, name: string) {
  return policy?.matching_plugins?.find((plugin) => plugin?.name === name) ?? null;
}

function fieldResolutionByName(policy: AddressResolutionPolicyValue | null, name: string) {
  return policy?.fields?.find((field) => field?.name === name) ?? null;
}

function describePlugin(plugin: ReturnType<typeof pluginByName>, fallback: string): string {
  const label = titleCaseToken(fallback);
  if (!plugin) return `${label} needs setup`;
  return `${label} ${plugin.enabled === false ? 'off' : 'on'}`;
}

const POLICY_CATEGORY_ORDER: Array<{
  key: PolicyCategoryKey;
  label: string;
  summary: string;
  signals: string[];
}> = [
  {
    key: 'map_policy',
    label: 'Map provider defaults',
    summary: 'Tiles, viewport, routing, and optimization provider stack.',
    signals: ['MapLibre / OSM', 'PostGIS / Valhalla / VROOM'],
  },
  {
    key: 'address_policy',
    label: 'Address capture',
    summary: 'Saudi address fields, coordinate capture, and required inputs.',
    signals: ['Short national address', 'Coordinates'],
  },
  {
    key: 'address_resolution_policy',
    label: 'Address resolution sources',
    summary: 'Per-field source order and review fallback behavior.',
    signals: ['Short-code registry', 'Manual review fallback'],
  },
  {
    key: 'geocoding_policy',
    label: 'Geocoding workflow',
    summary: 'Provider order, fuzzy match, short-code plugin, and review gate.',
    signals: ['Short-code plugin', 'Fuzzy plugin', 'Manual review'],
  },
];

function policyCategoryLabel(category: PolicyCategoryKey): string {
  return POLICY_CATEGORY_ORDER.find((policy) => policy.key === category)?.label ?? titleCaseToken(category);
}

const TABS: Array<{ key: TabKey; label: string }> = [
  { key: 'addresses', label: 'Addresses' },
  { key: 'geocodes', label: 'Geocodes' },
  { key: 'canonical', label: 'Canonical refs' },
  { key: 'policy', label: 'Policy & attempts' },
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

function AddressGeocodeAction({
  address,
  organizationId,
}: {
  address: AddressRow;
  organizationId: string | null;
}) {
  const go = useConsoleNavigator();
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
    ? 'Linked shipment unavailable'
    : targetShipment?.tracking_number
      ? `Shipment ${targetShipment.tracking_number}`
      : 'No linked shipment found for this address';

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
        label={requeueGeocode.isPending ? 'Requeueing...' : 'Requeue geocode'}
        iconName="refresh"
        kind="primary"
        capability={CAP.SHIPMENTS_WRITE}
        disabled={isBusy || isUnavailable}
        title={title}
        onClick={() => {
          setReadback(null);
          setExecutionError(null);
          if (!targetShipment) {
            pushToast('No linked shipment found for this address', 'warn');
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
                pushToast('Geocode update requested', 'good');
              },
              onError: (err) => {
                const message = err instanceof Error ? err.message : 'Could not requeue geocode';
                setExecutionError(message);
                pushToast(message, 'danger');
              },
            },
          );
        }}
      />
      {shipmentsQuery.isLoading ? (
        <Chip label="Checking linked shipment" kind="neutral" size="xs" />
      ) : shipmentsQuery.isError ? (
        <Chip label="Shipment link unavailable" kind="warn" size="xs" />
      ) : targetShipment?.tracking_number ? (
        <Chip label={targetShipment.tracking_number} kind="info" size="xs" className="mono" />
      ) : (
        <Chip label="No linked shipment" kind="neutral" size="xs" />
      )}
      {readback ? (
        <div
          data-testid="geocode-execution-readback"
          aria-label="Geocode status"
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
            Location update
          </span>
          <Chip label="Update requested" kind="good" size="xs" />
          <Chip label={`Status ${titleCaseToken(readback.status)}`} kind="info" size="xs" />
          {readback.geocodeWorkflowStatus ? (
            <Chip
              label={`Geocode ${titleCaseToken(readback.geocodeWorkflowStatus)}`}
              kind={isFailureExecution(readback.geocodeWorkflowStatus, readback.failureReason) ? 'danger' : 'info'}
              size="xs"
            />
          ) : null}
          {readback.geocodeWorkflowRunId ? (
            <Chip label="Follow-up queued" kind="neutral" size="xs" />
          ) : null}
          {readback.geocodingAttemptId ? (
            <Chip label="Address check recorded" kind="info" size="xs" />
          ) : null}
          {readback.geocodeId ? (
            <Chip label="Coordinate saved" kind="good" size="xs" />
          ) : null}
          {readback.manualReviewTaskId ? (
            <Chip label="Review queued" kind="warn" size="xs" />
          ) : null}
          {readback.failureReason ? (
            <Chip label={`Reason ${titleCaseToken(readback.failureReason)}`} kind="danger" size="xs" />
          ) : null}
          {isManualReviewExecution(readback.geocodeWorkflowStatus ?? readback.status, readback.manualReviewTaskId) ? (
            <Button
              label="Open review queue"
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
            Execution failed
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
  const mapStackLabel = `${titleCaseToken(mapTileProvider?.engine)} · ${titleCaseToken(
    mapTileProvider?.data_provider ?? mapTileProvider?.provider,
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
        .map((row) => buildGeocodePoint(row, addressById, geocodingThresholds))
        .filter((point): point is GeoPoint => point != null),
    [addressById, geocodes, geocodingThresholds],
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
      const t = a.created_at ? new Date(a.created_at as string).getTime() : NaN;
      return Number.isFinite(t) && t >= cutoff;
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
      pushToast(`${policyCategoryLabel(category)} cannot be edited yet`, 'warn');
      return;
    }

    modal.open({
      title: `Configure ${policy?.label ?? category}`,
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
                pushToast(`${titleCaseToken(scopeType)} scope is not available in this session`, 'warn');
                return undefined;
              }
              const result = (await proposeSettings.mutateAsync({
                category,
                scope: policyScope.scope,
                value: parsed,
                dryRun,
                justification,
              })) as SettingsChangePreviewResult;
              pushToast(dryRun ? 'Policy change preview ready' : 'Policy change submitted', 'good');
              if (!dryRun) modal.close();
              return result;
            } catch {
              pushToast(
                'Policy change could not be prepared. Check the entered settings and try again.',
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
                pushToast(`${titleCaseToken(scopeType)} scope is not available in this session`, 'warn');
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
                `${policyCategoryLabel(category)} saved`,
                'good',
              );
              modal.close();
              return result;
            } catch {
              pushToast(
                'Policy change could not be saved. Check the entered settings and try again.',
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
        label: 'Street',
        sortable: true,
        filterable: true,
        render: (_raw, row) => addressStreetOf(row) ?? '—',
      },
      { key: 'district', label: 'District', sortable: true, filterable: true },
      { key: 'city', label: 'City', sortable: true, filterable: true },
      { key: 'country', label: 'Country', sortable: true, filterable: true },
      { key: 'postal_code', label: 'Postal', mono: true, sortable: true },
      {
        key: 'validation_status',
        label: 'Status',
        sortable: true,
        filterable: true,
        render: (raw) => {
          const v = raw == null ? null : String(raw);
          return v ? (
            <CanonicalChip category="address_validation_status" value={v} labelOverride={policyDisplayLabel(v)} />
          ) : (
            <span>—</span>
          );
        },
      },
      {
        key: '__geocodes__',
        label: 'Geocodes',
        align: 'right',
        sortable: false,
        filterable: false,
        render: (_raw, row) => {
          const n = geocodesByAddress.get(row.id)?.length ?? 0;
          return n === 0 ? '—' : fmtNumber(n);
        },
      },
    ],
    [geocodesByAddress, fmtNumber]
  );

  const geocodeColumns = useMemo<Array<DataTableColumn<GeocodeRow>>>(
    () => [
      {
        key: 'address_id',
        label: 'Address',
        sortable: true,
        filterable: true,
        render: (raw) => {
          const address = raw ? addressById.get(String(raw)) : null;
          return address ? [addressStreetOf(address), address.city].filter(Boolean).join(' · ') : 'Linked address';
        },
      },
      // Canonical column is `provider_name`; seed alias `provider` is also
      // accepted via the row's render closure so legacy seeds keep rendering.
      {
        key: 'provider_name',
        label: 'Provider',
        sortable: true,
        filterable: true,
        render: (raw, row) => policyDisplayLabel(String(raw ?? row.provider ?? '')),
      },
      { key: 'lat', label: 'Lat', mono: true, align: 'right', sortable: true, type: 'number' },
      { key: 'lng', label: 'Lng', mono: true, align: 'right', sortable: true, type: 'number' },
      {
        key: 'confidence_score',
        label: 'Confidence',
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
        label: 'Cached',
        format: 'datetime',
        sortable: true,
        render: (raw, row) => {
          const v = (raw ?? row.cached_at) as string | undefined;
          return v ? fmtDateTime(v) : '—';
        },
      },
    ],
    [addressById, fmtDateTime]
  );

  const cityColumns = useMemo<Array<DataTableColumn<CanonicalCityRow>>>(
    () => [
      // Canonical key is `name_canonical`; we still surface a Code column for
      // legacy seed compatibility (falls through to `id` when absent).
      {
        key: 'id',
        label: 'Code',
        mono: true,
        sortable: true,
        filterable: true,
        render: (raw, row) => String(row.code ?? raw ?? '—'),
      },
      {
        key: 'name_canonical',
        label: 'Name',
        sortable: true,
        filterable: true,
        render: (raw, row) => String(raw ?? row.name ?? '—'),
      },
      {
        key: 'country_code',
        label: 'Country',
        sortable: true,
        filterable: true,
        render: (raw, row) => String(raw ?? row.country ?? '—'),
      },
    ],
    []
  );

  const districtColumns = useMemo<Array<DataTableColumn<CanonicalDistrictRow>>>(
    () => [
      {
        key: 'id',
        label: 'Code',
        mono: true,
        sortable: true,
        filterable: true,
        render: (raw, row) => String(row.code ?? raw ?? '—'),
      },
      {
        key: 'name_canonical',
        label: 'Name',
        sortable: true,
        filterable: true,
        render: (raw, row) => String(raw ?? row.name ?? '—'),
      },
      {
        key: 'city_id',
        label: 'City',
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
    [cities]
  );

  const attemptColumns = useMemo<Array<DataTableColumn<GeocodingAttemptRow>>>(
    () => [
      { key: 'created_at', label: 'When', format: 'datetime', sortable: true },
      {
        key: 'provider_name',
        label: 'Provider',
        sortable: true,
        filterable: true,
        render: (raw) => policyDisplayLabel(String(raw ?? '')),
      },
      // W13-1 — `attempt_type` resolves through metadata.attempt_type (no column). Sort/filter
      // operate on the projected key via the cell render below; per-projection key
      // keeps React key uniqueness across columns.
      {
        key: 'metadata.attempt_type',
        label: 'Type',
        sortable: false,
        filterable: false,
        render: (_raw, row) => {
          const t = attemptTypeOf(row);
          return t ? <span>{policyDisplayLabel(t)}</span> : <span>—</span>;
        },
      },
      {
        key: 'status',
        label: 'Status',
        sortable: true,
        filterable: true,
        render: (raw) => {
          const v = raw == null ? null : String(raw);
          return v ? (
            <CanonicalChip category="geocoding_attempt_status" value={v} labelOverride={policyDisplayLabel(v)} />
          ) : (
            <span>—</span>
          );
        },
      },
      {
        key: 'duration_ms',
        label: 'Duration',
        align: 'right',
        sortable: true,
        format: 'ms',
        type: 'number',
      },
      {
        key: 'address_id',
        label: 'Address',
        sortable: true,
        render: (raw) => {
          const address = raw ? addressById.get(String(raw)) : null;
          return address ? [addressStreetOf(address), address.city].filter(Boolean).join(' · ') : 'Linked address';
        },
      },
    ],
    [addressById]
  );

  function openAddress(addr: AddressRow) {
    const linkedGeocodes = geocodesByAddress.get(addr.id) ?? [];
    const linkedGeocodePoints = linkedGeocodes
      .map((row) => buildGeocodePoint(row, addressById, geocodingThresholds))
      .filter((point): point is GeoPoint => point != null);
    const rows: KvRow[] = [
      // W20 — Street row resolves canonical `normalized_line1` first via
      // `addressStreetOf()`; FE alias `street` remains a back-compat fallback.
      { key: 'street', label: 'Street', value: addressStreetOf(addr) ?? '—' },
      { key: 'district', label: 'District', value: addr.district ?? '—' },
      { key: 'city', label: 'City', value: addr.city ?? '—' },
      { key: 'country', label: 'Country', value: addr.country ?? '—' },
      {
        key: 'postal_code',
        label: 'Postal',
        value: addr.postal_code ?? '—',
        mono: true,
      },
      {
        key: 'validation_status',
        label: 'Status',
        value: addr.validation_status ? policyDisplayLabel(addr.validation_status) : '—',
      },
      {
        key: 'geocodes_count',
        label: 'Geocodes cached',
        value: linkedGeocodes.length === 0 ? '—' : fmtNumber(linkedGeocodes.length),
        mono: true,
      },
    ];

    drawer.open({
      title: `Address · ${addressStreetOf(addr) ?? addr.id}`,
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
                labelOverride={policyDisplayLabel(addr.validation_status)}
              />
            ) : null}
          </div>
          <KvGrid rows={rows} />

          <div className="section-eyebrow">Location map</div>
          <div style={{ padding: '0 14px 12px' }}>
            <GeoPointMap
              points={linkedGeocodePoints}
              bounds={mapDefaultViewport}
              height={220}
              title="Address geocode map"
              emptyLabel="No coordinate is available for this address yet."
              tileUrlTemplate={mapTileProvider?.url_template}
              allowedTileHosts={mapTileProvider?.allowed_hosts}
              tileUsageTier={mapTileProvider?.usage_tier}
              tileCacheRequired={mapTileProvider?.cache_required}
              sameOriginProxyAllowed={mapTileProvider?.same_origin_proxy_allowed}
              tileAttributionLabel={mapTileProvider?.attribution_label}
              tileAttributionUrl={mapTileProvider?.attribution_url}
            />
          </div>

          <div className="section-eyebrow">Geocodes for this address</div>
          {linkedGeocodes.length === 0 ? (
            <StateView
              kind="empty"
              hint="No geocode cached yet. Workflow runtime resolves addresses asynchronously."
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

          <div className="section-eyebrow">Workflow action</div>
          <AddressGeocodeAction address={addr} organizationId={tenantId} />

          <div className="section-eyebrow">Review settings</div>
          <div
            style={{
              display: 'flex',
              gap: '6px',
              padding: '0 14px',
              flexWrap: 'wrap',
            }}
          >
            <Button
              label="Address settings"
              iconName="settings"
              kind="ghost"
              onClick={() => {
                drawer.close();
                setActive('policy');
              }}
            />
            <Button
              label="Activity history"
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
    const providerLabel = provider === '—' ? provider : policyDisplayLabel(provider);
    const confidence = g.confidence_score ?? g.confidence;
    const cachedAt = g.geocoded_at ?? g.cached_at;
    const point = buildGeocodePoint(g, addressById, geocodingThresholds);
    const rows: KvRow[] = [
      { key: 'provider_name', label: 'Provider', value: providerLabel },
      { key: 'lat', label: 'Lat', value: g.lat != null ? String(g.lat) : '—', mono: true },
      { key: 'lng', label: 'Lng', value: g.lng != null ? String(g.lng) : '—', mono: true },
      {
        key: 'confidence_score',
        label: 'Confidence',
        value:
          confidence != null
            ? `${(Number(confidence) * 100).toFixed(1)}%`
            : '—',
        mono: true,
      },
      {
        key: 'geocoded_at',
        label: 'Cached',
        value: cachedAt ? fmtDateTime(cachedAt as string) : '—',
        mono: true,
      },
    ];

    drawer.open({
      title: `Geocode · ${providerLabel !== '—' ? providerLabel : 'Selected coordinate'}`,
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
          <div className="section-eyebrow">Location map</div>
          <div style={{ padding: '0 14px 12px' }}>
            <GeoPointMap
              points={point ? [point] : []}
              selectedId={point?.id}
              bounds={mapDefaultViewport}
              height={220}
              title="Geocode coordinate map"
              emptyLabel="This geocode row does not include a coordinate."
              tileUrlTemplate={mapTileProvider?.url_template}
              allowedTileHosts={mapTileProvider?.allowed_hosts}
              tileUsageTier={mapTileProvider?.usage_tier}
              tileCacheRequired={mapTileProvider?.cache_required}
              sameOriginProxyAllowed={mapTileProvider?.same_origin_proxy_allowed}
              tileAttributionLabel={mapTileProvider?.attribution_label}
              tileAttributionUrl={mapTileProvider?.attribution_url}
            />
          </div>
          <div className="section-eyebrow">Linked address</div>
          {parent ? (
            <KvGrid
              rows={[
                {
                  key: 'street',
                  label: 'Street',
                  // W20 — resolves canonical normalized_line1 first.
                  value: addressStreetOf(parent) ?? '—',
                },
                { key: 'city', label: 'City', value: parent.city ?? '—' },
                {
                  key: 'country',
                  label: 'Country',
                  value: parent.country ?? '—',
                },
                {
                  key: 'status',
                  label: 'Status',
                  value: parent.validation_status ? policyDisplayLabel(parent.validation_status) : '—',
                },
              ]}
            />
          ) : (
            <StateView
              kind="empty"
              hint="Address row not in current page — open Addresses tab to inspect."
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
      { key: 'created_at', label: 'When', value: attempt.created_at ? fmtDateTime(attempt.created_at) : '—', mono: true },
      { key: 'provider_name', label: 'Provider', value: policyDisplayLabel(attempt.provider_name) },
      { key: 'status', label: 'Status', value: policyDisplayLabel(attempt.status) },
      { key: 'attempt_type', label: 'Type', value: policyDisplayLabel(type) },
      { key: 'duration_ms', label: 'Duration', value: attempt.duration_ms != null ? `${attempt.duration_ms} ms` : '—', mono: true },
      { key: 'address_id', label: 'Address', value: attempt.address_id ? 'Linked address' : '—' },
      { key: 'workflow_run_id', label: 'Workflow', value: workflowRunId ? 'Workflow recorded' : '—' },
      { key: 'manual_review_task_id', label: 'Review task', value: manualReviewTaskId ? 'Review task ready' : '—' },
      { key: 'failure_reason', label: 'Failure', value: failureReason ? policyDisplayLabel(failureReason) : '—' },
    ];
    const showReviewQueue = isManualReviewExecution(type ?? attempt.status, manualReviewTaskId);

    drawer.open({
      title: `Geocoding attempt - ${policyDisplayLabel(attempt.provider_name)}`,
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
          <div className="section-eyebrow">Execution routing</div>
          <div style={{ display: 'flex', gap: '6px', padding: '0 14px', flexWrap: 'wrap' }}>
            {attempt.address_id && addressById.has(attempt.address_id) ? (
              <Button
                label="Open address"
                iconName="pin"
                kind="ghost"
                onClick={() => openAddress(addressById.get(attempt.address_id!)!)}
              />
            ) : null}
            {showReviewQueue ? (
              <Button
                label="Open review queue"
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
              <Chip label={`Failure reason: ${policyDisplayLabel(failureReason)}`} kind="danger" size="xs" />
            ) : null}
          </div>
        </div>
      ),
    });
  }

  function renderAddressesTab(): ReactNode {
    if (addressesQuery.isError)
      return <StateView kind="error" hint="Could not load addresses." />;
    if (addressesQuery.isLoading || !addressesQuery.data)
      return <StateView kind="loading" hint="Loading addresses…" />;
    if (!addresses.length)
      return (
        <StateView
          kind="empty"
          title="No addresses indexed"
          hint="Addresses arrive via shipment intake. Once webhooks fire they appear here."
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
      return <StateView kind="error" hint="Could not load geocodes." />;
    if (geocodesQuery.isLoading || !geocodesQuery.data)
      return <StateView kind="loading" hint="Loading geocodes…" />;
    if (!geocodes.length)
      return (
        <StateView
          kind="empty"
          title="No geocodes cached"
          hint="Once addresses resolve through the geocoding pipeline they appear here."
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
          hint="Could not load canonical references."
        />
      );
    if (citiesQuery.isLoading || districtsQuery.isLoading)
      return (
        <StateView kind="loading" hint="Loading canonical references…" />
      );
    if (!cities.length && !districts.length)
      return (
        <StateView
          kind="empty"
          title="Canonical references unavailable"
          hint="canonical_cities and canonical_districts feed the address resolver. Add canonical rows to populate this surface."
        />
      );
    return (
      <>
        <div className="section-eyebrow">Canonical cities</div>
        {cities.length ? (
          <DataTable<CanonicalCityRow>
            columns={cityColumns}
            rows={cities}
            viewKey="canonical_cities"
            entityKind="canonical_city"
          />
        ) : (
          <StateView kind="empty" hint="No canonical cities found." />
        )}
        <div className="section-eyebrow">Canonical districts</div>
        {districts.length ? (
          <DataTable<CanonicalDistrictRow>
            columns={districtColumns}
            rows={districts}
            viewKey="canonical_districts"
            entityKind="canonical_district"
          />
        ) : (
          <StateView kind="empty" hint="No canonical districts found." />
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
            label="Map settings"
            query={mapPolicyQuery}
          />
          <PolicySnapshot
            label="Address settings"
            query={addressPolicyQuery}
          />
          <PolicySnapshot
            label="Address resolution settings"
            query={addressResolutionPolicyQuery}
          />
          <PolicySnapshot
            label="Geocoding settings"
            query={geocodingPolicyQuery}
          />
        </div>

        <div className="section-eyebrow">Recent geocoding attempts</div>
        {attemptsQuery.isError ? (
          <StateView
            kind="empty"
            hint="Attempts ledger unavailable — registry may not surface geocoding_attempts in this environment."
          />
        ) : attemptsQuery.isLoading ? (
          <StateView kind="loading" hint="Loading attempts…" />
        ) : attempts.length === 0 ? (
          <StateView
            kind="empty"
            title="No attempts logged"
            hint="The geocoding_attempts ledger is empty. Workflow runs append rows here as they execute."
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
          eyebrow="Network"
          titleAccent="Geocoding"
          titlePlain="& addresses"
        />
        <StateView
          kind="denied"
          capability={CAP.NETWORK_READ}
          hint="You do not have permission to view geocoding & addresses."
        />
      </div>
    );
  }

  return (
    <div className="page">
      <PageHeader
        moduleKey="geocoding"
        eyebrow="Network"
        titleAccent="Geocoding"
        titlePlain="& addresses"
        pills={[
          <ScopePill key="scope" scopeType="tenant" scopeId={tenantId} />,
          <Chip
            key="src"
            label="addresses · geocodes · attempts"
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
          label="Addresses"
          value={fmtNumber(addresses.length)}
          delta="across senders"
          tone="neutral"
        />
        <KPICard
          label="Valid %"
          value={`${validPct}%`}
          delta="validation status"
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
          label="Geocodes cached"
          value={fmtNumber(geocodes.length)}
          delta="multi-provider"
          tone="info"
        />
        <KPICard
          label="Avg confidence"
          value={
            avgConfidence == null
              ? '—'
              : `${(avgConfidence * 100).toFixed(1)}%`
          }
          delta={avgConfidence == null ? 'no geocodes' : 'rolling mean'}
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
          label="Attempts (24h)"
          value={attempts24h == null ? '—' : fmtNumber(attempts24h)}
          delta={
            attempts24h == null
              ? 'feed unavailable'
              : districtCoverage != null
              ? `district coverage ${districtCoverage}%`
              : 'rolling 24h'
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
            <div className="section-eyebrow" style={{ padding: 0 }}>Geocoding coverage map</div>
            <div className="state__hint">
              {fmtNumber(geocodePoints.length)} plotted coordinates
              {missingCoordinateCount > 0
                ? ` · ${fmtNumber(missingCoordinateCount)} missing coordinates`
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
          title="Geocoding coverage map"
          tileUrlTemplate={mapTileProvider?.url_template}
          allowedTileHosts={mapTileProvider?.allowed_hosts}
          tileUsageTier={mapTileProvider?.usage_tier}
          tileCacheRequired={mapTileProvider?.cache_required}
          sameOriginProxyAllowed={mapTileProvider?.same_origin_proxy_allowed}
          tileAttributionLabel={mapTileProvider?.attribution_label}
          tileAttributionUrl={mapTileProvider?.attribution_url}
        />
      </div>

      <div className="tabs" role="tablist" aria-label="Geocoding tabs">
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-selected={active === t.key}
            className={`tabs__tab ${active === t.key ? 'is-active' : ''}`}
            onClick={() => setActive(t.key)}
          >
            {t.label}
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
          <div className="section-eyebrow" style={{ padding: 0 }}>Execution variants</div>
          <div className="state__hint">Recent ledger coverage for provider, review, and failure paths.</div>
        </div>
        <Chip label="geocoding_attempts" kind="info" size="xs" className="mono" />
      </div>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
          gap: '8px',
        }}
      >
        <PolicySignal
          label="Latest attempt"
          value={latest ? `${policyDisplayLabel(latest.status)} / ${policyDisplayLabel(attemptTypeOf(latest))}` : 'None yet'}
          kind={latestKind}
        />
        <PolicySignal
          label="Provider mix"
          value={providerCount ? `${providerCount} providers` : 'None yet'}
          kind={providerCount > 1 ? 'good' : providerCount === 1 ? 'info' : 'neutral'}
        />
        <PolicySignal
          label="Manual review"
          value={
            manualReview
              ? 'Review task ready'
              : 'No review needed'
          }
          kind={manualReview ? 'warn' : 'neutral'}
        />
        <PolicySignal
          label="Failure"
          value={
            failure
              ? policyDisplayLabel(metadataString(failure, 'failure_reason', 'failure_code', 'error', 'message') ?? failure.status)
              : 'No failures'
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
              label="Inspect manual review"
              iconName="audit"
              kind="ghost"
              size="sm"
              testId="inspect-geocode-manual-review"
              onClick={() => onOpenAttempt(manualReview)}
            />
          ) : null}
          {failure ? (
            <Button
              label="Inspect failure"
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
          <div className="section-eyebrow" style={{ padding: 0 }}>Policy updates</div>
          <div className="state__hint">Tenant-editable map and address controls are saved through the approved policy workflow.</div>
        </div>
        <Chip label="Approved save path" kind="info" size="xs" />
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
                {policy.label}
              </span>
              <Chip label="Tenant editable" kind="neutral" size="xs" />
            </div>
            <div className="state__hint" style={{ flex: 1 }}>{policy.summary}</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px' }}>
              {policy.signals.map((signal) => (
                <Chip key={signal} label={signal} kind="info" size="xs" />
              ))}
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
              <Button
                label={`Configure ${policy.label}`}
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
            Policy update
          </span>
          <Chip label={policyCategoryLabel(readback.category)} kind="good" size="xs" />
          <Chip label={readback.scopeType === 'tenant' ? 'Tenant scope' : titleCaseToken(readback.scopeType)} kind="info" size="xs" />
          <Chip label="Settings saved" kind="info" size="xs" />
          <Chip label="Policy refreshed" kind="info" size="xs" />
          {readback.version ? (
            <Chip label={`v${readback.version}`} kind="good" size="xs" className="mono" />
          ) : null}
          {readback.justification ? (
            <Chip label={`Reason ${readback.justification.slice(0, 48)}`} kind="neutral" size="xs" />
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
    return sources.length ? sources.slice(0, 3).map(policyDisplayLabel).join(' > ') : 'Sources missing';
  };

  return (
    <div className="card" style={{ padding: '12px', marginBottom: '12px' }}>
      <div className="section-eyebrow" style={{ padding: 0, marginBottom: '8px' }}>
        Policy breadth
      </div>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
          gap: '8px',
        }}
      >
        <PolicySignal
          label="Map provider"
          value={`${titleCaseToken(tile?.engine)} / ${titleCaseToken(tile?.data_provider ?? tile?.provider)}`}
          kind={tile?.engine === 'maplibre' && (tile?.data_provider ?? tile?.provider) === 'openstreetmap' ? 'good' : 'warn'}
        />
        <PolicySignal
          label="Tile delivery"
          value={`${policyDisplayLabel(tile?.usage_tier ?? 'tier missing')}${boolValue(tile?.cache_required) === true ? ' enabled' : ''}`}
          kind={boolValue(tile?.cache_required) === true ? 'good' : 'warn'}
        />
        <PolicySignal
          label="Geo stack"
          value={[
            stringValue(stackRecord?.spatial_source_of_truth) ?? stringValue(stackRecord?.geospatial_source_of_truth),
            stringValue(stackRecord?.routing_engine),
            stringValue(stackRecord?.optimization_engine),
          ].filter(Boolean).map((value) => titleCaseToken(String(value))).join(' / ') || 'stack missing'}
          kind={stackRecord ? 'good' : 'warn'}
        />
        <PolicySignal
          label="Saudi short address"
          value={`${describePlugin(shortCode, 'short_code')} ${policyDisplayLabel(stringValue(shortCodeParams?.code_type) ?? 'Saudi short code')}`}
          kind={shortCode?.enabled === false || !shortCode ? 'warn' : 'good'}
        />
        <PolicySignal
          label="Short-code sources"
          value={sourceSummary(shortCodeResolution)}
          kind={shortCodeResolution ? 'good' : 'warn'}
        />
        <PolicySignal
          label="Coordinates"
          value={`${stringValue(coordinateHandling?.country_boundary) === 'SA' ? 'Saudi Arabia' : policyDisplayLabel(stringValue(coordinateHandling?.country_boundary) ?? 'country')} ${coordinateHandling?.validate_bounds === false ? 'unbounded' : 'bounds checked'}`}
          kind={coordinateHandling?.use_provided_coordinates === false ? 'warn' : 'good'}
        />
        <PolicySignal
          label="Coordinate sources"
          value={sourceSummary(coordinateResolution)}
          kind={coordinateResolution ? 'good' : 'warn'}
        />
        <PolicySignal
          label="Fuzzy matching"
          value={describePlugin(fuzzy, 'fuzzy')}
          kind={fuzzy?.enabled === false || !fuzzy ? 'warn' : 'good'}
        />
        <PolicySignal
          label="Review fallback"
          value={policyDisplayLabel(manualReviewRule)}
          kind={manualReviewRule === 'manual_review' ? 'good' : 'warn'}
        />
        <PolicySignal
          label="External providers"
          value={providerPriority.length ? providerPriority.map(policyDisplayLabel).join(', ') : 'Explicit only'}
          kind={providerPriority.length ? 'info' : 'good'}
        />
      </div>
    </div>
  );
}

function PolicySnapshot({ label, query }: PolicySnapshotProps) {
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
        <Chip label="resolved snapshot" kind="info" size="xs" />
      </div>
      {query.isError ? (
        <StateView
          kind="empty"
          hint={`Resolver returned no row for ${label}. Add a settings_versions entry to populate.`}
        />
      ) : query.isLoading || !query.data ? (
        <StateView kind="loading" hint="Resolving ladder…" />
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
            ladder
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
  if (value == null) {
    return <StateView kind="empty" hint="Resolved value is null." />;
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>);
    const summary = entries.slice(0, 6).map(([key, entry]) => {
      if (Array.isArray(entry)) return `${policyDisplayLabel(key)}: ${entry.length} items`;
      if (entry && typeof entry === 'object') return `${policyDisplayLabel(key)}: ${Object.keys(entry).length} settings`;
      if (typeof entry === 'boolean') return `${policyDisplayLabel(key)}: ${entry ? 'Enabled' : 'Off'}`;
      if (typeof entry === 'string') return `${policyDisplayLabel(key)}: ${policyDisplayLabel(entry)}`;
      if (entry == null) return `${policyDisplayLabel(key)}: Not configured`;
      return `${policyDisplayLabel(key)}: ${String(entry)}`;
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
          {entries.length} saved policy settings
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px' }}>
          {summary.map((entry) => (
            <Chip key={entry} label={entry} kind="neutral" size="xs" />
          ))}
        </div>
        <details style={{ marginTop: '8px' }}>
          <summary className="state__hint" style={{ cursor: 'pointer' }}>
            Show configured policy details
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
