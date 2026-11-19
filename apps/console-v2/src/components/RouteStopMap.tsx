import { GeoPointMap, type GeoPoint } from './GeoPointMap';
import type { MapBounds } from './OpenStreetMapTileLayer';

export interface RouteStopMapStop {
  id: string;
  shipment_id: string;
  sequence_order?: number | null;
}

export interface RouteStopMapShipment {
  id: string;
  tracking_number?: string | null;
  destination_address_id?: string | null;
  address_id?: string | null;
  recipient_address_id?: string | null;
}

export interface RouteStopMapGeocode {
  address_id?: string | null;
  latitude?: number | string | null;
  longitude?: number | string | null;
  lat?: number | string | null;
  lng?: number | string | null;
  confidence_score?: number | string | null;
  confidence?: number | string | null;
  provider_name?: string | null;
  is_primary?: boolean | null;
  geocoded_at?: string | null;
  expires_at?: string | null;
}

export interface RouteStopMapTileProvider {
  url_template?: string | null;
  allowed_hosts?: string[] | null;
  usage_tier?: string | null;
  cache_required?: boolean | null;
  same_origin_proxy_allowed?: boolean | null;
  attribution_label?: string | null;
  attribution_url?: string | null;
}

interface RouteStopMapProps {
  stops: RouteStopMapStop[];
  shipments: RouteStopMapShipment[];
  geocodes: RouteStopMapGeocode[];
  tileProvider?: RouteStopMapTileProvider | null;
  bounds?: MapBounds | null;
  height?: number;
  title?: string;
  emptyLabel?: string;
  testId?: string;
}

function toNumber(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function shipmentAddressId(shipment: RouteStopMapShipment | undefined): string | null {
  return (
    shipment?.destination_address_id ??
    shipment?.address_id ??
    shipment?.recipient_address_id ??
    null
  );
}

function timestampScore(value: unknown): number {
  if (typeof value !== 'string' || value.trim().length === 0) return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function isExpired(geocode: RouteStopMapGeocode): boolean {
  if (!geocode.expires_at) return false;
  const parsed = Date.parse(geocode.expires_at);
  return Number.isFinite(parsed) && parsed <= Date.now();
}

function geocodeRank(geocode: RouteStopMapGeocode): [number, number, number, number] {
  const confidence = toNumber(geocode.confidence_score ?? geocode.confidence) ?? -1;
  return [
    isExpired(geocode) ? 0 : 1,
    geocode.is_primary === true ? 1 : 0,
    confidence,
    timestampScore(geocode.geocoded_at),
  ];
}

function compareGeocodeRank(a: RouteStopMapGeocode, b: RouteStopMapGeocode): number {
  const left = geocodeRank(a);
  const right = geocodeRank(b);
  for (let i = 0; i < left.length; i += 1) {
    if (left[i] !== right[i]) return left[i]! - right[i]!;
  }
  return 0;
}

export function buildRouteStopGeoPoints(
  stops: RouteStopMapStop[],
  shipments: RouteStopMapShipment[],
  geocodes: RouteStopMapGeocode[],
): GeoPoint[] {
  const shipmentById = new Map(shipments.map((shipment) => [shipment.id, shipment]));
  const geocodeByAddressId = new Map<string, RouteStopMapGeocode>();
  for (const geocode of geocodes) {
    const addressId = geocode.address_id;
    if (!addressId) continue;
    const current = geocodeByAddressId.get(addressId);
    if (!current || compareGeocodeRank(geocode, current) >= 0) {
      geocodeByAddressId.set(addressId, geocode);
    }
  }

  return stops
    .map<GeoPoint | null>((stop) => {
      const shipment = shipmentById.get(stop.shipment_id);
      const addressId = shipmentAddressId(shipment);
      const geocode = addressId ? geocodeByAddressId.get(addressId) : undefined;
      const lat = toNumber(geocode?.latitude ?? geocode?.lat);
      const lng = toNumber(geocode?.longitude ?? geocode?.lng);
      if (lat == null || lng == null) return null;
      const confidence = toNumber(geocode?.confidence_score ?? geocode?.confidence);
      const sequence = Number.isFinite(Number(stop.sequence_order)) ? `#${stop.sequence_order}` : 'Stop';
      const label = `${sequence} ${shipment?.tracking_number ?? stop.shipment_id}`;
      return {
        id: stop.id,
        lat,
        lng,
        label,
        detail: [
          geocode?.provider_name ? `${geocode.provider_name} geocode` : 'geocoded stop',
          confidence != null ? `${Math.round(confidence * 100)}%` : null,
        ].filter(Boolean).join(' - '),
        tone: 'info' as const,
      };
    })
    .filter((point): point is GeoPoint => point != null);
}

export function RouteStopMap({
  stops,
  shipments,
  geocodes,
  tileProvider,
  bounds,
  height = 220,
  title = 'Route stop map',
  emptyLabel = 'No geocoded stops for this route yet.',
  testId = 'route-stop-map',
}: RouteStopMapProps) {
  const points = buildRouteStopGeoPoints(stops, shipments, geocodes);

  return (
    <div data-testid={testId}>
      <GeoPointMap
        points={points}
        bounds={bounds}
        height={height}
        title={title}
        emptyLabel={emptyLabel}
        tileUrlTemplate={tileProvider?.url_template}
        allowedTileHosts={tileProvider?.allowed_hosts}
        tileUsageTier={tileProvider?.usage_tier}
        tileCacheRequired={tileProvider?.cache_required}
        sameOriginProxyAllowed={tileProvider?.same_origin_proxy_allowed}
        tileAttributionLabel={tileProvider?.attribution_label}
        tileAttributionUrl={tileProvider?.attribution_url}
      />
    </div>
  );
}
