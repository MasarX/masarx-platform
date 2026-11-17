import { normalizeOpenMapTilePolicy, resolveOpenMapConfiguration, type OpenMapCamera, type OpenMapConfiguration, type OpenMapPolicy } from "@masarx/config";
export type MobileMapCamera = OpenMapCamera;
export type MobileOpenMapPolicy = OpenMapPolicy;
export type MobileMapConfiguration = OpenMapConfiguration;

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function bounded(value: unknown, fallback: number, max: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= max ? value : fallback;
}
export function normalizeMobileOpenMapPolicy(value: unknown): MobileOpenMapPolicy {
  const input = record(value);
  const padding = record(input.zoom_padding);
  const viewport = record(input.default_viewport);
  const zoom = bounded(viewport.zoom, 11, 22);
  return {
    ...normalizeOpenMapTilePolicy(input.tile_provider),
    loadTimeoutMs: bounded(record(input.tile_provider).load_timeout_ms, 15000, 120000) || 15000,
    camera: {
      singlePointZoom: zoom, maxZoom: zoom,
      padding: {
        top: bounded(padding.top ?? padding.all, 80, 512),
        right: bounded(padding.right ?? padding.all, 48, 512),
        bottom: bounded(padding.bottom ?? padding.all, 220, 512),
        left: bounded(padding.left ?? padding.all, 48, 512),
      },
    },
  };
}
export const resolveMobileMapConfiguration = resolveOpenMapConfiguration;
