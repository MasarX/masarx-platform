import {
  createArrivalState,
  distanceMeters,
  evaluateArrivalTransitions,
  evaluateProximityToStops,
  normalizeGeofenceArrivalPolicy,
  recordArrivalTrigger,
} from "../../../apps/fieldops/src/mobile-geofence-arrival";

const location = { latitude: 0, longitude: 0 };
const stop = { stopId: "example-stop", location, status: "open", sequence: 1 };
const policy = normalizeGeofenceArrivalPolicy({ enabled: true, dwell_seconds: 3 });

test("measures distance symmetrically and orders active stops by proximity", () => {
  const farther = { latitude: 0, longitude: 0.001 };
  expect(distanceMeters(location, location)).toBe(0);
  expect(distanceMeters(location, farther)).toBeCloseTo(111.2, 1);
  expect(distanceMeters(location, farther)).toBe(distanceMeters(farther, location));
  const stops = [
    { ...stop, stopId: "farther", location: farther, arrivalRadiusM: 10_000 },
    { ...stop, stopId: "closed", status: "completed" },
    { ...stop, stopId: "no-coordinate", location: null },
    stop,
  ];
  expect(evaluateProximityToStops({ location, stops, policy })).toMatchObject([
    { stopId: stop.stopId, withinRadius: true, radiusM: policy.default_radius_m },
    { stopId: "farther", withinRadius: true, radiusM: policy.max_radius_m },
  ]);
  expect(evaluateProximityToStops({ location: null, stops, policy })).toEqual([]);
});

test("clamps the radius and ignores invalid configuration values", () => {
  const defaults = normalizeGeofenceArrivalPolicy(null);
  expect(normalizeGeofenceArrivalPolicy({ enabled: "true", dwell_seconds: -5 })).toEqual(defaults);
  expect(normalizeGeofenceArrivalPolicy({ default_radius_m: 9_000 }).default_radius_m).toBe(defaults.max_radius_m);
  expect(normalizeGeofenceArrivalPolicy({ default_radius_m: 1 }).default_radius_m).toBe(defaults.min_radius_m);
});

test("requires dwell and restarts the timer after losing location", () => {
  const input = { location, stops: [stop], policy };
  const entered = evaluateArrivalTransitions({ ...input, state: createArrivalState(), now: 10_000 });
  expect(entered.nextState.enteredAt).toEqual({ [stop.stopId]: 10_000 });
  expect(entered.transitions).toEqual([]);
  expect(evaluateArrivalTransitions({ ...input, state: entered.nextState, now: 12_999 }).transitions).toEqual([]);
  expect(evaluateArrivalTransitions({ ...input, state: entered.nextState, now: 13_000 }).transitions).toEqual([
    { stopId: stop.stopId, triggerArrival: true, distanceM: 0 },
  ]);
  const lost = evaluateArrivalTransitions({ ...input, location: null, state: entered.nextState, now: 13_001 });
  expect(lost.nextState.enteredAt).toEqual({});
  expect(evaluateArrivalTransitions({ ...input, state: lost.nextState, now: 13_002 }).transitions).toEqual([]);
});

test("honors the debounce and an explicitly disabled policy", () => {
  const input = { location, stops: [stop], policy };
  const original = { enteredAt: { [stop.stopId]: 10_000 }, lastTriggeredAt: {} };
  const marked = recordArrivalTrigger(original, stop.stopId, 13_000);
  expect(original.enteredAt).toEqual({ [stop.stopId]: 10_000 });
  expect(marked.enteredAt).toEqual({});
  const { nextState } = evaluateArrivalTransitions({ ...input, state: marked, now: 14_000 });
  expect(evaluateArrivalTransitions({ ...input, state: nextState, now: 72_999 }).transitions).toEqual([]);
  expect(evaluateArrivalTransitions({ ...input, state: nextState, now: 73_000 }).transitions).toHaveLength(1);
  const disabled = evaluateArrivalTransitions({ ...input, policy: { ...policy, enabled: false }, state: nextState, now: 73_000 });
  expect(disabled.transitions).toEqual([]);
  expect(disabled.nextState.enteredAt).toEqual(nextState.enteredAt);
});
