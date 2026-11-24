// tracking-map.tsx — Operator tracking map (clustered shipment density + hub
// markers + district labels) driven by `map_policy.clustering`.
//
// Backed by:
//   - public.geocodes (HASH-partitioned by address_id, MOD 4)  — 202510110006
//   - public.shipments                                          — core
//   - public.hubs (seeded; cloud schema uses public.branches)   — domain-routes
//   - resolve_settings('map_policy')                            — 202602061540
//
// SCHEMA NOTE: cloud `map_policy.clustering.grid_px` is the canonical key
// (see migration 202602061540_mobile_shell_policy_pack_v1.sql). Workspace
// seed stores the legacy `clustering.grid` key. We read both with grid_px
// taking precedence, so the same module works against both.

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Button } from '@/components/Button';
import { Chip } from '@/components/Chip';
import { ScopePill } from '@/components/ScopePill';
import { LadderViz } from '@/components/LadderViz';
import { PageHeader } from '@/components/PageHeader';
import { StateView } from '@/components/StateView';
import { MapLibreBackdrop } from '@/components/MapLibreBackdrop';
import { OpenStreetMapAttribution } from '@/components/OpenStreetMapTileLayer';
import { buildDecisionTrailDrawerSpec } from '@/components/decisionTrail';
import { useResolveSettings, useResourceList, useProposeSettingsChange } from '@/lib/queries';
import { useDrawer } from '@/hooks/useOverlay';
import { pushToast } from '@/components/toastStore';
import { useCapability, useIdentity } from '@/lib/identity';
import { CAP } from '@/lib/capabilities';
import type { SettingsResolution } from '@/types/domain';

// Wave 6 schema-drift remediation (OPERATIONS Sections 13, 14, 15):
// FE row interfaces annotated against canonical `public.geocodes`,
// `public.shipments`, and `public.branches` (resource key 'hubs').
// See __audit__/SCHEMA-DRIFT/OPERATIONS.md §13-§15.
//
// Cross-cutting: ui_read_registry.geocodes projection should expand the
// geography(POINT, 4326) column into latitude/longitude scalars via ST_Y/ST_X
// (paired backend projection deferred W7).
interface GeocodeRow extends Record<string, unknown> {
  id: string;                       // SSOT: geocodes.id
  latitude?: number | string | null; // SSOT projection alias (ST_Y(coordinates))
  longitude?: number | string | null;// SSOT projection alias (ST_X(coordinates))
  lat?: number | string | null;      // api.geocodes map-ready alias
  lng?: number | string | null;      // api.geocodes map-ready alias
  address_id?: string;              // SSOT: geocodes.address_id
}
interface ShipmentRow extends Record<string, unknown> {
  id: string;                       // SSOT: shipments.id
  tracking_number: string;          // SSOT: shipments.tracking_number
  destination_city?: string;        // W38 closure: projection-only — canonical
                                    // value resolved through v_shipment_directory
                                    // (consumed via useResourceList below).
                                    // Optional on the base row so the canonical
                                    // SSOT stays projection-bound; the seed
                                    // adapter still emits this field for
                                    // backward parity but the FE prefers the
                                    // directory join when present.
  service_type: string;             // SSOT: shipments.service_type
}

// W38-OPERATIONS P2-2 closure — paired projection consumption mirrors
// shipments.tsx (W24 pattern). The base shipments resource is the canonical
// SSOT; v_shipment_directory enriches reads with destination_city /
// origin_city / counterparty labels joined through canonical FKs.
interface ShipmentDirectoryRow extends Record<string, unknown> {
  id: string;
  destination_city?: string | null;
  origin_city?: string | null;
}
interface HubRow extends Record<string, unknown> {
  id: string;                       // SSOT: branches.id ('hubs' aliases branches)
  code: string;                     // SSOT: branches.code
  name: string;                     // SSOT: branches.name
  city: string;                     // SSOT: REMOVE — projection (resolve via branches.address->>'city' JSONB)
  cutoff_time: string;              // SSOT: REMOVE — projection (resolve via branches.operating_hours JSONB / policy)
  lat?: number | string | null;
  lng?: number | string | null;
  latitude?: number | string | null;
  longitude?: number | string | null;
  coordinates?: {
    lat?: number | string | null;
    lng?: number | string | null;
    latitude?: number | string | null;
    longitude?: number | string | null;
  } | null;
}

// W34c — canonical districts row shape consumed for ambient label rendering.
// SSOT: `public.canonical_districts` (city_code + name_canonical + optional
// `centroid_lat`/`centroid_lng` jsonb projection). Districts without
// centroids are skipped (no synthetic fallback coordinates).
interface CanonicalDistrictRow extends Record<string, unknown> {
  id: string;
  city_code: string;
  name_canonical?: string | null;
  name?: string | null;
  centroid_lat?: number | null;
  centroid_lng?: number | null;
}

interface Viewport {
  minLat: number;
  maxLat: number;
  minLng: number;
  maxLng: number;
}

function policyDetailRows(value: unknown): Array<{ key: string; value: string }> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  return Object.entries(value as Record<string, unknown>)
    .slice(0, 8)
    .map(([key, raw]) => ({ key, value: policyDetailValue(raw) }));
}

function operatorLabel(value: unknown, fallback = 'Not set'): string {
  if (value == null || value === '') return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (normalized === 'rto') return 'Return';
  return String(value)
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function policyDetailValue(value: unknown): string {
  if (value == null || value === '') return 'Not set';
  if (typeof value === 'boolean') return value ? 'Enabled' : 'Disabled';
  if (typeof value === 'number') return String(value);
  if (typeof value === 'string') return operatorLabel(value);
  if (Array.isArray(value)) return `${value.length} item${value.length === 1 ? '' : 's'}`;
  if (typeof value === 'object') {
    const count = Object.keys(value as Record<string, unknown>).length;
    return `${count} setting${count === 1 ? '' : 's'}`;
  }
  return String(value);
}

const W = 1000;
const H = 600;
// W54-C closure — INITIAL_VIEWPORT inlined Riyadh-canonical bbox literal
// removed. The default viewport is now resolved strictly from canonical
// `map_policy.default_viewport`. Missing canonical row surfaces a loud
// StateView so operators see the gap rather than a silent fallback.

// Hub coordinates are sourced strictly from the canonical `hubs`
// resource (FE alias of `public.branches`; branches.coordinates JSONB
// carries canonical lat/lng — see seed-raw/network-branches.js +
// seed-raw/domain-routes.js#hubs). NO fallback constants — when a hub
// row lacks lat/lng, the map renders an explicit "missing-location"
// marker rather than silently substituting a literal coordinate.

// W34c — DISTRICT_LABELS removed in favor of canonical
// `useResourceList('canonical_districts')` projection (see
// `tracking-map.tsx` body). The canonical SSOT is
// `public.canonical_districts` enriched with optional
// `centroid_lat`/`centroid_lng` projections (seeded for the rendered
// neighborhoods); districts without centroids are skipped without
// synthesizing coordinates.

interface Cluster {
  count: number;
  x: number;
  y: number;
  members: GeocodeRow[];
}

interface MapClustering {
  enabled?: boolean;
  // Cloud SSOT key.
  grid_px?: number;
  // Legacy workspace seed key.
  grid?: number;
  min_count?: number;
  show_legend?: boolean;
}
interface MapPolicyValue {
  clustering?: MapClustering;
  tile_provider?: {
    url_template?: string;
    allowed_hosts?: string[];
    usage_tier?: string;
    cache_required?: boolean;
    same_origin_proxy_allowed?: boolean;
    attribution_label?: string;
    attribution_url?: string;
  };
  show_legend?: boolean;
  // W54-C closure — default viewport bbox + cluster fit-to-bounds zoom
  // padding resolved strictly from canonical map_policy. NO inline FE
  // literals.
  default_viewport?: Viewport;
  zoom_padding?: { lat?: number; lng?: number };
}

function mapNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

export function resolveTrackingGeocodeCoordinates(row: Record<string, unknown>): { lat: number; lng: number } | null {
  const lat = mapNumber(row.latitude ?? row.lat);
  const lng = mapNumber(row.longitude ?? row.lng);
  if (lat == null || lng == null || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    return null;
  }
  return { lat, lng };
}

export function TrackingMapModule() {
  const drawer = useDrawer();
  const { scope, currentTenantId } = useIdentity();
  const canRead = useCapability(CAP.SHIPMENTS_READ);
  const tenantId = scope.tenant?.id ?? currentTenantId() ?? null;
  const tenantListOpts = useMemo(
    () => (tenantId ? { filter: { organization_id: tenantId } } : undefined),
    [tenantId],
  );
  const tenantSettingsScope = useMemo(
    () => (tenantId ? { organization_id: tenantId } : undefined),
    [tenantId],
  );
  // W54-C closure — viewport state is null until canonical map_policy
  // resolves the default_viewport bbox; the page surfaces a strict error
  // StateView when the policy is missing rather than silently substituting
  // an inline Riyadh bbox.
  const [viewport, setViewport] = useState<Viewport | null>(null);

  const { data: policy } = useResolveSettings('map_policy', tenantSettingsScope);
  // CLAIM-OPERATIONS-WIRING (Phase C1) — clustering toggle now persists via
  // the canonical proposeSettingsChange RPC (resolves through ladder).
  // Backed by `proposeSettingsChange('map_policy', { tenant_id }, value)`.
  const proposeSettings = useProposeSettingsChange();
  const { data: shipmentsData, isLoading: shipmentsLoading } = useResourceList<ShipmentRow>('shipments', tenantListOpts);
  const { data: geocodesData, isLoading: geocodesLoading } = useResourceList<GeocodeRow>('geocodes', tenantListOpts);
  const { data: hubsData } = useResourceList<HubRow>('hubs', tenantListOpts);
  // W34c — canonical district label projection. Replaces the prior inline
  // DISTRICT_LABELS literal with an SSOT-faithful read; rendering filters to
  // rows with non-null `centroid_lat`/`centroid_lng`.
  const { data: districtsData } = useResourceList<CanonicalDistrictRow>('canonical_districts');
  // W38-OPERATIONS P2-2 closure — additive paired projection. Canonical SSOT
  // remains `shipments`; this read enriches the bottom card list with
  // FE-shaped destination_city joined through addresses via
  // v_shipment_directory. Mirrors the pattern in shipments.tsx +
  // route-plans.tsx (W24).
  const { data: shipmentDirectoryData } = useResourceList<ShipmentDirectoryRow>('shipment_directory', tenantListOpts);

  const shipments = useMemo(() => shipmentsData?.rows ?? [], [shipmentsData]);
  const geocodes = useMemo(() => geocodesData?.rows ?? [], [geocodesData]);
  const hubs = useMemo(() => hubsData?.rows ?? [], [hubsData]);
  const shipmentDirectoryById = useMemo(() => {
    const map = new Map<string, ShipmentDirectoryRow>();
    for (const r of shipmentDirectoryData?.rows ?? []) map.set(r.id, r);
    return map;
  }, [shipmentDirectoryData]);

  const policyValue = (policy?.value as MapPolicyValue | undefined) ?? {};
  const clustering = policyValue.clustering ?? {};
  // W54-C closure — strict no-fallback for grid_px / min_count. Cloud SSOT
  // is `clustering.grid_px`; legacy workspace seed accepts `clustering.grid`
  // as an alias. Missing both keys means the canonical policy was not
  // seeded — surface a loud StateView below rather than silently
  // substituting an inline FE literal.
  const gridPxResolved = clustering.grid_px ?? clustering.grid ?? null;
  const minCountResolved = clustering.min_count ?? null;
  const gridPx = gridPxResolved ?? 0;
  const minCount = minCountResolved ?? 0;
  const showLegend = policyValue.show_legend === true || clustering.show_legend === true;
  const clusteringEnabled = clustering.enabled !== false;
  const mapTileProvider = policyValue.tile_provider;
  // Default viewport + zoom padding strictly resolved from canonical
  // `map_policy`. Missing keys → page surfaces a loud StateView.
  const defaultViewport = policyValue.default_viewport ?? null;
  const zoomPaddingLat = policyValue.zoom_padding?.lat ?? null;
  const zoomPaddingLng = policyValue.zoom_padding?.lng ?? null;
  const clusterMinimumLabel = minCount === 1 ? 'shipment' : 'shipments';
  // Bind the viewport state to the canonical default the first time policy
  // resolves. Tenants override at tenant scope; toggling clustering keeps
  // the operator-selected viewport intact.
  useEffect(() => {
    if (!viewport && defaultViewport) {
      setViewport(defaultViewport);
    }
  }, [viewport, defaultViewport]);

  const proj = useMemo(() => {
    if (!viewport) {
      // Strict no-fallback — without a canonical viewport, `proj` cannot
      // map lat/lng to pixel coordinates. Returning a sentinel `null` lets
      // downstream consumers no-op until the policy resolves.
      return null as null | ((lat: number, lng: number) => { x: number; y: number });
    }
    const v = viewport;
    return (lat: number, lng: number) => ({
      x: ((lng - v.minLng) / (v.maxLng - v.minLng)) * W,
      y: ((v.maxLat - lat) / (v.maxLat - v.minLat)) * H,
    });
  }, [viewport]);

  const clusters = useMemo(() => {
    const m = new Map<string, Cluster>();
    if (!clusteringEnabled || !proj || gridPxResolved == null) return m;
    geocodes.forEach((g) => {
      const coordinates = resolveTrackingGeocodeCoordinates(g);
      if (!coordinates) return;
      const { x, y } = proj(coordinates.lat, coordinates.lng);
      if (x < 0 || y < 0 || x > W || y > H) return;
      const cx = Math.floor(x / gridPx);
      const cy = Math.floor(y / gridPx);
      const key = `${cx}_${cy}`;
      let c = m.get(key);
      if (!c) {
        c = { count: 0, x: cx * gridPx + gridPx / 2, y: cy * gridPx + gridPx / 2, members: [] };
        m.set(key, c);
      }
      c.count++;
      c.members.push(g);
    });
    return m;
  }, [geocodes, gridPx, gridPxResolved, proj, clusteringEnabled]);

  // CLAIM-OPERATIONS-WIRING (Phase C1) — propose a tenant-scoped override
  // toggling map_policy.clustering.enabled. The RPC writes a new
  // settings_version with status='proposed' (production) or returns the new
  // shape directly (in-memory adapter); the UI invalidates the resolver
  // query so the chip pill updates without a full refetch.
  async function handleToggleClustering() {
    if (!tenantId) {
      pushToast('Select a tenant before changing map clustering.', 'warn');
      return;
    }
    const nextEnabled = !clusteringEnabled;
    try {
      await proposeSettings.mutateAsync({
        category: 'map_policy',
        scope: { tenant_id: tenantId },
        value: {
          ...((policy?.value as MapPolicyValue | undefined) ?? {}),
          clustering: {
            ...(((policy?.value as MapPolicyValue | undefined)?.clustering) ?? {}),
            enabled: nextEnabled,
            grid_px: gridPx,
            min_count: minCount,
          },
        },
        dryRun: false,
        justification: `Operator toggled clustering ${nextEnabled ? 'on' : 'off'} from /operate/tracking-map`,
      });
      pushToast(`Map clustering ${nextEnabled ? 'enabled' : 'disabled'} for review.`, 'good');
    } catch {
      pushToast('Map clustering could not be updated. Try again.', 'danger');
    }
  }

  function zoomTo(cluster: Cluster) {
    if (!cluster.members.length) return;
    // W54-C — zoom padding resolved strictly from canonical
    // `map_policy.zoom_padding`. NO inline `0.004` / `0.005` literals.
    if (zoomPaddingLat == null || zoomPaddingLng == null) {
      pushToast('Map zoom settings are unavailable. Try again after policy is updated.', 'warn');
      return;
    }
    const memberCoordinates = cluster.members
      .map(resolveTrackingGeocodeCoordinates)
      .filter((coordinates): coordinates is { lat: number; lng: number } => coordinates != null);
    if (!memberCoordinates.length) return;
    const lats = memberCoordinates.map((m) => m.lat);
    const lngs = memberCoordinates.map((m) => m.lng);
    setViewport({
      minLat: Math.min(...lats) - zoomPaddingLat,
      maxLat: Math.max(...lats) + zoomPaddingLat,
      minLng: Math.min(...lngs) - zoomPaddingLng,
      maxLng: Math.max(...lngs) + zoomPaddingLng,
    });
  }
  function resetZoom() {
    // W54-C — strict no-fallback: reset to the canonical default viewport.
    if (defaultViewport) setViewport(defaultViewport);
  }

  function openPolicyDrawer() {
    drawer.open({
      title: 'Map display policy',
      body: (
        <div>
          <p className="state__hint">
            These settings control clustering, default view, and map behavior for this tenant.
          </p>
          {policy ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px', margin: '8px 0' }}>
              <ScopePill scopeType={policy.resolved_from} />
              <Chip size="xs" kind="info" label="Policy applied" />
            </div>
          ) : null}
          <LadderViz resolution={policy} />
          <h4 className="eyebrow" style={{ marginTop: '14px' }}>Resolved settings</h4>
          <div className="card" style={{ display: 'grid', gap: 6 }}>
            {policyDetailRows(policy?.value ?? {}).map((row) => (
              <div
                key={row.key}
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'minmax(120px, 0.45fr) minmax(0, 1fr)',
                  gap: 8,
                  fontSize: 11,
                }}
              >
                <span className="eyebrow">{operatorLabel(row.key)}</span>
                <span>{row.value}</span>
              </div>
            ))}
          </div>
        </div>
      ),
    });
  }

  function openShipmentDrawer(s: ShipmentRow) {
    drawer.open(
      buildDecisionTrailDrawerSpec(s as Record<string, unknown>, 'shipment'),
    );
  }

  const policyResolved: SettingsResolution | undefined = policy;
  const pills: ReactNode[] = [
    <ScopePill
      key="scope"
      scopeType={policyResolved?.resolved_from ?? 'global'}
      scopeId={policyResolved?.resolved_from === 'tenant' ? (tenantId ?? '') : 'global'}
    />,
    <Chip key="cat" size="xs" label="Clustering policy" />,
    !clusteringEnabled ? (
      <Chip key="off" size="xs" kind="warn" label="Clustering off" />
    ) : null,
  ].filter(Boolean) as ReactNode[];

  if (!canRead) {
    return (
      <div className="page">
        <PageHeader
          moduleKey="trackingMap"
          eyebrow="Operate"
          titleAccent="Tracking"
          titlePlain="map"
        />
        <StateView
          kind="denied"
          capability={CAP.SHIPMENTS_READ}
          hint="You do not have permission to view the tracking map."
        />
      </div>
    );
  }

  if (shipmentsLoading || geocodesLoading) {
    return (
      <div className="page">
        <PageHeader moduleKey="trackingMap" eyebrow="Operate" titleAccent="Tracking" titlePlain="map" pills={pills} actions={[]} />
        <StateView kind="loading" />
      </div>
    );
  }

  // W54-C closure — strict no-fallback: surface canonical policy gaps
  // (default_viewport / clustering.grid_px / clustering.min_count) as a
  // loud StateView so operators see exactly which canonical row is
  // missing rather than silently substituting FE literals.
  if (policy && (!defaultViewport || gridPxResolved == null || minCountResolved == null)) {
    const missingKeys: string[] = [];
    if (!defaultViewport) missingKeys.push('Default viewport');
    if (gridPxResolved == null) missingKeys.push('Cluster grid size');
    if (minCountResolved == null) missingKeys.push('Minimum shipments per cluster');
    return (
      <div className="page">
        <PageHeader moduleKey="trackingMap" eyebrow="Operate" titleAccent="Tracking" titlePlain="map" pills={pills} actions={[]} />
        <StateView
          kind="error"
          title="Map settings are incomplete"
          hint={`Update the map display policy before viewing the tracking map. Missing: ${missingKeys.join(', ')}.`}
        />
      </div>
    );
  }
  if (!viewport) {
    return (
      <div className="page">
        <PageHeader moduleKey="trackingMap" eyebrow="Operate" titleAccent="Tracking" titlePlain="map" pills={pills} actions={[]} />
        <StateView kind="loading" />
      </div>
    );
  }
  if (!proj) {
    return (
      <div className="page">
        <PageHeader moduleKey="trackingMap" eyebrow="Operate" titleAccent="Tracking" titlePlain="map" pills={pills} actions={[]} />
        <StateView kind="loading" />
      </div>
    );
  }

  // Build hub render list strictly from the canonical `hubs` resource
  // (FE alias of `branches`; canonical column: branches.coordinates JSONB).
  // Rows with lat/lng resolve to a positioned marker; rows without
  // coordinates resolve to a "missing-location" marker (no synthetic
  // substitution).
  type HubMarker =
    | { id: string; located: true; lat: number; lng: number; label: string }
    | { id: string; located: false; label: string };
  const hubMarkers: HubMarker[] = hubs.map((h): HubMarker => {
    const lat = mapNumber(h.lat ?? h.latitude ?? h.coordinates?.lat ?? h.coordinates?.latitude);
    const lng = mapNumber(h.lng ?? h.longitude ?? h.coordinates?.lng ?? h.coordinates?.longitude);
    if (lat == null || lng == null || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
      return { id: h.id, located: false, label: h.name };
    }
    return { id: h.id, located: true, lat, lng, label: h.name };
  });
  const locatedHubMarkers = hubMarkers.filter(
    (h): h is Extract<HubMarker, { located: true }> => h.located,
  );
  const missingHubMarkers = hubMarkers.filter(
    (h): h is Extract<HubMarker, { located: false }> => !h.located,
  );

  return (
    <div className="page">
      <PageHeader
        moduleKey="trackingMap"
        eyebrow="Operate"
        titleAccent="Tracking"
        titlePlain="map"
        pills={pills}
        actions={[
          <Button key="inspect" label="Inspect policy" iconName="eye" kind="ghost" onClick={openPolicyDrawer} />,
          <Button
            key="toggle-clustering"
            label={clusteringEnabled ? 'Disable clustering' : 'Enable clustering'}
            iconName="bolt"
            kind="ghost"
            capability={CAP.SETTINGS_WRITE}
            disabled={proposeSettings.isPending}
            onClick={handleToggleClustering}
          />,
        ]}
      />

      <div style={{ flex: 1, display: 'grid', gridTemplateColumns: '1fr 380px', minHeight: 0, overflow: 'hidden' }}>
        <div className="map-canvas" style={{ position: 'relative' }}>
          <MapLibreBackdrop
            bounds={viewport}
            width={W}
            height={H}
            tileUrlTemplate={mapTileProvider?.url_template}
            allowedTileHosts={mapTileProvider?.allowed_hosts}
            usageTier={mapTileProvider?.usage_tier}
            cacheRequired={mapTileProvider?.cache_required}
            sameOriginProxyAllowed={mapTileProvider?.same_origin_proxy_allowed}
            attributionLabel={mapTileProvider?.attribution_label}
            attributionUrl={mapTileProvider?.attribution_url}
            fallbackWashClassName="tracking-map__tile-wash"
            fallbackGridClassName="tracking-map__fallback-grid"
          />
          <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMid meet">
            {/* Grid lines */}
            <g>
              {Array.from({ length: Math.floor(W / (gridPx * 4)) + 1 }, (_, i) => i * gridPx * 4).map((x) => (
                <line key={`gx-${x}`} x1={x} x2={x} y1={0} y2={H} stroke="var(--line)" strokeWidth={0.5} />
              ))}
              {Array.from({ length: Math.floor(H / (gridPx * 4)) + 1 }, (_, i) => i * gridPx * 4).map((y) => (
                <line key={`gy-${y}`} x1={0} x2={W} y1={y} y2={y} stroke="var(--line)" strokeWidth={0.5} />
              ))}
            </g>
            {/* Subtle gradient backdrop */}
            <defs>
              <radialGradient id="mapGrad" cx="50%" cy="50%" r="70%">
                <stop offset="0%" stopColor="oklch(from var(--accent) l c h / 0.04)" />
                <stop offset="100%" stopColor="transparent" />
              </radialGradient>
            </defs>
            <rect x={0} y={0} width={W} height={H} fill="url(#mapGrad)" />

            {/* District labels (light, ambient) — sourced from the district list. Districts
                without centroid_lat/centroid_lng are silently skipped (no
                synthetic coordinates). */}
            {(districtsData?.rows ?? [])
              .filter((d) =>
                typeof d.centroid_lat === 'number' &&
                typeof d.centroid_lng === 'number',
              )
              .map((d) => {
                const lat = d.centroid_lat as number;
                const lng = d.centroid_lng as number;
                const { x, y } = proj(lat, lng);
                if (x < 0 || y < 0 || x > W || y > H) return null;
                const labelText = d.name_canonical ?? d.name ?? d.id;
                return (
                  <text
                    key={d.id}
                    x={x}
                    y={y}
                    textAnchor="middle"
                    fill="var(--ink-3)"
                    fontFamily="var(--font-mono)"
                    fontSize={10}
                    opacity={0.55}
                    fontWeight={500}
                    style={{ textTransform: 'uppercase', letterSpacing: '0.08em' }}
                  >
                    {labelText}
                  </text>
                );
              })}

            {/* Hub markers — driven by useResourceList('hubs'); strict
                verified lat/lng. Hubs without coordinates render the
                missing-location indicator below (outside the SVG). */}
            {locatedHubMarkers.map((h) => {
              const { x, y } = proj(h.lat, h.lng);
              if (x < 0 || y < 0 || x > W || y > H) return null;
              return (
                <g key={h.id}>
                  <rect x={x - 9} y={y - 9} width={18} height={18} rx={3} fill="var(--paper)" stroke="var(--ink)" strokeWidth={1.5} />
                  <rect x={x - 4} y={y - 4} width={8} height={8} fill="var(--ink)" />
                  <text
                    x={x}
                    y={y + 28}
                    textAnchor="middle"
                    fill="var(--ink)"
                    fontFamily="var(--font-mono)"
                    fontSize={11}
                    fontWeight={600}
                  >
                    {h.label}
                  </text>
                </g>
              );
            })}

            {/* Clusters */}
            {Array.from(clusters.values()).map((c, i) =>
              c.count >= minCount ? (
                <g key={`cluster-${i}`}>
                  <circle
                    cx={c.x}
                    cy={c.y}
                    r={6 + Math.min(c.count, 12)}
                    fill="var(--accent)"
                    fillOpacity={0.18}
                    stroke="var(--accent)"
                    strokeWidth={1.4}
                    style={{ cursor: 'pointer' }}
                    onClick={() => zoomTo(c)}
                  />
                  <text
                    x={c.x}
                    y={c.y + 4}
                    textAnchor="middle"
                    fill="var(--accent-ink)"
                    fontFamily="Geist Mono"
                    fontSize={11}
                    fontWeight={600}
                    style={{ pointerEvents: 'none' }}
                  >
                    {c.count}
                  </text>
                </g>
              ) : (
                c.members.map((m) => {
                  const coordinates = resolveTrackingGeocodeCoordinates(m);
                  if (!coordinates) return null;
                  const { x, y } = proj(coordinates.lat, coordinates.lng);
                  return <circle key={`pt-${m.id}`} cx={x} cy={y} r={3} fill="var(--accent)" />;
                })
              ),
            )}

            {/* When clustering is disabled, render every geocode as a dot. */}
            {!clusteringEnabled
              ? geocodes.map((g) => {
                  const coordinates = resolveTrackingGeocodeCoordinates(g);
                  if (!coordinates) return null;
                  const { x, y } = proj(coordinates.lat, coordinates.lng);
                  if (x < 0 || y < 0 || x > W || y > H) return null;
                  return <circle key={`pt-${g.id}`} cx={x} cy={y} r={3} fill="var(--accent)" />;
                })
              : null}

            {showLegend ? (
              <text x={12} y={H - 12} fill="var(--ink-3)" fontFamily="Geist Mono" fontSize={11}>
                {`Clustering: ${gridPx}px grid, ${minCount} ${clusterMinimumLabel} minimum. Click a cluster to zoom.`}
              </text>
            ) : null}
          </svg>
          <button
            type="button"
            className="btn btn--sm"
            style={{
              position: 'absolute',
              top: '12px',
              right: '12px',
              zIndex: 2,
              boxShadow: 'var(--shadow-soft)',
              background: 'var(--paper)',
            }}
            onClick={resetZoom}
          >
            Reset zoom
          </button>
          <OpenStreetMapAttribution
            className="tracking-map__attribution"
            label={mapTileProvider?.attribution_label}
            url={mapTileProvider?.attribution_url}
          />
          {missingHubMarkers.length > 0 ? (
            <div
              data-testid="hub-missing-location"
              style={{
                position: 'absolute',
                bottom: '12px',
                left: '12px',
                background: 'var(--paper)',
                border: '1px solid var(--line)',
                borderRadius: '4px',
                padding: '6px 10px',
                fontSize: '10.5px',
                fontFamily: 'var(--font-mono)',
                color: 'var(--warn-ink, var(--ink))',
                boxShadow: 'var(--shadow-soft)',
              }}
            >
              <span className="eyebrow" style={{ marginRight: '6px' }}>
                Missing location
              </span>
              {missingHubMarkers.map((h) => (
                <Chip
                  key={h.id}
                  size="xs"
                  kind="warn"
                  label={`${h.label} - location unavailable`}
                />
              ))}
            </div>
          ) : null}
        </div>

        {/* Sidebar — clickable shipment cards open the decision-trail drawer */}
        <div style={{ borderLeft: '1px solid var(--line)', overflow: 'auto', background: 'var(--paper)' }}>
          <div className="section-eyebrow">Shipments in view</div>
          {shipments.slice(0, 18).map((s) => {
            // W38 closure - prefer canonical v_shipment_directory join,
            // fall back to base row destination_city for legacy seed
            // rows that have not yet emitted the directory projection.
            const detail = `${shipmentDirectoryById.get(s.id)?.destination_city ?? s.destination_city ?? '-'} - ${operatorLabel(s.service_type, 'Service not set')}`;
            return (
            <button
              key={s.id}
              type="button"
              className="card"
              style={{
                margin: '6px 12px',
                padding: '8px 10px',
                width: 'calc(100% - 24px)',
                textAlign: 'left',
                cursor: 'pointer',
                background: 'var(--paper)',
                border: '1px solid var(--line)',
              }}
              onClick={() => openShipmentDrawer(s)}
              // WCAG 2.5.3: the name carries all visible card text after the action.
              aria-label={`Open ${s.tracking_number}, ${detail}`}
            >
              <div className="mono" style={{ fontWeight: 600 }}>{s.tracking_number}</div>
              <div className="mono" style={{ fontSize: '10.5px', color: 'var(--ink-3)' }}>
                {detail}
              </div>
            </button>
            );
          })}
        </div>
      </div>

      {drawer.node}
    </div>
  );
}
