import type { MobileMapPolicy } from "./mobile-shell-policy";

const VIRTUAL_MAP_WIDTH_PX = 320;
const VIRTUAL_MAP_HEIGHT_PX = 220;
const MAP_PADDING_X_PCT = 8;
const MAP_PADDING_Y_PCT = 10;

export type RouteStatusTone = "active" | "done" | "issue" | "neutral";

export type RouteMapPoint = {
  id: string;
  latitude: number;
  longitude: number;
  status?: string | null;
};

export type RouteMapPin = {
  id: string;
  xPct: number;
  yPct: number;
  tone: RouteStatusTone;
};

export type RouteMapCluster = {
  key: string;
  xPct: number;
  yPct: number;
  count: number;
  pointIds: string[];
};

export type RouteMapModel = {
  pins: RouteMapPin[];
  clusters: RouteMapCluster[];
  mappableCount: number;
};

function clamp(value: number, min: number, max: number): number {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

function toFinite(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return value;
}

function roundPct(value: number): number {
  return Math.round(value * 100) / 100;
}

function normalizeStatus(status: unknown): string {
  if (typeof status !== "string") return "";
  return status.trim().toLowerCase();
}

export function mapRouteStatusTone(status: unknown): RouteStatusTone {
  const normalized = normalizeStatus(status);
  if (
    normalized.includes("done") ||
    normalized.includes("delivered") ||
    normalized.includes("completed")
  ) {
    return "done";
  }
  if (
    normalized.includes("failed") ||
    normalized.includes("exception") ||
    normalized.includes("issue") ||
    normalized.includes("cancel")
  ) {
    return "issue";
  }
  if (
    normalized.includes("active") ||
    normalized.includes("enroute") ||
    normalized.includes("in_progress") ||
    normalized.includes("open")
  ) {
    return "active";
  }
  return "neutral";
}

export function buildRouteMapModel(
  points: RouteMapPoint[],
  policy: MobileMapPolicy
): RouteMapModel {
  const mappable = points
    .map((point) => {
      const lat = toFinite(point.latitude);
      const lng = toFinite(point.longitude);
      if (lat == null || lng == null) return null;
      return {
        id: point.id,
        latitude: lat,
        longitude: lng,
        tone: mapRouteStatusTone(point.status),
      };
    })
    .filter((point): point is { id: string; latitude: number; longitude: number; tone: RouteStatusTone } => Boolean(point));

  if (!mappable.length) {
    return {
      pins: [],
      clusters: [],
      mappableCount: 0,
    };
  }

  let minLat = mappable[0].latitude;
  let maxLat = mappable[0].latitude;
  let minLng = mappable[0].longitude;
  let maxLng = mappable[0].longitude;
  for (const point of mappable) {
    if (point.latitude < minLat) minLat = point.latitude;
    if (point.latitude > maxLat) maxLat = point.latitude;
    if (point.longitude < minLng) minLng = point.longitude;
    if (point.longitude > maxLng) maxLng = point.longitude;
  }
  const latSpan = Math.max(maxLat - minLat, 0.00001);
  const lngSpan = Math.max(maxLng - minLng, 0.00001);

  const normalized = mappable.map((point) => {
    const xNormalized = (point.longitude - minLng) / lngSpan;
    const yNormalized = (maxLat - point.latitude) / latSpan;
    const xPct = MAP_PADDING_X_PCT + xNormalized * (100 - MAP_PADDING_X_PCT * 2);
    const yPct = MAP_PADDING_Y_PCT + yNormalized * (100 - MAP_PADDING_Y_PCT * 2);
    return {
      ...point,
      xPct: roundPct(xPct),
      yPct: roundPct(yPct),
    };
  });

  if (!policy.clusteringEnabled) {
    return {
      mappableCount: normalized.length,
      clusters: [],
      pins: normalized.map((point) => ({
        id: point.id,
        xPct: point.xPct,
        yPct: point.yPct,
        tone: point.tone,
      })),
    };
  }

  const gridPx = clamp(policy.clusteringGridPx, 60, 220);
  const minCount = clamp(policy.clusteringMinCount, 2, 12);
  const buckets = new Map<string, typeof normalized>();
  for (const point of normalized) {
    const xPx = (point.xPct / 100) * VIRTUAL_MAP_WIDTH_PX;
    const yPx = (point.yPct / 100) * VIRTUAL_MAP_HEIGHT_PX;
    const key = `${Math.floor(xPx / gridPx)}:${Math.floor(yPx / gridPx)}`;
    const bucket = buckets.get(key);
    if (bucket) bucket.push(point);
    else buckets.set(key, [point]);
  }

  const pins: RouteMapPin[] = [];
  const clusters: RouteMapCluster[] = [];
  for (const [key, bucket] of buckets.entries()) {
    if (bucket.length >= minCount) {
      const xPct =
        bucket.reduce((sum, point) => sum + point.xPct, 0) / bucket.length;
      const yPct =
        bucket.reduce((sum, point) => sum + point.yPct, 0) / bucket.length;
      clusters.push({
        key,
        xPct: roundPct(xPct),
        yPct: roundPct(yPct),
        count: bucket.length,
        pointIds: bucket.map((point) => point.id),
      });
      continue;
    }

    for (const point of bucket) {
      pins.push({
        id: point.id,
        xPct: point.xPct,
        yPct: point.yPct,
        tone: point.tone,
      });
    }
  }

  clusters.sort((a, b) => b.count - a.count);
  pins.sort((a, b) => a.id.localeCompare(b.id));

  return {
    mappableCount: normalized.length,
    pins,
    clusters,
  };
}
