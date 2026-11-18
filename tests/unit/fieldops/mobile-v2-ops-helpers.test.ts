import {
  applyMobileV2CashAdjust,
  computeMobileV2CashVariance,
  formatMobileV2Currency,
  formatMobileV2CurrencyCompact,
  formatMobileV2Eta,
  minutesSinceMs,
} from "../../../apps/fieldops/src/mobile-v2-ops-helpers";

describe("mobile v2 ops helpers", () => {
  describe("formatMobileV2Eta", () => {
    test("returns Now for zero/negative", () => {
      expect(formatMobileV2Eta(0)).toBe("Now");
      expect(formatMobileV2Eta(-5)).toBe("Now");
    });

    test("returns minutes-only when under an hour", () => {
      expect(formatMobileV2Eta(1)).toBe("1m");
      expect(formatMobileV2Eta(45)).toBe("45m");
      expect(formatMobileV2Eta(59)).toBe("59m");
    });

    test("returns hours and minutes when over an hour", () => {
      expect(formatMobileV2Eta(60)).toBe("1h 0m");
      expect(formatMobileV2Eta(75)).toBe("1h 15m");
      expect(formatMobileV2Eta(184)).toBe("3h 4m");
    });

    test("guards against non-finite input", () => {
      expect(formatMobileV2Eta(Number.NaN)).toBe("Now");
      expect(formatMobileV2Eta(Number.POSITIVE_INFINITY)).toBe("Now");
    });
  });

  describe("computeMobileV2CashVariance", () => {
    test("hasVariance is false when counted equals expected", () => {
      expect(computeMobileV2CashVariance(1240, 1240)).toEqual({
        variance: 0,
        hasVariance: false,
      });
    });

    test("variance is negative when counted is short", () => {
      const r = computeMobileV2CashVariance(1140, 1240);
      expect(r.variance).toBe(-100);
      expect(r.hasVariance).toBe(true);
    });

    test("variance is positive when counted exceeds expected", () => {
      const r = computeMobileV2CashVariance(1280, 1240);
      expect(r.variance).toBe(40);
      expect(r.hasVariance).toBe(true);
    });

    test("treats non-finite values as zero", () => {
      expect(computeMobileV2CashVariance(Number.NaN, 100)).toEqual({
        variance: -100,
        hasVariance: true,
      });
      expect(computeMobileV2CashVariance(50, Number.NaN)).toEqual({
        variance: 50,
        hasVariance: true,
      });
    });
  });

  describe("applyMobileV2CashAdjust", () => {
    test("adds positive delta", () => {
      expect(applyMobileV2CashAdjust(1240, 10)).toBe(1250);
      expect(applyMobileV2CashAdjust(1240, 100)).toBe(1340);
    });

    test("subtracts negative delta", () => {
      expect(applyMobileV2CashAdjust(1240, -100)).toBe(1140);
      expect(applyMobileV2CashAdjust(1240, -1)).toBe(1239);
    });

    test("clamps at zero — never returns negative SAR", () => {
      expect(applyMobileV2CashAdjust(50, -100)).toBe(0);
      expect(applyMobileV2CashAdjust(0, -1)).toBe(0);
    });

    test("guards against non-finite input", () => {
      expect(applyMobileV2CashAdjust(Number.NaN, 10)).toBe(10);
      expect(applyMobileV2CashAdjust(100, Number.NaN)).toBe(100);
    });
  });

  describe("formatMobileV2CurrencyCompact", () => {
    test("returns the canonical rial sign (U+FDFC) for SAR code", () => {
      const out = formatMobileV2CurrencyCompact(1240, "SAR");
      // The FieldOps Mobile V2 design SSOT renders SAR as the Unicode
      // rial sign ﷼ (U+FDFC), placed AFTER the value.
      expect(out).toBe("1,240 ﷼");
    });

    test("supports AED / KWD / USD / EUR from the symbol table", () => {
      expect(formatMobileV2CurrencyCompact(100, "AED")).toContain("د.إ");
      expect(formatMobileV2CurrencyCompact(100, "KWD")).toContain("د.ك");
      expect(formatMobileV2CurrencyCompact(100, "USD")).toContain("$");
      expect(formatMobileV2CurrencyCompact(100, "EUR")).toContain("€");
    });

    test("falls back to the ISO code for unknown currencies", () => {
      expect(formatMobileV2CurrencyCompact(50, "ZZZ")).toBe("50 ZZZ");
    });

    test("groups thousands by default", () => {
      expect(formatMobileV2CurrencyCompact(1840, "SAR")).toBe("1,840 ﷼");
    });

    test("grouped:false emits the raw value (design route/map COD chip)", () => {
      // Design `flow-route.jsx` StopRow / ScrMap render `{s.cod} ﷼` —
      // the raw value with no thousands separator.
      expect(formatMobileV2CurrencyCompact(1840, "SAR", { grouped: false })).toBe("1840 ﷼");
      expect(formatMobileV2CurrencyCompact(320, "SAR", { grouped: false })).toBe("320 ﷼");
    });

    test("handles non-finite amounts safely", () => {
      expect(formatMobileV2CurrencyCompact(Number.NaN, "SAR")).toContain("0");
      expect(formatMobileV2CurrencyCompact(Number.POSITIVE_INFINITY, "USD")).toContain("0");
    });

    test("trims and uppercases currency input", () => {
      expect(formatMobileV2CurrencyCompact(75, "  sar  ")).toContain("﷼");
      expect(formatMobileV2CurrencyCompact(75, "usd")).toContain("$");
    });
  });

  describe("formatMobileV2Currency", () => {
    test("Intl-formats when available", () => {
      // Result varies by Node Intl ICU build. Intl.NumberFormat with
      // ar-SA emits Arabic-Indic digits (١٬٢٤٠); other ICU builds emit
      // Western digits (1,240). Both contain "240" in their final 3
      // digits — assert on the SAR symbol presence + non-empty output.
      const out = formatMobileV2Currency(1240, "SAR");
      expect(out.length).toBeGreaterThan(0);
      expect(out).toMatch(/(ر\.س|SAR|﷼)/);
    });

    test("can opt out of Intl with localized:false", () => {
      const out = formatMobileV2Currency(1240, "SAR", { localized: false });
      // Output uses toLocaleString() which varies by ICU but must
      // contain the numeric digits and the canonical SAR rial sign.
      expect(out).toMatch(/1.?240/);
      expect(out).toContain("﷼");
    });

    test("handles empty/garbage currency without throwing", () => {
      expect(() => formatMobileV2Currency(50, "")).not.toThrow();
      expect(() => formatMobileV2Currency(50, "  ")).not.toThrow();
    });
  });

  describe("minutesSinceMs", () => {
    test("returns 0 when timestamp is in the future", () => {
      const now = 1_700_000_000_000;
      expect(minutesSinceMs(now + 5 * 60_000, now)).toBe(0);
    });

    test("rounds to nearest minute", () => {
      const now = 1_700_000_000_000;
      expect(minutesSinceMs(now - 60_000, now)).toBe(1);
      expect(minutesSinceMs(now - 59_999, now)).toBe(1);
      expect(minutesSinceMs(now - 30_001, now)).toBe(1);
      expect(minutesSinceMs(now - 29_999, now)).toBe(0);
    });

    test("handles 22 minutes ago like the hold-queue ribbon", () => {
      const now = 1_700_000_000_000;
      expect(minutesSinceMs(now - 22 * 60_000, now)).toBe(22);
    });

    test("guards against non-finite input", () => {
      expect(minutesSinceMs(Number.NaN, 100)).toBe(0);
      expect(minutesSinceMs(100, Number.NaN)).toBe(0);
    });
  });
});
