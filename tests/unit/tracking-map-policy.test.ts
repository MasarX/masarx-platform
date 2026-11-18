import { resolveTrackingMapConfiguration } from "../../packages/ui/src/tracking-map-policy";
import { normalizeMobileOpenMapPolicy, resolveMobileMapConfiguration } from "../../apps/fieldops/src/mobile-open-map-policy";
const configured = () => ({
  tile_provider: { url_template: "https://tile.openstreetmap.org/{z}/{x}/{y}.png", allowed_hosts: ["tile.openstreetmap.org"], usage_tier: "local_dev_light", cache_required: false, attribution_label: "OpenStreetMap contributors", attribution_url: "https://www.openstreetmap.org/copyright", load_timeout_ms: 1200 },
  default_viewport: { zoom: 10 }, zoom_padding: { all: 24 },
});
test("explicit tracking policy uses shared raster validation without mobile defaults", () => {
  const result = resolveTrackingMapConfiguration(configured());
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error("Expected configured policy");
  expect(result.camera).toEqual({singlePointZoom:10,maxZoom:10,padding:{top:24,right:24,bottom:24,left:24}});
  expect(result.loadTimeoutMs).toBe(1200);
  expect(result.style.sources.tiles.tiles).toEqual(["https://tile.openstreetmap.org/{z}/{x}/{y}.png"]);
});
test.each([undefined,null,{},[]])("absent tracking configuration %j cannot inherit mobile defaults", value => {
  expect(resolveTrackingMapConfiguration(value)).toEqual({ok:false,reason:"unconfigured"});
});
test.each(["default_viewport","zoom_padding"] as const)("explicit %s is mandatory", key => {
  const value:Record<string,unknown> = configured(); delete value[key];
  expect(resolveTrackingMapConfiguration(value)).toEqual({ok:false,reason:"unconfigured"});
});
test.each([undefined,null,0,-1,Infinity,120001,"1000"])("invalid or missing timeout %j fails closed (case %#)", timeout => {
  const value = configured();
  (value.tile_provider as Record<string,unknown>).load_timeout_ms=timeout;
  expect(resolveTrackingMapConfiguration(value)).toEqual({ok:false,reason:"unconfigured"});
});
test("individual configured padding replaces defaults without inventing omitted sides", () => {
  const value:Record<string,unknown> = configured();
  value.zoom_padding={top:1,right:2,bottom:3,left:4};
  const result=resolveTrackingMapConfiguration(value);
  expect(result.ok && result.camera.padding).toEqual({top:1,right:2,bottom:3,left:4});
  value.zoom_padding={top:1};
  expect(resolveTrackingMapConfiguration(value)).toEqual({ok:false,reason:"unconfigured"});
});
test("relative policy requires verified HTTPS origin; absolute policy does not", () => {
  const value=configured();
  Object.assign(value.tile_provider,{url_template:"/tiles/{z}/{x}/{y}.png",allowed_hosts:["same-origin"],same_origin_proxy_allowed:true,usage_tier:"production",cache_required:true});
  expect(resolveTrackingMapConfiguration(value)).toEqual({ok:false,reason:"unsupported"});
  expect(resolveTrackingMapConfiguration(value,"http://console.example")).toEqual({ok:false,reason:"insecure"});
  const result=resolveTrackingMapConfiguration(value,"https://console.example");
  expect(result.ok && result.style.sources.tiles.tiles).toEqual(["https://console.example/tiles/{z}/{x}/{y}.png"]);
});
test.each([
  {url_template:"https://api.mapbox.com/{z}/{x}/{y}",allowed_hosts:["api.mapbox.com"]},
  {usage_tier:"production"},
  {allowed_hosts:["*.openstreetmap.org"]},
])("existing provider/host/tier rejection remains intact %j", fields => {
  const value=configured();Object.assign(value.tile_provider,fields);
  expect(resolveTrackingMapConfiguration(value)).toEqual({ok:false,reason:"unapproved"});
});
test("shared extraction preserves mobile-only defaults and unchanged raster result", () => {
  const value=configured(); const mobile=normalizeMobileOpenMapPolicy(value);
  expect(resolveMobileMapConfiguration(mobile,"web")).toEqual(resolveTrackingMapConfiguration(value));
  expect(normalizeMobileOpenMapPolicy({}).camera.padding.bottom).toBe(220);
  expect(normalizeMobileOpenMapPolicy({}).loadTimeoutMs).toBe(15000);
});
