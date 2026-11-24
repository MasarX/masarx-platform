const mockImpact = jest.fn().mockResolvedValue(undefined);
const mockNotification = jest.fn().mockResolvedValue(undefined);
const mockSelection = jest.fn().mockResolvedValue(undefined);
jest.mock("expo-haptics", () => ({
  impactAsync: mockImpact,
  notificationAsync: mockNotification,
  selectionAsync: mockSelection,
  ImpactFeedbackStyle: { Light: "light", Medium: "medium", Heavy: "heavy" },
  NotificationFeedbackType: { Success: "success", Warning: "warning", Error: "error" },
}), { virtual: true });

const { triggerHaptic } = require("../../apps/fieldops/src/mobile-haptic-trigger.native") as
  typeof import("../../apps/fieldops/src/mobile-haptic-trigger.native");

test("uses native impact, notification, and selection without calling the native API for off", async () => {
  await triggerHaptic("medium");
  await triggerHaptic("warning");
  await triggerHaptic("selection");
  await triggerHaptic("off");
  expect(mockImpact).toHaveBeenCalledTimes(1);
  expect(mockImpact).toHaveBeenCalledWith("medium");
  expect(mockNotification).toHaveBeenCalledTimes(1);
  expect(mockNotification).toHaveBeenCalledWith("warning");
  expect(mockSelection).toHaveBeenCalledTimes(1);
});

test("preserves the operation when native feedback rejects", async () => {
  mockImpact.mockRejectedValueOnce(new Error("feedback unavailable"));
  await expect(triggerHaptic("light")).resolves.toBeUndefined();
});
