import {
  resolveContentBottomPadding,
  resolveHeaderTopPadding,
  resolveNavModalBottomPadding,
} from "../../../apps/fieldops/src/mobile-shell-safe-area";

describe("mobile shell safe area resolver", () => {
  test("keeps minimum header spacing when top inset is missing", () => {
    expect(resolveHeaderTopPadding(0)).toBe(16);
    expect(resolveHeaderTopPadding(-12)).toBe(16);
    expect(resolveHeaderTopPadding(Number.NaN)).toBe(16);
  });

  test("adds top inset to header spacing for notched devices", () => {
    expect(resolveHeaderTopPadding(24)).toBe(32);
    expect(resolveHeaderTopPadding(44)).toBe(52);
  });

  test("adds bottom inset to content and nav modal paddings", () => {
    expect(resolveContentBottomPadding(0)).toBe(16);
    expect(resolveContentBottomPadding(20)).toBe(36);
    expect(resolveNavModalBottomPadding(0)).toBe(24);
    expect(resolveNavModalBottomPadding(20)).toBe(44);
  });
});
