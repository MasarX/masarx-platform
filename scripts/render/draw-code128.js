const { rgb } = require('pdf-lib');
const { CODE128_RUNS, encodeCode128Auto } = require('./code128');

const DEFAULT_DPI = 203;
const DEFAULT_QUIET_ZONE_MODULES = 10;
const DEFAULT_TARGET_MODULE_DOTS = 2;
const DEFAULT_HARD_MIN_MODULE_DOTS = 1;

const clampInt = (v, min, max) => Math.max(min, Math.min(max, Math.floor(v)));

const snapToGrid = (pt, gridPt) => {
  if (!Number.isFinite(pt) || !Number.isFinite(gridPt) || gridPt <= 0) return pt;
  return Math.round(pt / gridPt) * gridPt;
};

const snapToGridCeil = (pt, gridPt) => {
  if (!Number.isFinite(pt) || !Number.isFinite(gridPt) || gridPt <= 0) return pt;
  return Math.ceil(pt / gridPt) * gridPt;
};

const snapToGridFloor = (pt, gridPt) => {
  if (!Number.isFinite(pt) || !Number.isFinite(gridPt) || gridPt <= 0) return pt;
  return Math.floor(pt / gridPt) * gridPt;
};

const resolveBoxX = (x, width, align) => {
  if (align === 'center') return { left: x - width / 2, right: x + width / 2 };
  if (align === 'right') return { left: x - width, right: x };
  return { left: x, right: x + width };
};

const snapStartXWithin = (idealStartX, boxLeft, boxRight, dotPt, totalWidthPt) => {
  if (!Number.isFinite(dotPt) || dotPt <= 0) return idealStartX;
  const maxStart = boxRight - totalWidthPt;
  if (maxStart < boxLeft) return idealStartX;

  const minDot = Math.ceil(boxLeft / dotPt);
  const maxDot = Math.floor(maxStart / dotPt);
  if (maxDot < minDot) return idealStartX;

  const idealDot = Math.round(idealStartX / dotPt);
  const clampedDot = Math.max(minDot, Math.min(maxDot, idealDot));
  return clampedDot * dotPt;
};

const resolveDpi = (dpi, fallbackDpi) => {
  const d = Number(dpi != null ? dpi : fallbackDpi);
  return Number.isFinite(d) && d > 0 ? d : DEFAULT_DPI;
};

const resolveQuietZone = (encodedModules, widthPt, dotPt, maxModuleWidthDotsScale, opts) => {
  const hasFixed = opts.quiet_zone_modules != null;
  const preferred = clampInt(
    hasFixed ? opts.quiet_zone_modules : (opts.preferred_quiet_zone_modules ?? DEFAULT_QUIET_ZONE_MODULES),
    0,
    40,
  );
  const min = clampInt(hasFixed ? preferred : (opts.min_quiet_zone_modules ?? preferred), 0, preferred);

  const targetDots = clampInt(opts.target_module_width_dots ?? DEFAULT_TARGET_MODULE_DOTS, 1, 10);
  const hardMinDots = clampInt(opts.hard_min_module_width_dots ?? DEFAULT_HARD_MIN_MODULE_DOTS, 1, targetDots);

  const widthDots = Math.floor(widthPt / dotPt);
  const effectiveScaleCap = maxModuleWidthDotsScale >= 1 ? maxModuleWidthDotsScale : 1_000_000;

  const dotsFit = (qz) => {
    const total = encodedModules + qz * 2;
    if (total <= 0) return 0;
    return Math.min(Math.floor(widthDots / total), effectiveScaleCap);
  };

  // Prefer keeping the quiet zone large, only shrinking it when needed to reach target/hard-min dots.
  for (let qz = preferred; qz >= min; qz -= 1) {
    if (dotsFit(qz) >= targetDots) return { quiet_zone_modules: qz, target_module_width_dots: targetDots, hard_min_module_width_dots: hardMinDots };
  }
  for (let qz = preferred; qz >= min; qz -= 1) {
    if (dotsFit(qz) >= hardMinDots) return { quiet_zone_modules: qz, target_module_width_dots: targetDots, hard_min_module_width_dots: hardMinDots };
  }

  return { quiet_zone_modules: min, target_module_width_dots: targetDots, hard_min_module_width_dots: hardMinDots };
};

const drawCode128 = (page, value, opts = {}) => {
  if (!page) throw new Error('drawCode128: page is required');
  const encoded = encodeCode128Auto(value);
  if (!encoded) return null;

  const x = Number(opts.x);
  const y = Number(opts.y);
  const width = Number(opts.width);
  const height = Number(opts.height);
  if (![x, y, width, height].every((n) => Number.isFinite(n))) {
    throw new Error('drawCode128: x/y/width/height must be numbers');
  }

  const dpi = resolveDpi(opts.dpi, DEFAULT_DPI);
  const dotPt = 72 / dpi;

  const baseModuleWidthPtRaw = Number(opts.base_module_width_pt);
  const baseModuleWidthPt = Number.isFinite(baseModuleWidthPtRaw) && baseModuleWidthPtRaw > 0 ? baseModuleWidthPtRaw : dotPt;

  const maxScaleRaw = Number(opts.max_scale);
  const maxScale = Number.isFinite(maxScaleRaw) && maxScaleRaw > 0 ? maxScaleRaw : 10;
  const maxModuleWidthPtByScale = baseModuleWidthPt * maxScale;
  const maxModuleWidthDotsScale = Math.floor(maxModuleWidthPtByScale / dotPt);

  const quietZoneDecision = resolveQuietZone(encoded.patternModules, width, dotPt, maxModuleWidthDotsScale, opts);
  const quietZoneModules = quietZoneDecision.quiet_zone_modules;
  const totalModules = encoded.patternModules + quietZoneModules * 2;

  const maxModuleWidthPtByFit = width / totalModules;
  const maxModuleWidthDotsFit = Math.floor(maxModuleWidthPtByFit / dotPt);
  const maxModuleWidthDots = Math.min(maxModuleWidthDotsFit, maxModuleWidthDotsScale > 0 ? maxModuleWidthDotsScale : 1000000);

  let fractionalModuleWidth = false;
  let moduleWidthDots = 0;
  let moduleWidthPt = maxModuleWidthPtByFit;

  if (maxModuleWidthDotsFit >= 1) {
    moduleWidthDots = clampInt(maxModuleWidthDots, 1, 100);
    moduleWidthPt = moduleWidthDots * dotPt;
  } else {
    // Too many modules to fit at even 1 printer dot/module (at the configured dpi).
    // We fall back to fractional module widths to preserve layout, but scanning reliability is not guaranteed.
    fractionalModuleWidth = true;
    moduleWidthDots = 0;
    moduleWidthPt = maxModuleWidthPtByFit;
  }

  const totalWidthPt = totalModules * moduleWidthPt;

  const box = resolveBoxX(x, width, opts.align);

  let startX = box.left;
  if (opts.align === 'center') startX = box.left + (width - totalWidthPt) / 2;
  else if (opts.align === 'right') startX = box.right - totalWidthPt;

  const snapRequested = opts.snap_to_dots !== false;
  const snap = snapRequested && !fractionalModuleWidth;

  // Snap within the barcode box (never exceed bounds).
  let drawY = y;
  let barHeightPt = height;
  if (snap) {
    drawY = snapToGridCeil(y, dotPt);
    const maxHeight = (y + height) - drawY;
    const snappedHeight = snapToGridFloor(maxHeight, dotPt);
    barHeightPt = snappedHeight > 0 ? snappedHeight : Math.max(0, maxHeight);
  }
  const drawStartX = snap ? snapStartXWithin(startX, box.left, box.right, dotPt, totalWidthPt) : startX;

  const color = opts.color || rgb(0, 0, 0);

  let cursorX = drawStartX + quietZoneModules * moduleWidthPt;

  for (const code of encoded.codes) {
    const runs = CODE128_RUNS[code];
    if (!runs) throw new Error(`drawCode128: missing pattern for code ${code}`);

    for (let r = 0; r < runs.length; r += 1) {
      const runWidthPt = runs[r] * moduleWidthPt;
      if (r % 2 === 0) {
        page.drawRectangle({ x: cursorX, y: drawY, width: runWidthPt, height: barHeightPt, color });
      }
      cursorX += runWidthPt;
    }
  }

  const quality = fractionalModuleWidth
    ? 'unscannable'
    : moduleWidthDots >= quietZoneDecision.target_module_width_dots
      ? 'ok'
      : moduleWidthDots >= quietZoneDecision.hard_min_module_width_dots
        ? 'at_risk'
        : 'unscannable';

  return {
    input_length: encoded.inputLength,
    codes_count: encoded.codes.length,
    pattern_modules: encoded.patternModules,
    quiet_zone_modules: quietZoneModules,
    target_module_width_dots: quietZoneDecision.target_module_width_dots,
    hard_min_module_width_dots: quietZoneDecision.hard_min_module_width_dots,
    total_modules: totalModules,
    dpi,
    module_width_dots: moduleWidthDots,
    module_width_pt: moduleWidthPt,
    total_width_pt: totalWidthPt,
    fits_width: totalWidthPt <= width + 0.001,
    fractional_module_width: fractionalModuleWidth,
    snap_to_dots_applied: snap,
    quality,
  };
};

module.exports = {
  drawCode128,
  snapToGrid,
  resolveDpi,
};
