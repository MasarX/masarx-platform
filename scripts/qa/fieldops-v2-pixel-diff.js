#!/usr/bin/env node
// Pixel-diff harness for FieldOps V2 design-vs-impl audit. Loads each
// matched design-*.png and impl-*.png pair, normalizes them to the same
// dimensions (the design canvas artboard is 380×780; impl captures are
// full-page so we crop to the phone-frame region), and computes a
// per-pixel RGB delta. Outputs a percentage similarity + worst-area
// rectangle so the audit can speak in numbers, not adjectives.
//
// Run: `node scripts/qa/fieldops-v2-pixel-diff.js`
// Output: `tests/fieldops-e2e/__screenshots__/visual-diff/pixel-diff-report.json`
//
// METHODOLOGY HISTORY (similarity scores are not apples-to-apples across
// these breakpoints — compare only within the same methodology era):
//   - IMPL_CROP tightening (commit 93c1d5b2f, 2026-05-13): trimmed pure-
//     black phone-frame padding from the crop bounds. Most screens
//     scored slightly higher (more honest); a few sheets dropped because
//     the prior bg padding had been pixel-matching design's dark bg.
//   - Bilinear resize (commit bc977ea4f, 2026-05-13): replaced nearest-
//     neighbor resample with bilinear. Comparable mean +1.04pp without
//     regression; collapses nearest-neighbor quantization noise that
//     was inflating RMS-similarity with the harness's own resample
//     artifact (not real visible drift). Real 1-2px misalignment still
//     trips the 30-RGB diffRatio threshold.
//   - Element-bbox impl capture (2026-05-16): the impl side is now
//     screenshotted by the `mobile-v2-pixel-frame` testID element box,
//     producing a native 380×780 PNG. The previous full-page capture +
//     fixed `IMPL_CROP` rectangle had a systematic few-pixel offset that
//     shifted every screen against the design artboard; the new capture
//     removes that offset so the diff reflects real content drift only.

"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { PNG } = require("pngjs");

const ROOT = path.resolve(__dirname, "..", "..");
const DIR = path.join(ROOT, "tests", "fieldops-e2e", "__screenshots__", "visual-diff");

// Pairs: [outName, designFile, implFile]. The impl captures show a full
// 2400×1400 viewport with the gallery sidebar on the left and the
// phone-frame floating mid-right. The phone-frame is rendered at ~390px
// wide and starts at roughly x≈1126, y≈260 (empirically). We crop the
// impl PNG to that frame so it's directly comparable to the 380×780
// design artboard.
//
// Pairs are derived dynamically: any `design-<name>.png` that also has
// `impl-<name>.png` is a pair. Honors AGENTS.md "zero hardcoding" —
// adding a new design anchor to `capture-design-anchors.spec.ts` and a
// matching impl gallery entry is enough; this script auto-picks them
// up on next run.
//
// Excludes `canvas-fullpage` (whole-canvas reference, not a per-screen
// artboard) and `live-login` (live-impl-vs-design composite).
const PAIR_EXCLUDE = new Set(["canvas-fullpage", "live-login"]);

// Pairs where the design canvas and impl gallery render the same sheet
// component in different lifecycle states, so per-pixel similarity is
// dominated by state-drift rather than design parity. The diff still
// runs and reports a score so visual review can inspect the rendering,
// but these pairs are marked `crossState: true` and excluded from any
// aggregate parity metric. Resolving them requires either aligning the
// gallery demo seed to the design canvas state (preferred) or refactoring
// the impl component to accept caller-controlled state props (e.g.
// optional subtitle / hideSeal for sheet-receive). Tracked separately
// in the project backlog.
//
// Keep this map keyed on pair name (not anchor id) so the script stays
// pair-derivation-symmetric.
// `pod` and `sheet-cash-drop` were cross-state until the 2026-05-16
// audit-cycle-2 rebuilds: the POD screen became the design ScrPOD
// multi-step wizard (its first step IS the p-scan scan viewfinder, so the
// `pod` pair now compares the same state) and the cash-drop sheet became
// the design SheetCashDrop numberpad form (the gallery demo is seeded to
// the design canvas's 0-SAR artboard state). Both are now genuine
// comparable pairs and have been removed from this exclusion map.
const CROSS_STATE_PAIRS = Object.freeze({
  "sheet-receive":
    "design=initial body (0/142, supplier ID input, missing/surplus/verified pills); impl=mid-flow body (46/48, seal intact, photo step). Subtitle already aligned via caller-controlled prop; remaining drift requires impl component to support hidden/optional seal+photo sections for initial-state rendering.",
  tasks:
    "design=Supervisor `Smart inbox` empty-state artboard (0/0/0/0 NOW/TODAY/LATER/TOTAL, All-clear illustration); impl=Driver Tasks populated state (3/2/1/6, Sync outbox + 2 task cards). Two different roles + two different states; per-pixel similarity reflects role/state drift, not parity gaps. The impl gallery renders the canonical driver Tasks list (matches `ui_navigation.apps.mobile` SSOT); the supervisor Smart inbox is exposed via the Supervisor gallery row, so this pair is a same-screen-name collision rather than a parity defect.",
  "sync-queue":
    "design=empty `All caught up` artboard (0 pending, last synced never, cloud-check disc + 'No pending writes. Local cache and server are in sync.'); impl=populated outbox state (4 entries: POD commit queued / Stop update retrying / Failed delivery queued / Customer message sent). Same component (ScrSyncQueue in flow-system.jsx) — design canvas snapshot was taken with an empty store, impl preview demonstrates the offline outbox feature shipped under the V2 production cutover. Both states are valid lifecycle points of the same screen; pixel-diff is dominated by lifecycle drift, not parity gaps.",
});

function derivePairs(dir) {
  const files = fs.readdirSync(dir);
  const designs = new Map();
  const impls = new Set();
  for (const f of files) {
    let m = f.match(/^design-(.+)\.png$/);
    if (m && !PAIR_EXCLUDE.has(m[1])) designs.set(m[1], f);
    m = f.match(/^impl-(.+)\.png$/);
    if (m) impls.add(m[1]);
  }
  const pairs = [];
  for (const [name, designFile] of designs) {
    if (impls.has(name)) pairs.push([name, designFile, `impl-${name}.png`]);
  }
  pairs.sort((a, b) => a[0].localeCompare(b[0]));
  return pairs;
}

const PAIRS = derivePairs(DIR);

// Both sides are now captured as native 380×780 element screenshots:
// the design artboard via its `[data-dc-slot]` bounding box, the impl
// phone frame via its `mobile-v2-pixel-frame` testID bounding box. No
// full-page screenshot, no fixed-rectangle crop — so there is no
// crop-misalignment offset systematically penalising every screen. The
// bilinear resize below is an identity transform whenever a capture is
// already 380×780 (the normal case) and a safety net for any ±1px
// element-capture rounding.
const REF_W = 380;
const REF_H = 780;

function loadPng(p) {
  const buf = fs.readFileSync(p);
  return PNG.sync.read(buf);
}

// Bilinear resize. Sample each output pixel from the 4 nearest source
// pixels weighted by sub-pixel distance. Smooths antialiased edges that
// nearest-neighbor would quantize to hard 1-2px transitions, so
// stroke/border changes register as small per-pixel deltas instead of
// large false-positive jumps. RMS-similarity now tracks visible parity
// more closely (audit Agent B verdict on 886e55c1a).
function resizeBilinear(src, w, h) {
  const out = new PNG({ width: w, height: h });
  // Map output [0..w-1] → source [0..src.width-1] by scaling along the
  // outer index span; same vertically. This keeps the corners pinned and
  // avoids a half-pixel offset when both dims are >1.
  const xScale = w > 1 ? (src.width - 1) / (w - 1) : 0;
  const yScale = h > 1 ? (src.height - 1) / (h - 1) : 0;
  for (let y = 0; y < h; y++) {
    const fy = y * yScale;
    const y0 = Math.floor(fy);
    const y1 = Math.min(src.height - 1, y0 + 1);
    const wy = fy - y0;
    const wy1 = 1 - wy;
    for (let x = 0; x < w; x++) {
      const fx = x * xScale;
      const x0 = Math.floor(fx);
      const x1 = Math.min(src.width - 1, x0 + 1);
      const wx = fx - x0;
      const wx1 = 1 - wx;
      const i00 = (y0 * src.width + x0) * 4;
      const i01 = (y0 * src.width + x1) * 4;
      const i10 = (y1 * src.width + x0) * 4;
      const i11 = (y1 * src.width + x1) * 4;
      const di = (y * w + x) * 4;
      for (let c = 0; c < 4; c++) {
        const v00 = src.data[i00 + c];
        const v01 = src.data[i01 + c];
        const v10 = src.data[i10 + c];
        const v11 = src.data[i11 + c];
        const top = v00 * wx1 + v01 * wx;
        const bot = v10 * wx1 + v11 * wx;
        out.data[di + c] = Math.round(top * wy1 + bot * wy);
      }
    }
  }
  return out;
}

// Fuzzy neighborhood match — a pixel at (x,y) in A is considered
// "visually matched" if ANY pixel within an N-pixel neighborhood
// in B is within the RGB tolerance. This absorbs the irreducible
// subpixel-AA drift between two different renderers
// (Babel-standalone HTML vs React Native Web in Chromium) which
// shifts glyph + border edges by ±N px without changing what a
// sighted reviewer sees. It does NOT absorb structural differences
// (missing card, wrong copy, wrong color) which span >N px.
//
// The 5×5 (±2px) variant is the appropriate measure for
// "visually identical" in this cross-renderer harness: text-heavy
// screens (role-select, route, rider-today) accumulate font-metric
// rounding across multiple glyphs and can drift by up to 2px on
// individual edges; structural defects (a missing card, wrong
// label, etc.) still span >5px so cannot be hidden by ±2px
// neighborhood matching.
function fuzzyMatch(a, b, x, y, tolerance = 30, radius = 2) {
  const ia = (y * a.width + x) * 4;
  const ar = a.data[ia], ag = a.data[ia + 1], ab = a.data[ia + 2];
  const tolSq = tolerance * tolerance;
  for (let dy = -radius; dy <= radius; dy++) {
    const yb = y + dy;
    if (yb < 0 || yb >= b.height) continue;
    for (let dx = -radius; dx <= radius; dx++) {
      const xb = x + dx;
      if (xb < 0 || xb >= b.width) continue;
      const ib = (yb * b.width + xb) * 4;
      const dr = ar - b.data[ib];
      const dg = ag - b.data[ib + 1];
      const db = ab - b.data[ib + 2];
      if (dr * dr + dg * dg + db * db <= tolSq) return true;
    }
  }
  return false;
}

function comparePngs(a, b) {
  const w = Math.min(a.width, b.width);
  const h = Math.min(a.height, b.height);
  let totalDelta = 0;
  let differentPixels = 0;
  let fuzzyMatchedPixels = 0;
  const tile = 40;
  const cols = Math.ceil(w / tile);
  const rows = Math.ceil(h / tile);
  const tileScores = new Array(cols * rows).fill(0);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const ia = (y * a.width + x) * 4;
      const ib = (y * b.width + x) * 4;
      const dr = a.data[ia] - b.data[ib];
      const dg = a.data[ia + 1] - b.data[ib + 1];
      const db = a.data[ia + 2] - b.data[ib + 2];
      const sq = dr * dr + dg * dg + db * db;
      totalDelta += sq;
      // Threshold: any pixel with sqrt(distance) > 30 counts as visibly different.
      if (sq > 900) {
        differentPixels += 1;
        // For pixels that are different at point-to-point, check
        // the 5×5 (±2px) neighborhood for an AA-shifted equivalent.
        if (fuzzyMatch(a, b, x, y, 30, 2)) fuzzyMatchedPixels += 1;
      } else {
        // Already a point-to-point match.
        fuzzyMatchedPixels += 1;
      }
      const ti = Math.floor(y / tile) * cols + Math.floor(x / tile);
      tileScores[ti] += sq;
    }
  }
  const totalPixels = w * h;
  const rms = Math.sqrt(totalDelta / totalPixels) / 255; // 0..~1
  const similarity = 1 - rms;
  const diffRatio = differentPixels / totalPixels;
  const fuzzyRatio = fuzzyMatchedPixels / totalPixels;
  // Find worst tile to point reviewer at the highest-divergence region.
  let worstIdx = 0;
  let worstScore = -1;
  for (let i = 0; i < tileScores.length; i++) {
    if (tileScores[i] > worstScore) {
      worstScore = tileScores[i];
      worstIdx = i;
    }
  }
  return {
    width: w,
    height: h,
    similarity: Number(similarity.toFixed(4)),
    diffRatio: Number(diffRatio.toFixed(4)),
    fuzzyMatch: Number(fuzzyRatio.toFixed(4)),
    worstTile: {
      col: worstIdx % cols,
      row: Math.floor(worstIdx / cols),
      ratio: Number(
        (worstScore /
          (Math.min(tile, w - (worstIdx % cols) * tile) *
            Math.min(tile, h - Math.floor(worstIdx / cols) * tile) *
            255 *
            255 *
            3)).toFixed(4),
      ),
    },
  };
}

const report = [];
for (const [name, designFile, implFile] of PAIRS) {
  const designPath = path.join(DIR, designFile);
  const implPath = path.join(DIR, implFile);
  if (!fs.existsSync(designPath) || !fs.existsSync(implPath)) {
    report.push({ name, status: "missing", designExists: fs.existsSync(designPath), implExists: fs.existsSync(implPath) });
    continue;
  }
  const designPng = loadPng(designPath);
  const implPng = loadPng(implPath);
  // Resize both to the common 380×780 reference frame. Identity when a
  // capture is already native 380×780 (the normal case post element-bbox
  // capture); a ±1px safety net otherwise.
  const designResized =
    designPng.width === REF_W && designPng.height === REF_H
      ? designPng
      : resizeBilinear(designPng, REF_W, REF_H);
  const implResized =
    implPng.width === REF_W && implPng.height === REF_H
      ? implPng
      : resizeBilinear(implPng, REF_W, REF_H);
  const diff = comparePngs(designResized, implResized);
  const crossStateNote = CROSS_STATE_PAIRS[name];
  const entry = {
    name,
    status: "ok",
    design: { w: designPng.width, h: designPng.height, file: designFile },
    impl: { w: implPng.width, h: implPng.height, file: implFile },
    ...diff,
  };
  if (crossStateNote !== undefined) {
    entry.crossState = true;
    entry.stateNote = crossStateNote;
  }
  report.push(entry);
}

const outFile = path.join(DIR, "pixel-diff-report.json");
fs.writeFileSync(outFile, JSON.stringify(report, null, 2));

const sortedBySim = [...report]
  .filter((r) => r.status === "ok")
  .sort((a, b) => a.similarity - b.similarity);
console.log("FieldOps V2 design-vs-impl pixel-diff report");
console.log("============================================");
console.log("(higher similarity = closer to design)\n");
console.log(`Pair                        Similarity  Diff%     WorstTile(col,row)   Notes`);
for (const r of sortedBySim) {
  const flag = r.crossState ? " [cross-state]" : "";
  console.log(
    `  ${r.name.padEnd(24)}    ${(r.similarity * 100).toFixed(2).padStart(6)}%   ${(r.diffRatio * 100).toFixed(2).padStart(5)}%   (${r.worstTile.col},${r.worstTile.row})${flag}`,
  );
}

// Headline-comparable subset excludes cross-state pairs whose pixel
// score is dominated by lifecycle drift rather than design parity.
const comparable = sortedBySim.filter((r) => !r.crossState);
const meanSim = comparable.length > 0
  ? comparable.reduce((acc, r) => acc + r.similarity, 0) / comparable.length
  : 0;
// Perceptual similarity = % pixels with RGB delta < 30 (visibly the
// same). This is closer to human perception than the RMS-similarity
// number (which accumulates sub-threshold differences across every
// glyph edge + border AA). Both metrics are reported so reviewers
// can pick the right lens for the question they're answering:
// "what fraction of pixels read as the same to a sighted reviewer?"
// vs "what's the global RMS distance between the two captures?".
const meanDiffRatio = comparable.length > 0
  ? comparable.reduce((acc, r) => acc + r.diffRatio, 0) / comparable.length
  : 0;
const meanPerceptual = 1 - meanDiffRatio;
const meanFuzzy = comparable.length > 0
  ? comparable.reduce((acc, r) => acc + (r.fuzzyMatch ?? 0), 0) / comparable.length
  : 0;
console.log(
  `\nComparable subset: ${comparable.length}/${sortedBySim.length} pairs (excluded ${sortedBySim.length - comparable.length} cross-state)`,
);
console.log(`Mean RMS similarity (comparable):         ${(meanSim * 100).toFixed(2)}%`);
console.log(`Mean perceptual similarity (delta<30):    ${(meanPerceptual * 100).toFixed(2)}%`);
console.log(`Mean fuzzy match (5x5 AA tolerance):      ${(meanFuzzy * 100).toFixed(2)}%`);

const crossState = report.filter((r) => r.crossState);
if (crossState.length > 0) {
  console.log("\nCross-state pairs (similarity not a parity signal):");
  for (const c of crossState) {
    console.log(`  ${c.name.padEnd(24)} — ${c.stateNote}`);
  }
}

const missing = report.filter((r) => r.status === "missing");
if (missing.length > 0) {
  console.log("\nMissing pairs:");
  for (const m of missing) console.log(`  ${m.name} (design=${m.designExists}, impl=${m.implExists})`);
}
console.log(`\nWrote report → ${outFile}`);
