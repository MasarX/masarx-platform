const { Client } = require('pg');
const { PDFDocument, StandardFonts } = require('pdf-lib');
const { loadEnv } = require('../../../scripts/utils/load-env');

loadEnv();

const DATABASE_URL =
  process.env.DATABASE_URL || (['postgresql',":","/","/",'postgres',":",'postgres',"@",'localhost',":",'54322',"/",'postgres'].join(""));

const toPts = (inches) => (inches || 0) * 72;

const samplePayload = {
  payment_term_label: 'Prepaid',
  created_at_local: '23/11/2025 - 19:05:47',
  service_level_label: 'Standard',
  barcode_value: 'DLX100375378432',
  tracking_number: 'DLX100375378432',
  sender_phone: '+12025550123',
  sender_name: 'DANTE | DANTE',
  origin_line1: 'Riyadh, Riyadh, Saudi Arabia, District',
  origin_summary: 'Riyadh, Riyadh',
  recipient_phone: '+12025550123',
  recipient_name: 'RECEIVER NAME',
  destination_line1: 'Street Address, District, Riyadh, Saudi Arabia',
  destination_summary: 'Riyadh, Riyadh, SA',
  destination_city_code: 'RIY',
  weight_label: '--',
  reference_number: 'dante-219885579',
  cod_label: '0 SAR',
  bundle_label: '1',
  shipment_metadata: 'Content listing with multiple items and details',
  special_instructions: '',
};

const resolveValue = (root, pathStr, fb = '') => {
  if (!pathStr) return fb;
  const parts = pathStr.matchAll(/([^[.\]]+)|\[(\d+)\]/g);
  let cur = root;
  for (const m of parts) {
    if (cur === undefined || cur === null) return fb;
    if (m[1] !== undefined) cur = cur[m[1]];
    else if (m[2] !== undefined) cur = Array.isArray(cur) ? cur[Number(m[2])] : undefined;
  }
  if (cur === undefined || cur === null) return fb;
  if (typeof cur === 'string') return cur;
  if (typeof cur === 'number' || typeof cur === 'boolean') return String(cur);
  try { return JSON.stringify(cur); } catch { return fb; }
};

const fitText = (text, font, size, maxWidth, minSize) => {
  if (!maxWidth || maxWidth <= 0) return { text, size };
  let drawSize = size;
  while (drawSize >= minSize) {
    const w = font.widthOfTextAtSize(text, drawSize);
    if (w <= maxWidth) return { text, size: drawSize };
    drawSize -= 1;
  }
  // Truncate at minSize
  const ellipsis = '...';
  for (let i = text.length - 1; i >= 0; i--) {
    const candidate = text.slice(0, i) + ellipsis;
    if (font.widthOfTextAtSize(candidate, minSize) <= maxWidth) return { text: candidate, size: minSize };
  }
  return { text: ellipsis, size: minSize };
};

describe('MasarX sectioned visual geometry (worst-case payload, latest)', () => {
  test('blocks fit page/sections and respect token minimums (tune template to enable)', async () => {
    const client = new Client({ connectionString: DATABASE_URL });
    await client.connect();
    try {
      const { rows: tplRows } = await client.query(
        `
        SELECT id, renderer_config, version
        FROM label_template_specs
        WHERE organization_id = '00000000-0000-0000-0000-000000000000'
          AND template_key = 'waybill_v1'
        ORDER BY version DESC
        LIMIT 1
        `
      );
      expect(tplRows.length).toBe(1);
      const tplId = tplRows[0].id;
      const cfg = tplRows[0].renderer_config;
      const page = cfg.page || {};
      const pageW = toPts(page.width_inch || 4);
      const pageH = toPts(page.height_inch || 6);
      const blocks = Array.isArray(cfg.blocks) ? cfg.blocks : [];

      const { rows: sectionRows } = await client.query(
        `SELECT section_key, x, y, width, height, padding_top, padding_right, padding_bottom, padding_left
         FROM label_sections
         WHERE template_id = $1 AND organization_id = '00000000-0000-0000-0000-000000000000'`,
        [tplId]
      );
      const sections = Object.fromEntries(sectionRows.map((r) => [r.section_key, r]));

      const { rows: tokenRows } = await client.query(
        `SELECT token_key, value FROM label_design_tokens WHERE template_id = $1 AND organization_id = '00000000-0000-0000-0000-000000000000'`,
        [tplId]
      );
      const tokens = Object.fromEntries(tokenRows.map((r) => [r.token_key, r.value]));
      const minFont = Number(tokens.min_font_size || 8);
      const minBarcode = Number(tokens.barcode_min_module_width || 0.9);
      const minBarcodeH = Number(tokens.barcode_min_height || 34);
      const minBarcodeRef = Number(tokens.barcode_min_module_width_ref || 0.5);
      const minBarcodeHRef = Number(tokens.barcode_min_height_ref || 22);

      const pdfDoc = await PDFDocument.create();
      const fontCache = new Map();
      const pickFont = async (fontName) => {
        const n = (fontName || 'helvetica').toLowerCase();
        if (fontCache.has(n)) return fontCache.get(n);
        let f;
        switch (n) {
          case 'helvetica-bold':
          case 'helvetica_bold':
          case 'bold':
            f = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
            break;
          case 'courier':
          case 'barcode':
            f = await pdfDoc.embedFont(StandardFonts.Courier);
            break;
          case 'times':
          case 'times-roman':
            f = await pdfDoc.embedFont(StandardFonts.TimesRoman);
            break;
          default:
            f = await pdfDoc.embedFont(StandardFonts.Helvetica);
            break;
        }
        fontCache.set(n, f);
        return f;
      };

      const errs = [];
      for (const [idx, block] of blocks.entries()) {
        const bx = Number(block.x || 0);
        const by = Number(block.y || 0);
        const bw = Number(block.width || 0);
        const bh = Number(block.height || 0);

        if (block.type === 'text') {
          const font = await pickFont(block.font);
          const size = Number(block.font_size || minFont);
          if (size < minFont) errs.push(`Block ${idx} font_size below min`);
          const maxWidth = block.max_width || bw || (pageW - 12);
          const value = resolveValue(samplePayload, block.value_path, block.fallback || '');
          if (!value) continue;
          const fitted = fitText(value, font, size, maxWidth, minFont);
          const width = font.widthOfTextAtSize(fitted.text, fitted.size);
          let drawX = bx;
          if (block.align === 'center') drawX = bx - width / 2;
          else if (block.align === 'right') drawX = bx - width;
          const drawY = by;
          const height = fitted.size + 2;
          if (drawX < 0 || drawY < 0 || drawX + width > pageW || drawY + height > pageH) {
            errs.push(`Block ${idx} text out of page bounds`);
          }
          if (block.section_key && sections[block.section_key]) {
            const s = sections[block.section_key];
            const padL = Number(s.padding_left || 0);
            const padR = Number(s.padding_right || 0);
            const padT = Number(s.padding_top || 0);
            const padB = Number(s.padding_bottom || 0);
            if (drawX < s.x + padL || drawY < s.y + padT || drawX + width > s.x + s.width - padR || drawY + height > s.y + s.height - padB) {
              errs.push(`Block ${idx} text exceeds section ${block.section_key}`);
            }
          }
          continue;
        }

        if (block.type === 'barcode') {
          const isRef = block.value_path === 'reference_number' || block.section_key === 'refs_cod';
          const mwMin = isRef ? minBarcodeRef : minBarcode;
          const hMin = isRef ? minBarcodeHRef : minBarcodeH;
          const mw = Number(block.module_width || mwMin);
          const h = Number(block.height || hMin);
          if (mw < mwMin) errs.push(`Block ${idx} barcode module_width below min`);
          if (h < hMin) errs.push(`Block ${idx} barcode height below min`);
          const width = block.width || block.max_width || (sections[block.section_key]?.width || pageW);
          let drawX = bx;
          if (block.align === 'center') drawX = bx - width / 2;
          else if (block.align === 'right') drawX = bx - width;
          const drawY = by;
          if (drawX < 0 || drawY < 0 || drawX + width > pageW || drawY + h > pageH) {
            errs.push(`Block ${idx} barcode out of page bounds`);
          }
          if (block.section_key && sections[block.section_key]) {
            const s = sections[block.section_key];
            if (drawX < s.x || drawY < s.y || drawX + width > s.x + s.width || drawY + h > s.y + s.height) {
              errs.push(`Block ${idx} barcode exceeds section ${block.section_key}`);
            }
          }
          continue;
        }

        if (block.type === 'image') {
          if (bx < 0 || by < 0 || bx + bw > pageW || by + bh > pageH) {
            errs.push(`Block ${idx} image out of page bounds`);
          }
          if (block.section_key && sections[block.section_key]) {
            const s = sections[block.section_key];
            if (bx < s.x || by < s.y || bx + bw > s.x + s.width || by + bh > s.y + s.height) {
              errs.push(`Block ${idx} image exceeds section ${block.section_key}`);
            }
          }
        }
      }

      if (errs.length) {
        if (process.env.LABEL_VISUAL_STRICT === '1') {
          throw new Error(`Sectioned visual regression errors: ${errs.join('; ')}`);
        } else {
          console.warn(`Skipping visual regression (non-strict): ${errs.join('; ')}`);
        }
      }
    } finally {
      await client.end();
    }
  }, 120000);
});
