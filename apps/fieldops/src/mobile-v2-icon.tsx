// Mobile V2 FxIcon — thin react-native-svg renderer over the typed catalog.
// Names are exhaustively type-checked against MobileV2IconName so a screen
// referencing a missing icon fails at compile time, not at runtime.
//
// Pure rendering helpers (resolveFxIconRenderProps, resolveFxIconShapeRender)
// live in mobile-v2-icon-render-helpers so unit tests can cover them without
// dragging in react-native-svg's native module surface.

import * as React from "react";
import Svg, { Circle, Path, Rect } from "react-native-svg";

import {
  MOBILE_V2_ICON_VIEWBOX,
  type MobileV2IconName,
  getMobileV2IconSpec,
} from "./mobile-v2-icon-specs";
import {
  type FxIconRenderInput,
  resolveFxIconRenderProps,
  resolveFxIconShapeRender,
} from "./mobile-v2-icon-render-helpers";

export type FxIconProps = FxIconRenderInput;
export type { MobileV2IconName };

export function FxIcon(props: FxIconProps): React.ReactElement | null {
  const spec = getMobileV2IconSpec(props.name);
  if (spec === null) {
    return null;
  }
  const { size, stroke, color, strokeLinecap, strokeLinejoin, accessibilityLabel } =
    resolveFxIconRenderProps(props);
  return (
    <Svg
      width={size}
      height={size}
      viewBox={MOBILE_V2_ICON_VIEWBOX}
      fill="none"
      stroke={color}
      strokeWidth={stroke}
      strokeLinecap={strokeLinecap}
      strokeLinejoin={strokeLinejoin}
      accessibilityLabel={accessibilityLabel}
    >
      {spec.map((shape, index) => {
        const render = resolveFxIconShapeRender(shape, color);
        switch (shape.kind) {
          case "path":
            return (
              <Path
                key={index}
                d={shape.d}
                fill={render.fill}
                stroke={render.stroke}
                strokeWidth={render.stroke === "none" ? 0 : stroke}
              />
            );
          case "rect":
            return (
              <Rect
                key={index}
                x={shape.x}
                y={shape.y}
                width={shape.width}
                height={shape.height}
                rx={shape.rx ?? 0}
                fill="none"
                stroke={color}
                strokeWidth={stroke}
              />
            );
          case "circle":
            return (
              <Circle
                key={index}
                cx={shape.cx}
                cy={shape.cy}
                r={shape.r}
                fill={render.fill}
                stroke={render.stroke}
                strokeWidth={render.stroke === "none" ? 0 : stroke}
              />
            );
          default:
            return null;
        }
      })}
    </Svg>
  );
}
