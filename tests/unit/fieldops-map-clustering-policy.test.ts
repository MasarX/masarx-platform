import { DEFAULT_MOBILE_MAP_POLICY } from "../../apps/fieldops/src/mobile-shell-policy";
import { buildRouteMapModel } from "../../apps/fieldops/src/mobile-shell-route-map";

const points = [
  { id: "p1", latitude: 0, longitude: 0 },
  { id: "p2", latitude: 0.001, longitude: 0.001 },
  { id: "p3", latitude: 0.002, longitude: 0.002 },
  { id: "p4", latitude: 1, longitude: 1 },
];
const policy = { ...DEFAULT_MOBILE_MAP_POLICY, clusteringEnabled: true };

test("clamps the configured cluster grid size", () => {
  for (const [input, bound] of [[5, 60], [9999, 220]]) {
    expect(buildRouteMapModel(points, { ...policy, clusteringGridPx: input })).toEqual(
      buildRouteMapModel(points, { ...policy, clusteringGridPx: bound })
    );
  }
});

test("uses the cluster count threshold and clamps it to the supported range", () => {
  const grouped = buildRouteMapModel(points, { ...policy, clusteringMinCount: 2 });
  expect(grouped.clusters.map(({ pointIds }) => pointIds)).toEqual([["p1", "p2", "p3"]]);

  const ungrouped = buildRouteMapModel(points, { ...policy, clusteringMinCount: 12 });
  expect(ungrouped.clusters).toEqual([]);
  expect(ungrouped.pins).toHaveLength(points.length);

  expect(buildRouteMapModel(points, { ...policy, clusteringMinCount: 0 })).toEqual(grouped);
  expect(buildRouteMapModel(points, { ...policy, clusteringMinCount: 999 })).toEqual(ungrouped);
});
