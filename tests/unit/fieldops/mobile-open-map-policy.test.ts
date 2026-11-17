import { normalizeMobileOpenMapPolicy, resolveMobileMapConfiguration } from "../../../apps/fieldops/src/mobile-open-map-policy";

const template = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";
const attribution = "https://www.openstreetmap.org/copyright";
const configured = (tile: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) =>
  normalizeMobileOpenMapPolicy({
    ...extra,
    tile_provider: {
      url_template: template, allowed_hosts: ["tile.openstreetmap.org"],
      usage_tier: "local_dev_light", cache_required: false,
      attribution_label: "© OpenStreetMap contributors", attribution_url: attribution,
      ...tile,
    },
  });

test.each([undefined, null, {}, [], "invalid"])("absent policy %j never invents a tile provider", value => {
  const policy = normalizeMobileOpenMapPolicy(value);
  expect(policy.tileUrlTemplate).toBe("");
  expect(resolveMobileMapConfiguration(policy, "web", "https://fieldops.example")).toEqual({ ok: false, reason: "unconfigured" });
  expect(policy.cacheRequired).toBe(true);
});

test("camera defaults and bounded overrides stay deterministic", () => {
  expect(normalizeMobileOpenMapPolicy({}).camera).toEqual({
    singlePointZoom: 11, maxZoom: 11, padding: { top: 80, right: 48, bottom: 220, left: 48 },
  });
  expect(configured({}, { default_viewport: { zoom: 15 }, zoom_padding: { all: 25, bottom: 100 } }).camera)
    .toEqual({ singlePointZoom: 15, maxZoom: 15, padding: { top: 25, right: 25, bottom: 100, left: 25 } });
  expect(configured({}, { default_viewport: { zoom: Infinity }, zoom_padding: { top: -1, right: 513, bottom: NaN, left: "4" } }).camera)
    .toEqual(normalizeMobileOpenMapPolicy({}).camera);
});

test.each(["web", "native"] as const)("explicit light OSM HTTPS works on %s and retains tile tokens", runtime => {
  const policy = configured();
  const result = resolveMobileMapConfiguration(policy, runtime);
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error("Expected explicitly approved policy");
  expect(result.style.sources.tiles.tiles).toEqual([template]);
  expect(result.attributionLabel).toBe("© OpenStreetMap contributors");
  expect(result.attributionUrl).toBe(attribution);
  expect(result.camera).toEqual(policy.camera);
});

test.each(["", "production", "shared", "LOCAL_DEV_LIGHT"])("OSM tier %j is never implicitly approved", usage_tier => {
  expect(resolveMobileMapConfiguration(configured({ usage_tier }), "native")).toEqual({ ok: false, reason: "unapproved" });
});

test.each([
  ["tile.openstreetmap.org.evil.example"], ["*.openstreetmap.org"], ["openstreetmap.org"],
  ["https://tile.openstreetmap.org"], ["tile.openstreetmap.org:443"], ["tile.openstreetmap.org/path"],
  ["tile.openstreetmap.org@evil.example"], [], [null, 42],
].map(hosts => [hosts]))("host approval requires exact hostname, not malformed entry %j", allowed_hosts => {
  expect(resolveMobileMapConfiguration(configured({ allowed_hosts }), "native")).toEqual({ ok: false, reason: "unapproved" });
});

test("trimmed exact host and explicit local-light cache exception remain supported", () => {
  expect(resolveMobileMapConfiguration(configured({ allowed_hosts: [" TILE.OPENSTREETMAP.ORG "], cache_required: true }), "native").ok).toBe(true);
});

test.each(["web", "native"] as const)("cache-required external tiles stay blocked on %s outside explicit light tier", runtime => {
  expect(resolveMobileMapConfiguration(configured({ cache_required: true, usage_tier: "production", url_template: "https://tiles.example/{z}/{x}/{y}", allowed_hosts: ["tiles.example"] }), runtime)).toEqual({ ok: false, reason: "unapproved" });
});

test("approved relative web proxy keeps origin and literal tokens without external tiles", () => {
  const policy = configured({ url_template: "/tiles/{z}/{x}/{y}.png", allowed_hosts: ["same-origin"],
    same_origin_proxy_allowed: true, usage_tier: "production", cache_required: true });
  const result = resolveMobileMapConfiguration(policy, "web", "https://fieldops.example");
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error("Expected approved same-origin proxy");
  expect(result.style.sources.tiles.tiles).toEqual(["https://fieldops.example/tiles/{z}/{x}/{y}.png"]);
  expect(resolveMobileMapConfiguration(policy, "native")).toEqual({ ok: false, reason: "unsupported" });
});

test.each([
  [{ same_origin_proxy_allowed: false }, "https://fieldops.example", "unapproved"],
  [{ allowed_hosts: ["fieldops.example"] }, "https://fieldops.example", "unapproved"],
  [{}, undefined, "unsupported"], [{}, "http://fieldops.example", "insecure"],
  [{}, "not-an-origin", "insecure"],
] as const)("relative proxy fails closed for %j / %s", (overrides, origin, reason) => {
  const policy = configured({ url_template: "/tiles/{z}/{x}/{y}.png", allowed_hosts: ["same-origin"],
    same_origin_proxy_allowed: true, ...overrides });
  expect(resolveMobileMapConfiguration(policy, "web", origin)).toEqual({ ok: false, reason });
});

test.each([
  "//tile.openstreetmap.org/{z}/{x}/{y}.png",
  "https:\\\\tile.openstreetmap.org\\{z}\\{x}\\{y}.png",
  (["https",":","/","/","user",":","hlkurmsnvgnhwnilvqhkgqvr","@","example.invalid","/","{z}","/","{x}","/","{y}.png"].join("")),
  "https://tile.openstreetmap.org/{z}/{x}/{y}.png#fragment",
  "http://tile.openstreetmap.org/{z}/{x}/{y}.png",
  "javascript:/{z}/{x}/{y}", "https://[invalid/{z}/{x}/{y}",
])("insecure template %s cannot create a style", url_template => {
  expect(resolveMobileMapConfiguration(configured({ url_template }), "web", "https://fieldops.example"))
    .toEqual({ ok: false, reason: "insecure" });
});

test.each(["api.mapbox.com", "maps.googleapis.com", "tiles.virtualearth.net", "api.maptiler.com", "tiles.arcgis.com"])(
  "proprietary host %s stays blocked even if explicitly listed", host => {
    const policy = configured({ url_template: "https://" + host + "/{z}/{x}/{y}", allowed_hosts: [host] });
    expect(resolveMobileMapConfiguration(policy, "native")).toEqual({ ok: false, reason: "unapproved" });
  },
);

test.each([
  { attribution_label: "" }, { attribution_label: "Unknown contributor" },
  { attribution_url: "" }, { attribution_url: "http://www.openstreetmap.org/copyright" },
  { attribution_url: attribution + "#extra" }, { attribution_url: "https://evil.example/copyright" },
])("attribution contract is mandatory: %j", fields => {
  expect(resolveMobileMapConfiguration(configured(fields), "native")).toEqual({ ok: false, reason: "attribution" });
});

test("policy cannot inject HTML or remote style, glyph or sprite configuration", () => {
  const result = resolveMobileMapConfiguration(configured(
    { attribution_label: "<img src=x onerror=alert(1)> OpenStreetMap", style: "https://evil.example/style.json" },
    { style: { glyphs: "https://evil.example", sprite: "https://evil.example" } },
  ), "native");
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error("Expected plain text attribution policy");
  expect(result.style).toEqual({
    version: 8, sources: { tiles: { type: "raster", tiles: [template], tileSize: 256, attribution: "" } },
    layers: [{ id: "tiles", type: "raster", source: "tiles" }],
  });
  expect(JSON.stringify(result.style)).not.toContain("<img");
});

test("unsupported runtime and missing tile tokens never produce style", () => {
  expect(resolveMobileMapConfiguration(configured(), "unsupported")).toEqual({ ok: false, reason: "unsupported" });
  expect(resolveMobileMapConfiguration(configured({ url_template: "https://tile.openstreetmap.org/0/{x}/{y}" }), "web"))
    .toEqual({ ok: false, reason: "unconfigured" });
});
test("map loading deadline defaults to 15 seconds for absent or invalid policy", () => {
  for (const load_timeout_ms of [undefined, null, 0, -1, NaN, Infinity, 120001, "1000"]) {
    expect(configured({ load_timeout_ms }).loadTimeoutMs).toBe(15000);
  }
});
test("explicit map loading deadline remains bounded and is forwarded to configuration", () => {
  const policy = configured({ load_timeout_ms: 120000 });
  expect(policy.loadTimeoutMs).toBe(120000);
  const result = resolveMobileMapConfiguration(policy, "native");
  expect(result.ok).toBe(true);
  if (result.ok) expect(result.loadTimeoutMs).toBe(120000);
});
