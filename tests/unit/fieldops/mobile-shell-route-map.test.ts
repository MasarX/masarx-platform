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

  test.each(["inactive", "undelivered", "not_completed", "reopened", "custom_failed_state", "cancel_requested", null, 1])(
    "does not infer an operational tone from unknown status %s", (status) => {
      expect(mapRouteStatusTone(status)).toBe("neutral");
    }
  );
  test("normalizes known status casing and whitespace", () => {
    expect(mapRouteStatusTone(" COMPLETED ")).toBe("done");
    expect(mapRouteStatusTone(" Failed_Attempt ")).toBe("issue");
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

  test("buildRouteMapModel projects pins from Saudi coordinates, not fixed anchors", () => {
    const model = buildRouteMapModel(
      [
        { id: "south", latitude: 24.7, longitude: 46.6, status: "open" },
        { id: "north-east", latitude: 24.8, longitude: 46.8, status: "in_progress" },
      ],
      buildPolicy({
        clusteringEnabled: false,
      })
    );

    expect(model.mappableCount).toBe(2);
    expect(model.pins).toEqual([
      expect.objectContaining({ id: "south", xPct: 8, yPct: 90, tone: "active" }),
      expect.objectContaining({ id: "north-east", xPct: 92, yPct: 10, tone: "active" }),
    ]);
  });

  test("buildRouteMapModel centers a single coordinate-backed stop instead of pinning it to the map edge", () => {
    const model = buildRouteMapModel(
      [{ id: "only", latitude: 24.7136, longitude: 46.6753, status: "open" }],
      buildPolicy({
        clusteringEnabled: false,
      })
    );

    expect(model).toMatchObject({
      mappableCount: 1,
      clusters: [],
      pins: [expect.objectContaining({ id: "only", xPct: 50, yPct: 50 })],
    });
  });

  test("buildRouteMapModel centers collapsed latitude or longitude axes while preserving the real varying axis", () => {
    const sameLatitude = buildRouteMapModel(
      [
        { id: "west", latitude: 24.7136, longitude: 46.6, status: "open" },
        { id: "east", latitude: 24.7136, longitude: 46.8, status: "open" },
      ],
      buildPolicy({
        clusteringEnabled: false,
      })
    );
    expect(sameLatitude.pins).toEqual([
      expect.objectContaining({ id: "west", xPct: 8, yPct: 50 }),
      expect.objectContaining({ id: "east", xPct: 92, yPct: 50 }),
    ]);

    const sameLongitude = buildRouteMapModel(
      [
        { id: "south", latitude: 24.6, longitude: 46.6753, status: "open" },
        { id: "north", latitude: 24.8, longitude: 46.6753, status: "open" },
      ],
      buildPolicy({
        clusteringEnabled: false,
      })
    );
    expect(sameLongitude.pins).toEqual([
      expect.objectContaining({ id: "south", xPct: 50, yPct: 90 }),
      expect.objectContaining({ id: "north", xPct: 50, yPct: 10 }),
    ]);
  });
});
