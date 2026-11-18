jest.mock("react-native", () => ({
  Easing: { bezier: () => (progress: number) => progress },
}), { virtual: true });

import {
  resolveCelebrationAccent,
  resolveCelebrationGlyph,
  resolveCelebrationSoftAccent,
} from "../../apps/fieldops/src/components/BrandCelebration";
import { getTokensForTheme } from "../../apps/fieldops/src/mobile-theme";

test.each(["light", "dark"] as const)("resolves the %s celebration palette", mode => {
  const tokens = getTokensForTheme(mode);

  for (const moment of ["sign_in", "shift_start"] as const) {
    expect(resolveCelebrationAccent(tokens, moment)).toBe(tokens.color.accent);
    expect(resolveCelebrationSoftAccent(tokens, moment)).toBe(tokens.color.accentSoft);
    expect(resolveCelebrationGlyph(moment)).toBe("•");
  }

  expect(resolveCelebrationAccent(tokens, "shift_end")).toBe(tokens.color.success);
  expect(resolveCelebrationSoftAccent(tokens, "shift_end")).toBe(tokens.color.successSoft);
  expect(resolveCelebrationGlyph("shift_end")).toBe("✓");
  expect(resolveCelebrationAccent(tokens, "error_recovery")).toBe(tokens.color.warning);
  expect(resolveCelebrationSoftAccent(tokens, "error_recovery")).toBe(tokens.color.warningSoft);

  const { accent, success, warning } = tokens.color;
  expect(resolveCelebrationSoftAccent({ color: { accent, success, warning } }, "shift_end"))
    .toBe(success);
});
