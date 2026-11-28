import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { getFieldOpsStrings } from "../../apps/fieldops/src/i18n";
import {
  MOBILE_REAL_MAP_POINT_PAINT,
  MOBILE_REAL_MAP_TONE_COLORS,
} from "../../apps/fieldops/src/mobile-real-map-renderer.types";

test("the map legend and both map renderers use the same tone colors", () => {
  const { done, issue, active, neutral } = MOBILE_REAL_MAP_TONE_COLORS;
  expect(MOBILE_REAL_MAP_POINT_PAINT["circle-color"]).toEqual([
    "match", ["get", "tone"], "done", done, "issue", issue, "active", active, neutral,
  ]);

  const source = readFileSync(resolve(__dirname, "../../apps/fieldops/src/mobile-real-map.tsx"), "utf8");
  expect(source).toContain('testID="mobile-real-map-legend"');
  expect(source).toContain("backgroundColor: MOBILE_REAL_MAP_TONE_COLORS[tone]");
  expect(source).toContain("<Text>{mapToneLabels[tone]}</Text>");
  expect(source).toMatch(/<View aria-hidden=\{true\}[^\n]*MOBILE_REAL_MAP_TONE_COLORS/);
});

test.each(["en", "ar"] as const)("the %s map legend labels all four tones", (locale) => {
  const labels = getFieldOpsStrings(locale).realMap.mapToneLabels;
  expect(Object.keys(labels).sort()).toEqual(Object.keys(MOBILE_REAL_MAP_TONE_COLORS).sort());
  expect(Object.values(labels).every((label) => label.trim().length > 0)).toBe(true);
});
