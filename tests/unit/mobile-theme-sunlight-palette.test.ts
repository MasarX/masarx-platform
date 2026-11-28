import { DARK_PALETTE, LIGHT_PALETTE, SUNLIGHT_PALETTE, getTokensForTheme } from "../../apps/fieldops/src/mobile-theme";

function luminance(hex: string): number {
  const channels = hex.slice(1).match(/.{2}/g)!;
  const [r, g, b] = channels.map((value) => {
    const srgb = Number.parseInt(value, 16) / 255;
    return srgb <= 0.04045 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
  });
  return r * 0.2126 + g * 0.7152 + b * 0.0722;
}

test("provides a distinct sunlight palette with the same keys as the existing palettes", () => {
  const keys = Object.keys(SUNLIGHT_PALETTE).sort();
  expect(keys).toEqual(Object.keys(LIGHT_PALETTE).sort());
  expect(keys).toEqual(Object.keys(DARK_PALETTE).sort());
  expect(SUNLIGHT_PALETTE.text).not.toBe(LIGHT_PALETTE.text);
  expect(SUNLIGHT_PALETTE.pageBg).not.toBe(DARK_PALETTE.pageBg);
  expect(getTokensForTheme("sunlight").color).toEqual(SUNLIGHT_PALETTE);
  expect(getTokensForTheme("light").color).toEqual(LIGHT_PALETTE);
  expect(getTokensForTheme("dark").color).toEqual(DARK_PALETTE);
});

test.each([
  ["text", "pageBg"],
  ["text", "cardBg"],
  ["textMuted", "cardBg"],
  ["controlText", "control"],
  ["successFg", "successSoft"],
  ["warningFg", "warningSoft"],
  ["dangerFg", "dangerSoft"],
  ["infoFg", "infoSoft"],
  ["metaFg", "metaSoft"],
] as const)("keeps the %s on %s contrast ratio at or above 7:1", (foreground, background) => {
  const a = luminance(SUNLIGHT_PALETTE[foreground]);
  const b = luminance(SUNLIGHT_PALETTE[background]);
  expect((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)).toBeGreaterThanOrEqual(7);
});
