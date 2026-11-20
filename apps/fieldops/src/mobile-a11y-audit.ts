/**
 * Mobile FieldOps WCAG 2.1 AA runtime accessibility audit helpers.
 *
 * Pure, dependency-free TypeScript so the runtime diagnostics screen can
 * capture either the web DOM or a flattened React Native ARIA tree and run
 * a structured check pass, emitting findings that downstream reports (and
 * future Detox/Maestro traces) can consume.
 *
 * Contract is append-only: new rules must add new `id`s and preserve the
 * semantics of existing severities so historical audits remain comparable.
 */

export type A11ySeverity = "critical" | "major" | "minor";

export type A11yTargetKind = "role" | "testID" | "label";

export type A11yTarget = {
  kind: A11yTargetKind;
  value: string;
};

export type A11yFinding = {
  id: string;
  severity: A11ySeverity;
  criterion: string;
  message: string;
  target: A11yTarget | null;
  fix_hint: string;
};

export type A11yElement = {
  tag: string;
  role: string | null;
  accessibilityLabel: string | null;
  accessibilityRole: string | null;
  accessibilityState: Record<string, boolean> | null;
  text: string;
  testID: string | null;
  widthPx: number;
  heightPx: number;
  fontSize: number | null;
  fgColor: string | null;
  bgColor: string | null;
};

export type A11yCheckInput = {
  dom?: {
    elements: A11yElement[];
  };
};

const MIN_TOUCH_TARGET_PX = 44;
const WCAG_AA_NORMAL = 4.5;
const WCAG_AA_LARGE = 3;
const LARGE_TEXT_MIN_PT = 18;
const LARGE_TEXT_BOLD_MIN_PT = 14;

const MOBILE_TESTID_PREFIX = "mobile-";

/**
 * Returns true when both sides of the hit rect meet the minimum touch target.
 *
 * WCAG 2.1 SC 2.5.5 (Level AAA) recommends >= 44x44 CSS px; the FieldOps
 * design system treats 44px as the baseline for all interactive targets.
 */
export function hasMinTouchTarget(
  widthPx: number,
  heightPx: number,
  minPx: number = MIN_TOUCH_TARGET_PX
): boolean {
  if (!Number.isFinite(widthPx) || !Number.isFinite(heightPx)) return false;
  if (!Number.isFinite(minPx)) return false;
  if (widthPx < 0 || heightPx < 0) return false;
  return widthPx >= minPx && heightPx >= minPx;
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

function parseHexChannel(hex: string, start: number): number {
  const slice = hex.slice(start, start + 2);
  const value = Number.parseInt(slice, 16);
  return Number.isFinite(value) ? value : NaN;
}

function normalizeHex(hex: string): string | null {
  if (typeof hex !== "string") return null;
  let value = hex.trim();
  if (!value) return null;
  if (value.startsWith("#")) value = value.slice(1);
  if (value.length === 3) {
    value = value
      .split("")
      .map((c) => `${c}${c}`)
      .join("");
  }
  if (value.length !== 6) return null;
  if (!/^[0-9a-fA-F]{6}$/.test(value)) return null;
  return value.toLowerCase();
}

function relativeLuminance(hex: string): number {
  const normalized = normalizeHex(hex);
  if (!normalized) return NaN;
  const r = parseHexChannel(normalized, 0);
  const g = parseHexChannel(normalized, 2);
  const b = parseHexChannel(normalized, 4);
  if (!Number.isFinite(r) || !Number.isFinite(g) || !Number.isFinite(b)) {
    return NaN;
  }
  const toLinear = (channel: number): number => {
    const s = clamp01(channel / 255);
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
}

/**
 * WCAG 2.1 relative luminance contrast ratio.
 *
 * Returns 0 when either colour cannot be parsed as a `#rgb` or `#rrggbb`
 * value so callers can treat it as a fail-closed signal without blowing up
 * on empty/legacy styles.
 */
export function computeContrastRatio(fgHex: string, bgHex: string): number {
  const fgLum = relativeLuminance(fgHex);
  const bgLum = relativeLuminance(bgHex);
  if (!Number.isFinite(fgLum) || !Number.isFinite(bgLum)) return 0;
  const lighter = Math.max(fgLum, bgLum);
  const darker = Math.min(fgLum, bgLum);
  const ratio = (lighter + 0.05) / (darker + 0.05);
  return Math.round(ratio * 100) / 100;
}

/**
 * Returns true when the provided ratio satisfies WCAG 1.4.3 AA.
 *
 * Large text threshold is 3.0:1; normal text is 4.5:1. The caller is
 * responsible for classifying text as large (>= 18pt / >= 14pt bold).
 */
export function meetsWcagAa(
  contrastRatio: number,
  isLargeText: boolean
): boolean {
  if (!Number.isFinite(contrastRatio)) return false;
  if (contrastRatio <= 0) return false;
  return contrastRatio >= (isLargeText ? WCAG_AA_LARGE : WCAG_AA_NORMAL);
}

/**
 * Normalizes an accessibility label for diff/comparison use in reports.
 * Strips excessive whitespace and collapses non-printable characters so
 * two visually-identical labels do not diverge across audit runs.
 */
export function sanitizeA11yLabel(label: string): string {
  if (typeof label !== "string") return "";
  return label
    .replace(/[\u0000-\u001F\u007F]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function deriveTarget(element: A11yElement): A11yTarget | null {
  if (element.testID) {
    return { kind: "testID", value: element.testID };
  }
  if (element.accessibilityLabel) {
    const sanitized = sanitizeA11yLabel(element.accessibilityLabel);
    if (sanitized) return { kind: "label", value: sanitized };
  }
  if (element.accessibilityRole) {
    return { kind: "role", value: element.accessibilityRole };
  }
  if (element.role) {
    return { kind: "role", value: element.role };
  }
  return null;
}

function isInteractive(element: A11yElement): boolean {
  if (element.role === "button") return true;
  if (element.accessibilityRole === "button") return true;
  if (element.testID && element.testID.startsWith(MOBILE_TESTID_PREFIX)) {
    return true;
  }
  return false;
}

function isLargeText(element: A11yElement): boolean {
  if (!element.fontSize || !Number.isFinite(element.fontSize)) return false;
  if (element.fontSize >= LARGE_TEXT_MIN_PT) return true;
  // A RN ARIA tree cannot always tell us the weight; we conservatively
  // classify >= 14pt as "large" only when a bold hint is surfaced via
  // accessibilityState.selected/bold (future-proofed for screen reader
  // bold hints). Most FieldOps labels are regular, so we default to false
  // when no explicit weight signal is provided.
  if (
    element.fontSize >= LARGE_TEXT_BOLD_MIN_PT &&
    element.accessibilityState &&
    element.accessibilityState.bold === true
  ) {
    return true;
  }
  return false;
}

function hasDisabledVisualCue(element: A11yElement): boolean {
  const sanitizedLabel = sanitizeA11yLabel(element.accessibilityLabel ?? "");
  const sanitizedText = sanitizeA11yLabel(element.text ?? "");
  const qualifier = /(disabled|unavailable|blocked|locked)/i;
  if (qualifier.test(sanitizedLabel)) return true;
  if (qualifier.test(sanitizedText)) return true;
  // Opacity/tint cues are not encoded in the ARIA tree directly; callers
  // that know a disabled element still has a visible greyscale tint should
  // set accessibilityState.grey or a `disabled-*` testID to opt-out here.
  if (element.testID && /disabled/i.test(element.testID)) return true;
  return false;
}

function pushFinding(
  out: A11yFinding[],
  finding: A11yFinding
): void {
  out.push(finding);
}

/**
 * Runs every WCAG 2.1 AA rule supported by this module over the provided
 * input and returns a stable, insertion-ordered list of findings.
 */
export function runA11yAudit(input: A11yCheckInput): A11yFinding[] {
  const findings: A11yFinding[] = [];
  const elements = input?.dom?.elements;
  if (!Array.isArray(elements) || elements.length === 0) return findings;

  for (const element of elements) {
    if (!element || typeof element !== "object") continue;
    const target = deriveTarget(element);
    const sanitizedLabel = sanitizeA11yLabel(
      element.accessibilityLabel ?? ""
    );
    const sanitizedText = sanitizeA11yLabel(element.text ?? "");

    // CRITICAL: Interactive element with no accessibility label AND no text.
    if (isInteractive(element)) {
      if (!sanitizedLabel && !sanitizedText) {
        pushFinding(findings, {
          id: "mobile-a11y.interactive-missing-label",
          severity: "critical",
          criterion: "WCAG 4.1.2",
          message:
            "Interactive element has no accessibilityLabel and no visible text; screen readers will announce nothing.",
          target,
          fix_hint:
            "Add accessibilityLabel=\"<action>\" or render a visible text child so the control announces.",
        });
      }
    }

    // MAJOR: Touch target below 44 x 44 baseline.
    if (isInteractive(element)) {
      if (!hasMinTouchTarget(element.widthPx, element.heightPx)) {
        pushFinding(findings, {
          id: "mobile-a11y.touch-target-too-small",
          severity: "major",
          criterion: "WCAG 2.5.5",
          message: `Interactive element is ${element.widthPx}x${element.heightPx}px; minimum is 44x44.`,
          target,
          fix_hint:
            "Increase hitSlop or padding so the pressable rect is at least 44x44 CSS px.",
        });
      }
    }

    // MAJOR: Contrast ratio below AA threshold.
    if (element.fgColor && element.bgColor) {
      const ratio = computeContrastRatio(element.fgColor, element.bgColor);
      const large = isLargeText(element);
      if (!meetsWcagAa(ratio, large)) {
        pushFinding(findings, {
          id: "mobile-a11y.contrast-below-aa",
          severity: "major",
          criterion: "WCAG 1.4.3",
          message: `Contrast ratio ${ratio.toFixed(2)}:1 is below AA (${large ? WCAG_AA_LARGE : WCAG_AA_NORMAL}:1).`,
          target,
          fix_hint:
            "Use FIELDOPS_TOKENS.color palette values to pick a foreground that clears AA for this surface.",
        });
      }
    }

    // MAJOR: Disabled button without a visible disabled cue.
    if (
      element.accessibilityRole === "button" &&
      element.accessibilityState &&
      element.accessibilityState.disabled === true
    ) {
      if (!hasDisabledVisualCue(element)) {
        pushFinding(findings, {
          id: "mobile-a11y.disabled-missing-cue",
          severity: "major",
          criterion: "WCAG 1.4.1",
          message:
            "Button is marked disabled via accessibilityState but has no visible disabled cue (opacity, label qualifier, or disabled-* testID).",
          target,
          fix_hint:
            "Add a disabled-* testID or include a \"disabled\"/\"unavailable\" qualifier in the label, plus a reduced opacity style.",
        });
      }
    }

    // MINOR: testID exists but accessibilityLabel is null.
    if (element.testID && element.accessibilityLabel === null) {
      pushFinding(findings, {
        id: "mobile-a11y.testid-missing-label",
        severity: "minor",
        criterion: "WCAG 4.1.2",
        message:
          "Element exposes a testID but no accessibilityLabel; automation can target it but assistive tech cannot describe it.",
        target,
        fix_hint:
          "Add accessibilityLabel alongside the testID so screen readers match the automation contract.",
      });
    }
  }

  return findings;
}
