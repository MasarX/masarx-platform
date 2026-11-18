import {
  DEFAULT_MOBILE_MAP_POLICY,
  normalizeResolvedMobileMapPolicy,
} from "../../../apps/fieldops/src/mobile-shell-policy";
import {
  resolveFieldopsPolicyValue,
  type MobileV2RpcContext,
} from "../../../apps/fieldops/src/mobile-v2-rpc-hooks";

function fakeSupabase(data: unknown) {
  const rpc = jest.fn().mockResolvedValue({ data, error: null });
  return {
    rpc,
    schema: jest.fn(() => ({ rpc })),
  } as unknown as NonNullable<MobileV2RpcContext["supabase"]>;
}

describe("Mobile V2 map policy live readback", () => {
  test("keeps preview mode renderable with the static fallback", async () => {
    await expect(
      resolveFieldopsPolicyValue({
        ctx: {
          supabase: null,
          policyContext: { organization_id: "org_preview" },
        },
        category: "map_policy",
        parse: normalizeResolvedMobileMapPolicy,
        fallback: DEFAULT_MOBILE_MAP_POLICY,
        requireResolved: true,
      }),
    ).resolves.toEqual(DEFAULT_MOBILE_MAP_POLICY);
  });

  test("fails closed in live mode when map_policy does not resolve", async () => {
    await expect(
      resolveFieldopsPolicyValue({
        ctx: {
          supabase: fakeSupabase([]),
          policyContext: { organization_id: "org_live" },
        },
        category: "map_policy",
        parse: normalizeResolvedMobileMapPolicy,
        fallback: DEFAULT_MOBILE_MAP_POLICY,
        requireResolved: true,
      }),
    ).rejects.toThrow("map_policy did not resolve a settings row");
  });

  test("reads the live map_policy row instead of using default map constants", async () => {
    const data = await resolveFieldopsPolicyValue({
      ctx: {
        supabase: fakeSupabase([
          {
            value: {
              route_views: ["orders_map", "list"],
              default_route_view_by_layout: { mobile: "orders_map" },
              clustering: { enabled: true, grid_px: 84, min_count: 4 },
              tile_provider: {
                engine: "maplibre",
                provider: "openstreetmap",
                data_provider: "openstreetmap",
                url_template: "/tenant-map-tiles/openstreetmap/{z}/{x}/{y}.png",
                attribution_label: "OpenStreetMap contributors",
                attribution_url: "https://www.openstreetmap.org/copyright",
                license: "ODbL-1.0",
                usage_tier: "production_cached",
                cache_required: true,
                allowed_hosts: ["same-origin"],
              },
              logistics_stack: {
                spatial_source_of_truth: "postgis",
                routing_engine: "valhalla",
                optimization_engine: "vroom",
              },
            },
          },
        ]),
        policyContext: { organization_id: "org_live" },
      },
      category: "map_policy",
      parse: normalizeResolvedMobileMapPolicy,
      fallback: DEFAULT_MOBILE_MAP_POLICY,
      requireResolved: true,
    });

    expect(data.defaultRouteView).toBe("orders_map");
    expect(data.clusteringGridPx).toBe(84);
    expect(data.tileProvider.urlTemplate).toBe(
      "/tenant-map-tiles/openstreetmap/{z}/{x}/{y}.png",
    );
  });
});
