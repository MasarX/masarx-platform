// Verify the resolved haptic pattern and driving-lock behavior.

import {
  STATIC_HAPTIC_EVENT,
  normalizeHapticEventPolicy,
  resolveHapticForEvent,
  type HapticEventPolicyValue,
} from "../../apps/fieldops/src/haptic-event-policy";

describe("haptic_event_policy helpers", () => {
  describe("STATIC_HAPTIC_EVENT (mirror of global seed)", () => {
    test("has version 1", () => {
      expect(STATIC_HAPTIC_EVENT.version).toBe(1);
    });
    test("supports all ten configured haptic events", () => {
      expect(Object.keys(STATIC_HAPTIC_EVENT.events).sort()).toEqual([
        "driving_lock.engaged",
        "error",
        "geofence.arrival",
        "outbox.synced",
        "pod.completed",
        "scan.failure",
        "scan.success",
        "selection",
        "swipe.commit",
        "swipe.threshold",
      ]);
    });
    test("scan.success: light + respects driving lock", () => {
      const e = STATIC_HAPTIC_EVENT.events["scan.success"]!;
      expect(e.pattern).toBe("light");
      expect(e.respect_driving_lock).toBe(true);
      expect(e.audio).toBeUndefined();
    });
    test("scan.failure: warning + respects driving lock", () => {
      const e = STATIC_HAPTIC_EVENT.events["scan.failure"]!;
      expect(e.pattern).toBe("warning");
      expect(e.respect_driving_lock).toBe(true);
    });
    test("pod.completed: medium + chime audio + respects driving lock", () => {
      const e = STATIC_HAPTIC_EVENT.events["pod.completed"]!;
      expect(e.pattern).toBe("medium");
      expect(e.audio).toBe("chime");
      expect(e.respect_driving_lock).toBe(true);
    });
    test("outbox.synced: success + respects driving lock", () => {
      const e = STATIC_HAPTIC_EVENT.events["outbox.synced"]!;
      expect(e.pattern).toBe("success");
      expect(e.respect_driving_lock).toBe(true);
    });
    test("driving_lock.engaged: heavy + warning audio + IGNORES driving lock (always fires)", () => {
      const e = STATIC_HAPTIC_EVENT.events["driving_lock.engaged"]!;
      expect(e.pattern).toBe("heavy");
      expect(e.audio).toBe("warning");
      expect(e.respect_driving_lock).toBe(false);
    });
    test("geofence.arrival: medium + respects driving lock", () => {
      const e = STATIC_HAPTIC_EVENT.events["geofence.arrival"]!;
      expect(e.pattern).toBe("medium");
      expect(e.respect_driving_lock).toBe(true);
    });
    test("swipe.threshold + swipe.commit: light/medium + respect driving lock", () => {
      const t = STATIC_HAPTIC_EVENT.events["swipe.threshold"]!;
      expect(t.pattern).toBe("light");
      expect(t.respect_driving_lock).toBe(true);
      const c = STATIC_HAPTIC_EVENT.events["swipe.commit"]!;
      expect(c.pattern).toBe("medium");
      expect(c.respect_driving_lock).toBe(true);
    });
    test("selection: selection pattern + respects driving lock", () => {
      const e = STATIC_HAPTIC_EVENT.events.selection!;
      expect(e.pattern).toBe("selection");
      expect(e.respect_driving_lock).toBe(true);
    });
    test("error: error pattern + IGNORES driving lock (always fires for safety)", () => {
      const e = STATIC_HAPTIC_EVENT.events.error!;
      expect(e.pattern).toBe("error");
      expect(e.respect_driving_lock).toBe(false);
    });
  });

  describe("resolveHapticForEvent (driving lock inactive — default behavior)", () => {
    test("scan.success returns { pattern: 'light' }", () => {
      expect(resolveHapticForEvent(STATIC_HAPTIC_EVENT, "scan.success")).toEqual({
        pattern: "light",
      });
    });
    test("pod.completed returns { pattern: 'medium', audio: 'chime' }", () => {
      expect(resolveHapticForEvent(STATIC_HAPTIC_EVENT, "pod.completed")).toEqual({
        pattern: "medium",
        audio: "chime",
      });
    });
    test("driving_lock.engaged returns { pattern: 'heavy', audio: 'warning' }", () => {
      expect(resolveHapticForEvent(STATIC_HAPTIC_EVENT, "driving_lock.engaged")).toEqual({
        pattern: "heavy",
        audio: "warning",
      });
    });
    test("error returns { pattern: 'error' }", () => {
      expect(resolveHapticForEvent(STATIC_HAPTIC_EVENT, "error")).toEqual({
        pattern: "error",
      });
    });
    test("explicit drivingLockActive=false behaves like inactive", () => {
      expect(resolveHapticForEvent(STATIC_HAPTIC_EVENT, "scan.success", false)).toEqual({
        pattern: "light",
      });
    });
    test("default (no drivingLockActive arg) behaves like inactive", () => {
      expect(resolveHapticForEvent(STATIC_HAPTIC_EVENT, "scan.success")).toEqual({
        pattern: "light",
      });
    });
  });

  describe("resolveHapticForEvent (driving lock active — suppression behavior)", () => {
    test("scan.success is suppressed (respect_driving_lock=true)", () => {
      expect(resolveHapticForEvent(STATIC_HAPTIC_EVENT, "scan.success", true)).toEqual({
        pattern: "off",
      });
    });
    test("pod.completed is suppressed (respect_driving_lock=true) — even with audio", () => {
      expect(resolveHapticForEvent(STATIC_HAPTIC_EVENT, "pod.completed", true)).toEqual({
        pattern: "off",
      });
    });
    test("outbox.synced is suppressed", () => {
      expect(resolveHapticForEvent(STATIC_HAPTIC_EVENT, "outbox.synced", true)).toEqual({
        pattern: "off",
      });
    });
    test("swipe.threshold + swipe.commit + selection + geofence.arrival + scan.failure are all suppressed", () => {
      for (const ev of [
        "swipe.threshold",
        "swipe.commit",
        "selection",
        "geofence.arrival",
        "scan.failure",
      ]) {
        expect(resolveHapticForEvent(STATIC_HAPTIC_EVENT, ev, true)).toEqual({
          pattern: "off",
        });
      }
    });
    test("driving_lock.engaged STILL fires (respect_driving_lock=false) — safety-critical", () => {
      expect(resolveHapticForEvent(STATIC_HAPTIC_EVENT, "driving_lock.engaged", true)).toEqual({
        pattern: "heavy",
        audio: "warning",
      });
    });
    test("error STILL fires (respect_driving_lock=false) — safety-critical", () => {
      expect(resolveHapticForEvent(STATIC_HAPTIC_EVENT, "error", true)).toEqual({
        pattern: "error",
      });
    });
  });

  describe("resolveHapticForEvent (edge cases)", () => {
    test("unknown event name returns { pattern: 'off' }", () => {
      expect(resolveHapticForEvent(STATIC_HAPTIC_EVENT, "nope.does_not_exist")).toEqual({
        pattern: "off",
      });
      expect(resolveHapticForEvent(STATIC_HAPTIC_EVENT, "nope.does_not_exist", true)).toEqual({
        pattern: "off",
      });
    });
    test("empty event name returns { pattern: 'off' }", () => {
      expect(resolveHapticForEvent(STATIC_HAPTIC_EVENT, "")).toEqual({ pattern: "off" });
    });
    test("explicitly configured 'off' pattern is honored when not suppressed", () => {
      const policy: HapticEventPolicyValue = {
        version: 1,
        events: { custom: { pattern: "off", respect_driving_lock: true } },
      };
      expect(resolveHapticForEvent(policy, "custom")).toEqual({ pattern: "off" });
      expect(resolveHapticForEvent(policy, "custom", true)).toEqual({ pattern: "off" });
    });
  });

  describe("normalizeHapticEventPolicy", () => {
    test("returns STATIC_HAPTIC_EVENT for null / undefined / non-object", () => {
      expect(normalizeHapticEventPolicy(null)).toEqual(STATIC_HAPTIC_EVENT);
      expect(normalizeHapticEventPolicy(undefined)).toEqual(STATIC_HAPTIC_EVENT);
      expect(normalizeHapticEventPolicy("string")).toEqual(STATIC_HAPTIC_EVENT);
      expect(normalizeHapticEventPolicy(123)).toEqual(STATIC_HAPTIC_EVENT);
    });
    test("falls back to STATIC seed when events object is empty", () => {
      const result = normalizeHapticEventPolicy({ version: 1, events: {} });
      expect(result.events).toEqual(STATIC_HAPTIC_EVENT.events);
    });
    test("falls back to STATIC seed when events is missing or wrong type", () => {
      expect(normalizeHapticEventPolicy({ version: 1 }).events).toEqual(STATIC_HAPTIC_EVENT.events);
      expect(normalizeHapticEventPolicy({ version: 1, events: "nope" }).events).toEqual(
        STATIC_HAPTIC_EVENT.events,
      );
      expect(normalizeHapticEventPolicy({ version: 1, events: [] }).events).toEqual(
        STATIC_HAPTIC_EVENT.events,
      );
    });
    test("preserves valid events with all required fields", () => {
      const result = normalizeHapticEventPolicy({
        version: 2,
        events: {
          "tenant.custom": { pattern: "heavy", audio: "buzz", respect_driving_lock: false },
        },
      });
      expect(result.version).toBe(2);
      expect(result.events["tenant.custom"]).toEqual({
        pattern: "heavy",
        audio: "buzz",
        respect_driving_lock: false,
      });
    });
    test("drops malformed entries (invalid pattern, missing pattern, garbage)", () => {
      const result = normalizeHapticEventPolicy({
        version: 1,
        events: {
          "ok.one": { pattern: "light", respect_driving_lock: true },
          "bad.pattern": { pattern: "vibrato", respect_driving_lock: true }, // not in enum
          "no.pattern": { respect_driving_lock: true }, // pattern missing
          "garbage.value": "not-an-object",
          "ok.two": { pattern: "selection", respect_driving_lock: false },
        },
      });
      expect(Object.keys(result.events).sort()).toEqual(["ok.one", "ok.two"]);
    });
    test("defaults respect_driving_lock to true when missing or non-boolean", () => {
      const result = normalizeHapticEventPolicy({
        version: 1,
        events: {
          "no.flag": { pattern: "light" },
          "bad.flag": { pattern: "medium", respect_driving_lock: "yes" },
        },
      });
      expect(result.events["no.flag"]!.respect_driving_lock).toBe(true);
      expect(result.events["bad.flag"]!.respect_driving_lock).toBe(true);
    });
    test("drops empty audio strings (falsy) but preserves non-empty audio", () => {
      const result = normalizeHapticEventPolicy({
        version: 1,
        events: {
          "ev.empty": { pattern: "light", audio: "", respect_driving_lock: true },
          "ev.set": { pattern: "medium", audio: "chime", respect_driving_lock: true },
        },
      });
      expect(result.events["ev.empty"]!.audio).toBeUndefined();
      expect(result.events["ev.set"]!.audio).toBe("chime");
    });
    test("uses default version=1 when version field is missing or invalid", () => {
      const result = normalizeHapticEventPolicy({
        events: {
          "ev.x": { pattern: "light", respect_driving_lock: true },
        },
      });
      expect(result.version).toBe(1);
    });
    test("normalized output is fully usable by resolveHapticForEvent", () => {
      const policy = normalizeHapticEventPolicy({
        version: 1,
        events: {
          "tenant.alarm": { pattern: "warning", audio: "siren", respect_driving_lock: false },
          "tenant.tap": { pattern: "light", respect_driving_lock: true },
        },
      });
      // tenant.alarm fires regardless of driving lock
      expect(resolveHapticForEvent(policy, "tenant.alarm", true)).toEqual({
        pattern: "warning",
        audio: "siren",
      });
      // tenant.tap is suppressed when lock is active
      expect(resolveHapticForEvent(policy, "tenant.tap", true)).toEqual({ pattern: "off" });
      expect(resolveHapticForEvent(policy, "tenant.tap", false)).toEqual({ pattern: "light" });
    });
  });
});
