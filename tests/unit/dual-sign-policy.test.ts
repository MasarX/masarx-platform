import {
  STATIC_DUAL_SIGN,
  normalizeDualSignPolicy,
  requiresDualSign,
  validateSignature,
  nextStateAfter,
  type DualSignPolicyValue,
  type DualSignState,
} from "../../apps/fieldops/src/dual-sign-policy";

const HISTORICAL_DUAL_SIGN_SEED: DualSignPolicyValue = {
  version: 1,
  enabled: false,
  required_for_categories: ["pharma", "high_value", "controlled_goods"],
  signing_order: "driver_first",
  driver_signature: {
    label_en: "Driver signature",
    label_ar: "توقيع السائق",
    min_strokes: 3,
    min_duration_ms: 500,
  },
  customer_signature: {
    label_en: "Customer signature",
    label_ar: "توقيع العميل",
    min_strokes: 3,
    min_duration_ms: 500,
    captured_on_driver_device: true,
  },
  auto_advance_after_first_signed: true,
  show_witness_pill: true,
};

function enabledPolicy(
  overrides: Partial<DualSignPolicyValue> = {},
): DualSignPolicyValue {
  return {
    ...HISTORICAL_DUAL_SIGN_SEED,
    enabled: true,
    required_for_categories: [...HISTORICAL_DUAL_SIGN_SEED.required_for_categories],
    driver_signature: { ...HISTORICAL_DUAL_SIGN_SEED.driver_signature },
    customer_signature: { ...HISTORICAL_DUAL_SIGN_SEED.customer_signature },
    ...overrides,
  };
}

describe("dual_sign_policy helpers", () => {
  describe("STATIC_DUAL_SIGN (mirror of migration global default seed)", () => {
    test("matches the migration global default seed exactly (enabled=false, full shape)", () => {
      expect(STATIC_DUAL_SIGN).toEqual(HISTORICAL_DUAL_SIGN_SEED);
    });

    test("default `enabled` is FALSE (dual-sign opt-in per tenant per regulated-goods workload)", () => {
      expect(STATIC_DUAL_SIGN.enabled).toBe(false);
    });

    test("defaults to the three configured delivery categories", () => {
      expect(STATIC_DUAL_SIGN.required_for_categories).toEqual([
        "pharma",
        "high_value",
        "controlled_goods",
      ]);
    });

    test("defaults to the driver signing first", () => {
      expect(STATIC_DUAL_SIGN.signing_order).toBe("driver_first");
    });

    test("default customer_signature.captured_on_driver_device is true", () => {
      expect(STATIC_DUAL_SIGN.customer_signature.captured_on_driver_device).toBe(true);
    });
  });

  describe("normalizeDualSignPolicy (defensive parse)", () => {
    test("returns STATIC seed for null / undefined / non-object inputs", () => {
      expect(normalizeDualSignPolicy(null)).toEqual(HISTORICAL_DUAL_SIGN_SEED);
      expect(normalizeDualSignPolicy(undefined)).toEqual(HISTORICAL_DUAL_SIGN_SEED);
      expect(normalizeDualSignPolicy("string")).toEqual(HISTORICAL_DUAL_SIGN_SEED);
      expect(normalizeDualSignPolicy(42)).toEqual(HISTORICAL_DUAL_SIGN_SEED);
      expect(normalizeDualSignPolicy(true)).toEqual(HISTORICAL_DUAL_SIGN_SEED);
    });

    test("normalized output deep-clones STATIC sub-objects (caller mutation is safe)", () => {
      const out = normalizeDualSignPolicy(null);
      out.required_for_categories.push("EXTRA");
      out.driver_signature.min_strokes = 999;
      out.customer_signature.label_en = "MUTATED";
      const fresh = normalizeDualSignPolicy(null);
      expect(fresh.required_for_categories).toEqual([
        "pharma",
        "high_value",
        "controlled_goods",
      ]);
      expect(fresh.driver_signature.min_strokes).toBe(3);
      expect(fresh.customer_signature.label_en).toBe("Customer signature");
    });

    test("preserves a fully-valid policy body unchanged", () => {
      const input: DualSignPolicyValue = {
        version: 1,
        enabled: true,
        required_for_categories: ["pharma", "narcotics"],
        signing_order: "customer_first",
        driver_signature: {
          label_en: "Courier sign",
          label_ar: "توقيع المندوب",
          min_strokes: 5,
          min_duration_ms: 800,
        },
        customer_signature: {
          label_en: "Recipient sign",
          label_ar: "توقيع المستلم",
          min_strokes: 4,
          min_duration_ms: 700,
          captured_on_driver_device: false,
        },
        auto_advance_after_first_signed: false,
        show_witness_pill: false,
      };
      expect(normalizeDualSignPolicy(input)).toEqual(input);
    });

    test("treats non-boolean `enabled` as disabled (defensive — strings must NOT activate dual-sign)", () => {
      const out = normalizeDualSignPolicy({
        version: 1,
        enabled: "true",
        required_for_categories: ["pharma"],
        signing_order: "driver_first",
        driver_signature: STATIC_DUAL_SIGN.driver_signature,
        customer_signature: STATIC_DUAL_SIGN.customer_signature,
        auto_advance_after_first_signed: true,
        show_witness_pill: true,
      });
      expect(out.enabled).toBe(false);
    });

    test("rejects unknown signing_order values and falls back to `driver_first`", () => {
      const out = normalizeDualSignPolicy({
        version: 1,
        enabled: true,
        required_for_categories: ["pharma"],
        signing_order: "both_at_once",
        driver_signature: STATIC_DUAL_SIGN.driver_signature,
        customer_signature: STATIC_DUAL_SIGN.customer_signature,
        auto_advance_after_first_signed: true,
        show_witness_pill: true,
      });
      expect(out.signing_order).toBe("driver_first");
    });

    test("dedupes + drops non-string entries from required_for_categories", () => {
      const out = normalizeDualSignPolicy({
        version: 1,
        enabled: true,
        required_for_categories: [
          "pharma",
          "pharma", // duplicate
          42, // non-string
          "  high_value  ", // trims
          null,
          "",
          "controlled_goods",
        ],
        signing_order: "driver_first",
        driver_signature: STATIC_DUAL_SIGN.driver_signature,
        customer_signature: STATIC_DUAL_SIGN.customer_signature,
        auto_advance_after_first_signed: true,
        show_witness_pill: true,
      });
      expect(out.required_for_categories).toEqual([
        "pharma",
        "high_value",
        "controlled_goods",
      ]);
    });

    test("clamps negative thresholds to 0 (a malformed row must never under-count)", () => {
      const out = normalizeDualSignPolicy({
        version: 1,
        enabled: true,
        required_for_categories: ["pharma"],
        signing_order: "driver_first",
        driver_signature: {
          label_en: "Driver",
          label_ar: "س",
          min_strokes: -10,
          min_duration_ms: -500,
        },
        customer_signature: {
          label_en: "Customer",
          label_ar: "ع",
          min_strokes: -5,
          min_duration_ms: -100,
          captured_on_driver_device: true,
        },
        auto_advance_after_first_signed: true,
        show_witness_pill: true,
      });
      expect(out.driver_signature.min_strokes).toBe(0);
      expect(out.driver_signature.min_duration_ms).toBe(0);
      expect(out.customer_signature.min_strokes).toBe(0);
      expect(out.customer_signature.min_duration_ms).toBe(0);
    });
  });

  describe("requiresDualSign (category-membership + disabled + defensive)", () => {
    test("returns false when policy.enabled is false (regardless of category)", () => {
      expect(requiresDualSign(STATIC_DUAL_SIGN, "pharma")).toBe(false);
      expect(requiresDualSign(STATIC_DUAL_SIGN, "high_value")).toBe(false);
      expect(requiresDualSign(STATIC_DUAL_SIGN, "controlled_goods")).toBe(false);
    });

    test("returns true when enabled AND category matches the required set", () => {
      const policy = enabledPolicy();
      expect(requiresDualSign(policy, "pharma")).toBe(true);
      expect(requiresDualSign(policy, "high_value")).toBe(true);
      expect(requiresDualSign(policy, "controlled_goods")).toBe(true);
    });

    test("returns false when enabled but category is not in the required set", () => {
      const policy = enabledPolicy();
      expect(requiresDualSign(policy, "groceries")).toBe(false);
      expect(requiresDualSign(policy, "documents")).toBe(false);
      expect(requiresDualSign(policy, "general")).toBe(false);
    });

    test("category comparison is exact + case-sensitive (no case-folding)", () => {
      const policy = enabledPolicy();
      expect(requiresDualSign(policy, "PHARMA")).toBe(false);
      expect(requiresDualSign(policy, "Pharma")).toBe(false);
      expect(requiresDualSign(policy, "pharma")).toBe(true);
    });

    test("trims whitespace before comparison (resolver rows can have stray spaces)", () => {
      const policy = enabledPolicy();
      expect(requiresDualSign(policy, "  pharma  ")).toBe(true);
      expect(requiresDualSign(policy, "\tpharma\n")).toBe(true);
    });

    test("returns false defensively for null/undefined/empty/non-string category", () => {
      const policy = enabledPolicy();
      expect(requiresDualSign(policy, "")).toBe(false);
      expect(requiresDualSign(policy, "   ")).toBe(false);
      expect(requiresDualSign(policy, null)).toBe(false);
      expect(requiresDualSign(policy, undefined)).toBe(false);
      expect(requiresDualSign(policy, 42)).toBe(false);
    });

    test("honors per-tenant override of required_for_categories", () => {
      const tenantPolicy = enabledPolicy({
        required_for_categories: ["narcotics", "controlled_substances"],
      });
      expect(requiresDualSign(tenantPolicy, "narcotics")).toBe(true);
      expect(requiresDualSign(tenantPolicy, "controlled_substances")).toBe(true);
      expect(requiresDualSign(tenantPolicy, "pharma")).toBe(false);
      expect(requiresDualSign(tenantPolicy, "high_value")).toBe(false);
    });
  });

  describe("validateSignature (per-role thresholds)", () => {
    const policy = enabledPolicy(); // 3 strokes / 500ms for both roles by default

    test("returns valid when both strokes and duration meet the driver threshold", () => {
      expect(validateSignature(policy, "driver", 3, 500)).toEqual({ valid: true });
      expect(validateSignature(policy, "driver", 10, 1500)).toEqual({ valid: true });
    });

    test("returns valid when both strokes and duration meet the customer threshold", () => {
      expect(validateSignature(policy, "customer", 3, 500)).toEqual({ valid: true });
      expect(validateSignature(policy, "customer", 5, 750)).toEqual({ valid: true });
    });

    test("returns below_min_strokes when strokes < threshold", () => {
      expect(validateSignature(policy, "driver", 2, 1000)).toEqual({
        valid: false,
        reason: "below_min_strokes",
      });
      expect(validateSignature(policy, "customer", 0, 1000)).toEqual({
        valid: false,
        reason: "below_min_strokes",
      });
    });

    test("returns below_min_duration when durationMs < threshold (and strokes are sufficient)", () => {
      expect(validateSignature(policy, "driver", 5, 499)).toEqual({
        valid: false,
        reason: "below_min_duration",
      });
      expect(validateSignature(policy, "customer", 5, 0)).toEqual({
        valid: false,
        reason: "below_min_duration",
      });
    });

    test("returns invalid_input for non-finite or negative numeric inputs", () => {
      expect(validateSignature(policy, "driver", -1, 500)).toEqual({
        valid: false,
        reason: "invalid_input",
      });
      expect(validateSignature(policy, "driver", 5, -100)).toEqual({
        valid: false,
        reason: "invalid_input",
      });
      expect(validateSignature(policy, "driver", Number.NaN, 500)).toEqual({
        valid: false,
        reason: "invalid_input",
      });
      expect(validateSignature(policy, "driver", 5, Infinity)).toEqual({
        valid: false,
        reason: "invalid_input",
      });
    });

    test("driver and customer thresholds are independent (per-role config)", () => {
      const asymmetric = enabledPolicy({
        driver_signature: {
          label_en: "Driver",
          label_ar: "س",
          min_strokes: 1,
          min_duration_ms: 100,
        },
        customer_signature: {
          label_en: "Customer",
          label_ar: "ع",
          min_strokes: 10,
          min_duration_ms: 2000,
          captured_on_driver_device: true,
        },
      });
      expect(validateSignature(asymmetric, "driver", 5, 500)).toEqual({ valid: true });
      expect(validateSignature(asymmetric, "customer", 5, 500)).toEqual({
        valid: false,
        reason: "below_min_strokes",
      });
    });

    test("treats fractional strokes/durations as truncated integers", () => {
      expect(validateSignature(policy, "driver", 2.9, 1000)).toEqual({
        valid: false,
        reason: "below_min_strokes",
      });
      expect(validateSignature(policy, "driver", 5, 499.9)).toEqual({
        valid: false,
        reason: "below_min_duration",
      });
    });
  });

  describe("nextStateAfter (pure state-machine transitions for driver_first flow)", () => {
    test("driver_signed event from idle → driver_signed", () => {
      expect(nextStateAfter("idle", "driver_signed")).toBe("driver_signed");
    });

    test("driver_signed event from driver_signing → driver_signed", () => {
      expect(nextStateAfter("driver_signing", "driver_signed")).toBe("driver_signed");
    });

    test("customer_signed event from driver_signed → complete", () => {
      expect(nextStateAfter("driver_signed", "customer_signed")).toBe("complete");
    });

    test("customer_signed event from customer_signing → complete", () => {
      expect(nextStateAfter("customer_signing", "customer_signed")).toBe("complete");
    });

    test("driver_signed event from driver_signed (re-tap) is a no-op", () => {
      expect(nextStateAfter("driver_signed", "driver_signed")).toBe("driver_signed");
    });

    test("customer_signed event from idle is a no-op (driver_first contract)", () => {
      expect(nextStateAfter("idle", "customer_signed")).toBe("idle");
    });

    test("any event from complete is a no-op (terminal state)", () => {
      expect(nextStateAfter("complete", "driver_signed")).toBe("complete");
      expect(nextStateAfter("complete", "customer_signed")).toBe("complete");
    });

    test("full happy path: idle → driver_signed → complete", () => {
      const afterDriver: DualSignState = nextStateAfter("idle", "driver_signed");
      expect(afterDriver).toBe("driver_signed");
      const afterCustomer: DualSignState = nextStateAfter(afterDriver, "customer_signed");
      expect(afterCustomer).toBe("complete");
    });
  });
});
