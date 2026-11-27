const fs = require('fs');
const path = require('path');
const { Client } = require('pg');
const { PDFDocument, StandardFonts } = require('pdf-lib');
const { loadEnv } = require('../../../scripts/utils/load-env');
const { blockBox, overlaps, leftFromAlign } = require('../../../scripts/render/layout-sim');

loadEnv();

const DATABASE_URL =
  process.env.DATABASE_URL || (['postgresql',":","/","/",'postgres',":",'postgres',"@",'localhost',":",'54322',"/",'postgres'].join(""));

const toPts = (inches) => (inches || 0) * 72;

const round = (n, digits = 2) => {
  if (typeof n !== 'number' || !Number.isFinite(n)) return n;
  const p = 10 ** digits;
  return Math.round(n * p) / p;
};

const roundBox = (b) => ({
  ...b,
  x: round(b.x),
  y: round(b.y),
  width: round(b.width),
  height: round(b.height),
  fit_size: b.fit_size != null ? round(b.fit_size, 3) : undefined,
});

const getTemplateLatest = async (client) => {
  const { rows } = await client.query(
    `
    SELECT id, renderer_config, version
    FROM label_template_specs
    WHERE organization_id = '00000000-0000-0000-0000-000000000000'
      AND template_key = 'waybill_v1'
    ORDER BY version DESC
    LIMIT 1
    `
  );
  if (!rows.length) throw new Error('Missing waybill_v1 template in label_template_specs');
  return { templateId: rows[0].id, rendererConfig: rows[0].renderer_config, version: rows[0].version };
};

const loadSections = async (client, templateId) => {
  const { rows } = await client.query(
    `
    SELECT section_key, x, y, width, height
    FROM label_sections
    WHERE organization_id = '00000000-0000-0000-0000-000000000000'
      AND template_id = $1
    `,
    [templateId]
  );
  return new Map(rows.map((r) => [r.section_key, r]));
};

const computeIssues = (boxes, { pageW, pageH, sectionsByKey }) => {
  const strictSections = new Set(['bottom_table', 'refs_cod']);
  const issues = [];

  for (const box of boxes) {
    if (box.x < 0 || box.y < 0 || box.x + box.width > pageW || box.y + box.height > pageH) {
      issues.push({ type: 'out_of_bounds', block: box.blockLabel, box });
    }

    if (box.section_key && sectionsByKey.has(box.section_key)) {
      const s = sectionsByKey.get(box.section_key);
      const sx = Number(s.x);
      const sy = Number(s.y);
      const sw = Number(s.width);
      const sh = Number(s.height);
      const within = (
        box.x >= sx - 0.01 &&
        box.y >= sy - 0.01 &&
        box.x + box.width <= sx + sw + 0.01 &&
        box.y + box.height <= sy + sh + 0.01
      );
      if (!within) {
        issues.push({ type: 'out_of_section', block: box.blockLabel, section_key: box.section_key, box, section: s });
      }
    }

    if (
      box.section_key &&
      strictSections.has(box.section_key) &&
      typeof box.sourceBlock?.width === 'number' &&
      typeof box.sourceBlock?.height === 'number' &&
      box.sourceBlock.width > 0 &&
      box.sourceBlock.height > 0
    ) {
      const sx = leftFromAlign(box.sourceBlock, box.sourceBlock.width);
      const sy = typeof box.sourceBlock.y === 'number' ? box.sourceBlock.y : 0;
      const withinField = (
        box.x >= sx - 0.01 &&
        box.y >= sy - 0.01 &&
        box.x + box.width <= sx + box.sourceBlock.width + 0.01 &&
        box.y + box.height <= sy + box.sourceBlock.height + 0.01
      );
      if (!withinField) {
        issues.push({
          type: 'out_of_field',
          block: box.blockLabel,
          section_key: box.section_key,
          box,
          field: { x: sx, y: sy, width: box.sourceBlock.width, height: box.sourceBlock.height },
        });
      }
    }
  }

  for (let i = 0; i < boxes.length; i += 1) {
    for (let j = i + 1; j < boxes.length; j += 1) {
      if (overlaps(boxes[i], boxes[j])) {
        issues.push({ type: 'overlap', a: boxes[i].blockLabel, b: boxes[j].blockLabel, aBox: boxes[i], bBox: boxes[j] });
      }
    }
  }

  return issues;
};

describe('Waybill layout goldens (MasarX, latest)', () => {
  test('10 golden payloads: no overlaps/out-of-bounds + stable fingerprint', async () => {
    const client = new Client({ connectionString: DATABASE_URL });
    await client.connect();
    try {
      const { templateId, rendererConfig, version: templateVersion } = await getTemplateLatest(client);
      const sectionsByKey = await loadSections(client, templateId);

      const page = rendererConfig?.page || {};
      const pageW = toPts(page.width_inch || 4);
      const pageH = toPts(page.height_inch || 6);

      const pdfDoc = await PDFDocument.create();
      const fonts = {
        normal: await pdfDoc.embedFont(StandardFonts.Helvetica),
        bold: await pdfDoc.embedFont(StandardFonts.HelveticaBold),
        courier: await pdfDoc.embedFont(StandardFonts.Courier),
        times: await pdfDoc.embedFont(StandardFonts.TimesRoman),
      };
      const selectFont = (name) => {
        const n = (name || 'helvetica').toLowerCase();
        if (n.includes('bold')) return fonts.bold;
        if (n.includes('courier') || n === 'barcode') return fonts.courier;
        if (n.includes('times')) return fonts.times;
        return fonts.normal;
      };

      const cases = [
        {
          id: 'baseline_logo',
          payload: {
            shipment_metadata: { header_brand_mode: 'logo', notes: 'TEST NOTE' },
            payment_term_label: 'Prepaid',
            created_at_local: '2025-12-14 12:00:00',
            service_level_label: 'delivery',
            barcode_value: 'DLX100375378432',
            tracking_number: 'DLX100375378432',
            sender_brand_name: 'MasarX',
            sender_phone: '+12025550123',
            origin_line1: 'Riyadh, Riyadh, SA',
            origin_summary: 'Riyadh, Riyadh, SA',
            recipient_name: 'Receiver Name',
            recipient_phone: '+12025550123',
            destination_line1: 'Street Address, District, Riyadh, SA',
            destination_summary: 'Riyadh, Riyadh, SA',
            destination_city_code: 'RIY',
            weight_label: '--',
            reference_number: 'dante-219885579',
            cod_label: '0 SAR',
            bundle_label: '1',
          },
        },
        {
          id: 'header_text_long_brand',
          payload: {
            shipment_metadata: { header_brand_mode: 'text', notes: 'TEST NOTE' },
            payment_term_label: 'COD',
            created_at_local: '2025-12-14 12:00:01',
            service_level_label: 'pickup',
            barcode_value: 'DLX5556E3180741852963074185296307',
            tracking_number: 'DLX5556E3180741852963074185296307',
            sender_brand_name: 'Sender Brand Name VeryLongName VeryLongName VeryLongName 999',
            sender_phone: '+12025550123',
            origin_line1: 'Warehouse Road Warehouse Road Warehouse Road Warehouse Road',
            origin_summary: 'Al Khobar, Eastern, SA',
            recipient_name: 'Recipient VeryLongName VeryLongName VeryLongName 999',
            recipient_phone: '000741852963074',
            destination_line1: '28 King Fahd Rd King Fahd Rd King Fahd Rd King Fahd Rd',
            destination_summary: 'Al Khobar, Eastern, SA',
            destination_city_code: 'AL',
            weight_label: '99.9 kg',
            reference_number: 'REF-VERY-LONG-REFERENCE-NUMBER-1234567890',
            cod_label: '100000 SAR',
            bundle_label: '3',
          },
        },
        {
          id: 'long_item_list_wrap',
          payload: {
            shipment_metadata: {
              header_brand_mode: 'logo',
              notes: 'Fragile Handle with care Handle with care Handle with care Handle with care Handle with care Handle with care',
            },
            payment_term_label: 'Prepaid',
            created_at_local: '2025-12-14 12:00:02',
            service_level_label: 'delivery',
            barcode_value: 'DLXA9D49A2507418529630741852963074185',
            tracking_number: 'DLXA9D49A2507418529630741852963074185',
            sender_brand_name: 'MasarX',
            origin_line1: 'WH-25 Warehouse Road Warehouse Road Warehouse Road Warehouse Road',
            origin_summary: 'Al Khobar, Eastern, SA',
            recipient_name: 'Recipient 25',
            recipient_phone: '+12025550123',
            destination_line1: '25 King Fahd Rd',
            destination_summary: 'Riyadh, Riyadh, SA',
            destination_city_code: 'RIY',
            weight_label: '--',
            reference_number: 'REF-DLXA9D49A2507418529630741852963074185',
            cod_label: '0 SAR',
            bundle_label: '1',
          },
        },
        {
          id: 'missing_optional_fields',
          payload: {
            shipment_metadata: { header_brand_mode: 'logo', notes: '' },
            payment_term_label: 'Prepaid',
            created_at_local: '',
            service_level_label: 'delivery',
            barcode_value: 'DLX100000000',
            tracking_number: 'DLX100000000',
            sender_brand_name: 'MasarX',
            origin_line1: '',
            origin_summary: '',
            recipient_name: '',
            recipient_phone: '',
            destination_line1: '',
            destination_summary: '',
            destination_city_code: '---',
            weight_label: '',
            reference_number: '',
            cod_label: '',
            bundle_label: '',
          },
        },
        {
          id: 'extreme_digits_everywhere',
          payload: {
            shipment_metadata: { header_brand_mode: 'text', notes: '1234567890 1234567890 1234567890 1234567890' },
            payment_term_label: 'COD',
            created_at_local: '2025-12-14 12:00:03',
            service_level_label: 'rto',
            barcode_value: 'DLX' + '7'.repeat(40),
            tracking_number: 'DLX' + '7'.repeat(40),
            sender_brand_name: '1234567890'.repeat(6),
            sender_phone: '0'.repeat(30),
            origin_line1: '1'.repeat(120),
            origin_summary: '2'.repeat(60),
            recipient_name: '3'.repeat(80),
            recipient_phone: '4'.repeat(30),
            destination_line1: '5'.repeat(140),
            destination_summary: '6'.repeat(60),
            destination_city_code: 'TAB',
            weight_label: '99999.9 kg',
            reference_number: 'REF-' + '8'.repeat(40),
            cod_label: '100000 SAR',
            bundle_label: '2',
          },
        },
        {
          id: 'long_destination_line',
          payload: {
            shipment_metadata: { header_brand_mode: 'logo', notes: 'TEST NOTE' },
            payment_term_label: 'Prepaid',
            created_at_local: '2025-12-14 12:00:04',
            service_level_label: 'delivery',
            barcode_value: 'DLX999999999999',
            tracking_number: 'DLX999999999999',
            sender_brand_name: 'MasarX',
            sender_phone: '+12025550123',
            origin_line1: 'WH-1 Warehouse Road',
            origin_summary: 'Riyadh, Riyadh, SA',
            recipient_name: 'Receiver VeryLongName VeryLongName',
            recipient_phone: '+12025550123',
            destination_line1: 'Street ' + 'VeryLongDistrictName '.repeat(10) + 'Riyadh, Saudi Arabia',
            destination_summary: 'Riyadh, Riyadh, SA',
            destination_city_code: 'RIY',
            weight_label: '--',
            reference_number: 'REF-999999999999',
            cod_label: '0 SAR',
            bundle_label: '1',
          },
        },
        {
          id: 'multi_line_notes_newlines',
          payload: {
            shipment_metadata: {
              header_brand_mode: 'logo',
              notes: 'Item A x1\nItem B x2\nItem C x3\nItem D x4\nItem E x5',
            },
            payment_term_label: 'Prepaid',
            created_at_local: '2025-12-14 12:00:05',
            service_level_label: 'delivery',
            barcode_value: 'DLX888888888888',
            tracking_number: 'DLX888888888888',
            sender_brand_name: 'MasarX',
            origin_line1: 'Riyadh, Riyadh, SA',
            origin_summary: 'Riyadh, Riyadh, SA',
            recipient_name: 'Receiver Name',
            recipient_phone: '+12025550123',
            destination_line1: 'Street Address, District, Riyadh, SA',
            destination_summary: 'Riyadh, Riyadh, SA',
            destination_city_code: 'MED',
            weight_label: '--',
            reference_number: 'REF-888888888888',
            cod_label: '0 SAR',
            bundle_label: '1',
          },
        },
        {
          id: 'header_text_short_brand',
          payload: {
            shipment_metadata: { header_brand_mode: 'text', notes: 'TEST NOTE' },
            payment_term_label: 'Prepaid',
            created_at_local: '2025-12-14 12:00:06',
            service_level_label: 'delivery',
            barcode_value: 'DLX777777777777',
            tracking_number: 'DLX777777777777',
            sender_brand_name: 'ACME',
            sender_phone: '+12025550123',
            origin_line1: 'Riyadh, Riyadh, SA',
            origin_summary: 'Riyadh, Riyadh, SA',
            recipient_name: 'Receiver',
            recipient_phone: '+12025550123',
            destination_line1: 'Address',
            destination_summary: 'Riyadh, Riyadh, SA',
            destination_city_code: 'HAI',
            weight_label: '--',
            reference_number: 'REF-777777777777',
            cod_label: '0 SAR',
            bundle_label: '1',
          },
        },
        {
          id: 'cod_large_currency_text',
          payload: {
            shipment_metadata: { header_brand_mode: 'logo', notes: 'TEST NOTE' },
            payment_term_label: 'COD',
            created_at_local: '2025-12-14 12:00:07',
            service_level_label: 'swap',
            barcode_value: 'DLX666666666666',
            tracking_number: 'DLX666666666666',
            sender_brand_name: 'MasarX',
            sender_phone: '+12025550123',
            origin_line1: 'Riyadh, Riyadh, SA',
            origin_summary: 'Riyadh, Riyadh, SA',
            recipient_name: 'Receiver',
            recipient_phone: '+12025550123',
            destination_line1: 'Address',
            destination_summary: 'Riyadh, Riyadh, SA',
            destination_city_code: 'MEC',
            weight_label: '--',
            reference_number: 'REF-666666666666',
            cod_label: '9999999.99 SAR',
            bundle_label: '1',
          },
        },
      ];

      const blocks = Array.isArray(rendererConfig?.blocks) ? rendererConfig.blocks : [];
      const ctx = { pageW, selectFont };

      const fingerprints = {};
      for (const c of cases) {
        const payload = c.payload;
        const boxes = [];
        for (let idx = 0; idx < blocks.length; idx += 1) {
          const block = blocks[idx];
          const box = blockBox(payload, block, ctx);
          if (!box) continue;
          boxes.push({ idx, ...box, sourceBlock: block });
        }

        const issues = computeIssues(boxes, { pageW, pageH, sectionsByKey });
        expect(issues).toEqual([]);

        fingerprints[c.id] = boxes.map((b) => roundBox({
          idx: b.idx,
          blockType: b.blockType,
          blockLabel: b.blockLabel,
          section_key: b.section_key,
          x: b.x,
          y: b.y,
          width: b.width,
          height: b.height,
          fit_size: b.fit_size,
          line_count: b.line_count,
        }));
      }

      const goldensPath = path.join(__dirname, '..', '..', 'fixtures', 'label', 'waybill-layout-goldens.json');
      const update = process.env.UPDATE_LABEL_GOLDENS === '1';
      if (update) {
        fs.mkdirSync(path.dirname(goldensPath), { recursive: true });
        fs.writeFileSync(
          goldensPath,
          JSON.stringify({ template_key: 'waybill_v1', template_version: templateVersion, cases: fingerprints }, null, 2) + '\n',
          'utf8'
        );
      } else {
        const goldens = JSON.parse(fs.readFileSync(goldensPath, 'utf8'));
        expect(goldens.template_key).toBe('waybill_v1');
        expect(goldens.template_version).toBe(templateVersion);
        expect(fingerprints).toEqual(goldens.cases);
      }
    } finally {
      await client.end();
    }
  }, 20000);
});
