#!/usr/bin/env node
/* eslint-disable no-console */
const fs = require('fs');
const path = require('path');
const { PDFDocument, rgb, StandardFonts } = require('pdf-lib');

const args = (() => {
  const out = {};
  const parts = process.argv.slice(2);
  for (let i = 0; i < parts.length; i++) {
    const arg = parts[i];
    if (arg.startsWith('--')) {
      const trimmed = arg.replace(/^--/, '');
      if (trimmed.includes('=')) {
        const [k, v] = trimmed.split('=');
        out[k] = v;
      } else if (i + 1 < parts.length && !parts[i + 1].startsWith('--')) {
        out[trimmed] = parts[i + 1];
        i += 1;
      } else {
        out[trimmed] = true;
      }
    }
  }
  return out;
})();

if (args.help) {
  console.log('Render a PDF using a label payload JSON + template JSON.');
  console.log('');
  console.log('Usage:');
  console.log('  node scripts/render/worker-render.js --payload <path> [--template <path>] [--out <path>]');
  console.log('');
  console.log('Defaults:');
  console.log('  --payload tmp/label-renderer/payload.json');
  console.log('  --out     tmp/label-renderer/render.pdf');
  process.exit(0);
}

const payloadPath = args.payload || path.join('tmp', 'label-renderer', 'payload.json');
const templatePath = args.template || path.join('supabase', 'templates', 'waybill_v1_5.json');
const outPath = args.out || path.join('tmp', 'label-renderer', 'render.pdf');

const CODE128_PATTERNS = [
  "11011001100", "11001101100", "11001100110", "10010011000", "10010001100", "10001001100", "10011001000",
  "10011000100", "10001100100", "11001001000", "11001000100", "11000100100", "10110011100", "10011011100",
  "10011001110", "10111001100", "10011101100", "10011100110", "11001110010", "11001011100", "11001001110",
  "11011100100", "11001110100", "11101101110", "11101001100", "11100101100", "11100100110", "11101100100",
  "11100110100", "11100110010", "11011011000", "11011000110", "11000110110", "10100011000", "10001011000",
  "10001000110", "10110001000", "10001101000", "10001100010", "11010001000", "11000101000", "11000100010",
  "10110111000", "10110001110", "10001101110", "10111011000", "10111000110", "10001110110", "11101110110",
  "11010001110", "11000101110", "11011101000", "11011100010", "11011101110", "11101011000", "11101000110",
  "11100010110", "11101101000", "11101100010", "11100011010", "11101111010", "11001000010", "11110001010",
  "10100110000", "10100001100", "10010110000", "10010000110", "10000101100", "10000100110", "10110010000",
  "10110000100", "10011010000", "10011000010", "10000110100", "10000110010", "11000010010", "11001010000",
  "11110111010", "11000010100", "10001111010", "10100111100", "10010111100", "10010011110", "10111100100",
  "10011110100", "10011110010", "11110100100", "11110010100", "11110010010", "11011011110", "11011110110",
  "11110110110", "10101111000", "10100011110", "10001011110", "10111101000", "10111100010", "11110101000",
  "11110100010", "10111011110", "10111101110", "11101011110", "11110101110", "11010000100", "11010010000",
  "11010011100", "1100011101011"
];

const encodeCode128B = (value) => {
  const codes = [104];
  let checksum = 104;
  for (let i = 0; i < value.length; i++) {
    const cp = value.charCodeAt(i);
    if (cp < 32 || cp > 126) throw new Error(`Invalid Code128-B char: ${value[i]}`);
    const code = cp - 32;
    codes.push(code);
    checksum += code * (i + 1);
  }
  const checksumCode = checksum % 103;
  codes.push(checksumCode);
  codes.push(106);
  const patterns = codes.map((code) => {
    const p = CODE128_PATTERNS[code];
    if (!p) throw new Error(`Missing pattern ${code}`);
    return p;
  });
  const patternString = patterns.join("");
  const modules = patternString.length + 20;
  return { pattern: patternString, modules };
};

const resolve = (root, pathStr) => {
  if (!root || !pathStr) return undefined;
  return pathStr.split('.').reduce((acc, key) => (acc ? acc[key] : undefined), root);
};

async function render() {
  const payload = JSON.parse(fs.readFileSync(payloadPath, 'utf8'));
  const tpl = JSON.parse(fs.readFileSync(templatePath, 'utf8'));
  const rendererConfig = tpl.templates.shipping;

  const pageCfg = rendererConfig.page || {};
  const widthPoints = Math.max(72, Math.round((pageCfg.width_inch || 4) * 72));
  const heightPoints = Math.max(72, Math.round((pageCfg.height_inch || 6) * 72));
  const pdfDoc = await PDFDocument.create();
  const page = pdfDoc.addPage([widthPoints, heightPoints]);
  const fontCache = new Map();

  const selectFont = async (name) => {
    const key = (name || 'helvetica').toLowerCase();
    if (!fontCache.has(key)) {
      fontCache.set(
        key,
        (async () => {
          switch (key) {
            case 'helvetica-bold':
            case 'bold':
              return pdfDoc.embedFont(StandardFonts.HelveticaBold);
            default:
              return pdfDoc.embedFont(StandardFonts.Helvetica);
          }
        })()
      );
    }
    return fontCache.get(key);
  };

  const blocks = Array.isArray(rendererConfig.blocks) ? rendererConfig.blocks : [];
  const body = payload?.payload || {};
  const defaultWidth = Math.max(24, page.getWidth() - 12);

  console.time('render');
  for (const block of blocks) {
    const x = block.x || 0;
    const y = block.y || 0;

    if (block.type === 'text') {
      const raw = resolve(body, block.value_path) || block.fallback || '';
      if (!raw) continue;
      const font = await selectFont(block.font);
      const size = block.font_size || 12;
      const text = String(raw);
      const textWidth = font.widthOfTextAtSize(text, size);
      let drawX = x;
      if (block.align === 'center') drawX = x - textWidth / 2;
      else if (block.align === 'right') drawX = x - textWidth;
      page.drawText(text, { x: drawX, y, size, font });
      continue;
    }

    if (block.type === 'barcode') {
      const raw = resolve(body, block.value_path) || block.fallback || '';
      if (!raw) continue;
      const { pattern, modules } = encodeCode128B(String(raw));
      let moduleWidth = block.module_width > 0 ? block.module_width : 1.1;
      const targetMax = block.max_width > 0 ? block.max_width : defaultWidth;
      moduleWidth = Math.min(moduleWidth, targetMax / modules);
      moduleWidth = Math.max(moduleWidth, 0.35);
      const quiet = 10 * moduleWidth;
      const totalWidth = modules * moduleWidth;
      let startX = x;
      if (block.align === 'center') startX = x - totalWidth / 2;
      else if (block.align === 'right') startX = x - totalWidth;
      const barHeight = block.height > 0 ? block.height : 56;
      let cursor = startX + quiet;
      let run = 0;
      for (let i = 0; i < pattern.length; i++) {
        const bit = pattern[i];
        if (bit === '1') run += moduleWidth;
        const isLast = i === pattern.length - 1;
        if (bit === '0' || isLast) {
          if (run > 0) {
            page.drawRectangle({ x: cursor, y, width: run, height: barHeight, color: rgb(0, 0, 0) });
            cursor += run;
            run = 0;
          }
          if (bit === '0') cursor += moduleWidth;
        }
      }
      continue;
    }

    if (block.type === 'rect') {
      page.drawRectangle({
        x,
        y,
        width: block.width || 0,
        height: block.height || 0,
        borderWidth: block.stroke_width || 1,
        borderColor: rgb(0, 0, 0)
      });
      continue;
    }
  }
  console.timeEnd('render');
  const bytes = await pdfDoc.save();
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, Buffer.from(bytes));
  console.log(`wrote ${outPath} (${bytes.length} bytes)`);
}

render().catch((err) => {
  console.error(err);
  process.exit(1);
});
