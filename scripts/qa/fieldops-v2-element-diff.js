#!/usr/bin/env node
// FieldOps V2 element-geometry diff.
//
// Reads the design + impl text-run geometry captured by
// `capture-screen-geometry.spec.ts` and reports, per screen, the exact px
// delta of each rendered text run between the design SSOT and the impl.
//
// Both sides render in the same Chromium with the same Geist fonts, so a
// text run's box is directly comparable: a non-zero delta is genuine
// layout drift, not cross-renderer noise. This is the actionable companion
// to the RMS-based `fieldops-v2-pixel-diff.js`.
//
// Usage:
//   node scripts/qa/fieldops-v2-element-diff.js            # summary table
//   node scripts/qa/fieldops-v2-element-diff.js --screen route   # per-run detail
//
// Pairs of runs are matched by exact (whitespace-normalised) text; repeated
// text is paired in y-order so list rows line up. Cross-state pairs (the
// design artboard and impl gallery deliberately render different lifecycle
// states) are listed but excluded from the aggregate, mirroring the
// pixel-diff harness.

"use strict";

const fs = require("node:fs");
const path = require("node:path");

const GEO_DIR = path.resolve(
  __dirname,
  "..",
  "..",
  "tests",
  "fieldops-e2e",
  "__screenshots__",
  "visual-diff",
  "geometry",
);

// Same cross-state exclusions as fieldops-v2-pixel-diff.js: the design and
// impl deliberately render different lifecycle/role states, so a geometry
// diff there reflects state drift, not parity defects.
const CROSS_STATE = new Set(["sheet-receive", "sync-queue", "tasks"]);

// Per-run drift thresholds (px). Sub-2px is sub-pixel rounding / AA noise.
const POS_TOL = 2;
const SIZE_TOL = 3;

function loadJson(name) {
  const p = path.join(GEO_DIR, name);
  if (!fs.existsSync(p)) {
    console.error(`Missing ${p} — run: npx playwright test -c playwright.fieldops.config.ts capture-screen-geometry`);
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

// Pair design↔impl runs for one screen. Matched by exact text; repeated
// text is paired in ascending-y order.
function pairRuns(designRuns, implRuns) {
  const byText = new Map();
  for (const r of designRuns) {
    if (!byText.has(r.t)) byText.set(r.t, { d: [], i: [] });
    byText.get(r.t).d.push(r);
  }
  for (const r of implRuns) {
    if (!byText.has(r.t)) byText.set(r.t, { d: [], i: [] });
    byText.get(r.t).i.push(r);
  }
  const matched = [];
  const unmatchedDesign = [];
  const unmatchedImpl = [];
  for (const [text, group] of byText) {
    const d = group.d.slice().sort((a, b) => a.y - b.y);
    const i = group.i.slice().sort((a, b) => a.y - b.y);
    const n = Math.min(d.length, i.length);
    for (let k = 0; k < n; k += 1) {
      matched.push({
        text,
        dx: Math.round((i[k].x - d[k].x) * 10) / 10,
        dy: Math.round((i[k].y - d[k].y) * 10) / 10,
        dw: Math.round((i[k].w - d[k].w) * 10) / 10,
        dh: Math.round((i[k].h - d[k].h) * 10) / 10,
        dfs: Math.round((i[k].fs - d[k].fs) * 10) / 10,
        dfw: i[k].fw - d[k].fw,
        design: d[k],
        impl: i[k],
      });
    }
    for (let k = n; k < d.length; k += 1) unmatchedDesign.push(d[k]);
    for (let k = n; k < i.length; k += 1) unmatchedImpl.push(i[k]);
  }
  return { matched, unmatchedDesign, unmatchedImpl };
}

function isDrift(m) {
  return (
    Math.abs(m.dx) > POS_TOL ||
    Math.abs(m.dy) > POS_TOL ||
    Math.abs(m.dw) > SIZE_TOL ||
    Math.abs(m.dh) > SIZE_TOL ||
    Math.abs(m.dfs) > 0.5 ||
    m.dfw !== 0
  );
}

// Detect a systematic offset: a value V (|V|>POS_TOL) shared by >=55% of
// matched runs within a ±2px band — i.e. the whole screen is shifted.
function systematicOffset(matched, axis) {
  if (matched.length < 4) return null;
  let best = null;
  for (const anchor of matched) {
    const v = anchor[axis];
    if (Math.abs(v) <= POS_TOL) continue;
    const inBand = matched.filter((m) => Math.abs(m[axis] - v) <= 2).length;
    if (!best || inBand > best.count) best = { value: v, count: inBand };
  }
  if (best && best.count / matched.length >= 0.55) {
    return Math.round(best.value * 10) / 10;
  }
  return null;
}

function mean(nums) {
  if (nums.length === 0) return 0;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

function summarise(name, design, impl) {
  const { matched, unmatchedDesign, unmatchedImpl } = pairRuns(design, impl);
  const drift = matched.filter(isDrift);
  return {
    name,
    crossState: CROSS_STATE.has(name),
    matched: matched.length,
    drift: drift.length,
    meanAbsDx: Math.round(mean(matched.map((m) => Math.abs(m.dx))) * 100) / 100,
    meanAbsDy: Math.round(mean(matched.map((m) => Math.abs(m.dy))) * 100) / 100,
    sysDx: systematicOffset(matched, "dx"),
    sysDy: systematicOffset(matched, "dy"),
    unmatchedDesign: unmatchedDesign.length,
    unmatchedImpl: unmatchedImpl.length,
    detail: { matched, unmatchedDesign, unmatchedImpl },
  };
}

function main() {
  const args = process.argv.slice(2);
  const screenIdx = args.indexOf("--screen");
  const onlyScreen = screenIdx >= 0 ? args[screenIdx + 1] : null;

  const design = loadJson("design.json");
  const impl = loadJson("impl.json");
  const names = Object.keys(design).filter((n) => Array.isArray(impl[n]));

  const summaries = names
    .map((n) => summarise(n, design[n], impl[n]))
    .sort((a, b) => b.drift - a.drift);

  if (onlyScreen) {
    const s = summaries.find((x) => x.name === onlyScreen);
    if (!s) {
      console.error(`No geometry for screen "${onlyScreen}"`);
      process.exit(1);
    }
    console.log(`\nElement-geometry detail · ${s.name}` + (s.crossState ? "  [cross-state]" : ""));
    console.log("=".repeat(64));
    console.log(`matched runs: ${s.matched}   drift>${POS_TOL}px: ${s.drift}` +
      `   sysDx: ${s.sysDx ?? "-"}   sysDy: ${s.sysDy ?? "-"}`);
    console.log("");
    console.log("  dx     dy     dw     dh   text");
    for (const m of s.detail.matched.slice().sort((a, b) => Math.abs(b.dy) - Math.abs(a.dy))) {
      const flag = isDrift(m) ? "*" : " ";
      const f = (v) => String(v).padStart(6);
      console.log(`${flag} ${f(m.dx)} ${f(m.dy)} ${f(m.dw)} ${f(m.dh)}   ${m.text}`);
    }
    if (s.detail.unmatchedDesign.length > 0) {
      console.log(`\n  design-only runs (${s.detail.unmatchedDesign.length}):`);
      for (const r of s.detail.unmatchedDesign) console.log(`    "${r.t}"  @${r.x},${r.y}`);
    }
    if (s.detail.unmatchedImpl.length > 0) {
      console.log(`\n  impl-only runs (${s.detail.unmatchedImpl.length}):`);
      for (const r of s.detail.unmatchedImpl) console.log(`    "${r.t}"  @${r.x},${r.y}`);
    }
    console.log("");
    return;
  }

  console.log("\nFieldOps V2 element-geometry diff (design SSOT vs impl)");
  console.log("=".repeat(78));
  console.log("(text-run boxes; same Chromium + Geist on both sides → delta = real drift)\n");
  console.log("Screen                 Matched  Drift  Mean|dx| Mean|dy|  SysOffset   Unmatched");
  let aggDrift = 0;
  let aggMatched = 0;
  for (const s of summaries) {
    const sys = [
      s.sysDx !== null ? `dx${s.sysDx > 0 ? "+" : ""}${s.sysDx}` : "",
      s.sysDy !== null ? `dy${s.sysDy > 0 ? "+" : ""}${s.sysDy}` : "",
    ].filter(Boolean).join(" ") || "-";
    const tag = s.crossState ? " [cross-state]" : "";
    console.log(
      `${s.name.padEnd(22)} ${String(s.matched).padStart(6)} ${String(s.drift).padStart(6)} ` +
      `${String(s.meanAbsDx).padStart(8)} ${String(s.meanAbsDy).padStart(8)}  ${sys.padEnd(12)} ` +
      `${s.unmatchedDesign}/${s.unmatchedImpl}${tag}`,
    );
    if (!s.crossState) {
      aggDrift += s.drift;
      aggMatched += s.matched;
    }
  }
  console.log("=".repeat(78));
  console.log(
    `Comparable screens: ${summaries.filter((s) => !s.crossState).length}` +
    `   total matched runs: ${aggMatched}   drifted: ${aggDrift}` +
    `   (${aggMatched ? Math.round((1 - aggDrift / aggMatched) * 1000) / 10 : 0}% within ${POS_TOL}px)`,
  );

  const reportPath = path.join(GEO_DIR, "element-diff-report.json");
  fs.writeFileSync(
    reportPath,
    JSON.stringify(
      summaries.map(({ detail, ...rest }) => ({ ...rest, runs: detail.matched.length })),
      null,
      2,
    ),
  );
  console.log(`\nWrote summary → ${reportPath}`);
  console.log("Per-screen detail: node scripts/qa/fieldops-v2-element-diff.js --screen <name>\n");
}

main();
