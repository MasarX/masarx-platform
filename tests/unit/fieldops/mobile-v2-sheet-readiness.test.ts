// Unit coverage for the 6 sheet `ready`/`hasIssues` pure helpers
// exported from `apps/fieldops/src/mobile-v2-sheet-readiness.ts`.
// Engineering audit P1 — every discriminated-union state transition is
// asserted here so a regression in any sheet's submit-gate is caught
// before it reaches Playwright.

import {
  computeMobileV2CashDropVariance,
  isMobileV2CashDropReady,
  isMobileV2DamageHoldReady,
  isMobileV2IncidentReady,
  isMobileV2ReturnReady,
  resolveMobileV2ReceiveSubtitle,
  MOBILE_V2_DAMAGE_HOLD_MIN_NOTE_LEN,
  MOBILE_V2_INCIDENT_MIN_STATEMENT_LEN,
  resolveMobileV2DamageHoldCtaTone,
} from "../../../apps/fieldops/src/mobile-v2-sheet-readiness";
import type { MobileV2IncidentType } from "../../../apps/fieldops/src/mobile-v2-sheet-incident";
import type { MobileV2DamageSeverity } from "../../../apps/fieldops/src/mobile-v2-sheet-damage-hold";

// ---------------------------------------------------------------------------
// Incident sheet
// ---------------------------------------------------------------------------

const INCIDENT_HIGH: MobileV2IncidentType = Object.freeze({
  id: "collision",
  label: "Vehicle collision",
  icon: "alert" as const,
  severity: "high" as const,
  needs: Object.freeze(["photo", "statement", "call_999"]),
});
const INCIDENT_MED: MobileV2IncidentType = Object.freeze({
  id: "breakdown",
  label: "Breakdown",
  icon: "truck" as const,
  severity: "med" as const,
  needs: Object.freeze(["photo"]),
});
const INCIDENT_LOW: MobileV2IncidentType = Object.freeze({
  id: "complaint",
  label: "Complaint",
  icon: "message" as const,
  severity: "low" as const,
  needs: Object.freeze(["statement"]),
});
const INCIDENT_NO_REQS: MobileV2IncidentType = Object.freeze({
  id: "report-only",
  label: "Report only",
  icon: "info" as const,
  severity: "low" as const,
  needs: Object.freeze(["call_112"]),
});
const TYPES = Object.freeze([INCIDENT_HIGH, INCIDENT_MED, INCIDENT_LOW, INCIDENT_NO_REQS]);

describe("isMobileV2IncidentReady", () => {
  test("returns false when no type is selected", () => {
    expect(
      isMobileV2IncidentReady({
        types: TYPES,
        selectedTypeId: null,
        photoCaptured: true,
        statement: "All requirements satisfied",
      }),
    ).toBe(false);
  });

  test("returns false when selectedTypeId does not match any type", () => {
    expect(
      isMobileV2IncidentReady({
        types: TYPES,
        selectedTypeId: "phantom",
        photoCaptured: true,
        statement: "All requirements satisfied",
      }),
    ).toBe(false);
  });

  test("requires photo when type.needs includes 'photo'", () => {
    expect(
      isMobileV2IncidentReady({
        types: TYPES,
        selectedTypeId: "breakdown",
        photoCaptured: false,
        statement: "",
      }),
    ).toBe(false);
    expect(
      isMobileV2IncidentReady({
        types: TYPES,
        selectedTypeId: "breakdown",
        photoCaptured: true,
        statement: "",
      }),
    ).toBe(true);
  });

  test("requires sufficient statement length when type.needs includes 'statement'", () => {
    expect(
      isMobileV2IncidentReady({
        types: TYPES,
        selectedTypeId: "complaint",
        photoCaptured: false,
        statement: "short",
      }),
    ).toBe(false);
    expect(
      isMobileV2IncidentReady({
        types: TYPES,
        selectedTypeId: "complaint",
        photoCaptured: false,
        statement: "this is a sufficient statement",
      }),
    ).toBe(true);
  });

  test("trims whitespace before measuring statement length", () => {
    const minLen = MOBILE_V2_INCIDENT_MIN_STATEMENT_LEN;
    const paddedShort = "   " + "a".repeat(minLen) + "   ";
    expect(
      isMobileV2IncidentReady({
        types: TYPES,
        selectedTypeId: "complaint",
        photoCaptured: false,
        statement: paddedShort,
      }),
    ).toBe(false);
    const paddedJustOver = "   " + "a".repeat(minLen + 1) + "   ";
    expect(
      isMobileV2IncidentReady({
        types: TYPES,
        selectedTypeId: "complaint",
        photoCaptured: false,
        statement: paddedJustOver,
      }),
    ).toBe(true);
  });

  test("high-severity needing photo + statement requires both", () => {
    expect(
      isMobileV2IncidentReady({
        types: TYPES,
        selectedTypeId: "collision",
        photoCaptured: true,
        statement: "short",
      }),
    ).toBe(false);
    expect(
      isMobileV2IncidentReady({
        types: TYPES,
        selectedTypeId: "collision",
        photoCaptured: false,
        statement: "a long statement that's plenty",
      }),
    ).toBe(false);
    expect(
      isMobileV2IncidentReady({
        types: TYPES,
        selectedTypeId: "collision",
        photoCaptured: true,
        statement: "a long statement that's plenty",
      }),
    ).toBe(true);
  });

  test("call-only needs (call_112/call_999) do not gate readiness", () => {
    expect(
      isMobileV2IncidentReady({
        types: TYPES,
        selectedTypeId: "report-only",
        photoCaptured: false,
        statement: "",
      }),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Damage hold sheet
// ---------------------------------------------------------------------------

const SEVERITIES = Object.freeze<MobileV2DamageSeverity[]>([
  Object.freeze({ id: "minor", label: "Minor", color: "info" as const }),
  Object.freeze({ id: "dented", label: "Dented", color: "warning" as const }),
  Object.freeze({ id: "broken", label: "Broken", color: "danger" as const }),
]);

describe("isMobileV2DamageHoldReady", () => {
  test("returns false when no severity selected", () => {
    expect(
      isMobileV2DamageHoldReady({
        severities: SEVERITIES,
        selectedSeverityId: null,
        note: "this is a fine note",
        photoCaptured: true,
      }),
    ).toBe(false);
  });

  test("returns false when photo not captured", () => {
    expect(
      isMobileV2DamageHoldReady({
        severities: SEVERITIES,
        selectedSeverityId: "dented",
        note: "this is a fine note",
        photoCaptured: false,
      }),
    ).toBe(false);
  });

  test("returns false when note too short (≤ min length)", () => {
    const minLen = MOBILE_V2_DAMAGE_HOLD_MIN_NOTE_LEN;
    expect(
      isMobileV2DamageHoldReady({
        severities: SEVERITIES,
        selectedSeverityId: "dented",
        note: "a".repeat(minLen),
        photoCaptured: true,
      }),
    ).toBe(false);
    expect(
      isMobileV2DamageHoldReady({
        severities: SEVERITIES,
        selectedSeverityId: "dented",
        note: "a".repeat(minLen + 1),
        photoCaptured: true,
      }),
    ).toBe(true);
  });

  test("returns true when all gates pass", () => {
    expect(
      isMobileV2DamageHoldReady({
        severities: SEVERITIES,
        selectedSeverityId: "broken",
        note: "scratched cover",
        photoCaptured: true,
      }),
    ).toBe(true);
  });
});

describe("resolveMobileV2DamageHoldCtaTone", () => {
  const baseReady = {
    severities: SEVERITIES,
    note: "this is a fine note",
    photoCaptured: true,
  } as const;

  test("returns 'soft' when not ready", () => {
    expect(
      resolveMobileV2DamageHoldCtaTone({
        ...baseReady,
        selectedSeverityId: null,
      }),
    ).toBe("soft");
    expect(
      resolveMobileV2DamageHoldCtaTone({
        ...baseReady,
        selectedSeverityId: "dented",
        photoCaptured: false,
      }),
    ).toBe("soft");
  });

  test("returns 'danger' when ready and severity color is 'danger'", () => {
    expect(
      resolveMobileV2DamageHoldCtaTone({
        ...baseReady,
        selectedSeverityId: "broken",
      }),
    ).toBe("danger");
  });

  test("returns 'primary' when ready and severity color is non-danger", () => {
    expect(
      resolveMobileV2DamageHoldCtaTone({
        ...baseReady,
        selectedSeverityId: "minor",
      }),
    ).toBe("primary");
    expect(
      resolveMobileV2DamageHoldCtaTone({
        ...baseReady,
        selectedSeverityId: "dented",
      }),
    ).toBe("primary");
  });
});

// ---------------------------------------------------------------------------
// Cash drop sheet
// ---------------------------------------------------------------------------

describe("computeMobileV2CashDropVariance", () => {
  test("returns counted − expected", () => {
    expect(computeMobileV2CashDropVariance(1000, 800)).toBe(200);
    expect(computeMobileV2CashDropVariance(300, 500)).toBe(-200);
    expect(computeMobileV2CashDropVariance(500, 500)).toBe(0);
  });
});

describe("isMobileV2CashDropReady", () => {
  const base = {
    countedSar: 1000,
    requirePhoto: true,
    photoCaptured: true,
    requireCounterSig: true,
    cashierId: "EMP-99",
  } as const;

  test("returns false when nothing has been counted", () => {
    expect(isMobileV2CashDropReady({ ...base, countedSar: 0 })).toBe(false);
  });

  test("returns false when a policy-required photo is missing", () => {
    expect(isMobileV2CashDropReady({ ...base, photoCaptured: false })).toBe(false);
  });

  test("returns false when a policy-required cashier id is too short", () => {
    expect(isMobileV2CashDropReady({ ...base, cashierId: "ab" })).toBe(false);
  });

  test("ignores the photo / cashier gates when policy does not require them", () => {
    expect(
      isMobileV2CashDropReady({
        countedSar: 1000,
        requirePhoto: false,
        photoCaptured: false,
        requireCounterSig: false,
        cashierId: "",
      }),
    ).toBe(true);
  });

  test("returns true even when variance ≠ 0 (variance is non-blocking)", () => {
    expect(isMobileV2CashDropReady({ ...base, countedSar: 800 })).toBe(true);
    expect(isMobileV2CashDropReady({ ...base, countedSar: 1200 })).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Receive sheet
// ---------------------------------------------------------------------------

describe("resolveMobileV2ReceiveSubtitle", () => {
  test("falls back to manifest-ID format when subtitle omitted", () => {
    expect(resolveMobileV2ReceiveSubtitle({ manifestId: "WB-RYD-7740" })).toBe(
      "Line-haul · manifest WB-RYD-7740",
    );
  });

  test("returns caller subtitle verbatim when provided (initial-state alias)", () => {
    expect(
      resolveMobileV2ReceiveSubtitle({
        subtitle: "Line-haul · scan all parcels",
        manifestId: "WB-RYD-7740",
      }),
    ).toBe("Line-haul · scan all parcels");
  });

  test("treats empty subtitle string as omitted and falls back", () => {
    expect(
      resolveMobileV2ReceiveSubtitle({ subtitle: "", manifestId: "WB-RYD-9999" }),
    ).toBe("Line-haul · manifest WB-RYD-9999");
  });

  test("returns whitespace-only subtitle verbatim (caller is responsible for trimming)", () => {
    // Caller controls the string — whitespace can be intentional padding
    // for alignment or RTL languages. The helper does not silently trim.
    expect(
      resolveMobileV2ReceiveSubtitle({ subtitle: "  ", manifestId: "WB-RYD-9999" }),
    ).toBe("  ");
  });
});

// ---------------------------------------------------------------------------
// Return sheet
// ---------------------------------------------------------------------------

describe("isMobileV2ReturnReady", () => {
  test("returns false when selectedTypeId is null", () => {
    expect(
      isMobileV2ReturnReady({ selectedTypeId: null, photoCaptured: true }),
    ).toBe(false);
  });

  test("returns false when photo not captured", () => {
    expect(
      isMobileV2ReturnReady({ selectedTypeId: "refused", photoCaptured: false }),
    ).toBe(false);
  });

  test("returns true when type picked AND photo captured", () => {
    expect(
      isMobileV2ReturnReady({ selectedTypeId: "refused", photoCaptured: true }),
    ).toBe(true);
  });
});

// EOD recon sheet (mobile-v2-sheet-eod-recon.tsx) renders caller-supplied
// inventory rows and derives its variance count inline from row.count vs
// row.expected, so it exposes no separate readiness helper to unit-test.
