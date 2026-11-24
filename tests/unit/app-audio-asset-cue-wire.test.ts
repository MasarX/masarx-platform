import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { STATIC_HAPTIC_EVENT } from "../../apps/fieldops/src/haptic-event-policy";

const mockHaptic = jest.fn().mockResolvedValue(undefined);
jest.mock("../../apps/fieldops/src/mobile-haptic-trigger", () => ({ triggerHaptic: mockHaptic }));
const { emitSensoryFeedback } = require("../../apps/fieldops/src/mobile-sensory-feedback") as
  typeof import("../../apps/fieldops/src/mobile-sensory-feedback");

test("resolves scan feedback under the admitted policy and respects driving suppression", () => {
  const state = { haptics: STATIC_HAPTIC_EVENT, drivingLocked: false };
  emitSensoryFeedback("scan.success", state);
  expect(mockHaptic).toHaveBeenCalledWith("light");
  emitSensoryFeedback("scan.success", { ...state, drivingLocked: true });
  expect(mockHaptic).toHaveBeenLastCalledWith("off");
});

test("wires device feedback to local scan persistence and verified delivery readback", () => {
  const app = readFileSync(resolve(__dirname, "../../apps/fieldops/App.tsx"), "utf8");
  expect(app).toContain('onScanSaved={() => emitDriverFeedback("scan.success")}');
  expect(app).toMatch(/setLastQueuedScan\(\{[\s\S]*?returnScope,\s*\}\);\s*onScanSaved\(\);/);
  expect(app).toContain("completionReadbackVerified && completionReadbackQuery.data?.delivered");
  expect(app).toMatch(/lastProofFeedback\.current = confirmedDeliveryQueue;\s*emitDriverFeedback\("pod.completed"\);/);
});
