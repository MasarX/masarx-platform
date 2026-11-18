import {
  MOBILE_V2_BOTTOM_SHEET_BACKDROP_ELEVATION,
  MOBILE_V2_BOTTOM_SHEET_BACKDROP_Z_INDEX,
  MOBILE_V2_BOTTOM_SHEET_DEFAULT_HEIGHT_FRACTION,
  MOBILE_V2_BOTTOM_SHEET_OVERLAY_ELEVATION,
  MOBILE_V2_BOTTOM_SHEET_OVERLAY_Z_INDEX,
  MOBILE_V2_BOTTOM_SHEET_PANEL_ELEVATION,
  MOBILE_V2_BOTTOM_SHEET_PANEL_Z_INDEX,
} from "../../../apps/fieldops/src/mobile-v2-bottom-sheet-layering";

describe("Mobile V2 bottom sheet layering", () => {
  test("keeps sheets above persistent bottom navigation", () => {
    expect(MOBILE_V2_BOTTOM_SHEET_OVERLAY_Z_INDEX).toBeGreaterThanOrEqual(30);
    expect(MOBILE_V2_BOTTOM_SHEET_OVERLAY_ELEVATION).toBeGreaterThanOrEqual(30);
  });

  test("uses a concrete default height for touchable sheet bounds", () => {
    expect(MOBILE_V2_BOTTOM_SHEET_DEFAULT_HEIGHT_FRACTION).toBeGreaterThanOrEqual(0.82);
    expect(MOBILE_V2_BOTTOM_SHEET_DEFAULT_HEIGHT_FRACTION).toBeLessThan(1);
  });

  test("keeps the panel above the backdrop for Android touch dispatch", () => {
    expect(MOBILE_V2_BOTTOM_SHEET_PANEL_Z_INDEX).toBeGreaterThan(
      MOBILE_V2_BOTTOM_SHEET_BACKDROP_Z_INDEX,
    );
    expect(MOBILE_V2_BOTTOM_SHEET_PANEL_ELEVATION).toBeGreaterThan(
      MOBILE_V2_BOTTOM_SHEET_BACKDROP_ELEVATION,
    );
  });
});
