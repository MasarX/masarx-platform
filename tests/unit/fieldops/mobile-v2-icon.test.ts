// FxIcon component itself imports react-native-svg which has no Node-friendly
// build for the unit jest config; we test the pure resolver helpers instead
// (which is where the bugs hide). Render correctness is covered by the icon
// catalog data tests + Phase 3 live Chrome audit.

import {
  MOBILE_V2_ICON_DEFAULT_SIZE,
  MOBILE_V2_ICON_DEFAULT_STROKE,
} from "../../../apps/fieldops/src/mobile-v2-icon-specs";
import {
  resolveFxIconRenderProps,
  resolveFxIconShapeRender,
} from "../../../apps/fieldops/src/mobile-v2-icon-render-helpers";

describe("FxIcon — resolveFxIconRenderProps", () => {
  test("applies design source defaults when props omitted", () => {
    const out = resolveFxIconRenderProps({ name: "menu" });
    expect(out.size).toBe(MOBILE_V2_ICON_DEFAULT_SIZE);
    expect(out.stroke).toBe(MOBILE_V2_ICON_DEFAULT_STROKE);
    expect(out.color).toBe("#FFFFFF");
    expect(out.strokeLinecap).toBe("round");
    expect(out.strokeLinejoin).toBe("round");
    expect(out.accessibilityLabel).toBe("menu");
  });

  test("respects positive size and stroke overrides", () => {
    const out = resolveFxIconRenderProps({ name: "scan", size: 32, stroke: 2.2 });
    expect(out.size).toBe(32);
    expect(out.stroke).toBe(2.2);
  });

  test("ignores invalid (zero or negative) size and stroke", () => {
    const out = resolveFxIconRenderProps({ name: "menu", size: 0, stroke: -1 });
    expect(out.size).toBe(MOBILE_V2_ICON_DEFAULT_SIZE);
    expect(out.stroke).toBe(MOBILE_V2_ICON_DEFAULT_STROKE);
  });

  test("respects color override (e.g. theme.accent)", () => {
    const out = resolveFxIconRenderProps({ name: "alert", color: "#F5D90A" });
    expect(out.color).toBe("#F5D90A");
  });

  test("treats empty color string as missing", () => {
    const out = resolveFxIconRenderProps({ name: "menu", color: "" });
    expect(out.color).toBe("#FFFFFF");
  });

  test("propagates accessibility label override", () => {
    const out = resolveFxIconRenderProps({
      name: "scan",
      accessibilityLabel: "Scan a parcel",
    });
    expect(out.accessibilityLabel).toBe("Scan a parcel");
  });

  test("respects custom stroke linecap and linejoin", () => {
    const out = resolveFxIconRenderProps({
      name: "menu",
      strokeLinecap: "square",
      strokeLinejoin: "miter",
    });
    expect(out.strokeLinecap).toBe("square");
    expect(out.strokeLinejoin).toBe("miter");
  });
});

describe("FxIcon — resolveFxIconShapeRender", () => {
  test("stroke-only path renders fill=none, stroke=color", () => {
    const out = resolveFxIconShapeRender({ kind: "path", d: "M0 0h10" }, "#FFFFFF");
    expect(out).toEqual({ fill: "none", stroke: "#FFFFFF" });
  });

  test("currentColor-filled path renders fill=color, stroke=none", () => {
    const out = resolveFxIconShapeRender(
      { kind: "path", d: "M0 0", fill: "currentColor" },
      "#F5D90A",
    );
    expect(out).toEqual({ fill: "#F5D90A", stroke: "none" });
  });

  test("currentColor-filled circle (e.g. dot) renders fill=color, stroke=none", () => {
    const out = resolveFxIconShapeRender(
      { kind: "circle", cx: 12, cy: 12, r: 3, fill: "currentColor" },
      "#22FF88",
    );
    expect(out).toEqual({ fill: "#22FF88", stroke: "none" });
  });

  test("stroke-only circle renders fill=none, stroke=color", () => {
    const out = resolveFxIconShapeRender({ kind: "circle", cx: 12, cy: 12, r: 4 }, "#1D4ED8");
    expect(out).toEqual({ fill: "none", stroke: "#1D4ED8" });
  });

  test("rect always renders stroke-only (no currentColor support in source)", () => {
    const out = resolveFxIconShapeRender(
      { kind: "rect", x: 0, y: 0, width: 10, height: 10 },
      "#A78BFA",
    );
    expect(out).toEqual({ fill: "none", stroke: "#A78BFA" });
  });
});
