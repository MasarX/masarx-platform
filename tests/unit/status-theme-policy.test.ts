// Verify that the resolver distinguishes status tones using policy metadata.

import {
  STATIC_STATUS_THEME,
  normalizeStatusThemePolicy,
  resolveToneFromPolicy,
  type StatusThemePolicyValue,
} from "../../apps/fieldops/src/status-theme-policy";

describe("status_theme_policy helpers", () => {
  describe("STATIC_STATUS_THEME (mirror of global seed)", () => {
    test("assigns the info tone to all info-family statuses, including open", () => {
      const infoStatuses = [
        "open",
        "assigned",
        "queued",
        "new",
        "in_progress",
        "in-progress",
        "inprogress",
        "en_route",
        "en-route",
        "enroute",
        "arrived",
        "started",
      ];
      for (const status of infoStatuses) {
        expect(STATIC_STATUS_THEME.status_map[status]?.tone).toBe("info");
      }
    });
    test("contains all success-family statuses", () => {
      for (const status of ["completed", "complete", "done", "closed", "synced", "succeeded", "success"]) {
        expect(STATIC_STATUS_THEME.status_map[status]?.tone).toBe("success");
      }
    });
    test("contains all danger-family statuses", () => {
      for (const status of ["failed", "fail", "dead", "exception", "rejected", "refused", "error"]) {
        expect(STATIC_STATUS_THEME.status_map[status]?.tone).toBe("danger");
      }
    });
    test("contains all warning-family statuses", () => {
      for (const status of ["overdue", "delayed", "late", "warning", "pending"]) {
        expect(STATIC_STATUS_THEME.status_map[status]?.tone).toBe("warning");
      }
    });
    test("default_tone is neutral", () => {
      expect(STATIC_STATUS_THEME.default_tone).toBe("neutral");
    });
  });

  describe("resolveToneFromPolicy", () => {
    test("returns mapped tone for known statuses", () => {
      expect(resolveToneFromPolicy(STATIC_STATUS_THEME, "open")).toBe("info");
      expect(resolveToneFromPolicy(STATIC_STATUS_THEME, "completed")).toBe("success");
      expect(resolveToneFromPolicy(STATIC_STATUS_THEME, "failed")).toBe("danger");
      expect(resolveToneFromPolicy(STATIC_STATUS_THEME, "overdue")).toBe("warning");
    });
    test("lowercases input before lookup", () => {
      expect(resolveToneFromPolicy(STATIC_STATUS_THEME, "OPEN")).toBe("info");
      expect(resolveToneFromPolicy(STATIC_STATUS_THEME, "Completed")).toBe("success");
    });
    test("trims whitespace", () => {
      expect(resolveToneFromPolicy(STATIC_STATUS_THEME, "  open  ")).toBe("info");
    });
    test("returns default_tone for unknown status", () => {
      expect(resolveToneFromPolicy(STATIC_STATUS_THEME, "weird-custom")).toBe("neutral");
    });
    test("returns default_tone for null / undefined / empty", () => {
      expect(resolveToneFromPolicy(STATIC_STATUS_THEME, null)).toBe("neutral");
      expect(resolveToneFromPolicy(STATIC_STATUS_THEME, undefined)).toBe("neutral");
      expect(resolveToneFromPolicy(STATIC_STATUS_THEME, "")).toBe("neutral");
      expect(resolveToneFromPolicy(STATIC_STATUS_THEME, "   ")).toBe("neutral");
    });
    test("respects per-tenant override (e.g. 'in_transit' → custom danger)", () => {
      const tenantOverride: StatusThemePolicyValue = {
        version: 1,
        default_tone: "neutral",
        status_map: {
          ...STATIC_STATUS_THEME.status_map,
          in_transit: { tone: "danger" },
        },
      };
      expect(resolveToneFromPolicy(tenantOverride, "in_transit")).toBe("danger");
      // Other entries unaffected
      expect(resolveToneFromPolicy(tenantOverride, "open")).toBe("info");
    });
  });

  describe("normalizeStatusThemePolicy", () => {
    test("returns STATIC_STATUS_THEME for null / undefined / non-object", () => {
      expect(normalizeStatusThemePolicy(null)).toEqual(STATIC_STATUS_THEME);
      expect(normalizeStatusThemePolicy(undefined)).toEqual(STATIC_STATUS_THEME);
      expect(normalizeStatusThemePolicy("string")).toEqual(STATIC_STATUS_THEME);
      expect(normalizeStatusThemePolicy(123)).toEqual(STATIC_STATUS_THEME);
    });
    test("returns STATIC_STATUS_THEME when status_map is empty (operator misconfig)", () => {
      const result = normalizeStatusThemePolicy({ version: 1, status_map: {} });
      expect(result.status_map).toEqual(STATIC_STATUS_THEME.status_map);
    });
    test("preserves valid status_map entries", () => {
      const result = normalizeStatusThemePolicy({
        version: 2,
        default_tone: "info",
        status_map: {
          custom_status: { tone: "warning" },
          another: { tone: "success" },
        },
      });
      expect(result.version).toBe(2);
      expect(result.default_tone).toBe("info");
      expect(result.status_map.custom_status.tone).toBe("warning");
      expect(result.status_map.another.tone).toBe("success");
    });
    test("coerces invalid tone values to default_tone", () => {
      const result = normalizeStatusThemePolicy({
        version: 1,
        default_tone: "info",
        status_map: {
          bad_one: { tone: "purple" },         // invalid tone
          missing_tone: { somethingElse: 5 },  // missing tone field
          good: { tone: "success" },
        },
      });
      // Even with bad entries, the seed fallback shouldn't kick in because at
      // least one valid entry exists.
      expect(result.status_map.bad_one.tone).toBe("info");        // coerced to default
      expect(result.status_map.missing_tone.tone).toBe("info");   // coerced to default
      expect(result.status_map.good.tone).toBe("success");
    });
    test("lowercases status keys on insertion", () => {
      const result = normalizeStatusThemePolicy({
        version: 1,
        status_map: { OPEN: { tone: "danger" } },
      });
      expect(result.status_map.open.tone).toBe("danger");
      expect(result.status_map.OPEN).toBeUndefined();
    });
  });
});
