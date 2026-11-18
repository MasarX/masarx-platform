import { normalizeOpenMapTilePolicy, resolveOpenMapConfiguration, type OpenMapConfiguration } from "@masarx/config";
export type TrackingMapConfiguration = OpenMapConfiguration;

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function finite(value: unknown, maximum: number): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= maximum;
}
/** No mobile camera defaults, provider defaults, or implied free-service admission. */
export function resolveTrackingMapConfiguration(value: unknown, webOrigin?: string): TrackingMapConfiguration {
  const input = record(value);
  const tile = record(input.tile_provider);
  const viewport = record(input.default_viewport);
  const padding = record(input.zoom_padding);
  const zoom = viewport.zoom;
  const timeout = tile.load_timeout_ms;
  const sides = [padding.top ?? padding.all, padding.right ?? padding.all, padding.bottom ?? padding.all, padding.left ?? padding.all];
  if (!finite(zoom, 22) || !finite(timeout, 120000) || timeout === 0 || !sides.every(side => finite(side, 512))) {
    return { ok: false, reason: "unconfigured" };
  }
  const [top, right, bottom, left] = sides as [number, number, number, number];
  return resolveOpenMapConfiguration({
    ...normalizeOpenMapTilePolicy(tile),
    camera: { singlePointZoom: zoom, maxZoom: zoom, padding: { top, right, bottom, left } },
    loadTimeoutMs: timeout,
  }, "web", webOrigin);
}
