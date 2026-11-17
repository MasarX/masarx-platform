import type { CircleLayerSpecification, LineLayerSpecification } from "@maplibre/maplibre-react-native";
import type { MobileRealMapModel } from "./mobile-real-map-model";

export type MobileRasterMapStyle = {
  version: 8;
  sources: Record<string, {
    type: "raster";
    tiles: string[];
    tileSize: 256 | 512;
    attribution: string;
    minzoom?: number;
    maxzoom?: number;
  }>;
  layers: Array<{ id: string; type: "raster"; source: string }>;
};

export type MobileRealMapRendererProps = {
  model: MobileRealMapModel;
  style: MobileRasterMapStyle;
  camera: { padding: { top: number; right: number; bottom: number; left: number }; singlePointZoom: number; maxZoom: number };
  onSelect: (id: string) => void;
  onState: (state: { modelId: string; status: "loading" | "ready" | "error" }) => void;
};

export const MOBILE_REAL_MAP_LINE_PAINT = {
  "line-color": "#2563eb",
  "line-width": 3,
} satisfies NonNullable<LineLayerSpecification["paint"]>;
export const MOBILE_REAL_MAP_POINT_PAINT = {
  "circle-radius": ["case", ["==", ["get", "active"], true], 10, 7],
  "circle-color": ["match", ["get", "tone"], "done", "#15803d", "issue", "#b91c1c", "active", "#b45309", "#2563eb"],
  "circle-stroke-width": 2,
  "circle-stroke-color": "#ffffff",
} satisfies NonNullable<CircleLayerSpecification["paint"]>;
