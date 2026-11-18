import {
  DEFAULT_VOICE_CALLOUT_POLICY,
  DEFAULT_VOICE_CATALOG,
  normalizeVoiceCalloutPolicy,
  shouldSpeakNow,
  speakCallout,
  type VoiceCalloutPolicy,
  type VoiceSpeaker,
} from "../../../apps/fieldops/src/mobile-voice-tts";

function utcDate(hour: number): Date {
  const d = new Date(Date.UTC(2026, 3, 21, hour, 0, 0));
  return d;
}

describe("fieldops mobile voice tts", () => {
  describe("normalizeVoiceCalloutPolicy", () => {
    test("falls back to defaults for null input", () => {
      const policy = normalizeVoiceCalloutPolicy(null);
      expect(policy).toEqual(DEFAULT_VOICE_CALLOUT_POLICY);
    });

    test("falls back to defaults for non-object input", () => {
      expect(normalizeVoiceCalloutPolicy("nope")).toEqual(DEFAULT_VOICE_CALLOUT_POLICY);
      expect(normalizeVoiceCalloutPolicy(42)).toEqual(DEFAULT_VOICE_CALLOUT_POLICY);
      expect(normalizeVoiceCalloutPolicy([])).toEqual(DEFAULT_VOICE_CALLOUT_POLICY);
    });

    test("coerces enabled flag from common truthy strings", () => {
      expect(normalizeVoiceCalloutPolicy({ enabled: "true" }).enabled).toBe(true);
      expect(normalizeVoiceCalloutPolicy({ enabled: 1 }).enabled).toBe(true);
      expect(normalizeVoiceCalloutPolicy({ enabled: "no" }).enabled).toBe(false);
    });

    test("clamps rate to [0.5, 1.5]", () => {
      expect(normalizeVoiceCalloutPolicy({ rate: 0.1 }).rate).toBe(0.5);
      expect(normalizeVoiceCalloutPolicy({ rate: 5 }).rate).toBe(1.5);
      expect(normalizeVoiceCalloutPolicy({ rate: 1.25 }).rate).toBe(1.25);
    });

    test("clamps pitch to [0.5, 1.5]", () => {
      expect(normalizeVoiceCalloutPolicy({ pitch: -2 }).pitch).toBe(0.5);
      expect(normalizeVoiceCalloutPolicy({ pitch: 99 }).pitch).toBe(1.5);
    });

    test("clamps volume to [0, 1]", () => {
      expect(normalizeVoiceCalloutPolicy({ volume: -1 }).volume).toBe(0);
      expect(normalizeVoiceCalloutPolicy({ volume: 2 }).volume).toBe(1);
      expect(normalizeVoiceCalloutPolicy({ volume: 0.3 }).volume).toBe(0.3);
    });

    test("accepts valid quiet hours", () => {
      const policy = normalizeVoiceCalloutPolicy({
        quiet_hours_start_utc: 22,
        quiet_hours_end_utc: 6,
      });
      expect(policy.quiet_hours_start_utc).toBe(22);
      expect(policy.quiet_hours_end_utc).toBe(6);
    });

    test("rejects out-of-range quiet hours", () => {
      const policy = normalizeVoiceCalloutPolicy({
        quiet_hours_start_utc: 25,
        quiet_hours_end_utc: -1,
      });
      expect(policy.quiet_hours_start_utc).toBeNull();
      expect(policy.quiet_hours_end_utc).toBeNull();
    });

    test("preserves locale string when provided", () => {
      expect(normalizeVoiceCalloutPolicy({ locale: "ar-SA" }).locale).toBe("ar-SA");
    });

    test("falls back when locale is empty/blank", () => {
      expect(normalizeVoiceCalloutPolicy({ locale: "   " }).locale).toBe(
        DEFAULT_VOICE_CALLOUT_POLICY.locale
      );
    });
  });

  describe("shouldSpeakNow", () => {
    const base: VoiceCalloutPolicy = { ...DEFAULT_VOICE_CALLOUT_POLICY, enabled: true };

    test("returns false when policy disabled", () => {
      expect(shouldSpeakNow({ ...base, enabled: false }, utcDate(12))).toBe(false);
    });

    test("returns true with no quiet hours", () => {
      expect(shouldSpeakNow(base, utcDate(12))).toBe(true);
    });

    test("respects forward quiet window (09 -> 17)", () => {
      const policy: VoiceCalloutPolicy = {
        ...base,
        quiet_hours_start_utc: 9,
        quiet_hours_end_utc: 17,
      };
      expect(shouldSpeakNow(policy, utcDate(8))).toBe(true);
      expect(shouldSpeakNow(policy, utcDate(9))).toBe(false);
      expect(shouldSpeakNow(policy, utcDate(12))).toBe(false);
      expect(shouldSpeakNow(policy, utcDate(17))).toBe(true);
    });

    test("respects wrap-around quiet window (22 -> 6)", () => {
      const policy: VoiceCalloutPolicy = {
        ...base,
        quiet_hours_start_utc: 22,
        quiet_hours_end_utc: 6,
      };
      expect(shouldSpeakNow(policy, utcDate(21))).toBe(true);
      expect(shouldSpeakNow(policy, utcDate(22))).toBe(false);
      expect(shouldSpeakNow(policy, utcDate(2))).toBe(false);
      expect(shouldSpeakNow(policy, utcDate(6))).toBe(true);
    });

    test("ignores incomplete quiet window (only start set)", () => {
      const policy: VoiceCalloutPolicy = { ...base, quiet_hours_start_utc: 20 };
      expect(shouldSpeakNow(policy, utcDate(21))).toBe(true);
    });
  });

  describe("speakCallout", () => {
    function makeSpeaker() {
      const calls: Array<Parameters<VoiceSpeaker>[0]> = [];
      const speaker: VoiceSpeaker = async (utt) => {
        calls.push(utt);
      };
      return { speaker, calls };
    }

    test("skips with reason=disabled when policy off", async () => {
      const { speaker, calls } = makeSpeaker();
      const result = await speakCallout(
        "arrived_at_stop",
        { ...DEFAULT_VOICE_CALLOUT_POLICY, enabled: false },
        speaker,
        { now: utcDate(12) }
      );
      expect(result).toEqual({ spoke: false, skipped_reason: "disabled" });
      expect(calls).toHaveLength(0);
    });

    test("skips with reason=quiet_hours inside the window", async () => {
      const { speaker, calls } = makeSpeaker();
      const result = await speakCallout(
        "arrived_at_stop",
        {
          ...DEFAULT_VOICE_CALLOUT_POLICY,
          enabled: true,
          quiet_hours_start_utc: 22,
          quiet_hours_end_utc: 6,
        },
        speaker,
        { now: utcDate(3) }
      );
      expect(result.spoke).toBe(false);
      expect(result.skipped_reason).toBe("quiet_hours");
      expect(calls).toHaveLength(0);
    });

    test("speaks English callout for en-* locale", async () => {
      const { speaker, calls } = makeSpeaker();
      const result = await speakCallout(
        "arrived_at_stop",
        { ...DEFAULT_VOICE_CALLOUT_POLICY, enabled: true, locale: "en-US" },
        speaker,
        { now: utcDate(12) }
      );
      expect(result).toEqual({ spoke: true });
      expect(calls).toHaveLength(1);
      expect(calls[0]?.text).toBe(DEFAULT_VOICE_CATALOG.arrived_at_stop.en);
      expect(calls[0]?.locale).toBe("en-US");
    });

    test("speaks Arabic callout for ar-* locale", async () => {
      const { speaker, calls } = makeSpeaker();
      const result = await speakCallout(
        "delivery_completed",
        { ...DEFAULT_VOICE_CALLOUT_POLICY, enabled: true, locale: "ar-SA" },
        speaker,
        { now: utcDate(12) }
      );
      expect(result.spoke).toBe(true);
      expect(calls[0]?.text).toBe(DEFAULT_VOICE_CATALOG.delivery_completed.ar);
    });

    test("explicit locale override wins over policy.locale", async () => {
      const { speaker, calls } = makeSpeaker();
      await speakCallout(
        "connection_lost",
        { ...DEFAULT_VOICE_CALLOUT_POLICY, enabled: true, locale: "en-US" },
        speaker,
        { now: utcDate(12), locale: "ar" }
      );
      expect(calls[0]?.text).toBe(DEFAULT_VOICE_CATALOG.connection_lost.ar);
    });

    test("forwards rate/pitch/volume from policy", async () => {
      const { speaker, calls } = makeSpeaker();
      await speakCallout(
        "driving_lock_active",
        {
          ...DEFAULT_VOICE_CALLOUT_POLICY,
          enabled: true,
          rate: 1.2,
          pitch: 0.9,
          volume: 0.75,
          locale: "en-US",
        },
        speaker,
        { now: utcDate(12) }
      );
      expect(calls[0]?.rate).toBe(1.2);
      expect(calls[0]?.pitch).toBe(0.9);
      expect(calls[0]?.volume).toBe(0.75);
    });

    test("uses injected catalog when provided", async () => {
      const { speaker, calls } = makeSpeaker();
      const catalog = {
        ...DEFAULT_VOICE_CATALOG,
        stop_approaching: { en: "Custom EN", ar: "Custom AR" },
      };
      await speakCallout(
        "stop_approaching",
        { ...DEFAULT_VOICE_CALLOUT_POLICY, enabled: true, locale: "en-US" },
        speaker,
        { now: utcDate(12), catalog }
      );
      expect(calls[0]?.text).toBe("Custom EN");
    });

    test("catalog covers all voice callout keys in both locales", () => {
      const keys: Array<keyof typeof DEFAULT_VOICE_CATALOG> = [
        "stop_approaching",
        "arrived_at_stop",
        "delivery_completed",
        "connection_lost",
        "connection_restored",
        "driving_lock_active",
      ];
      for (const key of keys) {
        expect(typeof DEFAULT_VOICE_CATALOG[key].en).toBe("string");
        expect(DEFAULT_VOICE_CATALOG[key].en.length).toBeGreaterThan(0);
        expect(typeof DEFAULT_VOICE_CATALOG[key].ar).toBe("string");
        expect(DEFAULT_VOICE_CATALOG[key].ar.length).toBeGreaterThan(0);
      }
    });
  });
});
