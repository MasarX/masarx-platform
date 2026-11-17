#!/usr/bin/env node
/* eslint-disable no-console */
const fs = require('fs');
const path = require('path');

const argv = process.argv.slice(2);

const getFiles = () => {
  if (argv.length > 0) return argv.map((p) => path.resolve(process.cwd(), p));
  const dir = path.join(process.cwd(), 'supabase', 'templates');
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith('.json') && !f.includes('schema'))
    .map((f) => path.join(dir, f));
};

const overlaps = (a, b) => !(a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y);

const blockBox = (b) => {
  if (b.type === 'rect' || b.type === 'line') return null;
  // Use declared width/height; for text without width, default to max_width or 0, height to font_size+4
  const x = b.x || 0;
  const y = b.y || 0;
  if (b.type === 'text') {
    const width = b.width || b.max_width || 0;
    const height = b.height || (b.font_size || 12) + 4;
    let drawX = x;
    if (b.align === 'center') drawX = x - width / 2;
    else if (b.align === 'right') drawX = x - width;
    return { x: drawX, y, width, height };
  }
  if (b.type === 'barcode') {
    const width = b.width || b.max_width || 0;
    const height = b.height || 56;
    let drawX = x;
    if (b.align === 'center') drawX = x - width / 2;
    else if (b.align === 'right') drawX = x - width;
    return { x: drawX, y: b.y || 0, width, height: height + (b.font_size ? b.font_size + 4 : 0) };
  }
  const width = b.width || 0;
  const height = b.height || 0;
  return { x, y, width, height };
};

const validateLayout = (tpl) => {
  const errors = [];
  const page = tpl.page || {};
  const pageW = (page.width_inch || 4) * 72;
  const pageH = (page.height_inch || 6) * 72;
  const blocks = Array.isArray(tpl.blocks) ? tpl.blocks : [];
  const boxes = [];
  blocks.forEach((b, idx) => {
    const box = blockBox(b);
    if (!box) return;
    if (box.x < 0 || box.y < 0 || box.x + box.width > pageW || box.y + box.height > pageH) {
      errors.push(`Block ${idx} out of page bounds: ${JSON.stringify(box)}`);
    }
    boxes.forEach((bx) => {
      if (overlaps(bx, box)) {
        errors.push(`Block ${idx} overlaps another block at ${JSON.stringify(box)}`);
      }
    });
    boxes.push(box);
  });
  return errors;
};

const main = () => {
  const files = getFiles();
  let failed = 0;
  files.forEach((file) => {
    const json = JSON.parse(fs.readFileSync(file, 'utf8'));
    const shipping = json.templates?.shipping;
    if (!shipping) return;
    const errs = validateLayout(shipping);
    if (errs.length) {
      failed += 1;
      console.error(`[layout-validator] ${file} failed:`);
      errs.forEach((e) => console.error(`  - ${e}`));
    } else {
      console.log(`[layout-validator] ${file} OK`);
    }
  });
  if (failed > 0) process.exit(1);
  console.log('[layout-validator] All layouts OK');
};

main();
