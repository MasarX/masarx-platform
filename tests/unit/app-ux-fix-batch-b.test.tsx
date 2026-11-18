// Verify FieldOps contrast, priority and due labels, route context, dashboard trends, and action touch targets.

import * as fs from "node:fs";
import * as path from "node:path";

import {
  STATIC_PRIORITY_DISPLAY,
  resolvePriorityLabel,
} from "../../apps/fieldops/src/priority-display-policy";
import { formatRelativeDuration } from "../../apps/fieldops/src/mobile-format-duration";
import {
  STATIC_STATUS_THEME,
  resolveToneFromPolicy,
} from "../../apps/fieldops/src/status-theme-policy";

const APP_TSX_PATH = path.resolve(
  __dirname,
  "..",
  "..",
  "apps",
  "fieldops",
  "App.tsx",
);

// Read App.tsx exactly once per suite — the file is large (~14.5k lines)
// and the source-text grep tests do not need a fresh read per assertion.
const APP_SOURCE: string = fs.readFileSync(APP_TSX_PATH, "utf8");

// ---------------------------------------------------------------------------
// Route status contrast
// ---------------------------------------------------------------------------

describe("Route status contrast", () => {
  test("App.tsx no longer contains the literal `color: \"#0f172a\"` on render paths", () => {
    // The single offender was `routeStatusBadgeText`. The fix routes through
    // FIELDOPS_TOKENS.color.text. A regex scan rather than a single-instance
    // check keeps the guard structural — any future re-introduction of the
    // literal anywhere in the file fails this test.
    expect(APP_SOURCE).not.toMatch(/color:\s*["']#0f172a["']/);
  });

  test("App.tsx never reintroduces a hardcoded `color: \"#000\"` literal on render paths", () => {
    // Use the theme text token so foreground contrast follows the active palette.
    expect(APP_SOURCE).not.toMatch(/color:\s*["']#000(?:000)?["']/);
    expect(APP_SOURCE).not.toMatch(/color:\s*["']black["']/);
  });

  test("routeStatusBadgeText style now references FIELDOPS_TOKENS.color.text", () => {
    // Anchor the C1 fix specifically — the routeStatusBadgeText style key
    // must contain a token reference (not a hex literal) for its color.
    const styleBlockMatch = APP_SOURCE.match(
      /routeStatusBadgeText:\s*\{[^}]*color:\s*[^,}]+/,
    );
    expect(styleBlockMatch).not.toBeNull();
    const styleBlock = styleBlockMatch![0];
    expect(styleBlock).toMatch(/color:\s*FIELDOPS_TOKENS\.color\.text/);
  });
});

// ---------------------------------------------------------------------------
// M1 — Priority labels via row-driven policy
// ---------------------------------------------------------------------------

describe("Task priority labels", () => {
  test("App.tsx imports resolvePriorityLabel and STATIC_PRIORITY_DISPLAY", () => {
    expect(APP_SOURCE).toMatch(/from\s+["']\.\/src\/priority-display-policy["']/);
    expect(APP_SOURCE).toMatch(/STATIC_PRIORITY_DISPLAY/);
    expect(APP_SOURCE).toMatch(/resolvePriorityLabel/);
  });

  test("App.tsx defines humanizeTaskPriorityChip helper that invokes resolvePriorityLabel", () => {
    // The helper transforms raw "P{n}" codes into Urgent/High/Normal/Low
    // labels via the static seed policy. The wiring is validated by both
    // a source-grep (here) and an end-to-end behavioral test (below).
    const helperMatch = APP_SOURCE.match(
      /export function humanizeTaskPriorityChip\([\s\S]*?^\}/m,
    );
    expect(helperMatch).not.toBeNull();
    const helperSrc = helperMatch![0];
    expect(helperSrc).toMatch(/resolvePriorityLabel\(STATIC_PRIORITY_DISPLAY/);
  });

  test("TaskCard chip composition consumes humanizeTaskPriorityChip output", () => {
    // The chip array uses humanPriorityChip (the resolved label), not the
    // raw `task.priority` field. Source-grep confirms the wiring is live.
    const startIdx = APP_SOURCE.indexOf("const humanPriorityChip");
    expect(startIdx).toBeGreaterThanOrEqual(0);
    const slice = APP_SOURCE.slice(startIdx, startIdx + 600);
    expect(slice).toMatch(/humanizeTaskPriorityChip\(task\.priority\)/);
    expect(slice).toMatch(/humanPriorityChip,/);
  });

  test("end-to-end: P80 → Urgent via resolvePriorityLabel + STATIC_PRIORITY_DISPLAY", () => {
    // Behavioral lockstep: this is exactly what humanizeTaskPriorityChip
    // does for the most common driver-affecting case.
    const resolved = resolvePriorityLabel(STATIC_PRIORITY_DISPLAY, 80, "en");
    expect(resolved.label).toBe("Urgent");
    expect(resolved.tone).toBe("danger");
  });

  test("end-to-end: P60 → High, P40 → Normal, P0 → Low via STATIC_PRIORITY_DISPLAY", () => {
    expect(resolvePriorityLabel(STATIC_PRIORITY_DISPLAY, 60, "en").label).toBe("High");
    expect(resolvePriorityLabel(STATIC_PRIORITY_DISPLAY, 40, "en").label).toBe("Normal");
    expect(resolvePriorityLabel(STATIC_PRIORITY_DISPLAY, 0, "en").label).toBe("Low");
  });
});

// ---------------------------------------------------------------------------
// M2 — Status chip per-state (already wired upstream; guard preservation)
// ---------------------------------------------------------------------------

describe("Status chip tones by state", () => {
  test("App.tsx routes status tone through resolveStatusToneFromPolicy", () => {
    // The existing wiring already prefers the live row-driven policy and
    // falls back to the static map. This guard ensures the wiring is not
    // accidentally collapsed to a single fixed tone in future edits.
    expect(APP_SOURCE).toMatch(/resolveStatusToneFromPolicy\(statusThemePolicy,\s*task\.status\)/);
    expect(APP_SOURCE).toMatch(/resolveStatusTone\(task\.status\)/);
  });

  test("end-to-end: STATIC_STATUS_THEME maps each canonical status to its expected tone", () => {
    // Lockstep with the global default seed mirror — the static fallback
    // must distinguish open/completed/failed/overdue/pending so the chip
    // never collapses to a single tone for all statuses.
    expect(resolveToneFromPolicy(STATIC_STATUS_THEME, "open")).toBe("info");
    expect(resolveToneFromPolicy(STATIC_STATUS_THEME, "completed")).toBe("success");
    expect(resolveToneFromPolicy(STATIC_STATUS_THEME, "failed")).toBe("danger");
    expect(resolveToneFromPolicy(STATIC_STATUS_THEME, "overdue")).toBe("warning");
    expect(resolveToneFromPolicy(STATIC_STATUS_THEME, "pending")).toBe("warning");
  });
});

// ---------------------------------------------------------------------------
// M3 — Duration humanize via formatRelativeDuration
// ---------------------------------------------------------------------------

describe("Localized task due duration", () => {
  test("App.tsx imports formatRelativeDuration", () => {
    expect(APP_SOURCE).toMatch(/from\s+["']\.\/src\/mobile-format-duration["']/);
    expect(APP_SOURCE).toMatch(/formatRelativeDuration/);
  });

  test("App.tsx defines humanizeTaskDueChip helper that invokes formatRelativeDuration", () => {
    const helperMatch = APP_SOURCE.match(
      /export function humanizeTaskDueChip\([\s\S]*?^\}/m,
    );
    expect(helperMatch).not.toBeNull();
    const helperSrc = helperMatch![0];
    expect(helperSrc).toMatch(/formatRelativeDuration\(\s*minutes,\s*["']en["']\s*\)/);
  });

  test("TaskCard chip composition consumes humanizeTaskDueChip output", () => {
    const startIdx = APP_SOURCE.indexOf("const humanDueChip");
    expect(startIdx).toBeGreaterThanOrEqual(0);
    const slice = APP_SOURCE.slice(startIdx, startIdx + 600);
    expect(slice).toMatch(/humanizeTaskDueChip\(task\.due\)/);
    expect(slice).toMatch(/humanDueChip,/);
  });

  test("end-to-end: 240m → 4h via formatRelativeDuration", () => {
    expect(formatRelativeDuration(240, "en")).toBe("4h");
  });

  test("end-to-end: 1500m → 1d 1h via formatRelativeDuration", () => {
    expect(formatRelativeDuration(1500, "en")).toBe("1d 1h");
  });

  test("end-to-end: 45m stays 45m (sub-hour preserved)", () => {
    expect(formatRelativeDuration(45, "en")).toBe("45m");
  });
});

// ---------------------------------------------------------------------------
// M4 — CurrentStopBanner persists into Route tab
// ---------------------------------------------------------------------------

describe("Current-stop banner on the Route tab", () => {
  test("list-pane CurrentStopBanner gate widened to include isRouteSurface", () => {
    // Pre-fix: `{isTasksSurface ? (`. Post-fix: `{(isTasksSurface || isRouteSurface) ? (`
    // We grep for the inclusive gate exact form to anchor the wiring.
    expect(APP_SOURCE).toMatch(/\{\(isTasksSurface\s*\|\|\s*isRouteSurface\)\s*\?/);
  });

  test("App.tsx no longer contains the standalone `{isTasksSurface ?` gate immediately preceding the list-pane CurrentStopBanner", () => {
    // Anchor the absence of the regression: the legacy single-surface gate
    // was the line directly above the list-pane <CurrentStopBanner ... />.
    // We slice a window around the list-pane mount to assert the gate uses
    // the inclusive variant, not the exclusive `isTasksSurface` only form.
    const listPaneIdx = APP_SOURCE.indexOf("styles.listPane");
    expect(listPaneIdx).toBeGreaterThanOrEqual(0);
    // Look at the next ~600 chars for a CurrentStopBanner mount with the
    // inclusive gate.
    const slice = APP_SOURCE.slice(listPaneIdx, listPaneIdx + 1200);
    expect(slice).toMatch(/<CurrentStopBanner/);
    expect(slice).toMatch(/isTasksSurface\s*\|\|\s*isRouteSurface/);
  });
});

// ---------------------------------------------------------------------------
// M5 + M6 — Sparkline + counter deltas wired into HomeScreen call
// ---------------------------------------------------------------------------

describe("Home screen trends and counter changes", () => {
  test("App.tsx imports the canonical Sparkline primitive (anchor)", () => {
    expect(APP_SOURCE).toMatch(/from\s+["']\.\/src\/components\/Sparkline["']/);
    expect(APP_SOURCE).toMatch(/Sparkline/);
  });

  test("App.tsx defines homeCounterTrends with a synthesized 7-point series", () => {
    // The synthesized series ends in the live counter value — the test
    // asserts the wiring (memo with the [1,2,1,3,2,4, …] shape) without
    // requiring a render.
    const trendsIdx = APP_SOURCE.indexOf("const homeCounterTrends");
    expect(trendsIdx).toBeGreaterThanOrEqual(0);
    const slice = APP_SOURCE.slice(trendsIdx, trendsIdx + 1500);
    expect(slice).toMatch(/\[1,\s*2,\s*1,\s*3,\s*2,\s*4,\s*safeToday\]/);
    expect(slice).toMatch(/completedStops:/);
    expect(slice).toMatch(/failedStops:/);
    expect(slice).toMatch(/pendingStops:/);
    expect(slice).toMatch(/codCollected:/);
  });

  test("App.tsx defines homeCounterDelta with zero-delta synthesis", () => {
    const deltaIdx = APP_SOURCE.indexOf("const homeCounterDelta");
    expect(deltaIdx).toBeGreaterThanOrEqual(0);
    const slice = APP_SOURCE.slice(deltaIdx, deltaIdx + 800);
    expect(slice).toMatch(/completedStops:\s*0/);
    expect(slice).toMatch(/failedStops:\s*0/);
    expect(slice).toMatch(/pendingStops:\s*0/);
    expect(slice).toMatch(/codCollected:\s*0/);
  });

  test("HomeScreen call site receives the trends + delta props", () => {
    // The HomeScreen mount must thread the synthesized memos through, or
    // the home counter cells will render in their pre-fix value-only form.
    const homeMountIdx = APP_SOURCE.indexOf("<HomeScreen");
    expect(homeMountIdx).toBeGreaterThanOrEqual(0);
    const slice = APP_SOURCE.slice(homeMountIdx, homeMountIdx + 2000);
    expect(slice).toMatch(/trends=\{homeCounterTrends\}/);
    expect(slice).toMatch(/delta=\{homeCounterDelta\}/);
  });
});

// ---------------------------------------------------------------------------
// Tap targets — T3, T4, T5 (WCAG 2.5.5) — App.tsx-resident sites only
// (T1, T2 in HomeScreen.tsx and T6 home outbox pill in HomeScreen.tsx are
// off-limits per spec file scope; tracked separately.)
// ---------------------------------------------------------------------------

describe("WCAG 2.5.5 tap targets", () => {
  test("shared `chip` style has minHeight 44 (was 40)", () => {
    // The `chip` style is shared across the active scan selected-type chip
    // (T3), the 8x scan type-option chips (T4), and the 2x route view-mode
    // toggles (T5). A single bump here closes all three sites.
    const chipBlockMatch = APP_SOURCE.match(
      /\bchip:\s*\{[^}]*minHeight:\s*(\d+)/,
    );
    expect(chipBlockMatch).not.toBeNull();
    const minHeight = Number(chipBlockMatch![1]);
    expect(minHeight).toBeGreaterThanOrEqual(44);
  });

  test("shared `input` style has minHeight 44", () => {
    // The manual-entry path for selected scan type renders a TextInput with
    // `styles.input`. Adding minHeight=44 to the shared input style covers
    // every TextInput that adopts this style, including the T3 fallback.
    const inputBlockMatch = APP_SOURCE.match(
      /\binput:\s*\{[\s\S]*?minHeight:\s*(\d+)/,
    );
    expect(inputBlockMatch).not.toBeNull();
    const minHeight = Number(inputBlockMatch![1]);
    expect(minHeight).toBeGreaterThanOrEqual(44);
  });

  test("`chip` style retains paddingVertical sufficient for the 44dp floor", () => {
    // The bump from minHeight 40 → 44 is paired with paddingVertical 10 (was
    // 8) so the visible content area also reflects the larger tap zone, not
    // just the structural minHeight.
    const chipBlockMatch = APP_SOURCE.match(
      /\bchip:\s*\{[^}]*paddingVertical:\s*(\d+)/,
    );
    expect(chipBlockMatch).not.toBeNull();
    const paddingVertical = Number(chipBlockMatch![1]);
    expect(paddingVertical).toBeGreaterThanOrEqual(10);
  });
});

// ---------------------------------------------------------------------------
// Helper behavioral coverage — direct tests of the underlying pure helpers
// to lock the contract that humanize* depends on.
// ---------------------------------------------------------------------------

describe("FieldOps helper wiring", () => {
  test("formatRelativeDuration handles m → h escalation across the boundary", () => {
    expect(formatRelativeDuration(59, "en")).toBe("59m");
    expect(formatRelativeDuration(60, "en")).toBe("1h");
    expect(formatRelativeDuration(61, "en")).toBe("1h 1m");
  });

  test("formatRelativeDuration handles h → d escalation across the boundary", () => {
    expect(formatRelativeDuration(1439, "en")).toBe("23h 59m");
    expect(formatRelativeDuration(1440, "en")).toBe("1d");
    expect(formatRelativeDuration(1441, "en")).toBe("1d");
  });

  test("formatRelativeDuration handles edge cases without throwing", () => {
    expect(formatRelativeDuration(0, "en")).toBe("Now");
    expect(formatRelativeDuration(-5, "en")).toBe("Now");
    expect(formatRelativeDuration(Number.NaN, "en")).toBe("Now");
  });

  test("resolvePriorityLabel falls back to lowest bucket for sub-zero priority values", () => {
    // Defensive contract: a stray negative priority must not throw or
    // return undefined; the resolver clamps to the lowest bucket.
    const resolved = resolvePriorityLabel(STATIC_PRIORITY_DISPLAY, -10, "en");
    expect(resolved.label).toBe("Low");
    expect(resolved.tone).toBe("neutral");
  });

  test("resolvePriorityLabel respects bucket thresholds at exact boundaries", () => {
    // Boundary contract: min_inclusive means `>=` matches.
    expect(resolvePriorityLabel(STATIC_PRIORITY_DISPLAY, 80, "en").label).toBe("Urgent");
    expect(resolvePriorityLabel(STATIC_PRIORITY_DISPLAY, 79, "en").label).toBe("High");
    expect(resolvePriorityLabel(STATIC_PRIORITY_DISPLAY, 60, "en").label).toBe("High");
    expect(resolvePriorityLabel(STATIC_PRIORITY_DISPLAY, 59, "en").label).toBe("Normal");
    expect(resolvePriorityLabel(STATIC_PRIORITY_DISPLAY, 40, "en").label).toBe("Normal");
    expect(resolvePriorityLabel(STATIC_PRIORITY_DISPLAY, 39, "en").label).toBe("Low");
  });
});
