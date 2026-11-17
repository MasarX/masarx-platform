import {
  DEFAULT_MOBILE_MAP_POLICY,
  type MobileMapPolicy,
} from "../../../apps/fieldops/src/mobile-shell-policy";
import {
  buildRouteMapModel,
  mapRouteStatusTone,
} from "../../../apps/fieldops/src/mobile-shell-route-map";

const BASE_POINTS = [
  { id: "a", latitude: 24.7, longitude: 46.6, status: "open" },
  { id: "b", latitude: 24.7004, longitude: 46.6005, status: "in_progress" },
  { id: "c", latitude: 24.7008, longitude: 46.6009, status: "delivered" },
  { id: "d", latitude: 24.76, longitude: 46.69, status: "exception" },
];

function buildPolicy(partial: Partial<MobileMapPolicy>): MobileMapPolicy {
  return {
    ...DEFAULT_MOBILE_MAP_POLICY,
    ...partial,
  };
}

describe("mobile shell route map helpers", () => {
  test("mapRouteStatusTone categorizes known statuses", () => {
    expect(mapRouteStatusTone("delivered")).toBe("done");
    expect(mapRouteStatusTone("in_progress")).toBe("active");
    expect(mapRouteStatusTone("failed_attempt")).toBe("issue");
    expect(mapRouteStatusTone("unknown")).toBe("neutral");
  });

  test("buildRouteMapModel returns empty model when no mappable points", () => {
    const model = buildRouteMapModel(
      [{ id: "x", latitude: Number.NaN, longitude: 46.6 }],
      buildPolicy({})
    );
    expect(model).toEqual({
      pins: [],
      clusters: [],
      mappableCount: 0,
    });
  });

  test("buildRouteMapModel clusters points when policy enables clustering", () => {
    const model = buildRouteMapModel(
      BASE_POINTS,
      buildPolicy({
        clusteringEnabled: true,
        clusteringGridPx: 220,
        clusteringMinCount: 2,
      })
    );

    expect(model.mappableCount).toBe(4);
    expect(model.clusters.length).toBeGreaterThan(0);
    expect(model.clusters[0]?.count).toBeGreaterThanOrEqual(2);
  });

  test("buildRouteMapModel returns pins only when clustering is disabled", () => {
    const model = buildRouteMapModel(
      BASE_POINTS,
      buildPolicy({
        clusteringEnabled: false,
      })
    );

    expect(model.clusters).toEqual([]);
    expect(model.pins).toHaveLength(4);
  });
});
