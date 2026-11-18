// Verify that priorities resolve to localized labels and tones.

import {
  STATIC_PRIORITY_DISPLAY,
  normalizePriorityDisplayPolicy,
  resolvePriorityLabel,
  type PriorityDisplayPolicyValue,
} from "../../apps/fieldops/src/priority-display-policy";

describe("priority_display_policy helpers", () => {
  describe("STATIC_PRIORITY_DISPLAY (mirror of global seed)", () => {
    test("has version 1", () => {
      expect(STATIC_PRIORITY_DISPLAY.version).toBe(1);
    });
    test("has exactly 4 buckets (Urgent/High/Normal/Low)", () => {
      expect(STATIC_PRIORITY_DISPLAY.buckets).toHaveLength(4);
    });
    test("buckets are sorted descending by min_inclusive", () => {
      const thresholds = STATIC_PRIORITY_DISPLAY.buckets.map((b) => b.min_inclusive);
      expect(thresholds).toEqual([80, 60, 40, 0]);
    });
    test("Urgent bucket has tone=danger and bilingual labels", () => {
      const urgent = STATIC_PRIORITY_DISPLAY.buckets[0]!;
      expect(urgent.label_en).toBe("Urgent");
      expect(urgent.label_ar).toBe("عاجل");
      expect(urgent.tone).toBe("danger");
    });
    test("Low bucket has tone=neutral and starts at 0", () => {
      const low = STATIC_PRIORITY_DISPLAY.buckets[3]!;
      expect(low.label_en).toBe("Low");
      expect(low.label_ar).toBe("منخفض");
      expect(low.tone).toBe("neutral");
      expect(low.min_inclusive).toBe(0);
    });
  });

  describe("resolvePriorityLabel (en locale)", () => {
    test("priority 95 → Urgent / danger", () => {
      const r = resolvePriorityLabel(STATIC_PRIORITY_DISPLAY, 95, "en");
      expect(r.label).toBe("Urgent");
      expect(r.tone).toBe("danger");
    });
    test("priority 80 → Urgent / danger (boundary inclusive)", () => {
      const r = resolvePriorityLabel(STATIC_PRIORITY_DISPLAY, 80, "en");
      expect(r.label).toBe("Urgent");
      expect(r.tone).toBe("danger");
    });
    test("priority 79 → High / warning (just below Urgent)", () => {
      const r = resolvePriorityLabel(STATIC_PRIORITY_DISPLAY, 79, "en");
      expect(r.label).toBe("High");
      expect(r.tone).toBe("warning");
    });
    test("priority 60 → High / warning (boundary inclusive)", () => {
      const r = resolvePriorityLabel(STATIC_PRIORITY_DISPLAY, 60, "en");
      expect(r.label).toBe("High");
      expect(r.tone).toBe("warning");
    });
    test("priority 50 → Normal / info", () => {
      const r = resolvePriorityLabel(STATIC_PRIORITY_DISPLAY, 50, "en");
      expect(r.label).toBe("Normal");
      expect(r.tone).toBe("info");
    });
    test("priority 40 → Normal / info (boundary inclusive)", () => {
      const r = resolvePriorityLabel(STATIC_PRIORITY_DISPLAY, 40, "en");
      expect(r.label).toBe("Normal");
      expect(r.tone).toBe("info");
    });
    test("priority 25 → Low / neutral", () => {
      const r = resolvePriorityLabel(STATIC_PRIORITY_DISPLAY, 25, "en");
      expect(r.label).toBe("Low");
      expect(r.tone).toBe("neutral");
    });
    test("priority 0 → Low / neutral (lowest boundary)", () => {
      const r = resolvePriorityLabel(STATIC_PRIORITY_DISPLAY, 0, "en");
      expect(r.label).toBe("Low");
      expect(r.tone).toBe("neutral");
    });
    test("priority 100 (max) → Urgent / danger", () => {
      const r = resolvePriorityLabel(STATIC_PRIORITY_DISPLAY, 100, "en");
      expect(r.label).toBe("Urgent");
      expect(r.tone).toBe("danger");
    });
  });

  describe("resolvePriorityLabel (ar locale)", () => {
    test("priority 85 → عاجل / danger", () => {
      const r = resolvePriorityLabel(STATIC_PRIORITY_DISPLAY, 85, "ar");
      expect(r.label).toBe("عاجل");
      expect(r.tone).toBe("danger");
    });
    test("priority 65 → مرتفع / warning", () => {
      const r = resolvePriorityLabel(STATIC_PRIORITY_DISPLAY, 65, "ar");
      expect(r.label).toBe("مرتفع");
      expect(r.tone).toBe("warning");
    });
    test("priority 45 → عادي / info", () => {
      const r = resolvePriorityLabel(STATIC_PRIORITY_DISPLAY, 45, "ar");
      expect(r.label).toBe("عادي");
      expect(r.tone).toBe("info");
    });
    test("priority 5 → منخفض / neutral", () => {
      const r = resolvePriorityLabel(STATIC_PRIORITY_DISPLAY, 5, "ar");
      expect(r.label).toBe("منخفض");
      expect(r.tone).toBe("neutral");
    });
  });

  describe("resolvePriorityLabel (edge cases)", () => {
    test("NaN priority falls back to lowest bucket (0 threshold)", () => {
      const r = resolvePriorityLabel(STATIC_PRIORITY_DISPLAY, NaN, "en");
      expect(r.label).toBe("Low");
      expect(r.tone).toBe("neutral");
    });
    test("respects per-tenant override (P>=70 → Urgent)", () => {
      const tenantOverride: PriorityDisplayPolicyValue = {
        version: 1,
        buckets: [
          { min_inclusive: 70, label_en: "Urgent", label_ar: "عاجل", tone: "danger" },
          { min_inclusive: 0, label_en: "Normal", label_ar: "عادي", tone: "info" },
        ],
      };
      // 75 should now hit Urgent (was High under default)
      const r = resolvePriorityLabel(tenantOverride, 75, "en");
      expect(r.label).toBe("Urgent");
      expect(r.tone).toBe("danger");
    });
    test("works when buckets are passed in ascending order (resolver re-sorts desc)", () => {
      const ascendingPolicy: PriorityDisplayPolicyValue = {
        version: 1,
        buckets: [
          { min_inclusive: 0, label_en: "Low", label_ar: "منخفض", tone: "neutral" },
          { min_inclusive: 40, label_en: "Normal", label_ar: "عادي", tone: "info" },
          { min_inclusive: 80, label_en: "Urgent", label_ar: "عاجل", tone: "danger" },
        ],
      };
      const r = resolvePriorityLabel(ascendingPolicy, 90, "en");
      expect(r.label).toBe("Urgent");
    });
    test("zero buckets falls back to STATIC seed", () => {
      const empty: PriorityDisplayPolicyValue = { version: 1, buckets: [] };
      const r = resolvePriorityLabel(empty, 50, "en");
      // STATIC has 40 → Normal/info matching at 50
      expect(r.label).toBe("Normal");
      expect(r.tone).toBe("info");
    });
  });

  describe("normalizePriorityDisplayPolicy", () => {
    test("returns STATIC_PRIORITY_DISPLAY for null / undefined / non-object", () => {
      expect(normalizePriorityDisplayPolicy(null)).toEqual(STATIC_PRIORITY_DISPLAY);
      expect(normalizePriorityDisplayPolicy(undefined)).toEqual(STATIC_PRIORITY_DISPLAY);
      expect(normalizePriorityDisplayPolicy("string")).toEqual(STATIC_PRIORITY_DISPLAY);
      expect(normalizePriorityDisplayPolicy(123)).toEqual(STATIC_PRIORITY_DISPLAY);
    });
    test("falls back to STATIC seed when buckets array is empty", () => {
      const result = normalizePriorityDisplayPolicy({ version: 1, buckets: [] });
      expect(result.buckets).toEqual(STATIC_PRIORITY_DISPLAY.buckets);
    });
    test("falls back to STATIC seed when buckets is not an array", () => {
      const result = normalizePriorityDisplayPolicy({ version: 1, buckets: "not-an-array" });
      expect(result.buckets).toEqual(STATIC_PRIORITY_DISPLAY.buckets);
    });
    test("preserves valid buckets and re-sorts descending", () => {
      const result = normalizePriorityDisplayPolicy({
        version: 2,
        buckets: [
          { min_inclusive: 0, label_en: "Low", label_ar: "منخفض", tone: "neutral" },
          { min_inclusive: 50, label_en: "Med", label_ar: "متوسط", tone: "info" },
          { min_inclusive: 90, label_en: "Crit", label_ar: "حرج", tone: "danger" },
        ],
      });
      expect(result.version).toBe(2);
      expect(result.buckets).toHaveLength(3);
      expect(result.buckets[0]!.min_inclusive).toBe(90);
      expect(result.buckets[1]!.min_inclusive).toBe(50);
      expect(result.buckets[2]!.min_inclusive).toBe(0);
    });
    test("drops malformed bucket entries (missing labels, non-numeric threshold)", () => {
      const result = normalizePriorityDisplayPolicy({
        version: 1,
        buckets: [
          { min_inclusive: 80, label_en: "Urgent", label_ar: "عاجل", tone: "danger" },
          { min_inclusive: "not-a-number", label_en: "Bad", label_ar: "سيء", tone: "danger" },
          { min_inclusive: 50, label_en: "", label_ar: "x", tone: "info" }, // empty label_en
          { min_inclusive: 30, label_en: "OK", tone: "info" }, // missing label_ar
          { min_inclusive: 0, label_en: "Low", label_ar: "منخفض", tone: "neutral" },
          "garbage",
          null,
        ],
      });
      // Only 2 valid buckets survive
      expect(result.buckets).toHaveLength(2);
      expect(result.buckets[0]!.min_inclusive).toBe(80);
      expect(result.buckets[1]!.min_inclusive).toBe(0);
    });
    test("coerces invalid tone values to 'neutral'", () => {
      const result = normalizePriorityDisplayPolicy({
        version: 1,
        buckets: [
          { min_inclusive: 80, label_en: "Urgent", label_ar: "عاجل", tone: "purple" },
        ],
      });
      expect(result.buckets[0]!.tone).toBe("neutral");
    });
    test("clamps min_inclusive to [0, 100]", () => {
      const result = normalizePriorityDisplayPolicy({
        version: 1,
        buckets: [
          { min_inclusive: 150, label_en: "Way too high", label_ar: "مرتفع جداً", tone: "danger" },
          { min_inclusive: -50, label_en: "Negative", label_ar: "سالب", tone: "neutral" },
        ],
      });
      expect(result.buckets[0]!.min_inclusive).toBe(100); // clamped from 150
      expect(result.buckets[1]!.min_inclusive).toBe(0); // clamped from -50
    });
    test("uses default version=1 when version field is missing or invalid", () => {
      const result = normalizePriorityDisplayPolicy({
        buckets: [{ min_inclusive: 0, label_en: "X", label_ar: "س", tone: "info" }],
      });
      expect(result.version).toBe(1);
    });
  });
});
