import { readFileSync } from "node:fs";
import { resolve } from "node:path";

test("shows the receiving shift status and keeps the existing start and end controls", () => {
  const app = readFileSync(resolve(__dirname, "../../apps/fieldops/App.tsx"), "utf8");
  const summary = readFileSync(resolve(__dirname, "../../apps/fieldops/src/screens/ShiftSummaryScreen.tsx"), "utf8");
  expect(app).toContain("<ShiftSummaryScreen shift={activeDriverShift}");
  expect(app).toMatch(/testID="mobile-start-driver-shift"\s+onPress=\{onStartShift\}\s+disabled=\{Boolean\(activeDriverShift\)/);
  expect(app).toMatch(/testID="mobile-end-driver-shift"\s+onPress=\{onEndShift\}\s+disabled=\{!activeDriverShift/);
  expect(summary).toContain('tone={shift ? "success" : "neutral"}');
  expect(summary).toContain("{shift?.openedAt ?");
});
