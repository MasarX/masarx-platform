const { shouldRenderBlock } = require('./block-conditions');
const { fitTextToBox, widestLineWidth } = require('./text-fit');

const resolvePathValue = (root, pathStr) => {
  if (!root || !pathStr || pathStr.trim().length === 0) return undefined;
  const iterator = pathStr.matchAll(/([^[.\]]+)|\[(\d+)\]/g);
  let current = root;
  for (const match of iterator) {
    if (current === undefined || current === null) return undefined;
    if (match[1] !== undefined) {
      current = current?.[match[1]];
    } else if (match[2] !== undefined) {
      const index = Number(match[2]);
      current = Array.isArray(current) ? current[index] : undefined;
    }
  }
  return current;
};

const stringify = (value, fallback) => {
  if (value === undefined || value === null) return fallback ?? '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    return JSON.stringify(value);
  } catch (_err) {
    return fallback ?? '';
  }
};

const overlaps = (a, b, eps = 0.01) =>
  !(
    a.x + a.width <= b.x + eps ||
    b.x + b.width <= a.x + eps ||
    a.y + a.height <= b.y + eps ||
    b.y + b.height <= a.y + eps
  );

const leftFromAlign = (block, width) => {
  const x = typeof block.x === 'number' ? block.x : 0;
  if (block.align === 'center') return x - width / 2;
  if (block.align === 'right') return x - width;
  return x;
};

const blockBox = (payload, block, ctx) => {
  if (!block || typeof block !== 'object') return null;
  if (!shouldRenderBlock(block, payload, resolvePathValue)) return null;
  const type = block.type;
  if (type === 'rect' || type === 'line') return null;

  if (type === 'text') {
    const raw = stringify(resolvePathValue(payload, block.value_path), block.fallback);
    if (!raw) return null;
    const textDefaults = ctx && typeof ctx.textDefaults === 'object' && ctx.textDefaults ? ctx.textDefaults : null;
    const selectTextFont = typeof ctx.selectTextFont === 'function' ? ctx.selectTextFont : null;
    const preferredFont = selectTextFont ? selectTextFont(block.font, raw, block, payload) : null;
    const font = preferredFont || ctx.selectFont(block.font);
    const fallbackMeasure = ctx && typeof ctx.measureTextWidthWithFallback === 'function' && preferredFont
      ? (text, size) => ctx.measureTextWidthWithFallback(text, size, preferredFont, ctx.selectFont(block.font))
      : null;
    const fontSize = Number(block.font_size || 12);
    const minSize = Number(block.min_font_size || textDefaults?.min_font_size || 8);
    const hardMinSizeRaw = Number(block.hard_min_font_size || textDefaults?.hard_min_font_size || 0.01);
    const hardMinSize = Number.isFinite(hardMinSizeRaw) && hardMinSizeRaw > 0
      ? Math.min(hardMinSizeRaw, minSize)
      : Math.min(0.01, minSize);
    const maxWidth = Number(block.max_width || block.width || ctx.pageW - 12);
    const maxHeight = block.max_height != null ? Number(block.max_height) : (block.height != null ? Number(block.height) : null);
    const getTextForFit = typeof ctx.getTextForFit === 'function' ? ctx.getTextForFit : null;
    const getLineForDraw = typeof ctx.getLineForDraw === 'function' ? ctx.getLineForDraw : null;
    const fitInput = getTextForFit ? getTextForFit(raw, block, payload) : raw;
    const fitted = fitTextToBox(fitInput, font, fontSize, maxWidth, maxHeight, {
      minSize,
      hardMinSize,
      overflow: block.text_overflow || textDefaults?.overflow,
      wrap: !!block.wrap,
      lineHeightFactor: block.line_height_factor || textDefaults?.line_height_factor,
      measureTextWidth: fallbackMeasure,
    });
    const drawLines = getLineForDraw ? fitted.lines.map((line) => getLineForDraw(line, raw, block, payload)) : fitted.lines;
    const width = widestLineWidth(font, drawLines, fitted.size, fallbackMeasure);
    const height = fitted.totalHeight;
    const x = leftFromAlign(block, width);
    const y0 = typeof block.y === 'number' ? block.y : 0;
    let y = y0;
    if (typeof block.height === 'number' && block.height > 0) {
      if (block.valign === 'top') y = y0 + Math.max(0, block.height - height);
      else if (block.valign === 'middle') y = y0 + Math.max(0, (block.height - height) / 2);
    }
    return {
      blockType: 'text',
      blockLabel: block.value_path || block.fallback || 'text',
      section_key: block.section_key,
      x,
      y,
      width,
      height,
      fit_size: fitted.size,
      line_count: drawLines.length,
      unfit: fitted.fits === false,
      fit_fits: fitted.fits,
      fit_fits_width: fitted.fits_width,
      fit_fits_height: fitted.fits_height,
    };
  }

  if (type === 'barcode') {
    const raw = stringify(resolvePathValue(payload, block.value_path), block.fallback);
    if (!raw) return null;
    const width = Number(block.width || block.max_width || 0);
    const totalHeight = Number(block.height || 0);
    const reserved = typeof block.reserve_bottom === 'number' ? Math.max(0, block.reserve_bottom) : 0;
    const height = Math.max(0, totalHeight - reserved);
    const x = leftFromAlign(block, width);
    const y0 = typeof block.y === 'number' ? block.y : 0;
    const y = y0 + reserved;
    return {
      blockType: 'barcode',
      blockLabel: block.value_path || 'barcode',
      section_key: block.section_key,
      x,
      y,
      width,
      height,
    };
  }

  if (type === 'image') {
    const width = Number(block.width || 0);
    const height = Number(block.height || 0);
    if (width <= 0 || height <= 0) return null;
    const x = leftFromAlign(block, width);
    const y = typeof block.y === 'number' ? block.y : 0;
    return {
      blockType: 'image',
      blockLabel: block.asset_ref || block.value_path || 'image',
      section_key: block.section_key,
      x,
      y,
      width,
      height,
    };
  }

  return null;
};

module.exports = {
  resolvePathValue,
  stringify,
  overlaps,
  leftFromAlign,
  blockBox,
};
