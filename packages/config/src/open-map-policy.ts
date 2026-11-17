export type OpenMapCamera = { padding: { top: number; right: number; bottom: number; left: number }; singlePointZoom: number; maxZoom: number };
export type OpenRasterMapStyle = { version: 8; sources: Record<string, { type: "raster"; tiles: string[]; tileSize: 256 | 512; attribution: string; minzoom?: number; maxzoom?: number }>; layers: Array<{ id: string; type: "raster"; source: string }> };
export type OpenMapTilePolicy = { tileUrlTemplate: string; allowedTileHosts: string[]; usageTier: string; cacheRequired: boolean; sameOriginProxyAllowed: boolean; attributionLabel: string; attributionUrl: string };
export type OpenMapPolicy = OpenMapTilePolicy & { camera: OpenMapCamera; loadTimeoutMs: number };
export type OpenMapConfiguration = { ok: false; reason: "unconfigured" | "unsupported" | "insecure" | "unapproved" | "attribution" } | { ok: true; style: OpenRasterMapStyle; camera: OpenMapCamera; attributionLabel: string; attributionUrl: string; loadTimeoutMs: number };

const COPYRIGHT_URL = "https://www.openstreetmap.org/copyright";
const PROPRIETARY_HOST = /mapbox|maps\.google|googleapis|virtualearth|bing\.com|hereapi|here\.com|tomtom|maptiler|arcgis/i;
const TOKENS = ["{z}", "{x}", "{y}"] as const;
function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function text(value: unknown): string { return typeof value === "string" ? value.trim() : ""; }

export function normalizeOpenMapTilePolicy(value: unknown): OpenMapTilePolicy {
  const tile = record(value);
  const hosts = tile.allowed_hosts ?? tile.allowedHosts;
  return {
    tileUrlTemplate: text(tile.url_template ?? tile.urlTemplate),
    allowedTileHosts: Array.isArray(hosts) ? hosts.filter((host): host is string => typeof host === "string").map((host) => host.trim().toLowerCase()).filter(Boolean) : [],
    usageTier: text(tile.usage_tier ?? tile.usageTier),
    cacheRequired: (tile.cache_required ?? tile.cacheRequired) !== false,
    sameOriginProxyAllowed: (tile.same_origin_proxy_allowed ?? tile.sameOriginProxyAllowed) === true,
    attributionLabel: text(tile.attribution_label ?? tile.attributionLabel),
    attributionUrl: text(tile.attribution_url ?? tile.attributionUrl),
  };
}
// URL/policy admissibility is not proof of a provider's price or live tile readiness.
export function resolveOpenMapConfiguration(
  policy: OpenMapPolicy, runtime: "web" | "native" | "unsupported", webOrigin?: string
): OpenMapConfiguration {
  if (runtime === "unsupported") return { ok: false, reason: "unsupported" };
  const template = policy.tileUrlTemplate;
  if (!template || !TOKENS.every((token) => template.includes(token))) return { ok: false, reason: "unconfigured" };
  // Reject network-path and backslash URL normalization: neither is a same-origin path.
  if (template.startsWith("//") || template.includes("\\")) return { ok: false, reason: "insecure" };
  const relative = template.startsWith("/");
  let parsed: URL;
  try {
    if (relative && (runtime !== "web" || !webOrigin)) return { ok: false, reason: "unsupported" };
    parsed = new URL(template.replaceAll("{z}", "0").replaceAll("{x}", "0").replaceAll("{y}", "0"), relative ? webOrigin : undefined);
  } catch { return { ok: false, reason: "insecure" }; }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.hash) return { ok: false, reason: "insecure" };
  if (PROPRIETARY_HOST.test(parsed.hostname)) return { ok: false, reason: "unapproved" };
  if (relative) {
    if (!policy.sameOriginProxyAllowed || !policy.allowedTileHosts.includes("same-origin")) return { ok: false, reason: "unapproved" };
  } else {
    if (!policy.allowedTileHosts.includes(parsed.hostname.toLowerCase())) return { ok: false, reason: "unapproved" };
    if (parsed.hostname === "tile.openstreetmap.org" && policy.usageTier !== "local_dev_light") return { ok: false, reason: "unapproved" };
    if (policy.cacheRequired && policy.usageTier !== "local_dev_light") return { ok: false, reason: "unapproved" };
  }
  if (!policy.attributionLabel.toLowerCase().includes("openstreetmap") || policy.attributionUrl !== COPYRIGHT_URL) return { ok: false, reason: "attribution" };
  const url = relative ? new URL(webOrigin!).origin + template : template;
  // Fixed style structure cannot inject arbitrary remote styles, glyphs, sprites or HTML.
  return {
    ok: true, camera: policy.camera, loadTimeoutMs: policy.loadTimeoutMs, attributionLabel: policy.attributionLabel, attributionUrl: policy.attributionUrl,
    style: { version: 8, sources: { tiles: { type: "raster", tiles: [url], tileSize: 256, attribution: "" } }, layers: [{ id: "tiles", type: "raster", source: "tiles" }] },
  };
}
