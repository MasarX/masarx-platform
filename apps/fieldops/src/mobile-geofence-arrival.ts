export type LatLng = { latitude: number; longitude: number };

export type GeofenceStopSnapshot = {
  stopId: string;
  location: LatLng | null;
  arrivalRadiusM?: number | null;
  status: string;
  sequence: number | null;
};

export type GeofenceArrivalPolicy = {
  enabled: boolean;
  default_radius_m: number;
  min_radius_m: number;
  max_radius_m: number;
  dwell_seconds: number;
  auto_transition: boolean;
};

export const DEFAULT_GEOFENCE_ARRIVAL_POLICY: GeofenceArrivalPolicy = {
  enabled: false,
  default_radius_m: 75,
  min_radius_m: 25,
  max_radius_m: 250,
  dwell_seconds: 20,
  auto_transition: true,
};

const ACTIVE_STOP_STATUSES: ReadonlyArray<string> = ["open", "assigned", "en_route"];
const EARTH_RADIUS_M = 6_371_008.8;
const RETRIGGER_DEBOUNCE_MS = 60_000;

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function readBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  return fallback;
}

function readPositiveNumber(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return fallback;
  }
  return value;
}

function clamp(value: number, min: number, max: number): number {
  if (min > max) return value;
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

function toRadians(deg: number): number {
  return (deg * Math.PI) / 180;
}

function isFiniteCoord(value: number): boolean {
  return typeof value === "number" && Number.isFinite(value);
}

function isValidLocation(loc: LatLng | null | undefined): loc is LatLng {
  if (!loc) return false;
  return isFiniteCoord(loc.latitude) && isFiniteCoord(loc.longitude);
}

export function normalizeGeofenceArrivalPolicy(raw: unknown): GeofenceArrivalPolicy {
  const input = asRecord(raw);
  const enabled = readBoolean(input.enabled, DEFAULT_GEOFENCE_ARRIVAL_POLICY.enabled);
  const minRadius = readPositiveNumber(
    input.min_radius_m,
    DEFAULT_GEOFENCE_ARRIVAL_POLICY.min_radius_m
  );
  const maxRadiusRaw = readPositiveNumber(
    input.max_radius_m,
    DEFAULT_GEOFENCE_ARRIVAL_POLICY.max_radius_m
  );
  const maxRadius = maxRadiusRaw < minRadius ? minRadius : maxRadiusRaw;
  const defaultRadiusRaw = readPositiveNumber(
    input.default_radius_m,
    DEFAULT_GEOFENCE_ARRIVAL_POLICY.default_radius_m
  );
  const defaultRadius = clamp(defaultRadiusRaw, minRadius, maxRadius);
  const dwellSeconds = readPositiveNumber(
    input.dwell_seconds,
    DEFAULT_GEOFENCE_ARRIVAL_POLICY.dwell_seconds
  );
  const autoTransition = readBoolean(
    input.auto_transition,
    DEFAULT_GEOFENCE_ARRIVAL_POLICY.auto_transition
  );
  return {
    enabled,
    default_radius_m: defaultRadius,
    min_radius_m: minRadius,
    max_radius_m: maxRadius,
    dwell_seconds: dwellSeconds,
    auto_transition: autoTransition,
  };
}

export function distanceMeters(a: LatLng, b: LatLng): number {
  if (!isValidLocation(a) || !isValidLocation(b)) return Number.POSITIVE_INFINITY;
  const lat1 = toRadians(a.latitude);
  const lat2 = toRadians(b.latitude);
  const dLat = toRadians(b.latitude - a.latitude);
  const dLon = toRadians(b.longitude - a.longitude);
  const sinDLat = Math.sin(dLat / 2);
  const sinDLon = Math.sin(dLon / 2);
  const h =
    sinDLat * sinDLat + Math.cos(lat1) * Math.cos(lat2) * sinDLon * sinDLon;
  const c = 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
  return EARTH_RADIUS_M * c;
}

export type ProximityEvaluation = {
  stopId: string;
  distanceM: number;
  withinRadius: boolean;
  radiusM: number;
};

function effectiveRadius(
  stop: GeofenceStopSnapshot,
  policy: GeofenceArrivalPolicy
): number {
  const raw =
    typeof stop.arrivalRadiusM === "number" && Number.isFinite(stop.arrivalRadiusM)
      ? stop.arrivalRadiusM
      : policy.default_radius_m;
  return clamp(raw, policy.min_radius_m, policy.max_radius_m);
}

function isActiveStop(stop: GeofenceStopSnapshot): boolean {
  return ACTIVE_STOP_STATUSES.includes(stop.status);
}

export function evaluateProximityToStops(params: {
  location: LatLng | null;
  stops: GeofenceStopSnapshot[];
  policy: GeofenceArrivalPolicy;
}): ProximityEvaluation[] {
  const { location, stops, policy } = params;
  if (!isValidLocation(location)) return [];
  const results: ProximityEvaluation[] = [];
  for (const stop of stops) {
    if (!isActiveStop(stop)) continue;
    if (!isValidLocation(stop.location)) continue;
    const radius = effectiveRadius(stop, policy);
    const distance = distanceMeters(location, stop.location);
    results.push({
      stopId: stop.stopId,
      distanceM: distance,
      withinRadius: distance <= radius,
      radiusM: radius,
    });
  }
  results.sort((a, b) => a.distanceM - b.distanceM);
  return results;
}

export type GeofenceArrivalState = {
  enteredAt: Record<string, number>;
  lastTriggeredAt: Record<string, number>;
};

export function createArrivalState(): GeofenceArrivalState {
  return { enteredAt: {}, lastTriggeredAt: {} };
}

export type ArrivalOutcome = {
  stopId: string;
  triggerArrival: boolean;
  distanceM: number;
};

function cloneRecord(record: Record<string, number>): Record<string, number> {
  const next: Record<string, number> = {};
  for (const key of Object.keys(record)) {
    next[key] = record[key];
  }
  return next;
}

export function evaluateArrivalTransitions(params: {
  state: GeofenceArrivalState;
  location: LatLng | null;
  stops: GeofenceStopSnapshot[];
  policy: GeofenceArrivalPolicy;
  now: number;
}): { nextState: GeofenceArrivalState; transitions: ArrivalOutcome[] } {
  const { state, location, stops, policy, now } = params;
  const nextEnteredAt = cloneRecord(state.enteredAt);
  const nextLastTriggeredAt = cloneRecord(state.lastTriggeredAt);

  if (!isValidLocation(location)) {
    return {
      nextState: { enteredAt: {}, lastTriggeredAt: nextLastTriggeredAt },
      transitions: [],
    };
  }

  const activeStops = stops.filter(isActiveStop);
  const transitions: ArrivalOutcome[] = [];
  const activeStopIds = new Set<string>();

  for (const stop of activeStops) {
    activeStopIds.add(stop.stopId);
    if (!isValidLocation(stop.location)) {
      delete nextEnteredAt[stop.stopId];
      continue;
    }
    const radius = effectiveRadius(stop, policy);
    const distance = distanceMeters(location, stop.location);
    const inside = distance <= radius;

    if (!inside) {
      delete nextEnteredAt[stop.stopId];
      continue;
    }

    const existingEnteredAt = nextEnteredAt[stop.stopId];
    if (existingEnteredAt === undefined) {
      nextEnteredAt[stop.stopId] = now;
      continue;
    }

    const dwellMs = policy.dwell_seconds * 1000;
    const dwellOk = now - existingEnteredAt >= dwellMs;
    const lastTrigger = nextLastTriggeredAt[stop.stopId];
    const debounceOk =
      lastTrigger === undefined || now - lastTrigger >= RETRIGGER_DEBOUNCE_MS;

    if (dwellOk && debounceOk && policy.enabled) {
      transitions.push({ stopId: stop.stopId, triggerArrival: true, distanceM: distance });
    }
  }

  // Clean up enteredAt entries for stops that are no longer active/tracked.
  for (const stopId of Object.keys(nextEnteredAt)) {
    if (!activeStopIds.has(stopId)) {
      delete nextEnteredAt[stopId];
    }
  }

  return {
    nextState: { enteredAt: nextEnteredAt, lastTriggeredAt: nextLastTriggeredAt },
    transitions,
  };
}

export function recordArrivalTrigger(
  state: GeofenceArrivalState,
  stopId: string,
  now: number
): GeofenceArrivalState {
  const nextEnteredAt = cloneRecord(state.enteredAt);
  const nextLastTriggeredAt = cloneRecord(state.lastTriggeredAt);
  delete nextEnteredAt[stopId];
  nextLastTriggeredAt[stopId] = now;
  return { enteredAt: nextEnteredAt, lastTriggeredAt: nextLastTriggeredAt };
}
