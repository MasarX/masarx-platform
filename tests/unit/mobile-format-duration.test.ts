// Verify localized minute, hour and day formatting.

import { formatRelativeDuration } from "../../apps/fieldops/src/mobile-format-duration";

describe("formatRelativeDuration", () => {
  describe("English locale", () => {
    test("0 minutes → 'Now'", () => {
      expect(formatRelativeDuration(0, "en")).toBe("Now");
    });
    test("negative minutes → 'Now' (already past)", () => {
      expect(formatRelativeDuration(-5, "en")).toBe("Now");
      expect(formatRelativeDuration(-1000, "en")).toBe("Now");
    });
    test("1 minute → '1m'", () => {
      expect(formatRelativeDuration(1, "en")).toBe("1m");
    });
    test("59 minutes → '59m' (just under 1h boundary)", () => {
      expect(formatRelativeDuration(59, "en")).toBe("59m");
    });
    test("60 minutes → '1h' (boundary; trailing minutes dropped when 0)", () => {
      expect(formatRelativeDuration(60, "en")).toBe("1h");
    });
    test("90 minutes → '1h 30m'", () => {
      expect(formatRelativeDuration(90, "en")).toBe("1h 30m");
    });
    test("240 minutes → '4h'", () => {
      expect(formatRelativeDuration(240, "en")).toBe("4h");
    });
    test("245 minutes → '4h 5m'", () => {
      expect(formatRelativeDuration(245, "en")).toBe("4h 5m");
    });
    test("1439 minutes → '23h 59m' (just under 1d boundary)", () => {
      expect(formatRelativeDuration(1439, "en")).toBe("23h 59m");
    });
    test("1440 minutes → '1d' (boundary; trailing hours dropped when 0)", () => {
      expect(formatRelativeDuration(1440, "en")).toBe("1d");
    });
    test("1500 minutes → '1d 1h'", () => {
      expect(formatRelativeDuration(1500, "en")).toBe("1d 1h");
    });
    test("4320 minutes (3 days exact) → '3d'", () => {
      expect(formatRelativeDuration(4320, "en")).toBe("3d");
    });
    test("10080 minutes (1 week) → '7d'", () => {
      expect(formatRelativeDuration(10080, "en")).toBe("7d");
    });
  });

  describe("Arabic locale", () => {
    test("0 minutes → 'الآن'", () => {
      expect(formatRelativeDuration(0, "ar")).toBe("الآن");
    });
    test("negative → 'الآن'", () => {
      expect(formatRelativeDuration(-10, "ar")).toBe("الآن");
    });
    test("30 minutes → '30د'", () => {
      expect(formatRelativeDuration(30, "ar")).toBe("30د");
    });
    test("60 minutes → '1س'", () => {
      expect(formatRelativeDuration(60, "ar")).toBe("1س");
    });
    test("90 minutes → '1س 30د'", () => {
      expect(formatRelativeDuration(90, "ar")).toBe("1س 30د");
    });
    test("240 minutes → '4س' in Arabic", () => {
      expect(formatRelativeDuration(240, "ar")).toBe("4س");
    });
    test("1440 minutes → '1ي'", () => {
      expect(formatRelativeDuration(1440, "ar")).toBe("1ي");
    });
    test("1500 minutes → '1ي 1س'", () => {
      expect(formatRelativeDuration(1500, "ar")).toBe("1ي 1س");
    });
  });

  describe("edge cases", () => {
    test("NaN minutes → 'Now' (defensive)", () => {
      expect(formatRelativeDuration(NaN, "en")).toBe("Now");
    });
    test("Infinity minutes → 'Now' (defensive)", () => {
      expect(formatRelativeDuration(Infinity, "en")).toBe("Now");
    });
    test("fractional minutes are floored (90.7 → '1h 30m')", () => {
      expect(formatRelativeDuration(90.7, "en")).toBe("1h 30m");
    });
    test("unknown locale falls back to English", () => {
      // @ts-expect-error — intentionally passing invalid locale
      expect(formatRelativeDuration(60, "fr")).toBe("1h");
    });
  });
});
