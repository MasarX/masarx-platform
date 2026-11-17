import { mapRouteStatusTone, type RouteStatusTone } from "./mobile-shell-route-map";

type Point = { type: "Point"; coordinates: [number, number] };
type LineString = { type: "LineString"; coordinates: [number, number][] };
type FeatureCollection<G, P = Record<string, never>> = {
  type: "FeatureCollection";
  features: Array<{ type: "Feature"; id?: string; properties: P; geometry: G }>;
};

export type MobileRealMapStop = {
  id: string;
  title: string;
  status?: string | null;
  /** Verified producer ETA only; never derived from SLA or elapsed time. */
  etaMinutes?: number | null;
  sequence: number | null;
  active: boolean;
  address: {
    validation_status?: unknown;
    sa_short_code?: unknown;
    raw_input?: unknown;
    line1?: unknown;
    city?: unknown;
    coordinates?: unknown;
  } | null;
};
export type MobileRealMapPointProperties = {
  id: string; title: string; sequence: number | null; active: boolean;
  status: string | null; tone: RouteStatusTone; etaMinutes: number | null;
};
export type MobileRealMapModel = {
  id: string;
  points: FeatureCollection<Point, MobileRealMapPointProperties>;
  routeLine: FeatureCollection<LineString>;
  bounds: { southwest: [number, number]; northeast: [number, number] } | null;
  count: number;
  excludedCount: number;
};

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
function coordinate(value: unknown, limit: number): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || Math.abs(value) > limit) return null;
  return value;
}

export function buildMobileMapListEntries(items: readonly Record<string, unknown>[]) {
  return items.map((item) => {
    const metadata = item.metadata && typeof item.metadata === "object" && !Array.isArray(item.metadata)
      ? item.metadata as Record<string, unknown> : {};
    // An explicit null clears the snapshot: never revive older nested coordinates.
    const raw = Object.prototype.hasOwnProperty.call(item, "destination_address") ? item.destination_address
      : Object.prototype.hasOwnProperty.call(metadata, "address") ? metadata.address : item.address;
    const address = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as NonNullable<MobileRealMapStop["address"]> : null;
    const rawCoordinates = address?.coordinates;
    const pair = rawCoordinates && typeof rawCoordinates === "object" && !Array.isArray(rawCoordinates)
      ? rawCoordinates as Record<string, unknown> : {};
    const latitude = coordinate(pair.latitude, 90);
    const longitude = coordinate(pair.longitude, 180);
    return { item, address, coords: latitude === null || longitude === null ? null : { latitude, longitude } };
  });
}

/** Approval and coordinates must come from the same canonical address snapshot. */
export function buildMobileRealMapModel(stops: readonly MobileRealMapStop[]): MobileRealMapModel {
  const points: MobileRealMapModel["points"] = { type: "FeatureCollection", features: [] };
  const seen = new Set<string>();
  // EPSG:3857 raster tiles cannot represent the poles; never clamp source truth.
  const maxMercatorLatitude = Math.atan(Math.sinh(Math.PI)) * 180 / Math.PI;
  for (const stop of stops) {
    const address = stop.address;
    if (!stop.id || seen.has(stop.id) || !address || address.validation_status !== "valid") continue;
    if (!text(address.sa_short_code) && !text(address.raw_input) && !text(address.line1)) continue;
    const raw = address.coordinates;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const coordinates = raw as Record<string, unknown>;
    const latitude = coordinate(coordinates.latitude, 90);
    const longitude = coordinate(coordinates.longitude, 180);
    if (latitude === null || longitude === null || Math.abs(latitude) > maxMercatorLatitude) continue;
    seen.add(stop.id);
    points.features.push({
      type: "Feature",
      id: stop.id,
      properties: {
        id: stop.id, title: text(stop.title) || stop.id, active: stop.active,
        status: text(stop.status) || null,
        tone: mapRouteStatusTone(stop.status),
        etaMinutes: typeof stop.etaMinutes === "number" && Number.isFinite(stop.etaMinutes) && stop.etaMinutes >= 0 ? stop.etaMinutes : null,
        sequence: typeof stop.sequence === "number" && Number.isFinite(stop.sequence) ? stop.sequence : null,
      },
      geometry: { type: "Point", coordinates: [longitude, latitude] },
    });
  }
  const ordered = points.features.filter((point) => point.properties.sequence !== null)
    .sort((left, right) => left.properties.sequence! - right.properties.sequence! || left.properties.id.localeCompare(right.properties.id));
  const routeLine: FeatureCollection<LineString> = {
    type: "FeatureCollection",
    features: ordered.length < 2 ? [] : [{
      type: "Feature", properties: {},
      geometry: { type: "LineString", coordinates: ordered.map((point) => point.geometry.coordinates) },
    }],
  };
  let bounds: MobileRealMapModel["bounds"] = null;
  if (points.features.length) {
    const positions = points.features.map((point) => point.geometry.coordinates);
    bounds = {
      southwest: [Math.min(...positions.map((p) => p[0])), Math.min(...positions.map((p) => p[1]))],
      northeast: [Math.max(...positions.map((p) => p[0])), Math.max(...positions.map((p) => p[1]))],
    };
  }
  return { id: JSON.stringify({ points, routeLine }), points, routeLine, bounds, count: points.features.length, excludedCount: stops.length - points.features.length };
}
