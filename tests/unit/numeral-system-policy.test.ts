// Verify localized numerals and the fallback numbering system.

import {
  STATIC_NUMERAL_SYSTEM,
  formatNumber,
  normalizeNumeralSystemPolicy,
  resolveNumberingSystem,
  type NumberingSystem,
  type NumeralSystemPolicyValue,
} from "../../apps/fieldops/src/numeral-system-policy";

describe("numeral_system_policy helpers", () => {
  describe("STATIC_NUMERAL_SYSTEM (mirror of migration seed)", () => {
    test("default_numbering_system is 'latn' (matches migration seed)", () => {
      expect(STATIC_NUMERAL_SYSTEM.default_numbering_system).toBe("latn");
    });

    test("seeds the 5 expected locale overrides (ar, ar_SA, ar_AE, ar_EG, fa)", () => {
      const locales = Object.keys(STATIC_NUMERAL_SYSTEM.locale_overrides).sort();
      expect(locales).toEqual(["ar", "ar_AE", "ar_EG", "ar_SA", "fa"]);
    });

    test("ar_SA → 'arab' (KSA convention — Eastern Arabic-Indic)", () => {
      expect(STATIC_NUMERAL_SYSTEM.locale_overrides.ar_SA?.numbering_system).toBe("arab");
    });

    test("ar_AE → 'latn' (UAE — Latin in modern commerce)", () => {
      expect(STATIC_NUMERAL_SYSTEM.locale_overrides.ar_AE?.numbering_system).toBe("latn");
    });

    test("ar_EG → 'arab' (Egyptian Arabic-Indic)", () => {
      expect(STATIC_NUMERAL_SYSTEM.locale_overrides.ar_EG?.numbering_system).toBe("arab");
    });

    test("fa → 'arabext' (Persian Eastern Arabic-Indic)", () => {
      expect(STATIC_NUMERAL_SYSTEM.locale_overrides.fa?.numbering_system).toBe("arabext");
    });

    test("every locale entry carries `allow_user_toggle: true`", () => {
      for (const cfg of Object.values(STATIC_NUMERAL_SYSTEM.locale_overrides)) {
        expect(cfg.allow_user_toggle).toBe(true);
      }
    });
  });

  describe("resolveNumberingSystem", () => {
    test("returns 'arab' for ar_SA (exact match)", () => {
      expect(resolveNumberingSystem(STATIC_NUMERAL_SYSTEM, "ar_SA")).toBe("arab");
    });

    test("returns 'arab' for ar_EG (exact match)", () => {
      expect(resolveNumberingSystem(STATIC_NUMERAL_SYSTEM, "ar_EG")).toBe("arab");
    });

    test("returns 'latn' for ar_AE (exact match — UAE Latin convention)", () => {
      expect(resolveNumberingSystem(STATIC_NUMERAL_SYSTEM, "ar_AE")).toBe("latn");
    });

    test("returns 'arabext' for fa (Persian)", () => {
      expect(resolveNumberingSystem(STATIC_NUMERAL_SYSTEM, "fa")).toBe("arabext");
    });

    test("returns 'latn' for en (no override → falls back to default)", () => {
      expect(resolveNumberingSystem(STATIC_NUMERAL_SYSTEM, "en")).toBe("latn");
    });

    test("returns 'latn' for unknown locale (e.g. zh) → default fallback", () => {
      expect(resolveNumberingSystem(STATIC_NUMERAL_SYSTEM, "zh")).toBe("latn");
    });

    test("returns 'arab' for ar_JO via language-prefix fallback (ar → arab)", () => {
      // ar_JO is not in the overrides; falls back to the "ar" entry, which
      // is "arab" in the seed (post v9-residual-fix). Bare-`ar` defaults
      // to Arabic-Indic so Arabic-locale drivers without a recognized
      // region tag still see localized numerals on the FieldOps shell.
      // Region-specific overrides (ar_AE → latn) continue to win.
      expect(resolveNumberingSystem(STATIC_NUMERAL_SYSTEM, "ar_JO")).toBe("arab");
    });

    test("accepts BCP-47 hyphen tag (ar-SA → 'arab') by swapping to underscore", () => {
      expect(resolveNumberingSystem(STATIC_NUMERAL_SYSTEM, "ar-SA")).toBe("arab");
    });

    test("returns default for empty / non-string locale (defensive)", () => {
      expect(resolveNumberingSystem(STATIC_NUMERAL_SYSTEM, "")).toBe("latn");
      // @ts-expect-error: testing defensive runtime path
      expect(resolveNumberingSystem(STATIC_NUMERAL_SYSTEM, undefined)).toBe("latn");
      // @ts-expect-error: testing defensive runtime path
      expect(resolveNumberingSystem(STATIC_NUMERAL_SYSTEM, null)).toBe("latn");
    });

    test("returns default when policy default differs (custom policy)", () => {
      const custom: NumeralSystemPolicyValue = {
        version: 1,
        default_numbering_system: "arab",
        locale_overrides: {},
      };
      expect(resolveNumberingSystem(custom, "fr")).toBe("arab");
    });
  });

  describe("formatNumber (Intl.NumberFormat numberingSystem)", () => {
    test("ar_SA renders 1234.56 in Arabic-Indic numerals", () => {
      const out = formatNumber(STATIC_NUMERAL_SYSTEM, 1234.56, "ar_SA");
      // The string MUST contain Arabic-Indic digits (٠-٩) and MUST NOT
      // contain ASCII digits.
      expect(out).toMatch(/[٠-٩]/);
      expect(out).not.toMatch(/[0-9]/);
    });

    test("ar_EG renders 1234.56 in Arabic-Indic numerals", () => {
      const out = formatNumber(STATIC_NUMERAL_SYSTEM, 1234.56, "ar_EG");
      expect(out).toMatch(/[٠-٩]/);
      expect(out).not.toMatch(/[0-9]/);
    });

    test("ar_AE renders 1234.56 in Latin numerals (UAE convention)", () => {
      const out = formatNumber(STATIC_NUMERAL_SYSTEM, 1234.56, "ar_AE");
      expect(out).toMatch(/[0-9]/);
      expect(out).not.toMatch(/[٠-٩]/);
    });

    test("en renders 1234.56 with Latin numerals and US grouping/decimal", () => {
      const out = formatNumber(STATIC_NUMERAL_SYSTEM, 1234.56, "en");
      // Should contain ASCII digits.
      expect(out).toMatch(/[0-9]/);
      // The classic US/EN format is "1,234.56".
      expect(out).toBe("1,234.56");
    });

    test("fa (Persian) renders 1234.56 in Eastern Arabic-Indic / Persian numerals", () => {
      const out = formatNumber(STATIC_NUMERAL_SYSTEM, 1234.56, "fa");
      // Persian / Eastern Arabic-Indic uses ۰-۹ digits.
      expect(out).toMatch(/[۰-۹]/);
      expect(out).not.toMatch(/[0-9]/);
    });

    test("unknown locale (zh) falls back to default numbering system (latn)", () => {
      const out = formatNumber(STATIC_NUMERAL_SYSTEM, 1234.56, "zh");
      // With "latn" numbering, output contains ASCII digits.
      expect(out).toMatch(/[0-9]/);
    });

    test("formatNumber honors caller-provided NumberFormatOptions (decimals)", () => {
      const out = formatNumber(STATIC_NUMERAL_SYSTEM, 100.5, "en", {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      });
      expect(out).toBe("100.50");
    });

    test("non-finite values fall back to String(value) (NaN, Infinity, -Infinity)", () => {
      expect(formatNumber(STATIC_NUMERAL_SYSTEM, Number.NaN, "en")).toBe("NaN");
      expect(formatNumber(STATIC_NUMERAL_SYSTEM, Infinity, "en")).toBe("Infinity");
      expect(formatNumber(STATIC_NUMERAL_SYSTEM, -Infinity, "ar_SA")).toBe("-Infinity");
    });

    test("Intl fallback: throws inside NumberFormat → returns value.toString()", () => {
      // Force Intl.NumberFormat to throw on every invocation by spying with
      // a constructor stub. Restore in finally so we don't poison sibling
      // tests in the same describe block.
      const originalNumberFormat = Intl.NumberFormat;
      // @ts-expect-error: deliberately replacing for the fallback path test.
      Intl.NumberFormat = function ThrowingNumberFormat() {
        throw new Error("fake-runtime-failure");
      };
      try {
        const out = formatNumber(STATIC_NUMERAL_SYSTEM, 42, "ar_SA");
        // Should fall back all the way to String(42).
        expect(out).toBe("42");
      } finally {
        // @ts-expect-error: restore original
        Intl.NumberFormat = originalNumberFormat;
      }
    });
  });

  describe("normalizeNumeralSystemPolicy (defensive parse)", () => {
    test("returns deep clone of STATIC seed for null / undefined / non-object inputs", () => {
      const out = normalizeNumeralSystemPolicy(null);
      expect(out.default_numbering_system).toBe(
        STATIC_NUMERAL_SYSTEM.default_numbering_system,
      );
      expect(Object.keys(out.locale_overrides).sort()).toEqual(
        Object.keys(STATIC_NUMERAL_SYSTEM.locale_overrides).sort(),
      );
      // Deep clone — mutating output must not poison the seed.
      out.locale_overrides.ar_SA!.numbering_system = "latn";
      expect(STATIC_NUMERAL_SYSTEM.locale_overrides.ar_SA?.numbering_system).toBe(
        "arab",
      );
    });

    test("preserves a fully-valid policy body", () => {
      const input: NumeralSystemPolicyValue = {
        version: 2,
        default_numbering_system: "arab",
        locale_overrides: {
          en: { numbering_system: "latn", allow_user_toggle: false },
          ar_SA: { numbering_system: "arab", allow_user_toggle: true },
        },
      };
      const out = normalizeNumeralSystemPolicy(input);
      expect(out.version).toBe(2);
      expect(out.default_numbering_system).toBe("arab");
      expect(out.locale_overrides.en?.numbering_system).toBe("latn");
      expect(out.locale_overrides.en?.allow_user_toggle).toBe(false);
      expect(out.locale_overrides.ar_SA?.numbering_system).toBe("arab");
    });

    test("rejects out-of-enum numbering_system and falls back to default", () => {
      const out = normalizeNumeralSystemPolicy({
        version: 1,
        default_numbering_system: "latn",
        locale_overrides: {
          ar_SA: { numbering_system: "klingon", allow_user_toggle: true },
        },
      });
      // Falls back to the policy default ("latn") for the malformed entry.
      expect(out.locale_overrides.ar_SA?.numbering_system).toBe("latn");
    });

    test("rejects out-of-enum default_numbering_system and falls back to STATIC seed", () => {
      const out = normalizeNumeralSystemPolicy({
        version: 1,
        default_numbering_system: "klingon",
        locale_overrides: {},
      });
      expect(out.default_numbering_system).toBe(
        STATIC_NUMERAL_SYSTEM.default_numbering_system,
      );
    });

    test("drops malformed override entries (non-object, missing numbering_system)", () => {
      const out = normalizeNumeralSystemPolicy({
        version: 1,
        default_numbering_system: "latn",
        locale_overrides: {
          good_locale: { numbering_system: "arab", allow_user_toggle: true },
          bad_locale_string: "not-an-object",
          bad_locale_array: [1, 2, 3],
          empty_locale: "",
        },
      });
      // good_locale survives
      expect(out.locale_overrides.good_locale?.numbering_system).toBe("arab");
      // bad_* / empty are dropped
      expect(out.locale_overrides.bad_locale_string).toBeUndefined();
      expect(out.locale_overrides.bad_locale_array).toBeUndefined();
      expect(out.locale_overrides[""]).toBeUndefined();
    });

    test("uses default version=1 when version is missing or invalid", () => {
      expect(
        normalizeNumeralSystemPolicy({
          default_numbering_system: "latn",
          locale_overrides: {},
        }).version,
      ).toBe(1);
      expect(
        normalizeNumeralSystemPolicy({
          version: "not-a-number",
          default_numbering_system: "latn",
          locale_overrides: {},
        }).version,
      ).toBe(1);
    });

    test("normalized output is fully usable by resolveNumberingSystem + formatNumber", () => {
      const policy = normalizeNumeralSystemPolicy({
        version: 1,
        default_numbering_system: "latn",
        locale_overrides: {
          ar_SA: { numbering_system: "arab", allow_user_toggle: true },
        },
      });
      expect(resolveNumberingSystem(policy, "ar_SA")).toBe("arab");
      const out = formatNumber(policy, 1234.56, "ar_SA");
      expect(out).toMatch(/[٠-٩]/);
    });

    test("falls back to true for missing/invalid allow_user_toggle (defensive default)", () => {
      const out = normalizeNumeralSystemPolicy({
        version: 1,
        default_numbering_system: "latn",
        locale_overrides: {
          ar_SA: { numbering_system: "arab" },
          ar_EG: { numbering_system: "arab", allow_user_toggle: "yes-please" },
        },
      });
      expect(out.locale_overrides.ar_SA?.allow_user_toggle).toBe(true);
      expect(out.locale_overrides.ar_EG?.allow_user_toggle).toBe(true);
    });
  });

  describe("type contracts (compile-time)", () => {
    test("NumberingSystem union is exactly latn | arab | arabext", () => {
      const valid: NumberingSystem[] = ["latn", "arab", "arabext"];
      // Compile-time check + runtime sanity.
      expect(valid).toEqual(["latn", "arab", "arabext"]);
    });
  });
});
