import { resolveHapticForEvent, type HapticEventPolicyValue } from "./haptic-event-policy";
import { triggerHaptic } from "./mobile-haptic-trigger";

export function emitSensoryFeedback(event: string, state: {
  haptics: HapticEventPolicyValue | null;
  drivingLocked: boolean;
}): void {
  if (state.haptics) {
    const haptic = resolveHapticForEvent(state.haptics, event, state.drivingLocked);
    void triggerHaptic(haptic.pattern);
  }
}
