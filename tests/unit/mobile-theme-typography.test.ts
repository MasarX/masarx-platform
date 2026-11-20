import { getTokensForTheme } from "../../apps/fieldops/src/mobile-theme";

test.each(["light", "dark"] as const)("exports the %s typography ramp on both platforms", mode => {
  const web = getTokensForTheme(mode, "web").font;
  const native = getTokensForTheme(mode, "native").font;

  expect(native.scale).toEqual(web.scale);
  expect(web.scale).toMatchObject({ xs: 11, md: 14, lg: 16, "2xl": 20, display: 34 });
  expect(web.weight).toMatchObject({ regular: 400, semibold: 600, bold: 700 });
  expect(web.lineHeight.tight).toBeLessThan(web.lineHeight.normal);
  expect(native.mono).toBe("monospace");
  expect(web.mono).toContain("monospace");
});
