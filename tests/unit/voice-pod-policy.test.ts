import {
  STATIC_VOICE_POD,
  normalizeVoicePodPolicy,
  getWakewords,
  matchWakeword,
  formatReadback,
  meetsMinConfidence,
  type VoicePodPolicyValue,
} from "../../apps/fieldops/src/voice-pod-policy";

const HISTORICAL_VOICE_POD_SEED: VoicePodPolicyValue = {
  version: 1,
  enabled: false,
  wakewords: {
    en: ["mark delivered", "mark complete"],
    ar: ["تم التسليم"],
  },
  speech_recognizer: {
    engine: "platform_native",
    min_confidence: 0.75,
    max_listen_seconds: 8,
    ambient_speech_filter: true,
  },
  confirmation: {
    require_readback: true,
    readback_template_en: "Delivered to ${customer_name} at ${address}. Confirm?",
    readback_template_ar: "تم التسليم إلى ${customer_name} في ${address}. تأكيد؟",
    haptic_pattern_on_accept: "medium",
    cancel_window_seconds: 5,
  },
  respect_driving_lock: false,
  driving_lock_required_stage: "voice",
};

function enabledPolicy(
  overrides: Partial<VoicePodPolicyValue> = {},
): VoicePodPolicyValue {
  return {
    ...HISTORICAL_VOICE_POD_SEED,
    enabled: true,
    wakewords: {
      en: [...HISTORICAL_VOICE_POD_SEED.wakewords.en],
      ar: HISTORICAL_VOICE_POD_SEED.wakewords.ar
        ? [...HISTORICAL_VOICE_POD_SEED.wakewords.ar]
        : undefined,
    },
    speech_recognizer: { ...HISTORICAL_VOICE_POD_SEED.speech_recognizer },
    confirmation: { ...HISTORICAL_VOICE_POD_SEED.confirmation },
    ...overrides,
  };
}

describe("voice_pod_policy helpers", () => {
  describe("STATIC_VOICE_POD (mirror of migration global default seed)", () => {
    test("matches the migration global default seed exactly (enabled=false, full shape)", () => {
      expect(STATIC_VOICE_POD).toEqual(HISTORICAL_VOICE_POD_SEED);
    });

    test("default `enabled` is FALSE (voice POD opt-in per tenant)", () => {
      expect(STATIC_VOICE_POD.enabled).toBe(false);
    });

    test("default en wakewords are exactly ['mark delivered','mark complete']", () => {
      expect(STATIC_VOICE_POD.wakewords.en).toEqual([
        "mark delivered",
        "mark complete",
      ]);
    });

    test("default ar wakewords contain the canonical Arabic 'delivered' phrase", () => {
      expect(STATIC_VOICE_POD.wakewords.ar).toEqual(["تم التسليم"]);
    });

    test("default speech_recognizer is platform_native @ 0.75 / 8s / ambient filter on", () => {
      expect(STATIC_VOICE_POD.speech_recognizer.engine).toBe("platform_native");
      expect(STATIC_VOICE_POD.speech_recognizer.min_confidence).toBe(0.75);
      expect(STATIC_VOICE_POD.speech_recognizer.max_listen_seconds).toBe(8);
      expect(STATIC_VOICE_POD.speech_recognizer.ambient_speech_filter).toBe(true);
    });

    test("default confirmation contract: readback on, 5s cancel window, medium haptic", () => {
      expect(STATIC_VOICE_POD.confirmation.require_readback).toBe(true);
      expect(STATIC_VOICE_POD.confirmation.cancel_window_seconds).toBe(5);
      expect(STATIC_VOICE_POD.confirmation.haptic_pattern_on_accept).toBe("medium");
    });

    test("default driving_lock_required_stage is 'voice' (mirrors stage C)", () => {
      expect(STATIC_VOICE_POD.driving_lock_required_stage).toBe("voice");
    });
  });

  describe("normalizeVoicePodPolicy (defensive parse)", () => {
    test("returns STATIC seed for null / undefined / non-object inputs", () => {
      expect(normalizeVoicePodPolicy(null)).toEqual(HISTORICAL_VOICE_POD_SEED);
      expect(normalizeVoicePodPolicy(undefined)).toEqual(HISTORICAL_VOICE_POD_SEED);
      expect(normalizeVoicePodPolicy("string")).toEqual(HISTORICAL_VOICE_POD_SEED);
      expect(normalizeVoicePodPolicy(42)).toEqual(HISTORICAL_VOICE_POD_SEED);
      expect(normalizeVoicePodPolicy(true)).toEqual(HISTORICAL_VOICE_POD_SEED);
    });

    test("normalized output deep-clones STATIC sub-objects (caller mutation is safe)", () => {
      const out = normalizeVoicePodPolicy(null);
      out.wakewords.en.push("mutated");
      out.confirmation.haptic_pattern_on_accept = "MUTATED";
      out.speech_recognizer.min_confidence = 0.01;
      const fresh = normalizeVoicePodPolicy(null);
      expect(fresh.wakewords.en).toEqual(["mark delivered", "mark complete"]);
      expect(fresh.confirmation.haptic_pattern_on_accept).toBe("medium");
      expect(fresh.speech_recognizer.min_confidence).toBe(0.75);
    });

    test("preserves a fully-valid policy body unchanged", () => {
      const input: VoicePodPolicyValue = {
        version: 1,
        enabled: true,
        wakewords: {
          en: ["complete order", "finish drop"],
          ar: ["انتهيت"],
        },
        speech_recognizer: {
          engine: "platform_native",
          min_confidence: 0.85,
          max_listen_seconds: 12,
          ambient_speech_filter: false,
        },
        confirmation: {
          require_readback: false,
          readback_template_en: "Done at ${address}?",
          readback_template_ar: "تم في ${address}؟",
          haptic_pattern_on_accept: "heavy",
          cancel_window_seconds: 10,
        },
        respect_driving_lock: true,
        driving_lock_required_stage: "stage_c",
      };
      expect(normalizeVoicePodPolicy(input)).toEqual(input);
    });

    test("clamps min_confidence to [0,1] (junk values cannot escape the probability range)", () => {
      const high = normalizeVoicePodPolicy({
        version: 1,
        enabled: true,
        wakewords: { en: ["mark delivered"] },
        speech_recognizer: {
          engine: "platform_native",
          min_confidence: 5.5, // way above 1
          max_listen_seconds: 8,
          ambient_speech_filter: true,
        },
        confirmation: HISTORICAL_VOICE_POD_SEED.confirmation,
        respect_driving_lock: false,
        driving_lock_required_stage: "voice",
      });
      expect(high.speech_recognizer.min_confidence).toBe(1);

      const low = normalizeVoicePodPolicy({
        version: 1,
        enabled: true,
        wakewords: { en: ["mark delivered"] },
        speech_recognizer: {
          engine: "platform_native",
          min_confidence: -2,
          max_listen_seconds: 8,
          ambient_speech_filter: true,
        },
        confirmation: HISTORICAL_VOICE_POD_SEED.confirmation,
        respect_driving_lock: false,
        driving_lock_required_stage: "voice",
      });
      expect(low.speech_recognizer.min_confidence).toBe(0);
    });

    test("clamps max_listen_seconds to [1,60] (no infinite mic, no zero-length listen)", () => {
      const huge = normalizeVoicePodPolicy({
        version: 1,
        enabled: true,
        wakewords: { en: ["mark delivered"] },
        speech_recognizer: {
          engine: "platform_native",
          min_confidence: 0.75,
          max_listen_seconds: 9999,
          ambient_speech_filter: true,
        },
        confirmation: HISTORICAL_VOICE_POD_SEED.confirmation,
        respect_driving_lock: false,
        driving_lock_required_stage: "voice",
      });
      expect(huge.speech_recognizer.max_listen_seconds).toBe(60);

      const zero = normalizeVoicePodPolicy({
        version: 1,
        enabled: true,
        wakewords: { en: ["mark delivered"] },
        speech_recognizer: {
          engine: "platform_native",
          min_confidence: 0.75,
          max_listen_seconds: 0,
          ambient_speech_filter: true,
        },
        confirmation: HISTORICAL_VOICE_POD_SEED.confirmation,
        respect_driving_lock: false,
        driving_lock_required_stage: "voice",
      });
      expect(zero.speech_recognizer.max_listen_seconds).toBe(1);
    });

    test("treats non-boolean `enabled` as disabled (defensive — junk never arms voice POD)", () => {
      const out = normalizeVoicePodPolicy({
        version: 1,
        enabled: "true", // strings must NOT activate voice POD
        wakewords: { en: ["mark delivered"] },
        speech_recognizer: HISTORICAL_VOICE_POD_SEED.speech_recognizer,
        confirmation: HISTORICAL_VOICE_POD_SEED.confirmation,
        respect_driving_lock: false,
        driving_lock_required_stage: "voice",
      });
      expect(out.enabled).toBe(false);
    });

    test("falls back to STATIC en wakewords when an empty array is provided", () => {
      const out = normalizeVoicePodPolicy({
        version: 1,
        enabled: true,
        wakewords: { en: [] },
        speech_recognizer: HISTORICAL_VOICE_POD_SEED.speech_recognizer,
        confirmation: HISTORICAL_VOICE_POD_SEED.confirmation,
        respect_driving_lock: false,
        driving_lock_required_stage: "voice",
      });
      expect(out.wakewords.en).toEqual(["mark delivered", "mark complete"]);
    });

    test("clamps cancel_window_seconds to [0,60]", () => {
      const negative = normalizeVoicePodPolicy({
        version: 1,
        enabled: true,
        wakewords: HISTORICAL_VOICE_POD_SEED.wakewords,
        speech_recognizer: HISTORICAL_VOICE_POD_SEED.speech_recognizer,
        confirmation: {
          ...HISTORICAL_VOICE_POD_SEED.confirmation,
          cancel_window_seconds: -10,
        },
        respect_driving_lock: false,
        driving_lock_required_stage: "voice",
      });
      expect(negative.confirmation.cancel_window_seconds).toBe(0);

      const huge = normalizeVoicePodPolicy({
        version: 1,
        enabled: true,
        wakewords: HISTORICAL_VOICE_POD_SEED.wakewords,
        speech_recognizer: HISTORICAL_VOICE_POD_SEED.speech_recognizer,
        confirmation: {
          ...HISTORICAL_VOICE_POD_SEED.confirmation,
          cancel_window_seconds: 9999,
        },
        respect_driving_lock: false,
        driving_lock_required_stage: "voice",
      });
      expect(huge.confirmation.cancel_window_seconds).toBe(60);
    });
  });

  describe("getWakewords (locale retrieval + en fallback)", () => {
    test("returns the en list verbatim for locale='en'", () => {
      expect(getWakewords(enabledPolicy(), "en")).toEqual([
        "mark delivered",
        "mark complete",
      ]);
    });

    test("returns the ar list when locale='ar' and ar is present", () => {
      expect(getWakewords(enabledPolicy(), "ar")).toEqual(["تم التسليم"]);
    });

    test("falls back to en when ar is missing/empty", () => {
      const noArPolicy = enabledPolicy({
        wakewords: { en: ["mark delivered", "mark complete"] },
      });
      expect(getWakewords(noArPolicy, "ar")).toEqual([
        "mark delivered",
        "mark complete",
      ]);
    });

    test("returns a fresh array each call (caller mutation is safe)", () => {
      const policy = enabledPolicy();
      const out = getWakewords(policy, "en");
      out.push("MUTATED");
      const fresh = getWakewords(policy, "en");
      expect(fresh).toEqual(["mark delivered", "mark complete"]);
    });
  });

  describe("matchWakeword (case-insensitive substring + locale)", () => {
    test("matches the canonical en wakeword exactly", () => {
      expect(matchWakeword(enabledPolicy(), "mark delivered", "en")).toBe(
        "mark delivered",
      );
      expect(matchWakeword(enabledPolicy(), "mark complete", "en")).toBe(
        "mark complete",
      );
    });

    test("matches the canonical en wakeword case-insensitively", () => {
      expect(matchWakeword(enabledPolicy(), "MARK DELIVERED", "en")).toBe(
        "mark delivered",
      );
      expect(matchWakeword(enabledPolicy(), "Mark Complete", "en")).toBe(
        "mark complete",
      );
    });

    test("matches as substring within a longer transcript", () => {
      expect(
        matchWakeword(enabledPolicy(), "okay please mark delivered now", "en"),
      ).toBe("mark delivered");
    });

    test("matches the canonical ar wakeword", () => {
      expect(matchWakeword(enabledPolicy(), "تم التسليم", "ar")).toBe(
        "تم التسليم",
      );
    });

    test("returns null when nothing matches", () => {
      expect(matchWakeword(enabledPolicy(), "cancel order", "en")).toBeNull();
      expect(matchWakeword(enabledPolicy(), "shukran", "ar")).toBeNull();
    });

    test("returns null for empty / non-string transcripts (defensive)", () => {
      expect(matchWakeword(enabledPolicy(), "", "en")).toBeNull();
      expect(matchWakeword(enabledPolicy(), "   ", "en")).toBeNull();
      expect(matchWakeword(enabledPolicy(), null, "en")).toBeNull();
      expect(matchWakeword(enabledPolicy(), 42, "en")).toBeNull();
    });

    test("falls back to en wakewords when ar locale list is missing", () => {
      const noArPolicy = enabledPolicy({
        wakewords: { en: ["mark delivered", "mark complete"] },
      });
      expect(
        matchWakeword(noArPolicy, "please mark delivered", "ar"),
      ).toBe("mark delivered");
    });
  });

  describe("formatReadback (${customer_name} + ${address} substitution)", () => {
    test("substitutes fixture data literally without expanding embedded placeholders", () => {
      expect(
        formatReadback(enabledPolicy(), "en", {
          customer_name: "Test ${address}",
          address: "Test $&",
        }),
      ).toBe("Delivered to Test ${address} at Test $&. Confirm?");
    });

    test("substitutes both vars into the en template", () => {
      expect(
        formatReadback(enabledPolicy(), "en", {
          customer_name: "Test Recipient",
          address: "Example Site",
        }),
      ).toBe("Delivered to Test Recipient at Example Site. Confirm?");
    });

    test("substitutes both vars into the ar template", () => {
      expect(
        formatReadback(enabledPolicy(), "ar", {
          customer_name: "مستلم اختباري",
          address: "موقع اختباري",
        }),
      ).toBe("تم التسليم إلى مستلم اختباري في موقع اختباري. تأكيد؟");
    });

    test("missing customer_name resolves to empty string (no literal ${customer_name})", () => {
      const out = formatReadback(enabledPolicy(), "en", { address: "Test Site" });
      expect(out).toBe("Delivered to  at Test Site. Confirm?");
      expect(out.includes("${customer_name}")).toBe(false);
    });

    test("missing address resolves to empty string (no literal ${address})", () => {
      const out = formatReadback(enabledPolicy(), "en", {
        customer_name: "Example Recipient",
      });
      expect(out).toBe("Delivered to Example Recipient at . Confirm?");
      expect(out.includes("${address}")).toBe(false);
    });

    test("both vars missing resolve to a clean templated string with empty slots", () => {
      const out = formatReadback(enabledPolicy(), "en", {});
      expect(out).toBe("Delivered to  at . Confirm?");
      expect(out.includes("${")).toBe(false);
    });

    test("substitutes multiple occurrences of the same token (defensive global replace)", () => {
      const policy = enabledPolicy({
        confirmation: {
          ...HISTORICAL_VOICE_POD_SEED.confirmation,
          readback_template_en:
            "Hello ${customer_name}, ${customer_name}! Drop at ${address}.",
        },
      });
      expect(
        formatReadback(policy, "en", {
          customer_name: "Sample Recipient",
          address: "Test Site",
        }),
      ).toBe("Hello Sample Recipient, Sample Recipient! Drop at Test Site.");
    });
  });

  describe("meetsMinConfidence (threshold + junk safety)", () => {
    test("returns true when confidence equals min_confidence (boundary inclusive)", () => {
      expect(meetsMinConfidence(enabledPolicy(), 0.75)).toBe(true);
    });

    test("returns true when confidence exceeds min_confidence", () => {
      expect(meetsMinConfidence(enabledPolicy(), 0.99)).toBe(true);
      expect(meetsMinConfidence(enabledPolicy(), 1)).toBe(true);
    });

    test("returns false when confidence is below min_confidence", () => {
      expect(meetsMinConfidence(enabledPolicy(), 0.7499)).toBe(false);
      expect(meetsMinConfidence(enabledPolicy(), 0)).toBe(false);
    });

    test("returns false for non-finite / non-number confidence (defensive)", () => {
      expect(meetsMinConfidence(enabledPolicy(), Number.NaN)).toBe(false);
      expect(meetsMinConfidence(enabledPolicy(), Infinity)).toBe(false);
      expect(meetsMinConfidence(enabledPolicy(), -Infinity)).toBe(false);
      expect(meetsMinConfidence(enabledPolicy(), "0.9")).toBe(false);
      expect(meetsMinConfidence(enabledPolicy(), null)).toBe(false);
    });

    test("honors a tenant override of min_confidence", () => {
      const stricter = enabledPolicy({
        speech_recognizer: {
          ...HISTORICAL_VOICE_POD_SEED.speech_recognizer,
          min_confidence: 0.95,
        },
      });
      expect(meetsMinConfidence(stricter, 0.9)).toBe(false);
      expect(meetsMinConfidence(stricter, 0.95)).toBe(true);
    });
  });
});
