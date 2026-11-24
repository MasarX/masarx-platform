import type { HapticPattern } from "./haptic-event-policy";

export async function triggerHaptic(pattern: HapticPattern): Promise<void> {
  if (pattern === "off") return;
  try {
    const { ImpactFeedbackStyle, NotificationFeedbackType, impactAsync, notificationAsync, selectionAsync } =
      require("expo-haptics") as typeof import("expo-haptics");
    switch (pattern) {
      case "light":
      case "medium":
      case "heavy":
        await impactAsync({ light: ImpactFeedbackStyle.Light, medium: ImpactFeedbackStyle.Medium, heavy: ImpactFeedbackStyle.Heavy }[pattern]);
        break;
      case "success":
      case "warning":
      case "error":
        await notificationAsync({
          success: NotificationFeedbackType.Success,
          warning: NotificationFeedbackType.Warning,
          error: NotificationFeedbackType.Error,
        }[pattern]);
        break;
      case "selection":
        await selectionAsync();
    }
  } catch {
    // Optional device feedback must never affect the operational action.
  }
}
