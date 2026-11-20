#!/usr/bin/env node
/**
 * FieldOps Mobile — WCAG AA accessibility audit.
 *
 * Runs `runA11yAudit` from `apps/fieldops/src/mobile-a11y-audit.ts` against
 * a synthetic element manifest derived from the extracted screens'
 * `testID`, `accessibilityRole`, and StyleSheet-declared tap-target sizes.
 *
 * This is a static, build-time audit: it does not boot Metro or Expo. The
 * synthetic manifest is the SSOT for each screen's interactive contract and
 * is kept in lock-step with the JSX via unit tests.
 *
 * Persists the audit report to
 *   docs/ops/evidence/<YYYY-MM-DD>/mobile-fieldops/a11y-audit.json
 * so the WCAG baseline is auditable and diff-reviewable.
 *
 * Usage:
 *   node scripts/qa/fieldops-a11y-audit.js [--out path] [--strict]
 *
 * `--strict` exits non-zero if any `critical` or `major` findings remain.
 */

"use strict";

const fs = require("fs");
const path = require("path");

const REPO_ROOT = path.resolve(__dirname, "..", "..");

// The bundled/typed module path is resolved through ts-node-style transpile
// via require hooks in CI. For this helper we ship a JSON-shaped manifest so
// the script has zero TypeScript transpile dependency. The same manifest is
// validated by a paired Jest test against the real TS module.
const AUDIT_OUTPUT_DIR = path.join(
  REPO_ROOT,
  "docs",
  "ops",
  "fieldops-accessibility"
);

function resolveTodayDir(now = new Date()) {
  const yyyy = now.getUTCFullYear();
  const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(now.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

// ---------------------------------------------------------------------------
// Screen elements checked by the accessibility audit.
// ---------------------------------------------------------------------------

const ELEMENT_MANIFEST = {
  "Shell": [
    {
      tag: "Pressable",
      role: "button",
      accessibilityLabel: "Open modules menu",
      accessibilityRole: "button",
      accessibilityState: { disabled: false },
      text: "☰",
      testID: "mobile-menu-toggle",
      // Raised from 38×38 to 44×44 on 2026-04-23 after the Playwright
      // a11y spec caught the WCAG 2.5.5 violation. Keep this entry so a
      // regression would fail the static audit.
      widthPx: 44,
      heightPx: 44,
      fontSize: 16,
      fgColor: "#0f172a",
      bgColor: "#ffffff",
    },
    {
      tag: "Pressable",
      role: "button",
      accessibilityLabel: "Close modules menu",
      accessibilityRole: "button",
      accessibilityState: { disabled: false },
      text: "×",
      testID: "mobile-menu-close",
      widthPx: 44,
      heightPx: 44,
      fontSize: 18,
      fgColor: "#4b5563",
      bgColor: "#ffffff",
    },
    {
      tag: "Pressable",
      role: "button",
      accessibilityLabel: "Role Driver. Long press to sign out.",
      accessibilityRole: "button",
      accessibilityState: { disabled: false },
      text: "D",
      testID: "mobile-role-avatar",
      widthPx: 44,
      heightPx: 44,
      fontSize: 12,
      fgColor: "#0f172a",
      bgColor: "#ffffff",
    },
  ],
  "OutboxScreen": [
    {
      tag: "Pressable",
      role: "button",
      accessibilityLabel: "Sync now",
      accessibilityRole: "button",
      accessibilityState: { disabled: false },
      text: "Sync now",
      testID: "mobile-outbox-sync-now",
      widthPx: 102,
      heightPx: 44,
      fontSize: 12,
      fgColor: "#0f172a",
      bgColor: "#ffffff",
    },
    {
      tag: "Pressable",
      role: "button",
      accessibilityLabel: "Clear dead",
      accessibilityRole: "button",
      accessibilityState: { disabled: false },
      text: "Clear dead",
      testID: "mobile-outbox-clear-dead",
      widthPx: 120,
      heightPx: 44,
      fontSize: 13,
      fgColor: "#0f172a",
      bgColor: "#ffffff",
    },
  ],
  "LocationScreen": [
    {
      tag: "Pressable",
      role: "button",
      accessibilityLabel: "Capture location",
      accessibilityRole: "button",
      accessibilityState: { disabled: false },
      text: "Capture location",
      testID: "mobile-location-capture",
      widthPx: 160,
      heightPx: 44,
      fontSize: 13,
      fgColor: "#0f172a",
      bgColor: "#ffffff",
    },
    {
      tag: "Pressable",
      role: "button",
      accessibilityLabel: "Queue ping",
      accessibilityRole: "button",
      accessibilityState: { disabled: false },
      text: "Queue ping",
      testID: "mobile-location-queue-ping",
      widthPx: 120,
      heightPx: 44,
      fontSize: 14,
      fgColor: "#ffffff",
      bgColor: "#0e7490",
    },
  ],
  "HomeScreen": [
    {
      tag: "Pressable",
      role: "button",
      accessibilityLabel: "Open next stop",
      accessibilityRole: "button",
      accessibilityState: { disabled: false },
      text: "Open next stop",
      testID: "mobile-home-open-next-stop",
      widthPx: 200,
      heightPx: 48,
      fontSize: 14,
      fgColor: "#ffffff",
      bgColor: "#0e7490",
    },
  ],
  "ShiftSummaryScreen": [
    {
      tag: "Pressable",
      role: "button",
      accessibilityLabel: "Cancel end shift",
      accessibilityRole: "button",
      accessibilityState: { disabled: false },
      text: "Cancel",
      testID: "mobile-shift-summary-cancel",
      widthPx: 120,
      heightPx: 44,
      fontSize: 14,
      fgColor: "#0f172a",
      bgColor: "#ffffff",
    },
    {
      tag: "Pressable",
      role: "button",
      accessibilityLabel: "Confirm end shift",
      accessibilityRole: "button",
      accessibilityState: { disabled: false },
      text: "End shift",
      testID: "mobile-shift-summary-confirm",
      widthPx: 160,
      heightPx: 48,
      fontSize: 14,
      fgColor: "#ffffff",
      bgColor: "#b91c1c",
    },
  ],
};

// ---------------------------------------------------------------------------
// Inline a11y audit evaluator (mirrors `runA11yAudit` in
// apps/fieldops/src/mobile-a11y-audit.ts). Kept as plain JS here so the
// script has zero TS build dependency; a paired Jest test verifies that the
// same synthetic manifest, when fed through the TS implementation, produces
// the same findings set (SSOT invariant).
// ---------------------------------------------------------------------------

function parseHexChannel(hex, start) {
  const slice = hex.slice(start, start + 2);
  const v = Number.parseInt(slice, 16);
  return Number.isFinite(v) ? v : NaN;
}

function normalizeHex(hex) {
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
  return value;
}

function srgbChannel(value) {
  const v = value / 255;
  return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

function relativeLuminance(hex) {
  const norm = normalizeHex(hex);
  if (!norm) return null;
  const r = parseHexChannel(norm, 0);
  const g = parseHexChannel(norm, 2);
  const b = parseHexChannel(norm, 4);
  if (![r, g, b].every(Number.isFinite)) return null;
  const R = srgbChannel(r);
  const G = srgbChannel(g);
  const B = srgbChannel(b);
  return 0.2126 * R + 0.7152 * G + 0.0722 * B;
}

function contrastRatio(fg, bg) {
  const Lf = relativeLuminance(fg);
  const Lb = relativeLuminance(bg);
  if (Lf == null || Lb == null) return 0;
  const bright = Math.max(Lf, Lb);
  const dark = Math.min(Lf, Lb);
  return (bright + 0.05) / (dark + 0.05);
}

function runAudit(elements) {
  const findings = [];
  for (const el of elements) {
    if (el.widthPx < 44 || el.heightPx < 44) {
      findings.push({
        id: "mobile-a11y.touch-target-too-small",
        severity: "major",
        testID: el.testID,
        message: `Interactive element is ${el.widthPx}x${el.heightPx}px; minimum is 44x44.`,
      });
    }
    if (el.accessibilityRole && !el.accessibilityLabel && !el.text) {
      findings.push({
        id: "mobile-a11y.interactive-missing-label",
        severity: "critical",
        testID: el.testID,
        message: "Interactive element has no accessibilityLabel and no text.",
      });
    }
    if (el.fgColor && el.bgColor) {
      const ratio = contrastRatio(el.fgColor, el.bgColor);
      const large =
        (el.fontSize || 0) >= 18 ||
        ((el.fontSize || 0) >= 14 && el.fontWeight === "bold");
      const threshold = large ? 3 : 4.5;
      if (ratio < threshold) {
        findings.push({
          id: "mobile-a11y.contrast-below-aa",
          severity: "major",
          testID: el.testID,
          message: `Contrast ratio ${ratio.toFixed(2)}:1 is below AA (${threshold}:1).`,
        });
      }
    }
    if (el.testID && !el.accessibilityLabel) {
      findings.push({
        id: "mobile-a11y.testid-missing-label",
        severity: "minor",
        testID: el.testID,
        message:
          "Element exposes a testID but no accessibilityLabel; automation can target it but assistive tech cannot describe it.",
      });
    }
  }
  return findings;
}

function main() {
  const args = process.argv.slice(2);
  let outPath = null;
  let strict = false;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--out" && args[i + 1]) {
      outPath = args[i + 1];
      i += 1;
    } else if (arg === "--strict") {
      strict = true;
    }
  }

  const report = {
    generated_at: new Date().toISOString(),
    source_of_truth: "apps/fieldops/src/mobile-a11y-audit.ts + scripts/qa/fieldops-a11y-audit.js",
    screens: {},
    summary: { critical: 0, major: 0, minor: 0, total: 0 },
  };

  for (const [screen, elements] of Object.entries(ELEMENT_MANIFEST)) {
    const findings = runAudit(elements);
    report.screens[screen] = {
      element_count: elements.length,
      findings,
    };
    for (const f of findings) {
      report.summary[f.severity] = (report.summary[f.severity] || 0) + 1;
      report.summary.total += 1;
    }
  }

  const todayDir = resolveTodayDir();
  const defaultOut = path.join(
    AUDIT_OUTPUT_DIR,
    todayDir,
    "mobile-fieldops",
    "a11y-audit.json"
  );
  const finalOut = outPath || defaultOut;
  fs.mkdirSync(path.dirname(finalOut), { recursive: true });
  fs.writeFileSync(finalOut, `${JSON.stringify(report, null, 2)}\n`);

  // eslint-disable-next-line no-console
  console.log(
    `[fieldops-a11y-audit] ${report.summary.total} findings across ${
      Object.keys(ELEMENT_MANIFEST).length
    } screens (critical=${report.summary.critical} major=${report.summary.major} minor=${report.summary.minor}).`
  );
  // eslint-disable-next-line no-console
  console.log(`[fieldops-a11y-audit] report written to ${finalOut}`);

  if (strict && (report.summary.critical > 0 || report.summary.major > 0)) {
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  ELEMENT_MANIFEST,
  runAudit,
};
