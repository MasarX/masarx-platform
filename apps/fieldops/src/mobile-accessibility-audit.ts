export type MobileAccessibilitySeverity = "critical" | "major" | "minor";

export type MobileAccessibilityFindingId =
  | "mobile-a11y.interactive-missing-label"
  | "mobile-a11y.touch-target-too-small"
  | "mobile-a11y.contrast-below-aa"
  | "mobile-a11y.disabled-missing-cue"
  | "mobile-a11y.testid-missing-label"
  | "mobile-a11y.interactive-role-missing"
  | "mobile-a11y.touch-target-below-wcag-aa"
  | "mobile-a11y.disabled-state-not-exposed"
  | "mobile-a11y.disabled-visual-cue-unverifiable"
  | "mobile-a11y.contrast-unverifiable";

export type MobileAccessibilityTarget = {
  kind: "testID" | "label" | "text" | "role";
  value: string;
};

export type MobileAccessibilityPolicy = {
  enabled: boolean;
  minimumTouchTargetDp: number;
  normalTextContrastRatio: number;
  largeTextContrastRatio: number;
  largeTextMinimumPt: number;
  largeBoldTextMinimumPt: number;
};

export type MobileAccessibilityElement = {
  id: string | null;
  interactive: boolean;
  role: string | null;
  label: string | null;
  text: string | null;
  widthDp: number;
  heightDp: number;
  fontSizePt: number | null;
  fontWeight: string | number | null;
  foregroundColor: string | null;
  backgroundColor: string | null;
  disabled: boolean;
  accessibilityStateDisabled: boolean | null;
  /** True only when the collector verified a visible disabled cue, not a label/testID heuristic. */
  disabledVisualCue?: boolean | null;
};

export type MobileAccessibilityFinding = {
  id: MobileAccessibilityFindingId;
  severity: MobileAccessibilitySeverity;
  criterion: string;
  target: MobileAccessibilityTarget | null;
  message: string;
  fix_hint: string;
};

const WCAG_22_MINIMUM_TOUCH_TARGET_DP = 24;
const WCAG_AA_NORMAL_TEXT_CONTRAST = 4.5;
const WCAG_AA_LARGE_TEXT_CONTRAST = 3;

export const DEFAULT_MOBILE_ACCESSIBILITY_POLICY: MobileAccessibilityPolicy = {
  enabled: true,
  minimumTouchTargetDp: 44,
  normalTextContrastRatio: WCAG_AA_NORMAL_TEXT_CONTRAST,
  largeTextContrastRatio: WCAG_AA_LARGE_TEXT_CONTRAST,
  largeTextMinimumPt: 18,
  largeBoldTextMinimumPt: 14,
};

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function readBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function readBoundedNumber(
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(maximum, Math.max(minimum, value));
}

/**
 * Normalizes a resolved accessibility policy row. Row values may strengthen
 * the baseline, but they cannot weaken WCAG 2.2 AA minimums.
 */
export function normalizeMobileAccessibilityPolicy(
  value: unknown
): MobileAccessibilityPolicy {
  const input = asRecord(value);
  return {
    enabled: readBoolean(input.enabled, DEFAULT_MOBILE_ACCESSIBILITY_POLICY.enabled),
    minimumTouchTargetDp: readBoundedNumber(
      input.minimum_touch_target_dp,
      DEFAULT_MOBILE_ACCESSIBILITY_POLICY.minimumTouchTargetDp,
      WCAG_22_MINIMUM_TOUCH_TARGET_DP,
      96
    ),
    normalTextContrastRatio: readBoundedNumber(
      input.normal_text_contrast_ratio,
      DEFAULT_MOBILE_ACCESSIBILITY_POLICY.normalTextContrastRatio,
      WCAG_AA_NORMAL_TEXT_CONTRAST,
      21
    ),
    largeTextContrastRatio: readBoundedNumber(
      input.large_text_contrast_ratio,
      DEFAULT_MOBILE_ACCESSIBILITY_POLICY.largeTextContrastRatio,
      WCAG_AA_LARGE_TEXT_CONTRAST,
      21
    ),
    largeTextMinimumPt: readBoundedNumber(
      input.large_text_minimum_pt,
      DEFAULT_MOBILE_ACCESSIBILITY_POLICY.largeTextMinimumPt,
      DEFAULT_MOBILE_ACCESSIBILITY_POLICY.largeTextMinimumPt,
      96
    ),
    largeBoldTextMinimumPt: readBoundedNumber(
      input.large_bold_text_minimum_pt,
      DEFAULT_MOBILE_ACCESSIBILITY_POLICY.largeBoldTextMinimumPt,
      DEFAULT_MOBILE_ACCESSIBILITY_POLICY.largeBoldTextMinimumPt,
      96
    ),
  };
}

export function sanitizeMobileAccessibilityText(value: unknown): string {
  if (typeof value !== "string") return "";
  return value
    .replace(/[\u0000-\u001F\u007F]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeHexColor(value: unknown): string | null {
  if (typeof value !== "string") return null;
  let hex = value.trim().replace(/^#/, "");
  if (/^[0-9a-f]{3}$/i.test(hex)) {
    hex = hex
      .split("")
      .map((character) => `${character}${character}`)
      .join("");
  }
  return /^[0-9a-f]{6}$/i.test(hex) ? hex.toLowerCase() : null;
}

function relativeLuminance(value: string): number | null {
  const hex = normalizeHexColor(value);
  if (!hex) return null;
  const channels = [0, 2, 4].map((index) => Number.parseInt(hex.slice(index, index + 2), 16));
  const [red, green, blue] = channels.map((channel) => {
    const normalized = channel / 255;
    return normalized <= 0.04045
      ? normalized / 12.92
      : Math.pow((normalized + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

export function computeMobileContrastRatio(
  foregroundColor: string,
  backgroundColor: string
): number | null {
  const foreground = relativeLuminance(foregroundColor);
  const background = relativeLuminance(backgroundColor);
  if (foreground == null || background == null) return null;
  const lighter = Math.max(foreground, background);
  const darker = Math.min(foreground, background);
  return Math.round(((lighter + 0.05) / (darker + 0.05)) * 100) / 100;
}

function isBold(weight: string | number | null): boolean {
  if (typeof weight === "number") return weight >= 700;
  if (typeof weight !== "string") return false;
  const normalized = weight.trim().toLowerCase();
  if (normalized === "bold") return true;
  const numeric = Number.parseInt(normalized, 10);
  return Number.isFinite(numeric) && numeric >= 700;
}

function isLargeText(
  element: MobileAccessibilityElement,
  policy: MobileAccessibilityPolicy
): boolean {
  if (element.fontSizePt == null || !Number.isFinite(element.fontSizePt)) return false;
  if (element.fontSizePt >= policy.largeTextMinimumPt) return true;
  return (
    element.fontSizePt >= policy.largeBoldTextMinimumPt &&
    isBold(element.fontWeight)
  );
}

function targetFor(element: MobileAccessibilityElement): MobileAccessibilityTarget | null {
  const candidates: Array<[MobileAccessibilityTarget["kind"], unknown]> = [
    ["testID", element.id],
    ["label", element.label],
    ["text", element.text],
    ["role", element.role],
  ];
  for (const [kind, raw] of candidates) {
    const value = sanitizeMobileAccessibilityText(raw);
    if (value) return { kind, value };
  }
  return null;
}

/**
 * Audits an already-flattened React Native accessibility snapshot. Collection
 * stays runtime-specific; this pure evaluator remains deterministic and safe
 * to run in local validation without an emulator.
 */
export function auditMobileAccessibilitySnapshot(input: {
  elements: MobileAccessibilityElement[];
  policy?: unknown;
}): MobileAccessibilityFinding[] {
  const policy = normalizeMobileAccessibilityPolicy(input.policy);
  if (!policy.enabled || !Array.isArray(input.elements)) return [];

  const findings: MobileAccessibilityFinding[] = [];
  for (const element of input.elements) {
    if (!element || typeof element !== "object") continue;
    const target = targetFor(element);
    const label = sanitizeMobileAccessibilityText(element.label);
    const text = sanitizeMobileAccessibilityText(element.text);
    const role = sanitizeMobileAccessibilityText(element.role);

    if (element.interactive && !label && !text) {
      findings.push({
        id: "mobile-a11y.interactive-missing-label",
        severity: "critical",
        criterion: "WCAG 2.2 SC 4.1.2",
        target,
        message: "Interactive control has no accessible name or visible text.",
        fix_hint: "Provide a meaningful visible label or accessibilityLabel for the control.",
      });
    }

    if (element.interactive && !role) {
      findings.push({
        id: "mobile-a11y.interactive-role-missing",
        severity: "critical",
        criterion: "WCAG 2.2 SC 4.1.2",
        target,
        message: "Interactive control has no accessibility role.",
        fix_hint: "Expose the native role matching the control behavior.",
      });
    }

    if (element.interactive) {
      const hasFiniteSize =
        Number.isFinite(element.widthDp) &&
        Number.isFinite(element.heightDp) &&
        element.widthDp >= 0 &&
        element.heightDp >= 0;
      if (
        !hasFiniteSize ||
        element.widthDp < WCAG_22_MINIMUM_TOUCH_TARGET_DP ||
        element.heightDp < WCAG_22_MINIMUM_TOUCH_TARGET_DP
      ) {
        findings.push({
          id: "mobile-a11y.touch-target-below-wcag-aa",
          severity: "critical",
          criterion: "WCAG 2.2 SC 2.5.8",
          target,
          message: "Interactive target is below the 24dp WCAG AA size baseline.",
          fix_hint: "Increase the measured interactive hit area to the required minimum.",
        });
      }
      if (
        element.widthDp < policy.minimumTouchTargetDp ||
        element.heightDp < policy.minimumTouchTargetDp
      ) {
        findings.push({
          id: "mobile-a11y.touch-target-too-small",
          severity: "major",
          criterion: "FieldOps touch-target policy",
          target,
          message: `Interactive target is below the configured ${policy.minimumTouchTargetDp}dp FieldOps baseline.`,
          fix_hint: "Increase the measured hit area to the resolved FieldOps touch-target policy.",
        });
      }
    }

    if (element.disabled && element.accessibilityStateDisabled !== true) {
      findings.push({
        id: "mobile-a11y.disabled-state-not-exposed",
        severity: "major",
        criterion: "WCAG 2.2 SC 4.1.2",
        target,
        message: "Disabled state is not exposed through accessibilityState.",
        fix_hint: "Expose the actual disabled state through accessibilityState.disabled.",
      });
    }

    if (element.interactive && element.disabled && element.disabledVisualCue !== true) {
      findings.push({
        id: element.disabledVisualCue === false
          ? "mobile-a11y.disabled-missing-cue" : "mobile-a11y.disabled-visual-cue-unverifiable",
        severity: "major",
        criterion: "FieldOps disabled-control visual cue",
        target,
        message: element.disabledVisualCue === false
          ? "Disabled control has no verified visible disabled cue."
          : "The snapshot does not establish whether the disabled control has a visible cue.",
        fix_hint: "Render a visible disabled cue and have the collector verify it; text/testID naming alone is not evidence.",
      });
    }

    if (element.text && element.foregroundColor && element.backgroundColor) {
      const ratio = computeMobileContrastRatio(
        element.foregroundColor,
        element.backgroundColor
      );
      if (ratio == null) {
        findings.push({
          id: "mobile-a11y.contrast-unverifiable",
          severity: "major",
          criterion: "WCAG 2.2 SC 1.4.3",
          target,
          message: "Resolved text colors are not valid hexadecimal colors.",
          fix_hint: "Collect resolved foreground/background colors in supported hexadecimal form.",
        });
      } else {
        const minimum = isLargeText(element, policy)
          ? policy.largeTextContrastRatio
          : policy.normalTextContrastRatio;
        if (ratio < minimum) {
          findings.push({
            id: "mobile-a11y.contrast-below-aa",
            severity: "major",
            criterion: "WCAG 2.2 SC 1.4.3",
            target,
            message: `Text contrast ${ratio}:1 is below the configured ${minimum}:1 baseline.`,
            fix_hint: "Choose text and surface colors that meet the resolved contrast policy.",
          });
        }
      }
    }
  }

  return findings;
}
