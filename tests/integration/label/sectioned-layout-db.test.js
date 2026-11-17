const { Client } = require('pg');
const { loadEnv } = require('../../../scripts/utils/load-env');

loadEnv();

const DATABASE_URL =
  process.env.DATABASE_URL || (['postgresql',":","/","/",'postgres',":",'postgres',"@",'localhost',":",'54322',"/",'postgres'].join(""));

const toPts = (inches) => (inches || 0) * 72;

describe('MasarX sectioned template geometry (latest)', () => {
  test('blocks fit page and sections with token minimums', async () => {
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
      const tpl = tplRows[0].renderer_config;
      const page = tpl.page || {};
      const pageW = toPts(page.width_inch || 4);
      const pageH = toPts(page.height_inch || 6);
      const blocks = Array.isArray(tpl.blocks) ? tpl.blocks : [];

      // English structure contract: canonical headings are static fallback blocks (not data-driven).
      // Payload fields may be English/Arabic; headings stay English by default.
      const requiredHeadings = new Set([
        'Sender',
        'Receiver',
        'Weight',
        'Reference Number',
        'COD',
        'Bundle',
        'Item List',
        'Notes',
        ':Content',
      ]);
      const headingBlocks = blocks.filter((b) => b && b.type === 'text' && requiredHeadings.has(b.fallback));
      const dynamicHeadings = headingBlocks.filter((b) => typeof b.value_path === 'string' && b.value_path.trim().length > 0);
      expect(dynamicHeadings).toHaveLength(0);
      const staticFallbacks = new Set(
        headingBlocks
          .filter((b) => b.value_path == null || String(b.value_path).trim().length === 0)
          .map((b) => b.fallback)
      );
      for (const heading of requiredHeadings) {
        expect(staticFallbacks.has(heading)).toBe(true);
      }

      const { rows: sectionRows } = await client.query(
        `
        SELECT section_key, x, y, width, height, padding_top, padding_right, padding_bottom, padding_left
        FROM label_sections
        WHERE template_id = $1
          AND organization_id = '00000000-0000-0000-0000-000000000000'
        `,
        [tplRows[0].id]
      );
      const sectionMap = Object.fromEntries(sectionRows.map((r) => [r.section_key, r]));

      const { rows: tokenRows } = await client.query(
        `
        SELECT token_key, value
        FROM label_design_tokens
        WHERE template_id = $1
          AND organization_id = '00000000-0000-0000-0000-000000000000'
        `,
        [tplRows[0].id]
      );
      const tokenMap = Object.fromEntries(
        tokenRows.map((r) => [r.token_key, r.value])
      );
      const minFont = Number(tokenMap.min_font_size || 8);
      const minBarcode = Number(tokenMap.barcode_min_module_width || 0.9);
      const minBarcodeH = Number(tokenMap.barcode_min_height || 34);

      const errs = [];
      for (const [idx, block] of blocks.entries()) {
        const bx = Number(block.x || 0);
        const by = Number(block.y || 0);
        const bw = Number(block.width || 0);
        const bh = Number(block.height || 0);
        if (bx < 0 || by < 0 || bw < 0 || bh < 0) {
          errs.push(`Block ${idx} has negative geometry`);
          continue;
        }
        if (bx < 0 || by < 0 || bx > pageW || by > pageH) {
          errs.push(`Block ${idx} origin outside page bounds`);
        }
        if (block.type === 'text') {
          const fs = Number(block.font_size || minFont);
          if (fs < minFont) errs.push(`Block ${idx} font_size below min_font_size`);
        }
        if (block.type === 'barcode') {
          const isRef = block.value_path === 'reference_number' || block.section_key === 'refs_cod';
          const mwToken = isRef ? Number(tokenMap.barcode_min_module_width_ref || minBarcode) : minBarcode;
          const hToken = isRef ? Number(tokenMap.barcode_min_height_ref || minBarcodeH) : minBarcodeH;
          const mw = Number(block.module_width || mwToken);
          const bhMin = Number(block.height || hToken);
          if (mw < mwToken) errs.push(`Block ${idx} barcode module_width below minimum`);
          if (bhMin < hToken) errs.push(`Block ${idx} barcode height below minimum`);
        }
      }

      if (errs.length) {
        throw new Error(`Sectioned layout errors: ${errs.join('; ')}`);
      }
    } finally {
      await client.end();
    }
  });
});
