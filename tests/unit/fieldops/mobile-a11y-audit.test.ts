import {
  computeContrastRatio,
  hasMinTouchTarget,
  meetsWcagAa,
  runA11yAudit,
  sanitizeA11yLabel,
  type A11yElement,
  type A11yFinding,
} from "../../../apps/fieldops/src/mobile-a11y-audit";

function makeElement(overrides: Partial<A11yElement> = {}): A11yElement {
  return {
    tag: "div",
    role: null,
    accessibilityLabel: null,
    accessibilityRole: null,
    accessibilityState: null,
    text: "",
    testID: null,
    widthPx: 48,
    heightPx: 48,
    fontSize: 16,
    fgColor: "#111111",
    bgColor: "#ffffff",
    ...overrides,
  };
}

function pickFinding(
  findings: A11yFinding[],
  id: string
): A11yFinding | undefined {
  return findings.find((entry) => entry.id === id);
}

describe("hasMinTouchTarget", () => {
  test("accepts exact 44x44 target", () => {
    expect(hasMinTouchTarget(44, 44)).toBe(true);
  });

  test("rejects 30x44 target", () => {
    expect(hasMinTouchTarget(30, 44)).toBe(false);
  });

  test("rejects 44x30 target", () => {
    expect(hasMinTouchTarget(44, 30)).toBe(false);
  });

  test("rejects negative width", () => {
    expect(hasMinTouchTarget(-1, 60)).toBe(false);
  });

  test("rejects NaN height", () => {
    expect(hasMinTouchTarget(60, Number.NaN)).toBe(false);
  });

  test("respects custom minPx override", () => {
    expect(hasMinTouchTarget(48, 48, 50)).toBe(false);
    expect(hasMinTouchTarget(50, 50, 50)).toBe(true);
  });
});

describe("computeContrastRatio", () => {
  test("returns 21 for white on black", () => {
    expect(computeContrastRatio("#ffffff", "#000000")).toBe(21);
  });

  test("returns 1 for identical colours", () => {
    expect(computeContrastRatio("#808080", "#808080")).toBe(1);
  });

  test("is symmetric between fg and bg", () => {
    const a = computeContrastRatio("#1e88e5", "#ffffff");
    const b = computeContrastRatio("#ffffff", "#1e88e5");
    expect(a).toBe(b);
  });

  test("returns 0 for unparseable hex", () => {
    expect(computeContrastRatio("not-a-color", "#ffffff")).toBe(0);
  });

  test("accepts 3-char shorthand hex", () => {
    const ratio = computeContrastRatio("#000", "#fff");
    expect(ratio).toBe(21);
  });
});

describe("meetsWcagAa", () => {
  test("fails at 4.49 for normal text", () => {
    expect(meetsWcagAa(4.49, false)).toBe(false);
  });

  test("passes at 4.5 for normal text", () => {
    expect(meetsWcagAa(4.5, false)).toBe(true);
  });

  test("passes at 3 for large text", () => {
    expect(meetsWcagAa(3, true)).toBe(true);
  });

  test("fails at 2.9 for large text", () => {
    expect(meetsWcagAa(2.9, true)).toBe(false);
  });

  test("rejects zero contrast ratio", () => {
    expect(meetsWcagAa(0, false)).toBe(false);
  });
});

describe("sanitizeA11yLabel", () => {
  test("collapses whitespace", () => {
    expect(sanitizeA11yLabel("  Sign   in  now  ")).toBe("Sign in now");
  });

  test("strips control chars", () => {
    expect(sanitizeA11yLabel("Scan\u0000Package")).toBe("Scan Package");
  });

  test("returns empty string for non-string", () => {
    // @ts-expect-error deliberately passing non-string to assert runtime guard
    expect(sanitizeA11yLabel(undefined)).toBe("");
  });
});

describe("runA11yAudit - empty inputs", () => {
  test("returns empty array when dom is missing", () => {
    expect(runA11yAudit({})).toEqual([]);
  });

  test("returns empty array when elements is empty", () => {
    expect(runA11yAudit({ dom: { elements: [] } })).toEqual([]);
  });
});

describe("runA11yAudit - CRITICAL: interactive without label", () => {
  test("flags role=button with no label and no text", () => {
    const element = makeElement({
      role: "button",
      testID: null,
    });
    const findings = runA11yAudit({ dom: { elements: [element] } });
    const critical = pickFinding(
      findings,
      "mobile-a11y.interactive-missing-label"
    );
    expect(critical).toBeDefined();
    expect(critical!.severity).toBe("critical");
    expect(critical!.criterion).toBe("WCAG 4.1.2");
  });

  test("flags mobile- testID with no label and no text", () => {
    const element = makeElement({
      testID: "mobile-signin-submit",
    });
    const findings = runA11yAudit({ dom: { elements: [element] } });
    expect(
      pickFinding(findings, "mobile-a11y.interactive-missing-label")
    ).toBeDefined();
  });

  test("does not flag when text is present", () => {
    const element = makeElement({
      role: "button",
      text: "Sign in",
    });
    const findings = runA11yAudit({ dom: { elements: [element] } });
    expect(
      pickFinding(findings, "mobile-a11y.interactive-missing-label")
    ).toBeUndefined();
  });

  test("does not flag when accessibilityLabel is present", () => {
    const element = makeElement({
      role: "button",
      accessibilityLabel: "Sign in",
    });
    const findings = runA11yAudit({ dom: { elements: [element] } });
    expect(
      pickFinding(findings, "mobile-a11y.interactive-missing-label")
    ).toBeUndefined();
  });
});

describe("runA11yAudit - MAJOR: touch target", () => {
  test("flags interactive element smaller than 44x44", () => {
    const element = makeElement({
      role: "button",
      accessibilityLabel: "Close",
      widthPx: 30,
      heightPx: 30,
    });
    const findings = runA11yAudit({ dom: { elements: [element] } });
    const ft = pickFinding(findings, "mobile-a11y.touch-target-too-small");
    expect(ft).toBeDefined();
    expect(ft!.severity).toBe("major");
    expect(ft!.criterion).toBe("WCAG 2.5.5");
    expect(ft!.message).toContain("30x30");
  });

  test("does not flag non-interactive elements below 44px", () => {
    const element = makeElement({
      widthPx: 12,
      heightPx: 12,
    });
    const findings = runA11yAudit({ dom: { elements: [element] } });
    expect(
      pickFinding(findings, "mobile-a11y.touch-target-too-small")
    ).toBeUndefined();
  });
});

describe("runA11yAudit - MAJOR: contrast below AA", () => {
  test("flags low-contrast normal text", () => {
    const element = makeElement({
      text: "Hello",
      fgColor: "#bbbbbb",
      bgColor: "#ffffff",
      fontSize: 14,
    });
    const findings = runA11yAudit({ dom: { elements: [element] } });
    const contrast = pickFinding(findings, "mobile-a11y.contrast-below-aa");
    expect(contrast).toBeDefined();
    expect(contrast!.severity).toBe("major");
    expect(contrast!.criterion).toBe("WCAG 1.4.3");
  });

  test("passes high contrast combination", () => {
    const element = makeElement({
      text: "Hello",
      fgColor: "#000000",
      bgColor: "#ffffff",
    });
    const findings = runA11yAudit({ dom: { elements: [element] } });
    expect(
      pickFinding(findings, "mobile-a11y.contrast-below-aa")
    ).toBeUndefined();
  });

  test("uses large-text threshold when fontSize >= 18pt", () => {
    const element = makeElement({
      text: "Hello",
      fgColor: "#949494",
      bgColor: "#ffffff",
      fontSize: 20,
    });
    const findings = runA11yAudit({ dom: { elements: [element] } });
    expect(
      pickFinding(findings, "mobile-a11y.contrast-below-aa")
    ).toBeUndefined();
  });

  test("skips contrast check when colours are missing", () => {
    const element = makeElement({
      text: "Hello",
      fgColor: null,
      bgColor: null,
    });
    const findings = runA11yAudit({ dom: { elements: [element] } });
    expect(
      pickFinding(findings, "mobile-a11y.contrast-below-aa")
    ).toBeUndefined();
  });
});

describe("runA11yAudit - MAJOR: disabled button without cue", () => {
  test("flags disabled button without qualifier/opacity cue", () => {
    const element = makeElement({
      accessibilityRole: "button",
      accessibilityState: { disabled: true },
      accessibilityLabel: "Submit",
      text: "Submit",
    });
    const findings = runA11yAudit({ dom: { elements: [element] } });
    const disabled = pickFinding(
      findings,
      "mobile-a11y.disabled-missing-cue"
    );
    expect(disabled).toBeDefined();
    expect(disabled!.severity).toBe("major");
  });

  test("does not flag when label includes 'disabled' qualifier", () => {
    const element = makeElement({
      accessibilityRole: "button",
      accessibilityState: { disabled: true },
      accessibilityLabel: "Submit (disabled)",
      text: "Submit",
    });
    const findings = runA11yAudit({ dom: { elements: [element] } });
    expect(
      pickFinding(findings, "mobile-a11y.disabled-missing-cue")
    ).toBeUndefined();
  });

  test("does not flag when testID encodes disabled state", () => {
    const element = makeElement({
      accessibilityRole: "button",
      accessibilityState: { disabled: true },
      accessibilityLabel: "Submit",
      text: "Submit",
      testID: "mobile-submit-disabled",
    });
    const findings = runA11yAudit({ dom: { elements: [element] } });
    expect(
      pickFinding(findings, "mobile-a11y.disabled-missing-cue")
    ).toBeUndefined();
  });
});

describe("runA11yAudit - MINOR: testID without label", () => {
  test("emits minor finding when testID exists but label is null", () => {
    const element = makeElement({
      testID: "mobile-scan-button",
      accessibilityLabel: null,
      text: "Scan",
    });
    const findings = runA11yAudit({ dom: { elements: [element] } });
    const minor = pickFinding(findings, "mobile-a11y.testid-missing-label");
    expect(minor).toBeDefined();
    expect(minor!.severity).toBe("minor");
  });

  test("does not emit minor when label is present", () => {
    const element = makeElement({
      testID: "mobile-scan-button",
      accessibilityLabel: "Scan parcel",
    });
    const findings = runA11yAudit({ dom: { elements: [element] } });
    expect(
      pickFinding(findings, "mobile-a11y.testid-missing-label")
    ).toBeUndefined();
  });
});

describe("runA11yAudit - target derivation", () => {
  test("prefers testID over label", () => {
    const element = makeElement({
      role: "button",
      widthPx: 30,
      heightPx: 30,
      testID: "mobile-close",
      accessibilityLabel: "Close",
    });
    const findings = runA11yAudit({ dom: { elements: [element] } });
    const ft = pickFinding(findings, "mobile-a11y.touch-target-too-small")!;
    expect(ft.target).toEqual({ kind: "testID", value: "mobile-close" });
  });

  test("falls back to sanitized label when testID is missing", () => {
    const element = makeElement({
      role: "button",
      widthPx: 30,
      heightPx: 30,
      accessibilityLabel: "  Close   dialog  ",
    });
    const findings = runA11yAudit({ dom: { elements: [element] } });
    const ft = pickFinding(findings, "mobile-a11y.touch-target-too-small")!;
    expect(ft.target).toEqual({ kind: "label", value: "Close dialog" });
  });

  test("falls back to role when no testID and no label", () => {
    const element = makeElement({
      role: "button",
      widthPx: 30,
      heightPx: 30,
      text: "X",
    });
    const findings = runA11yAudit({ dom: { elements: [element] } });
    const ft = pickFinding(findings, "mobile-a11y.touch-target-too-small")!;
    expect(ft.target).toEqual({ kind: "role", value: "button" });
  });
});

describe("runA11yAudit - multi-finding and order stability", () => {
  test("emits multiple findings for a single element where applicable", () => {
    const element = makeElement({
      role: "button",
      widthPx: 20,
      heightPx: 20,
      testID: "mobile-oops",
      accessibilityLabel: null,
      text: "",
      fgColor: "#cccccc",
      bgColor: "#ffffff",
    });
    const findings = runA11yAudit({ dom: { elements: [element] } });
    const ids = findings.map((entry) => entry.id);
    expect(ids).toEqual(
      expect.arrayContaining([
        "mobile-a11y.interactive-missing-label",
        "mobile-a11y.touch-target-too-small",
        "mobile-a11y.contrast-below-aa",
        "mobile-a11y.testid-missing-label",
      ])
    );
  });

  test("ignores malformed entries without throwing", () => {
    const elements = [
      null,
      undefined,
      makeElement({ role: "button", text: "OK" }),
    ] as unknown as A11yElement[];
    expect(() => runA11yAudit({ dom: { elements } })).not.toThrow();
  });

  test("preserves insertion order across multiple elements", () => {
    const elements: A11yElement[] = [
      makeElement({ role: "button", text: "", testID: "mobile-a" }),
      makeElement({ role: "button", text: "", testID: "mobile-b" }),
    ];
    const findings = runA11yAudit({ dom: { elements } });
    const firstMatch = findings.find(
      (entry) => entry.target?.value === "mobile-a"
    );
    const secondMatch = findings.find(
      (entry) => entry.target?.value === "mobile-b"
    );
    expect(firstMatch).toBeDefined();
    expect(secondMatch).toBeDefined();
    expect(findings.indexOf(firstMatch!)).toBeLessThan(
      findings.indexOf(secondMatch!)
    );
  });
});

describe("runA11yAudit - fix hints", () => {
  test("every finding has a non-empty fix_hint", () => {
    const element = makeElement({
      role: "button",
      widthPx: 10,
      heightPx: 10,
      testID: "mobile-z",
      accessibilityLabel: null,
      text: "",
      fgColor: "#dddddd",
      bgColor: "#ffffff",
    });
    const findings = runA11yAudit({ dom: { elements: [element] } });
    expect(findings.length).toBeGreaterThan(0);
    for (const finding of findings) {
      expect(typeof finding.fix_hint).toBe("string");
      expect(finding.fix_hint.length).toBeGreaterThan(0);
    }
  });
});
