export type BlockType = "text" | "barcode" | "image" | "line" | "rect";

export type TemplateBlock = {
  type: BlockType;
  x: number;
  y: number;
  width?: number;
  height?: number;
  max_width?: number;
  max_height?: number;
  color?: string;
  fill_color?: string;
  stroke_width?: number;
  rotation?: number;
  align?: "left" | "center" | "right";
  valign?: "top" | "middle" | "bottom";
  render_if?: unknown;

  // text
  font?: string;
  font_size?: number;
  value_path?: string;
  fallback?: string;
  wrap?: boolean;

  // barcode
  barcode_type?: string;
  human_readable?: boolean;
  module_width?: number;
  quiet_zone_modules?: number;
  error_correction?: "L" | "M" | "Q" | "H";

  // image
  asset_ref?: string;

  // layer management
  name?: string;
  locked?: boolean;
  visible?: boolean;
};

export type PageConfig = {
  width_inch: number;
  height_inch: number;
  dpi: number;
  margin_inch?: number;
};

export type CanvasState = {
  selectedBlockIndices: number[];
  hoveredBlockIndex: number | null;
  dragState: DragState | null;
  resizeState: ResizeState | null;
};

export type DragState = {
  blockIndex: number;
  startX: number;
  startY: number;
  originBlockX: number;
  originBlockY: number;
};

export type ResizeState = {
  blockIndex: number;
  handle: ResizeHandle;
  startX: number;
  startY: number;
  originWidth: number;
  originHeight: number;
  originX: number;
  originY: number;
};

export type ResizeHandle = "se" | "sw" | "ne" | "nw" | "e" | "w" | "n" | "s";

export const POINTS_PER_INCH = 72;

export const DEFAULT_PAGE: PageConfig = {
  width_inch: 4,
  height_inch: 6,
  dpi: 203,
};

export function pageToPixels(page: PageConfig, scale: number) {
  return {
    width: page.width_inch * POINTS_PER_INCH * scale,
    height: page.height_inch * POINTS_PER_INCH * scale,
  };
}
