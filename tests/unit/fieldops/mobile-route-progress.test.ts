import { readFileSync } from "node:fs";
import { resolve } from "node:path";

test("route progress uses the visible route counts and stays hidden under the driving lock", () => {
  const source = readFileSync(resolve(__dirname, "../../../apps/fieldops/App.tsx"), "utf8");
  expect(source).toMatch(/routeSummary && routeSummary\.totalStops > 0 && !drivingModeLocked \? \(\s*<View\s+testID="mobile-route-progress"/);
  expect(source).toContain('accessibilityRole="progressbar"');
  expect(source).toContain("accessibilityValue={{ min: 0, max: routeSummary.totalStops, now: routeSummary.doneStops }}");
});
