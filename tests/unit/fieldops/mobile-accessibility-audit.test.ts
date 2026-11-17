import {
  DEFAULT_MOBILE_ACCESSIBILITY_POLICY,
  auditMobileAccessibilitySnapshot,
  computeMobileContrastRatio,
  normalizeMobileAccessibilityPolicy,
  sanitizeMobileAccessibilityText,
  type MobileAccessibilityElement,
} from "../../../apps/fieldops/src/mobile-accessibility-audit";

function element(
  overrides: Partial<MobileAccessibilityElement> = {}
): MobileAccessibilityElement {
  return {
    id: "mobile-control",
    interactive: true,
    role: "button",
    label: "Continue",
    text: "Continue",
    widthDp: 44,
    heightDp: 44,
    fontSizePt: 16,
    fontWeight: "400",
    foregroundColor: "#0f172a",
    backgroundColor: "#ffffff",
    disabled: false,
    accessibilityStateDisabled: false,
    ...overrides,
  };
}

describe("mobile accessibility policy", () => {
  test("keeps FieldOps defaults when a policy row is absent", () => {
    expect(normalizeMobileAccessibilityPolicy(null)).toEqual(
      DEFAULT_MOBILE_ACCESSIBILITY_POLICY
    );
  });

  test("accepts stronger row-driven thresholds", () => {
    expect(
      normalizeMobileAccessibilityPolicy({
        minimum_touch_target_dp: 48,
        normal_text_contrast_ratio: 7,
        large_text_contrast_ratio: 4.5,
      })
    ).toEqual(
      expect.objectContaining({
        minimumTouchTargetDp: 48,
        normalTextContrastRatio: 7,
        largeTextContrastRatio: 4.5,
      })
    );
  });

  test("does not let a policy row weaken WCAG AA minimums", () => {
    expect(
      normalizeMobileAccessibilityPolicy({
        minimum_touch_target_dp: 8,
        normal_text_contrast_ratio: 1,
        large_text_contrast_ratio: 1,
        large_text_minimum_pt: 8,
        large_bold_text_minimum_pt: 8,
      })
    ).toEqual(
      expect.objectContaining({
        minimumTouchTargetDp: 24,
        normalTextContrastRatio: 4.5,
        largeTextContrastRatio: 3,
        largeTextMinimumPt: 18,
        largeBoldTextMinimumPt: 14,
      })
    );
  });
});

describe("mobile accessibility primitives", () => {
  test("computes WCAG contrast deterministically", () => {
    expect(computeMobileContrastRatio("#fff", "#000000")).toBe(21);
    expect(computeMobileContrastRatio("invalid", "#000000")).toBeNull();
  });

  test("normalizes labels without preserving control characters", () => {
    expect(sanitizeMobileAccessibilityText("  Open\u0000  menu ")).toBe("Open menu");
  });
});

describe("mobile accessibility snapshot audit", () => {
  test("passes a named, role-bearing, 44dp high-contrast control", () => {
    expect(auditMobileAccessibilitySnapshot({ elements: [element()] })).toEqual([]);
  });

  test("reports missing accessible names and roles", () => {
    const findings = auditMobileAccessibilitySnapshot({
      elements: [element({ role: null, label: null, text: null })],
    });
    expect(findings.map((finding) => finding.id)).toEqual(
      expect.arrayContaining([
        "mobile-a11y.interactive-missing-label",
        "mobile-a11y.interactive-role-missing",
      ])
    );
  });

  test("separates WCAG AA target failure from the stronger FieldOps policy", () => {
    const belowWcag = auditMobileAccessibilitySnapshot({
      elements: [element({ widthDp: 20, heightDp: 20 })],
    });
    const belowFieldOps = auditMobileAccessibilitySnapshot({
      elements: [element({ widthDp: 32, heightDp: 32 })],
    });

    expect(belowWcag.map((finding) => finding.id)).toContain(
      "mobile-a11y.touch-target-below-wcag-aa"
    );
    expect(belowWcag.map((finding) => finding.id)).toContain(
      "mobile-a11y.touch-target-too-small"
    );
    expect(belowFieldOps.map((finding) => finding.id)).toContain(
      "mobile-a11y.touch-target-too-small"
    );
    expect(belowFieldOps.map((finding) => finding.id)).not.toContain(
      "mobile-a11y.touch-target-below-wcag-aa"
    );
  });

  test("uses the row-driven touch target threshold", () => {
    const findings = auditMobileAccessibilitySnapshot({
      policy: { minimum_touch_target_dp: 48 },
      elements: [element({ widthDp: 44, heightDp: 44 })],
    });
    expect(findings).toEqual([
      expect.objectContaining({
        id: "mobile-a11y.touch-target-too-small",
        message: expect.stringContaining("48dp"),
      }),
    ]);
  });

  test("reports a disabled control whose state is not exposed", () => {
    const findings = auditMobileAccessibilitySnapshot({
      elements: [element({ disabled: true, accessibilityStateDisabled: null })],
    });
    expect(findings.map((finding) => finding.id)).toContain(
      "mobile-a11y.disabled-state-not-exposed"
    );
  });

  test("applies normal and large-text contrast thresholds", () => {
    const normal = auditMobileAccessibilitySnapshot({
      elements: [
        element({
          foregroundColor: "#777777",
          backgroundColor: "#ffffff",
          fontSizePt: 16,
        }),
      ],
    });
    const largeBold = auditMobileAccessibilitySnapshot({
      elements: [
        element({
          foregroundColor: "#777777",
          backgroundColor: "#ffffff",
          fontSizePt: 14,
          fontWeight: "700",
        }),
      ],
    });
    expect(normal.map((finding) => finding.id)).toContain(
      "mobile-a11y.contrast-below-aa"
    );
    expect(largeBold.map((finding) => finding.id)).not.toContain(
      "mobile-a11y.contrast-below-aa"
    );
  });

  test("fails closed when supplied colors cannot be evaluated", () => {
    const findings = auditMobileAccessibilitySnapshot({
      elements: [element({ foregroundColor: "rgb(0, 0, 0)" })],
    });
    expect(findings.map((finding) => finding.id)).toContain(
      "mobile-a11y.contrast-unverifiable"
    );
  });

  test("does not emit findings when the resolved policy disables collection", () => {
    expect(
      auditMobileAccessibilitySnapshot({
        policy: { enabled: false },
        elements: [element({ role: null, label: null, text: null })],
      })
    ).toEqual([]);
  });
});


describe("selected accessibility report obligations", () => {
  test.each([undefined, null, false, true])("disabled cue evidence %s remains distinct from exposed state", cue => {
    const findings = auditMobileAccessibilitySnapshot({ elements: [element({
      disabled: true, accessibilityStateDisabled: true, disabledVisualCue: cue,
      id: "mobile-disabled", label: "Submit (disabled)", text: "Submit (disabled)",
    })] });
    const ids = findings.map(finding => finding.id);
    expect(ids).not.toContain("mobile-a11y.disabled-state-not-exposed");
    if (cue === true) expect(ids).toEqual([]);
    else expect(ids).toEqual([cue === false
      ? "mobile-a11y.disabled-missing-cue" : "mobile-a11y.disabled-visual-cue-unverifiable"]);
  });
  test("visible cue does not substitute for exposing disabled state", () => {
    const findings = auditMobileAccessibilitySnapshot({ elements: [element({
      disabled: true, accessibilityStateDisabled: false, disabledVisualCue: true,
    })] });
    expect(findings.map(finding => finding.id)).toEqual(["mobile-a11y.disabled-state-not-exposed"]);
  });
  test("noninteractive and enabled elements do not need disabled-cue evidence", () => {
    expect(auditMobileAccessibilitySnapshot({ elements: [
      element({ disabledVisualCue: false }),
      element({ interactive: false, disabled: true, accessibilityStateDisabled: true }),
    ] })).toEqual([]);
  });
  test("all findings are actionable and preserve deterministic current target/order", () => {
    const elements = [
      element({ id: "first", role: null, label: null, text: " ", widthDp: 0,
        disabled: true, accessibilityStateDisabled: null, foregroundColor: "#fff", backgroundColor: "#fff" }),
      element({ id: "second", foregroundColor: "invalid" }),
      element({ id: "third", widthDp: 32, heightDp: 32 }),
    ];
    const findings = auditMobileAccessibilitySnapshot({ elements });
    expect(findings.length).toBeGreaterThan(5);
    expect(findings).toEqual(auditMobileAccessibilitySnapshot({ elements }));
    for (const finding of findings) expect(finding.fix_hint.trim().length).toBeGreaterThan(0);
    expect(findings.map(finding => finding.target)).toEqual([
      ...Array(findings.filter(finding => finding.target?.value === "first").length)
        .fill({ kind: "testID", value: "first" }),
      { kind: "testID", value: "second" },
      { kind: "testID", value: "third" },
    ]);
  });
  test("preserves historical report identities, severities and typed target fallbacks", () => {
    const findings = auditMobileAccessibilitySnapshot({ elements: [
      element({ id: null, label: null, text: null, role: null }),
      element({ id: null, label: "Label target", foregroundColor: "invalid" }),
      element({ id: null, label: null, text: "Text target", foregroundColor: "invalid" }),
      element({ id: null, label: null, text: null, role: "button" }),
      element({ widthDp: 32, heightDp: 32 }),
      element({ disabled: true, accessibilityStateDisabled: true, disabledVisualCue: false }),
      element({ foregroundColor: "#777777", backgroundColor: "#ffffff" }),
    ] });
    expect(findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "mobile-a11y.interactive-missing-label", severity: "critical", target: null }),
      expect.objectContaining({ id: "mobile-a11y.touch-target-too-small", severity: "major" }),
      expect.objectContaining({ id: "mobile-a11y.disabled-missing-cue", severity: "major" }),
      expect.objectContaining({ id: "mobile-a11y.contrast-below-aa", severity: "major" }),
      expect.objectContaining({ target: { kind: "label", value: "Label target" } }),
      expect.objectContaining({ target: { kind: "text", value: "Text target" } }),
      expect.objectContaining({ target: { kind: "role", value: "button" } }),
    ]));
  });
  test("visible text names controls without blanket testID-label warnings", () => {
    expect(auditMobileAccessibilitySnapshot({ elements: [element({ label: null, text: "Continue" })] })).toEqual([]);
  });
});


describe("current connectivity banner accessibility", () => {
  test("exposes its localized title and summary as a polite alert", () => {
    const fs = require("fs");
    const path = require("path");
    const ts = require("typescript");
    const vm = require("vm");
    const source = fs.readFileSync(path.resolve(__dirname, "../../../apps/fieldops/App.tsx"), "utf8");
    const parsed = ts.createSourceFile("App.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const banners: any[] = [];
    function visit(node: any) {
      if (ts.isJsxOpeningElement(node) && node.tagName.getText(parsed) === "View") {
        const style = node.attributes.properties.find((prop: any) => prop.name?.getText(parsed) === "style");
        if (style?.getText(parsed).includes("styles.connectivityBanner,")) banners.push(node);
      }
      ts.forEachChild(node, visit);
    }
    visit(parsed);
    expect(banners).toHaveLength(1);
    const props = banners[0].attributes.properties;
    const attr = (name: string) => props.find((prop: any) => prop.name?.getText(parsed) === name);
    expect(attr("accessible")).toBeDefined();
    expect(attr("accessible").initializer).toBeUndefined();
    expect(attr("accessibilityRole").initializer.text).toBe("alert");
    expect(attr("accessibilityLiveRegion").initializer.text).toBe("polite");
    const expression = attr("accessibilityLabel").initializer.expression.getText(parsed);
    for (const shell of [
      { offlineMode: "Offline mode", degradedTitle: "Connectivity degraded" },
      { offlineMode: "وضع عدم الاتصال", degradedTitle: "الاتصال ضعيف" },
    ]) {
      for (const connectivityStatus of ["offline", "degraded"]) {
        const connectivitySummary = "3 pending";
        const label = vm.runInNewContext(expression, { connectivityStatus, connectivitySummary, strings: { shell } });
        expect(label).toBe((connectivityStatus === "offline" ? shell.offlineMode : shell.degradedTitle) + ". " + connectivitySummary);
      }
    }
  });
});
