import {
  STATIC_VISION_POD,
  normalizeVisionPodPolicy,
  evaluateClassification,
  buildModelAssetUri,
  shouldFallbackToManual,
  type VisionPodPolicyValue,
  type ClassificationResult,
} from "../../apps/fieldops/src/vision-pod-policy";

const HISTORICAL_VISION_POD_SEED: VisionPodPolicyValue = {
  version: 1,
  enabled: false,
  model: {
    name: "yolov26-n",
    version: "1.0.0",
    size_mb: 8,
    asset_uri_pattern: "${cdn_base}/vision/yolov26-n-${version}.tflite",
  },
  quality_gates: {
    min_confidence: 0.65,
    require_package_in_frame: true,
    require_label_legible: false,
    require_addressee_visible: false,
    min_frame_brightness: 0.15,
    max_motion_blur: 0.30,
  },
  user_messaging: {
    package_missing_en: "Move closer so the package fills the frame",
    package_missing_ar: "اقترب أكثر حتى تملأ الطرد الإطار",
    label_unreadable_en: "Try again with better lighting on the label",
    label_unreadable_ar: "حاول مرة أخرى مع إضاءة أفضل للملصق",
    low_brightness_en: "Find a brighter spot",
    low_brightness_ar: "ابحث عن مكان أكثر إضاءة",
    motion_blur_en: "Hold still and try again",
    motion_blur_ar: "اثبت في مكانك وحاول مرة أخرى",
  },
  fallback_to_manual_after_attempts: 3,
};

function enabledPolicy(
  overrides: Partial<VisionPodPolicyValue> = {},
): VisionPodPolicyValue {
  return {
    ...HISTORICAL_VISION_POD_SEED,
    enabled: true,
    model: { ...HISTORICAL_VISION_POD_SEED.model },
    quality_gates: { ...HISTORICAL_VISION_POD_SEED.quality_gates },
    user_messaging: { ...HISTORICAL_VISION_POD_SEED.user_messaging },
    ...overrides,
  };
}

function perfectClassification(
  overrides: Partial<ClassificationResult> = {},
): ClassificationResult {
  return {
    confidence: 0.95,
    has_package: true,
    label_legible: true,
    addressee_visible: true,
    brightness: 0.80,
    motion_blur: 0.05,
    ...overrides,
  };
}

describe("vision_pod_policy helpers", () => {
  describe("STATIC_VISION_POD (mirror of migration global default seed)", () => {
    test("matches the migration global default seed exactly (enabled=false, full shape)", () => {
      expect(STATIC_VISION_POD).toEqual(HISTORICAL_VISION_POD_SEED);
    });

    test("default `enabled` is FALSE (vision POD opt-in per tenant — model not yet bundled)", () => {
      expect(STATIC_VISION_POD.enabled).toBe(false);
    });

    test("default model is YOLOv26-N v1.0.0 / 8 MB / templated asset URI", () => {
      expect(STATIC_VISION_POD.model.name).toBe("yolov26-n");
      expect(STATIC_VISION_POD.model.version).toBe("1.0.0");
      expect(STATIC_VISION_POD.model.size_mb).toBe(8);
      expect(STATIC_VISION_POD.model.asset_uri_pattern).toBe(
        "${cdn_base}/vision/yolov26-n-${version}.tflite",
      );
    });

    test("default quality gates carry the documented thresholds", () => {
      expect(STATIC_VISION_POD.quality_gates.min_confidence).toBe(0.65);
      expect(STATIC_VISION_POD.quality_gates.require_package_in_frame).toBe(true);
      expect(STATIC_VISION_POD.quality_gates.require_label_legible).toBe(false);
      expect(STATIC_VISION_POD.quality_gates.require_addressee_visible).toBe(false);
      expect(STATIC_VISION_POD.quality_gates.min_frame_brightness).toBe(0.15);
      expect(STATIC_VISION_POD.quality_gates.max_motion_blur).toBe(0.30);
    });

    test("default user_messaging carries paired EN/AR strings for all four gates", () => {
      expect(STATIC_VISION_POD.user_messaging.package_missing_en.length).toBeGreaterThan(0);
      expect(STATIC_VISION_POD.user_messaging.package_missing_ar.length).toBeGreaterThan(0);
      expect(STATIC_VISION_POD.user_messaging.label_unreadable_en.length).toBeGreaterThan(0);
      expect(STATIC_VISION_POD.user_messaging.label_unreadable_ar.length).toBeGreaterThan(0);
      expect(STATIC_VISION_POD.user_messaging.low_brightness_en.length).toBeGreaterThan(0);
      expect(STATIC_VISION_POD.user_messaging.low_brightness_ar.length).toBeGreaterThan(0);
      expect(STATIC_VISION_POD.user_messaging.motion_blur_en.length).toBeGreaterThan(0);
      expect(STATIC_VISION_POD.user_messaging.motion_blur_ar.length).toBeGreaterThan(0);
    });

    test("default fallback_to_manual_after_attempts is 3", () => {
      expect(STATIC_VISION_POD.fallback_to_manual_after_attempts).toBe(3);
    });
  });

  describe("normalizeVisionPodPolicy (defensive parse)", () => {
    test("returns STATIC seed for null / undefined / non-object inputs", () => {
      expect(normalizeVisionPodPolicy(null)).toEqual(HISTORICAL_VISION_POD_SEED);
      expect(normalizeVisionPodPolicy(undefined)).toEqual(HISTORICAL_VISION_POD_SEED);
      expect(normalizeVisionPodPolicy("string")).toEqual(HISTORICAL_VISION_POD_SEED);
      expect(normalizeVisionPodPolicy(42)).toEqual(HISTORICAL_VISION_POD_SEED);
      expect(normalizeVisionPodPolicy(true)).toEqual(HISTORICAL_VISION_POD_SEED);
    });

    test("normalized output deep-clones STATIC sub-objects (caller mutation is safe)", () => {
      const out = normalizeVisionPodPolicy(null);
      out.model.name = "tampered";
      out.quality_gates.min_confidence = 0.99;
      out.user_messaging.package_missing_en = "tampered";
      const fresh = normalizeVisionPodPolicy(null);
      expect(fresh.model.name).toBe("yolov26-n");
      expect(fresh.quality_gates.min_confidence).toBe(0.65);
      expect(fresh.user_messaging.package_missing_en).toBe(
        "Move closer so the package fills the frame",
      );
    });

    test("preserves a fully-valid policy body unchanged", () => {
      const input: VisionPodPolicyValue = {
        version: 1,
        enabled: true,
        model: {
          name: "yolov26-n",
          version: "1.1.0",
          size_mb: 12,
          asset_uri_pattern: "${cdn_base}/v/${version}/m.tflite",
        },
        quality_gates: {
          min_confidence: 0.80,
          require_package_in_frame: true,
          require_label_legible: true,
          require_addressee_visible: true,
          min_frame_brightness: 0.25,
          max_motion_blur: 0.20,
        },
        user_messaging: {
          package_missing_en: "A", package_missing_ar: "B",
          label_unreadable_en: "C", label_unreadable_ar: "D",
          low_brightness_en: "E", low_brightness_ar: "F",
          motion_blur_en: "G", motion_blur_ar: "H",
        },
        fallback_to_manual_after_attempts: 5,
      };
      expect(normalizeVisionPodPolicy(input)).toEqual(input);
    });

    test("clamps min_confidence / min_frame_brightness / max_motion_blur into [0,1]", () => {
      const out = normalizeVisionPodPolicy({
        ...HISTORICAL_VISION_POD_SEED,
        enabled: true,
        quality_gates: {
          min_confidence: 1.5,         // clamps to 1
          require_package_in_frame: true,
          require_label_legible: false,
          require_addressee_visible: false,
          min_frame_brightness: -0.2,  // clamps to 0
          max_motion_blur: 2.0,        // clamps to 1
        },
      });
      expect(out.quality_gates.min_confidence).toBe(1);
      expect(out.quality_gates.min_frame_brightness).toBe(0);
      expect(out.quality_gates.max_motion_blur).toBe(1);
    });

    test("clamps fallback_to_manual_after_attempts into [1,10]", () => {
      const low = normalizeVisionPodPolicy({
        ...HISTORICAL_VISION_POD_SEED,
        fallback_to_manual_after_attempts: 0,
      });
      const high = normalizeVisionPodPolicy({
        ...HISTORICAL_VISION_POD_SEED,
        fallback_to_manual_after_attempts: 999,
      });
      expect(low.fallback_to_manual_after_attempts).toBe(1);
      expect(high.fallback_to_manual_after_attempts).toBe(10);
    });

    test("treats non-boolean `enabled` as disabled (defensive)", () => {
      const out = normalizeVisionPodPolicy({
        ...HISTORICAL_VISION_POD_SEED,
        enabled: "true", // strings must NOT activate vision POD
      });
      expect(out.enabled).toBe(false);
    });

    test("falls back to static model.size_mb when raw input is malformed (NaN, negative)", () => {
      const out = normalizeVisionPodPolicy({
        ...HISTORICAL_VISION_POD_SEED,
        model: {
          ...HISTORICAL_VISION_POD_SEED.model,
          size_mb: -5,
        },
      });
      expect(out.model.size_mb).toBe(1); // clamped to floor of 1
    });
  });

  describe("evaluateClassification (gate evaluator)", () => {
    test("returns passed=true with no failures and null userMessage when policy.enabled is false (no-op fallback)", () => {
      const result = evaluateClassification(
        STATIC_VISION_POD,
        perfectClassification({ has_package: false, brightness: 0 }),
        "en",
      );
      expect(result.passed).toBe(true);
      expect(result.failures).toEqual([]);
      expect(result.userMessage).toBeNull();
    });

    test("returns passed=true with no failures when every enabled gate passes", () => {
      const result = evaluateClassification(enabledPolicy(), perfectClassification(), "en");
      expect(result.passed).toBe(true);
      expect(result.failures).toEqual([]);
      expect(result.userMessage).toBeNull();
    });

    test("flags package_missing when require_package_in_frame is true and has_package is false", () => {
      const result = evaluateClassification(
        enabledPolicy(),
        perfectClassification({ has_package: false }),
        "en",
      );
      expect(result.passed).toBe(false);
      expect(result.failures).toContain("package_missing");
      expect(result.userMessage).toBe("Move closer so the package fills the frame");
    });

    test("does NOT flag package_missing when require_package_in_frame is false (gate disabled)", () => {
      const policy = enabledPolicy({
        quality_gates: {
          ...HISTORICAL_VISION_POD_SEED.quality_gates,
          require_package_in_frame: false,
        },
      });
      const result = evaluateClassification(
        policy,
        perfectClassification({ has_package: false }),
        "en",
      );
      expect(result.passed).toBe(true);
      expect(result.failures).toEqual([]);
    });

    test("flags low_brightness when brightness < min_frame_brightness", () => {
      const result = evaluateClassification(
        enabledPolicy(),
        perfectClassification({ brightness: 0.10 }), // below 0.15
        "en",
      );
      expect(result.failures).toContain("low_brightness");
      expect(result.userMessage).toBe("Find a brighter spot");
    });

    test("flags motion_blur when motion_blur > max_motion_blur", () => {
      const result = evaluateClassification(
        enabledPolicy(),
        perfectClassification({ motion_blur: 0.50 }), // above 0.30
        "en",
      );
      expect(result.failures).toContain("motion_blur");
      expect(result.userMessage).toBe("Hold still and try again");
    });

    test("flags low_confidence when confidence < min_confidence", () => {
      const result = evaluateClassification(
        enabledPolicy(),
        perfectClassification({ confidence: 0.50 }), // below 0.65
        "en",
      );
      expect(result.failures).toContain("low_confidence");
    });

    test("flags label_unreadable only when require_label_legible is enabled", () => {
      const policy = enabledPolicy({
        quality_gates: {
          ...HISTORICAL_VISION_POD_SEED.quality_gates,
          require_label_legible: true,
        },
      });
      const result = evaluateClassification(
        policy,
        perfectClassification({ label_legible: false }),
        "en",
      );
      expect(result.failures).toContain("label_unreadable");
      expect(result.userMessage).toBe("Try again with better lighting on the label");
    });

    test("flags addressee_missing only when require_addressee_visible is enabled", () => {
      const policy = enabledPolicy({
        quality_gates: {
          ...HISTORICAL_VISION_POD_SEED.quality_gates,
          require_addressee_visible: true,
        },
      });
      const result = evaluateClassification(
        policy,
        perfectClassification({ addressee_visible: false }),
        "en",
      );
      expect(result.failures).toContain("addressee_missing");
    });

    test("first-failure-wins ordering: brightness fails before package", () => {
      const result = evaluateClassification(
        enabledPolicy(),
        perfectClassification({ brightness: 0.05, has_package: false }),
        "en",
      );
      expect(result.failures[0]).toBe("low_brightness");
      expect(result.userMessage).toBe("Find a brighter spot");
      expect(result.failures).toContain("package_missing");
    });

    test("returns the AR user-facing message when locale === 'ar' (locale-aware MENA UX)", () => {
      const result = evaluateClassification(
        enabledPolicy(),
        perfectClassification({ has_package: false }),
        "ar",
      );
      expect(result.userMessage).toBe("اقترب أكثر حتى تملأ الطرد الإطار");
    });

    test("returns null userMessage when nothing fails (passed=true)", () => {
      const result = evaluateClassification(enabledPolicy(), perfectClassification(), "ar");
      expect(result.userMessage).toBeNull();
    });

    test("treats null/garbage classification as low_confidence (defensive — never silently passes)", () => {
      const result = evaluateClassification(
        enabledPolicy(),
        null as unknown as ClassificationResult,
        "en",
      );
      expect(result.passed).toBe(false);
      expect(result.failures).toEqual(["low_confidence"]);
      expect(result.userMessage).toBe("Move closer so the package fills the frame");
    });
  });

  describe("buildModelAssetUri (placeholder substitution)", () => {
    test("substitutes ${cdn_base} and ${version} into the default pattern", () => {
      const uri = buildModelAssetUri(STATIC_VISION_POD, "https://cdn.example.com");
      expect(uri).toBe("https://cdn.example.com/vision/yolov26-n-1.0.0.tflite");
    });

    test("normalizes trailing slashes on cdnBase (no double-slash in joined URI)", () => {
      const uri = buildModelAssetUri(STATIC_VISION_POD, "https://cdn.example.com///");
      expect(uri).toBe("https://cdn.example.com/vision/yolov26-n-1.0.0.tflite");
    });

    test("substitutes per-tenant version override (tenant pinned on a different model build)", () => {
      const tenantPolicy: VisionPodPolicyValue = {
        ...HISTORICAL_VISION_POD_SEED,
        model: { ...HISTORICAL_VISION_POD_SEED.model, version: "1.2.3" },
      };
      const uri = buildModelAssetUri(tenantPolicy, "https://cdn.example.invalid");
      expect(uri).toBe("https://cdn.example.invalid/vision/yolov26-n-1.2.3.tflite");
    });

    test("returns the policy's pattern unchanged when no placeholders are present", () => {
      const policy: VisionPodPolicyValue = {
        ...HISTORICAL_VISION_POD_SEED,
        model: {
          ...HISTORICAL_VISION_POD_SEED.model,
          asset_uri_pattern: "https://static.example.com/fixed.tflite",
        },
      };
      expect(buildModelAssetUri(policy, "https://ignored.example.com")).toBe(
        "https://static.example.com/fixed.tflite",
      );
    });

    test("treats non-string cdnBase as empty (defensive — pattern still substitutes ${version})", () => {
      const uri = buildModelAssetUri(
        STATIC_VISION_POD,
        undefined as unknown as string,
      );
      expect(uri).toBe("/vision/yolov26-n-1.0.0.tflite");
    });
  });

  describe("shouldFallbackToManual (manual escape hatch)", () => {
    test("returns false when policy.enabled is false (the gate never blocks; nothing to fall back from)", () => {
      expect(shouldFallbackToManual(STATIC_VISION_POD, 99)).toBe(false);
    });

    test("returns false below the threshold (default threshold is 3)", () => {
      const policy = enabledPolicy();
      expect(shouldFallbackToManual(policy, 0)).toBe(false);
      expect(shouldFallbackToManual(policy, 1)).toBe(false);
      expect(shouldFallbackToManual(policy, 2)).toBe(false);
    });

    test("returns true at and above the threshold (>= comparison, 3 = first manual fallback)", () => {
      const policy = enabledPolicy();
      expect(shouldFallbackToManual(policy, 3)).toBe(true);
      expect(shouldFallbackToManual(policy, 4)).toBe(true);
      expect(shouldFallbackToManual(policy, 100)).toBe(true);
    });

    test("honors per-tenant override of fallback_to_manual_after_attempts", () => {
      const tightPolicy = enabledPolicy({ fallback_to_manual_after_attempts: 1 });
      const looseyPolicy = enabledPolicy({ fallback_to_manual_after_attempts: 5 });
      expect(shouldFallbackToManual(tightPolicy, 1)).toBe(true);
      expect(shouldFallbackToManual(looseyPolicy, 4)).toBe(false);
      expect(shouldFallbackToManual(looseyPolicy, 5)).toBe(true);
    });

    test("coerces negative / non-finite attempt counts to 0 (never falls back from junk input)", () => {
      const policy = enabledPolicy();
      expect(shouldFallbackToManual(policy, -5)).toBe(false);
      expect(shouldFallbackToManual(policy, Number.NaN)).toBe(false);
      expect(shouldFallbackToManual(policy, Infinity)).toBe(false);
    });
  });
});
