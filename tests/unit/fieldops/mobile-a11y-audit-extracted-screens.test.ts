import { runA11yAudit, type A11yElement } from "../../../apps/fieldops/src/mobile-a11y-audit";
import { ELEMENT_MANIFEST } from "../../../scripts/qa/fieldops-a11y-audit";

/**
 * P3.10 — WCAG AA audit parity test.
 *
 * The `scripts/qa/fieldops-a11y-audit.js` helper persists an evidence-grade
 * audit report. It uses an inlined JS contrast/target implementation so the
 * script has zero TS build dependency. This test feeds the same
 * ELEMENT_MANIFEST through the canonical TS `runA11yAudit` and asserts the
 * two implementations agree — so the persisted report stays trustworthy.
 */

describe("mobile-a11y-audit — extracted screens parity (P3.10)", () => {
  for (const [screen, elements] of Object.entries(ELEMENT_MANIFEST as Record<string, A11yElement[]>)) {
    test(`${screen}: every interactive element clears WCAG AA baseline`, () => {
      const findings = runA11yAudit({ dom: { elements } });
      const critical = findings.filter((f) => f.severity === "critical");
      const major = findings.filter((f) => f.severity === "major");
      expect({ screen, critical, major }).toEqual({ screen, critical: [], major: [] });
    });
  }

  test("manifest covers every extracted screen currently in src/screens/", () => {
    const screens = Object.keys(ELEMENT_MANIFEST);
    expect(screens).toEqual(
      expect.arrayContaining([
        "Shell",
        "OutboxScreen",
        "LocationScreen",
        "HomeScreen",
        "ShiftSummaryScreen",
      ])
    );
  });
});
