// Pure render helpers for FxIcon, separated from the .tsx component so unit
// tests cover the defaulting and per-shape rendering logic without dragging
// in react-native-svg's native module surface.

import {
  MOBILE_V2_ICON_DEFAULT_SIZE,
  MOBILE_V2_ICON_DEFAULT_STROKE,
  type MobileV2IconName,
  type MobileV2IconShape,
} from "./mobile-v2-icon-specs";

export interface FxIconRenderInput {
  readonly name: MobileV2IconName;
  readonly size?: number;
  readonly stroke?: number;
  readonly color?: string;
  readonly strokeLinecap?: "round" | "butt" | "square";
  readonly strokeLinejoin?: "round" | "miter" | "bevel";
  readonly accessibilityLabel?: string;
}

export interface FxIconRenderProps {
  readonly size: number;
  readonly stroke: number;
  readonly color: string;
  readonly strokeLinecap: "round" | "butt" | "square";
  readonly strokeLinejoin: "round" | "miter" | "bevel";
  readonly accessibilityLabel: string;
}

/**
 * Apply design defaults to FxIcon props. Invalid (non-positive) numeric inputs
 * fall back to source defaults (size=20, stroke=1.7); empty color strings fall
 * back to a safe high-contrast white. Extracted so corruption from runtime
 * theme overrides cannot crash the renderer.
 */
export function resolveFxIconRenderProps(input: FxIconRenderInput): FxIconRenderProps {
  return {
    size:
      typeof input.size === "number" && input.size > 0 ? input.size : MOBILE_V2_ICON_DEFAULT_SIZE,
    stroke:
      typeof input.stroke === "number" && input.stroke > 0
        ? input.stroke
        : MOBILE_V2_ICON_DEFAULT_STROKE,
    color: typeof input.color === "string" && input.color.length > 0 ? input.color : "#FFFFFF",
    strokeLinecap: input.strokeLinecap ?? "round",
    strokeLinejoin: input.strokeLinejoin ?? "round",
    accessibilityLabel: input.accessibilityLabel ?? input.name,
  };
}

/**
 * Decide how a single shape renders given the active color. The design source
 * uses currentColor inheritance (CSS), which RN does not have; we translate
 * `fill: "currentColor"` into a literal fill matching the resolved color and
 * suppress the stroke for those shapes (otherwise the icon picks up an
 * unintended outline). Stroke-only shapes keep fill=none.
 */
export function resolveFxIconShapeRender(
  shape: MobileV2IconShape,
  color: string,
): {
  readonly fill: string;
  readonly stroke: string;
} {
  if ((shape.kind === "path" || shape.kind === "circle") && shape.fill === "currentColor") {
    return { fill: color, stroke: "none" };
  }
  return { fill: "none", stroke: color };
}
