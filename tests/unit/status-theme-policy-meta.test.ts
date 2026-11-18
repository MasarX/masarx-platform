/** Verify the shared meta tone for quiet status details. */

import {
  STATIC_STATUS_THEME,
  normalizeStatusThemePolicy,
  resolveToneFromPolicy,
  type StatusTone,
  type StatusThemePolicyValue,
} from "../../apps/fieldops/src/status-theme-policy";

describe("StatusTone — meta extension", () => {
  test("StatusTone union includes 'meta' as a valid value", () => {
    // Compile-time: this assignment must type-check. If 'meta' were
    // dropped from the union, ts-jest would surface a compile error here.
    const tone: StatusTone = "meta";
    expect(tone).toBe("meta");
  });

  test("StatusTone union still includes the original five tones (no regression)", () => {
    const tones: StatusTone[] = [
      "neutral",
      "info",
      "success",
      "warning",
      "danger",
      "meta",
    ];
    // Each tone must round-trip as a string. Anchoring this here so a
    // future PR that accidentally narrows the union (e.g. dropping
    // 'warning') would fail this test before it broke chip rendering.
    for (const t of tones) {
      const assigned: StatusTone = t;
      expect(typeof assigned).toBe("string");
    }
    expect(tones).toHaveLength(6);
  });
});

describe("resolveToneFromPolicy — meta MUST NOT be auto-resolved", () => {
  test("unknown statuses still return 'neutral' (not 'meta') from the global seed", () => {
    // This is the load-bearing semantic guarantee. Drivers must visually
    // distinguish "I don't know this status" (neutral) from "this is not a
    // status, it's a count/tag" (meta). If a future seed change ever
    // started returning meta for unknowns, both visuals would collapse.
    expect(resolveToneFromPolicy(STATIC_STATUS_THEME, "weird-custom-status")).toBe(
      "neutral",
    );
    expect(resolveToneFromPolicy(STATIC_STATUS_THEME, "future-status-x")).toBe(
      "neutral",
    );
  });

  test("null / undefined / empty inputs still resolve to default_tone (not 'meta')", () => {
    expect(resolveToneFromPolicy(STATIC_STATUS_THEME, null)).toBe("neutral");
    expect(resolveToneFromPolicy(STATIC_STATUS_THEME, undefined)).toBe("neutral");
    expect(resolveToneFromPolicy(STATIC_STATUS_THEME, "")).toBe("neutral");
    expect(resolveToneFromPolicy(STATIC_STATUS_THEME, "   ")).toBe("neutral");
  });

  test("STATIC_STATUS_THEME.status_map does NOT contain a 'meta' tone for any status", () => {
    // Defense-in-depth: enumerate every entry in the shipped seed and
    // assert none maps to meta. If a future migration ever adds a
    // `meta` mapping to the seed, this test fires before the visual
    // semantic regresses.
    for (const [status, entry] of Object.entries(STATIC_STATUS_THEME.status_map)) {
      expect(entry.tone).not.toBe("meta");
      // Sanity: ensure entry shape is intact.
      expect(typeof status).toBe("string");
      expect(typeof entry.tone).toBe("string");
    }
  });

  test("default_tone in the static seed is 'neutral' (not 'meta')", () => {
    expect(STATIC_STATUS_THEME.default_tone).toBe("neutral");
  });
});

describe("normalizeStatusThemePolicy — accepts caller-explicit meta overrides", () => {
  test("per-tenant override mapping a status to 'meta' round-trips correctly", () => {
    // Operators MAY explicitly set a status_map entry to meta if they want
    // a particular status code to render as a meta chip (e.g. an
    // ambiguous "internal-tracking-only" code that should stay visually
    // neutral but distinct from neutral). The normalizer must accept it.
    const tenantOverride = {
      version: 1,
      default_tone: "neutral",
      status_map: {
        internal_only: { tone: "meta" },
        ...STATIC_STATUS_THEME.status_map,
      },
    };
    const normalized = normalizeStatusThemePolicy(tenantOverride);
    expect(normalized.status_map.internal_only?.tone).toBe("meta");
    // And resolveToneFromPolicy on that normalized value must surface meta.
    expect(resolveToneFromPolicy(normalized, "internal_only")).toBe("meta");
  });

  test("an invalid tone in a per-tenant override coerces to default_tone (not meta)", () => {
    // Coverage for the existing coercion path — proves meta does not
    // become a dumping ground for invalid tones.
    const result = normalizeStatusThemePolicy({
      version: 1,
      default_tone: "info",
      status_map: {
        bad_one: { tone: "purple" }, // invalid
        good: { tone: "meta" },      // explicitly meta — preserved
      },
    });
    expect(result.status_map.bad_one?.tone).toBe("info"); // coerced to default_tone
    expect(result.status_map.good?.tone).toBe("meta");    // preserved
  });

  test("default_tone='meta' is preserved when an operator sets it explicitly", () => {
    // Edge case: an operator may want unknown statuses to fall to meta in
    // a particular tenant. The normalizer must accept it without coercing
    // back to neutral.
    const explicit: unknown = {
      version: 1,
      default_tone: "meta",
      status_map: { foo: { tone: "info" } },
    };
    const normalized = normalizeStatusThemePolicy(explicit);
    expect(normalized.default_tone).toBe("meta");
    // And unknown statuses now route to meta in this tenant.
    expect(resolveToneFromPolicy(normalized, "unknown")).toBe("meta");
  });
});

describe("STATIC_STATUS_THEME — matches the seeded status-policy shape", () => {
  test("status_map still has at least 30 entries (parity with pgTAP test 8)", () => {
    expect(Object.keys(STATIC_STATUS_THEME.status_map).length).toBeGreaterThanOrEqual(30);
  });

  test("anchor entries from the global seed remain stable", () => {
    // Keep the resolver assertion aligned with the SQL policy test.
    const map = STATIC_STATUS_THEME.status_map;
    expect(map.open?.tone).toBe("info");
    expect(map.completed?.tone).toBe("success");
    expect(map.failed?.tone).toBe("danger");
    expect(map.overdue?.tone).toBe("warning");
  });

  test("policy value type is structurally complete (StatusThemePolicyValue contract)", () => {
    // Compile-time + runtime: this re-assertion proves the type
    // import path is healthy and the seed is structurally compatible.
    const seed: StatusThemePolicyValue = STATIC_STATUS_THEME;
    expect(typeof seed.version).toBe("number");
    expect(typeof seed.default_tone).toBe("string");
    expect(typeof seed.status_map).toBe("object");
  });
});
