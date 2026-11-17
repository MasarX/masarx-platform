/* eslint-disable no-console */
const fs = require('fs');
const path = require('path');
const { PDFDocument, rgb, StandardFonts, degrees } = require('pdf-lib');

const { fitTextToBox, widestLineWidth } = require('../render/text-fit');
const { shouldRenderBlock } = require('../render/block-conditions');
const { resolvePathValue, stringify } = require('../render/layout-sim');
const { drawCode128 } = require('../render/draw-code128');

const normalizeColor = (color) => {
  if (!color) return rgb(0, 0, 0);
  if (typeof color === 'string') {
    const s = color.trim();
    const hex = s.match(/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/);
    if (hex) {
      const raw = hex[1];
      const full = raw.length === 3 ? raw.split('').map((c) => c + c).join('') : raw;
      const r = parseInt(full.slice(0, 2), 16) / 255;
      const g = parseInt(full.slice(2, 4), 16) / 255;
      const b = parseInt(full.slice(4, 6), 16) / 255;
      return rgb(r, g, b);
    }
    if (s.toLowerCase() === 'black') return rgb(0, 0, 0);
    if (s.toLowerCase() === 'white') return rgb(1, 1, 1);
  }
  if (typeof color === 'object') {
    const r = Number(color.r);
    const g = Number(color.g);
    const b = Number(color.b);
    if ([r, g, b].every((n) => Number.isFinite(n))) {
      const scale = Math.max(r, g, b) > 1 ? 255 : 1;
      return rgb(r / scale, g / scale, b / scale);
    }
  }
  return rgb(0, 0, 0);
};

const selectFont = async (pdfDoc, cache, name) => {
  const key = (name || 'helvetica').toLowerCase();
  if (cache.has(key)) return cache.get(key);
  const p = (async () => {
    switch (key) {
      case 'helvetica-bold':
      case 'helvetica_bold':
      case 'bold':
        return await pdfDoc.embedFont(StandardFonts.HelveticaBold);
      case 'courier':
      case 'barcode':
        return await pdfDoc.embedFont(StandardFonts.Courier);
      case 'times':
      case 'times-roman':
        return await pdfDoc.embedFont(StandardFonts.TimesRoman);
      default:
        return await pdfDoc.embedFont(StandardFonts.Helvetica);
    }
  })();
  cache.set(key, p);
  return p;
};

const resolveTemplateSnapshot = (composed) => (
  composed?.job?.template ||
  composed?.job?.template_snapshot ||
  composed?.job?.templateSnapshot ||
  composed?.template ||
  composed?.template_snapshot ||
  {}
);

const resolveRendererConfig = (snapshot, labelType = 'shipping') => {
  if (!snapshot || typeof snapshot !== 'object') return {};
  const rc = snapshot.renderer_config || snapshot.rendererConfig;
  if (rc && typeof rc === 'object') return rc;
  const templates = snapshot.templates;
  if (templates && typeof templates === 'object') {
    const candidate = templates[labelType] || templates[String(labelType || '').toLowerCase()];
    if (candidate && typeof candidate === 'object') return candidate;
  }
  return {};
};

const renderComposedLabelPdf = async (composed, outFile, opts = {}) => {
  const payload = composed?.payload || {};
  const snapshot = resolveTemplateSnapshot(composed);
  const labelType = String(opts.labelType || 'shipping').toLowerCase();
  const rendererConfig = resolveRendererConfig(snapshot, labelType);
  const pageCfg = rendererConfig.page || {};

  const widthPt = Math.round((pageCfg.width_inch || 4) * 72);
  const heightPt = Math.round((pageCfg.height_inch || 6) * 72);

  const dpi = Number.isFinite(Number(opts.dpi)) ? Number(opts.dpi) : (Number(pageCfg.dpi) || 203);
  const quietZoneModules = Number.isFinite(Number(opts.quietZoneModules)) ? Math.floor(Number(opts.quietZoneModules)) : 10;
  const minQuietZoneModules = Number.isFinite(Number(opts.minQuietZoneModules)) ? Math.floor(Number(opts.minQuietZoneModules)) : 4;
  const targetDots = Number.isFinite(Number(opts.targetDots)) ? Math.floor(Number(opts.targetDots)) : 2;
  const hardMinDots = Number.isFinite(Number(opts.hardMinDots)) ? Math.floor(Number(opts.hardMinDots)) : 1;

  const pdfDoc = await PDFDocument.create();
  const page = pdfDoc.addPage([widthPt, heightPt]);
  const fontCache = new Map();

  const blocks = Array.isArray(rendererConfig.blocks) ? rendererConfig.blocks : [];
  const barcodeMeta = [];

  for (const block of blocks) {
    if (!block || typeof block !== 'object') continue;
    if (!shouldRenderBlock(block, payload, resolvePathValue)) continue;

    const x = typeof block.x === 'number' ? block.x : 0;
    const y = typeof block.y === 'number' ? block.y : 0;

    if (block.type === 'rect') {
      page.drawRectangle({
        x,
        y,
        width: block.width || 0,
        height: block.height || 0,
        borderWidth: block.stroke_width || 1,
        borderColor: normalizeColor(block.color),
      });
      continue;
    }

    if (block.type === 'line') {
      const x2 = typeof block.width === 'number' ? block.width : x;
      const y2 = typeof block.height === 'number' ? block.height : y;
      page.drawLine({ start: { x, y }, end: { x: x2, y: y2 }, thickness: block.stroke_width || 1, color: normalizeColor(block.color) });
      continue;
    }

    if (block.type === 'barcode') {
      const val = stringify(resolvePathValue(payload, block.value_path), block.fallback);
      if (!val) continue;
      const targetHeight = block.height || 0;
      const reservedBottom = typeof block.reserve_bottom === 'number' ? Math.max(0, block.reserve_bottom) : 0;
      const availableHeight = targetHeight > 0 ? Math.max(0, targetHeight - reservedBottom) : targetHeight;
      const w = Number(block.max_width || block.width || (widthPt - 12));
      const h = Number(availableHeight || block.height || 0);
      const meta = drawCode128(page, val, {
        x,
        y: y + reservedBottom,
        width: w,
        height: h,
        align: block.align,
        dpi,
        base_module_width_pt: block.module_width,
        max_scale: block.max_scale,
        preferred_quiet_zone_modules: quietZoneModules,
        min_quiet_zone_modules: minQuietZoneModules,
        target_module_width_dots: targetDots,
        hard_min_module_width_dots: hardMinDots,
        snap_to_dots: true,
        color: normalizeColor(block.color),
      });
      barcodeMeta.push({ value_path: block.value_path || null, ...meta });
      continue;
    }

    if (block.type === 'text') {
      const val = stringify(resolvePathValue(payload, block.value_path), block.fallback);
      if (!val) continue;
      const font = await selectFont(pdfDoc, fontCache, block.font);
      const fontSize = Number(block.font_size || 12);
      const maxWidth = Number(block.max_width || block.width || (widthPt - 12));
      const maxHeight = block.max_height != null ? Number(block.max_height) : (block.height != null ? Number(block.height) : null);
      const fitted = fitTextToBox(String(val), font, fontSize, maxWidth, maxHeight, {
        minSize: Number.isFinite(Number(block.min_font_size)) ? Number(block.min_font_size) : 6,
        hardMinSize: Number.isFinite(Number(block.hard_min_font_size)) ? Number(block.hard_min_font_size) : 4,
        overflow: block.text_overflow || 'shrink',
        wrap: !!block.wrap,
        lineHeightFactor: block.line_height_factor,
      });

      const drawLines = fitted.lines;
      const color = normalizeColor(block.color);
      const rotate = typeof block.rotation === 'number' ? degrees(block.rotation) : undefined;

      if (drawLines.length <= 1) {
        const line = drawLines[0] || '';
        const lineWidth = font.widthOfTextAtSize(line, fitted.size);
        let drawX = x;
        if (block.align === 'center') drawX = x - lineWidth / 2;
        else if (block.align === 'right') drawX = x - lineWidth;
        page.drawText(line, { x: drawX, y, size: fitted.size, font, color, ...(rotate ? { rotate } : {}) });
      } else {
        const lineHeight = fitted.lineHeight;
        const textHeight = fitted.textHeight;
        const totalHeight = fitted.totalHeight;
        const descentFactor = typeof block.baseline_descent_factor === 'number' ? block.baseline_descent_factor : 0.2;
        const startY = y + totalHeight;
        for (let i = 0; i < drawLines.length; i += 1) {
          const line = drawLines[i] ?? '';
          const lineWidth = widestLineWidth(font, [line], fitted.size);
          let drawX = x;
          if (block.align === 'center') drawX = x - lineWidth / 2;
          else if (block.align === 'right') drawX = x - lineWidth;
          const lineBoxBottom = startY - (lineHeight * (i + 1));
          const drawY = lineBoxBottom + (textHeight * descentFactor);
          page.drawText(line, { x: drawX, y: drawY, size: fitted.size, font, color, ...(rotate ? { rotate } : {}) });
        }
      }
      continue;
    }

    // Skip image blocks in sim mode: barcode scanning tests don't require assets.
  }

  const bytes = await pdfDoc.save();
  if (outFile) {
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    fs.writeFileSync(outFile, Buffer.from(bytes));
  }

  return { bytes: new Uint8Array(bytes), barcodeMeta, dpi, widthPt, heightPt };
};

module.exports = {
  normalizeColor,
  renderComposedLabelPdf,
};

