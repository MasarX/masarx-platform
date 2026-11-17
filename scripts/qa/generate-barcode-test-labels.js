#!/usr/bin/env node
/* eslint-disable no-console */
const fs = require('fs');
const path = require('path');
const { PDFDocument } = require('pdf-lib');

const { renderComposedLabelPdf } = require('./label-render-sim');

const ROOT = process.cwd();

const parseArgs = (argv) => {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) out[key] = true;
    else {
      out[key] = next;
      i += 1;
    }
  }
  return out;
};

const digits = (count, seed = '1234567890') => {
  const s = String(seed);
  let out = '';
  for (let i = 0; i < count; i += 1) out += s[i % s.length];
  return out;
};

const alphaNum = (count, seed = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789') => {
  const s = String(seed);
  let out = '';
  for (let i = 0; i < count; i += 1) out += s[i % s.length];
  return out;
};

const buildCases = () => ([
  {
    id: '01',
    label: 'baseline (short ref)',
    tracking: `DLX${digits(12, '100375378432')}`,
    reference: 'dante-219885579',
  },
  {
    id: '02',
    label: 'ref digits (20) expect ok/at_risk',
    tracking: `DLX${digits(12, '100375378432')}`,
    reference: digits(20),
  },
  {
    id: '03',
    label: 'ref digits (30) expect at_risk',
    tracking: `DLX${digits(12, '100375378432')}`,
    reference: digits(30),
  },
  {
    id: '04',
    label: 'ref digits (50) expect at_risk/unscannable',
    tracking: `DLX${digits(12, '100375378432')}`,
    reference: digits(50),
  },
  {
    id: '05',
    label: 'ref alnum (10) expect ok',
    tracking: `DLX${digits(12, '100375378432')}`,
    reference: alphaNum(10, 'ABCD1234EF'),
  },
  {
    id: '06',
    label: 'ref alnum (20) expect at_risk',
    tracking: `DLX${digits(12, '100375378432')}`,
    reference: alphaNum(20, 'ABCD1234EFGH5678IJKL'),
  },
  {
    id: '07',
    label: 'ref alnum (30) expect at_risk/unscannable',
    tracking: `DLX${digits(12, '100375378432')}`,
    reference: alphaNum(30),
  },
  {
    id: '08',
    label: 'ref mixed with separators',
    tracking: `DLX${digits(12, '100375378432')}`,
    reference: `WH-LOC-A1-B2-20251226-${digits(16, '0001234500012345')}`,
  },
  {
    id: '09',
    label: 'ref extreme alnum (60) likely unscannable',
    tracking: `DLX${digits(12, '100375378432')}`,
    reference: alphaNum(60),
  },
]);

const main = async () => {
  const args = parseArgs(process.argv.slice(2));

  const inputPath = path.resolve(ROOT, String(args.in || 'tmp-payload.json'));
  const outDir = path.resolve(ROOT, String(args['out-dir'] || 'tmp/barcode-test-labels'));

  const dpiArg = Number(args.dpi);
  const dpi = Number.isFinite(dpiArg) && dpiArg > 0 ? dpiArg : undefined;

  const quietZoneModules = Number.isFinite(Number(args['quiet-zone'])) ? Math.floor(Number(args['quiet-zone'])) : 10;
  const minQuietZoneModules = Number.isFinite(Number(args['min-quiet-zone'])) ? Math.floor(Number(args['min-quiet-zone'])) : 4;
  const targetDots = Number.isFinite(Number(args['target-dots'])) ? Math.floor(Number(args['target-dots'])) : 2;
  const hardMinDots = Number.isFinite(Number(args['hard-min-dots'])) ? Math.floor(Number(args['hard-min-dots'])) : 1;

  if (!fs.existsSync(inputPath)) {
    console.error(`[barcode-test] input not found: ${inputPath}`);
    process.exit(1);
  }
  const base = JSON.parse(fs.readFileSync(inputPath, 'utf8'));

  const cases = buildCases();
  const index = {
    generated_at: new Date().toISOString(),
    input: path.relative(ROOT, inputPath).replace(/\\/g, '/'),
    out_dir: path.relative(ROOT, outDir).replace(/\\/g, '/'),
    render: { dpi: dpi || null },
    policy: { quiet_zone_modules: quietZoneModules, min_quiet_zone_modules: minQuietZoneModules, target_module_width_dots: targetDots, hard_min_module_width_dots: hardMinDots },
    cases: [],
  };

  const packDoc = await PDFDocument.create();

  for (const c of cases) {
    const composed = {
      ...base,
      payload: {
        ...(base.payload || {}),
        tracking_number: c.tracking,
        barcode_value: c.tracking,
        reference_number: c.reference,
      },
    };

    const fileName = `${c.id}_${c.label.replace(/[^a-z0-9]+/gi, '_').toLowerCase()}.pdf`;
    const outFile = path.join(outDir, fileName);

    const rendered = await renderComposedLabelPdf(composed, outFile, {
      ...(dpi ? { dpi } : {}),
      quietZoneModules,
      minQuietZoneModules,
      targetDots,
      hardMinDots,
    });

    const doc = await PDFDocument.load(rendered.bytes);
    const [page] = await packDoc.copyPages(doc, [0]);
    packDoc.addPage(page);

    index.cases.push({
      id: c.id,
      label: c.label,
      file: path.relative(ROOT, outFile).replace(/\\/g, '/'),
      tracking: c.tracking,
      reference: c.reference,
      dpi: rendered.dpi,
      barcodes: rendered.barcodeMeta,
    });
    console.log(`[barcode-test] wrote ${path.relative(ROOT, outFile)}`);
  }

  const packBytes = await packDoc.save();
  const packPath = path.join(outDir, 'barcode-test-pack.pdf');
  fs.writeFileSync(packPath, Buffer.from(packBytes));
  console.log(`[barcode-test] wrote ${path.relative(ROOT, packPath)}`);

  const indexPath = path.join(outDir, 'index.json');
  fs.writeFileSync(indexPath, `${JSON.stringify(index, null, 2)}\n`);
  console.log(`[barcode-test] wrote ${path.relative(ROOT, indexPath)}`);
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
