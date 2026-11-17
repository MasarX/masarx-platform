#!/usr/bin/env node
/**
 * Barcode rendering micro-benchmark (Code128).
 *
 * Compares vector (pdf-lib rectangles) vs PNG (bwip-js -> embedPng) rendering cost.
 *
 * Example:
 *   node scripts/benchmarks/label-barcode-render-bench.js --iterations 200 --engine both
 *   node scripts/benchmarks/label-barcode-render-bench.js --dpi 300 --value "DLX100375378432" --iterations 200
 */
/* eslint-disable no-console */

const bwipjs = require('bwip-js');
const { PDFDocument, rgb } = require('pdf-lib');
const { drawCode128 } = require('../render/draw-code128');

function parseArgs(argv) {
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
}

function msSince(t0) {
  const diff = process.hrtime.bigint() - t0;
  return Number(diff) / 1e6;
}

function percentile(sortedNums, p) {
  if (!sortedNums.length) return null;
  const idx = Math.min(sortedNums.length - 1, Math.floor(sortedNums.length * p));
  return sortedNums[idx];
}

async function renderVectorOnce(value, cfg) {
  const pdfDoc = await PDFDocument.create();
  const page = pdfDoc.addPage([cfg.pageWidthPt, cfg.pageHeightPt]);
  drawCode128(page, value, {
    x: cfg.x,
    y: cfg.y,
    width: cfg.widthPt,
    height: cfg.heightPt,
    align: cfg.align,
    dpi: cfg.dpi,
    snap_to_dots: true,
    color: rgb(0, 0, 0),
  });
  return pdfDoc.save();
}

async function renderPngOnce(value, cfg) {
  const pdfDoc = await PDFDocument.create();
  const page = pdfDoc.addPage([cfg.pageWidthPt, cfg.pageHeightPt]);
  const png = await bwipjs.toBuffer({
    bcid: 'code128',
    text: value,
    scale: cfg.bwipScale,
    height: cfg.bwipHeightMm,
    includetext: false,
    paddingwidth: cfg.bwipPaddingWidth,
    paddingheight: cfg.bwipPaddingHeight,
    backgroundcolor: 'FFFFFF',
    barcolor: '000000',
  });
  const img = await pdfDoc.embedPng(png);
  page.drawImage(img, { x: cfg.xPng, y: cfg.yPng, width: cfg.widthPt, height: cfg.heightPt });
  return pdfDoc.save();
}

async function bench({ label, fn, values, iterations, uniqueSuffix }) {
  const times = [];
  const sizes = [];

  // Warmup
  await fn(values[0]);

  for (let i = 0; i < iterations; i += 1) {
    const base = values[i % values.length];
    const value = uniqueSuffix ? `${base}${String(i).padStart(6, '0')}` : base;
    const t0 = process.hrtime.bigint();
    // eslint-disable-next-line no-await-in-loop
    const bytes = await fn(value);
    times.push(msSince(t0));
    sizes.push(bytes.length);
  }

  times.sort((a, b) => a - b);
  sizes.sort((a, b) => a - b);

  const sum = times.reduce((a, b) => a + b, 0);
  const avg = sum / times.length;
  const p50 = percentile(times, 0.5);
  const p95 = percentile(times, 0.95);
  const avgSize = sizes.reduce((a, b) => a + b, 0) / sizes.length;

  return {
    label,
    iterations,
    values: values.map((v) => String(v).length),
    avg_ms: avg,
    p50_ms: p50,
    p95_ms: p95,
    avg_pdf_bytes: avgSize,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const engine = String(args.engine || 'both').toLowerCase();
  const iterationsRaw = Number(args.iterations);
  const iterations = Number.isFinite(iterationsRaw) && iterationsRaw > 0 ? Math.floor(iterationsRaw) : 120;

  const dpiRaw = Number(args.dpi);
  const dpi = Number.isFinite(dpiRaw) && dpiRaw > 0 ? dpiRaw : 203;

  const valuesArg = typeof args.values === 'string' ? args.values : null;
  const valueArg = typeof args.value === 'string' ? args.value : null;
  const values = valueArg
    ? [valueArg]
    : valuesArg
      ? valuesArg.split(',').map((s) => s.trim()).filter(Boolean)
      : [
        'DLX100375378432',
        'WH-LOC-A1-B2-20251226-0001234500012345',
      ];

  const uniqueSuffix = args.unique === true || String(args.unique || '') === '1';

  const cfg = {
    dpi,
    // 4x6 label canvas (points)
    pageWidthPt: 288,
    pageHeightPt: 432,
    // Barcode box (roughly matches top barcode placement)
    x: 144,
    y: 300,
    widthPt: 232,
    heightPt: 80,
    align: 'center',
    // bwip-js params (approx prior settings)
    bwipScale: 3,
    bwipHeightMm: 15,
    bwipPaddingWidth: 12,
    bwipPaddingHeight: 4,
    // Image draw origin (top barcode box)
    xPng: 28,
    yPng: 300,
  };

  const reports = [];

  if (engine === 'vector' || engine === 'both') {
    // eslint-disable-next-line no-await-in-loop
    reports.push(await bench({
      label: `vector(dpi=${dpi})`,
      fn: (v) => renderVectorOnce(v, cfg),
      values,
      iterations,
      uniqueSuffix,
    }));
  }

  if (engine === 'png' || engine === 'both') {
    // eslint-disable-next-line no-await-in-loop
    reports.push(await bench({
      label: `png(bwip, dpi=${dpi})`,
      fn: (v) => renderPngOnce(v, cfg),
      values,
      iterations,
      uniqueSuffix,
    }));
  }

  for (const r of reports) {
    console.log(
      [
        `[barcode-bench] ${r.label}`,
        `iterations=${r.iterations}`,
        `valueLens=[${r.values.join(',')}]`,
        `avg_ms=${r.avg_ms.toFixed(2)}`,
        `p50_ms=${r.p50_ms.toFixed(2)}`,
        `p95_ms=${r.p95_ms.toFixed(2)}`,
        `avg_pdf_bytes=${Math.round(r.avg_pdf_bytes)}`,
      ].join(' ')
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

