const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ts = require('typescript');
const pdf = require('pdf-lib');
const bwip = require('bwip-js');
const qrcode = require('qrcode-generator');
const barcode = require('../../../supabase/functions/label-renderer/barcode');
const { fitBlockToPage } = require('../../../packages/ui/src/label-designer/canvas/block-geometry');
const { validateBarcodeData } = require('../../../packages/ui/src/label-designer/canvas/barcode-types');

const repo = path.resolve(__dirname, '../../..');
const source = fs.readFileSync(path.join(repo, 'supabase/functions/label-renderer/index.ts'), 'utf8');
function section(start, end) {
  const first = source.indexOf(start);
  const last = source.indexOf(end, first);
  if (first < 0 || last <= first) throw new Error(`Renderer section not found: ${start}`);
  return source.slice(first, last);
}

// Execute the shipped renderer and its actual text/geometry helpers without starting Edge, storage or DB clients.
const compiled = ts.transpileModule([
  section('class TemplateError extends Error', 'const SUPABASE_URL'),
  section('const asRecord =', 'const resolveSettingsScope ='),
  section('const normalizeString =', 'const readBooleanSetting ='),
  section('const parseColorInput =', 'const DEFAULT_BRAND_COLOR ='),
  section('const resolvePathValue =', 'const resolveEdgeDbMode ='),
  section('const splitRunsByScript =', 'interface LoadedAsset'),
  section('const renderTemplateBlocksToPage =', 'const renderTemplatePdf ='),
  'module.exports = renderTemplateBlocksToPage;',
].join('\n'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const rendererModule = { exports: {} };
vm.runInNewContext(compiled, {
  module: rendererModule, exports: rendererModule.exports,
  ...pdf, ...barcode, bwip, qrcode, bidiFactory: require('bidi-js'), console,
}, { filename: 'label-renderer-authoring.ts' });
const renderBlocks = rendererModule.exports;

async function render(blocks) {
  const pdfDoc = await pdf.PDFDocument.create();
  const page = pdfDoc.addPage([288, 432]);
  const text = jest.spyOn(page, 'drawText');
  const rectangles = jest.spyOn(page, 'drawRectangle');
  const result = await renderBlocks({}, {}, { renderer_config: { blocks } }, {
    pdfDoc, page, fontCache: new Map(), getAssetEmbed: async () => null, dotPt: 72 / 203,
  });
  return { pdfDoc, page, text, rectangles, result };
}

function barcodeBlock(type, fallback, extra = {}) {
  return { type: 'barcode', x: 276, y: 100, width: 264, height: 100, align: 'right', barcode_type: type, fallback, ...extra };
}

test('pins the real bwip encoder and keeps the shared bounds inside the existing Edge bundle graph', () => {
  expect(JSON.parse(fs.readFileSync(path.join(repo, 'node_modules/bwip-js/package.json'), 'utf8')).version).toBe('4.11.2');
  expect(source).toContain('import("npm:bwip-js@4.11.2")');
  expect(fs.readFileSync(path.join(repo, 'supabase/functions/label-renderer/barcode.ts'), 'utf8'))
    .toContain('from "../_shared/label-barcodes.ts"');
  expect(fs.readFileSync(path.join(repo, 'scripts/edge/sync-shared.js'), 'utf8'))
    .toContain('copyRecursive(sharedSource, target)');
  expect(Object.keys(barcode.BARCODE_MAX_CHARS)).toEqual(['code128', 'qr', 'ean13', 'upca', 'code39', 'pdf417', 'datamatrix']);
});

test.each([
  ['ean13', '590123412345', '5901234123457'],
  ['ean-13', '5901234123457', '5901234123457'],
  ['upca', '01234567890', '012345678905'],
  ['UPC-A', '012345678905', '012345678905'],
])('%s human-readable digits match the real encoded bars for %s', async (type, value, expected) => {
  const encoded = bwip.raw({ bcid: barcode.canonicalBarcodeType(type), text: value, includetext: true })[0];
  expect(encoded.txt.map(([digit]) => digit).join('')).toBe(expected);
  const { text, rectangles, pdfDoc } = await render([barcodeBlock(type, value)]);
  expect(text).toHaveBeenCalledTimes(1);
  const [printed, options] = text.mock.calls[0];
  expect(printed).toBe(expected);
  expect(options.x + options.font.widthOfTextAtSize(printed, options.size)).toBeCloseTo(276);
  expect(rectangles.mock.calls.length).toBeGreaterThan(0);
  expect((await pdf.PDFDocument.load(await pdfDoc.save())).getPageCount()).toBe(1);
});

test('checksum text follows rotation and can be suppressed without suppressing bars', async () => {
  const rotated = await render([barcodeBlock('ean13', '590123412345', { rotation: 90 })]);
  expect(rotated.text.mock.calls[0][0]).toBe('5901234123457');
  expect(rotated.text.mock.calls[0][1].rotate.angle).toBe(90);
  const hidden = await render([barcodeBlock('upca', '01234567890', { human_readable: false })]);
  expect(hidden.text).not.toHaveBeenCalled();
  expect(hidden.rectangles.mock.calls.length).toBeGreaterThan(0);
});

test.each(['pdf417', 'datamatrix', 'qr'])('%s renders an 81-character value beyond the old global limit', async (type) => {
  const value = 'A'.repeat(81);
  expect(validateBarcodeData(type, value)).toBe(true);
  const { result, rectangles } = await render([barcodeBlock(type, value)]);
  expect(result.renderedBlocks).toBe(1);
  expect(rectangles.mock.calls.length).toBeGreaterThan(0);
  rectangles.mock.calls.forEach(([rect]) => {
    expect(rect.width).toBeGreaterThan(0);
    expect(rect.height).toBeGreaterThan(0);
    expect(rect.x).toBeGreaterThanOrEqual(12 - 1e-8);
    expect(rect.x + rect.width).toBeLessThanOrEqual(276 + 1e-8);
    expect(rect.y).toBeGreaterThanOrEqual(100 - 1e-8);
    expect(rect.y + rect.height).toBeLessThanOrEqual(200 + 1e-8);
  });
});

test.each(['code128', 'code39', 'pdf417', 'datamatrix'])('%s accepts the shared maximum and rejects one over before encoding', async (type) => {
  const max = barcode.BARCODE_MAX_CHARS[type];
  const value = 'A'.repeat(max);
  expect(validateBarcodeData(type, value)).toBe(true);
  const { result } = await render([barcodeBlock(type, value)]);
  expect(result.renderedBlocks).toBe(1);
  expect(validateBarcodeData(type, value + 'A')).toBe(false);
  await expect(render([barcodeBlock(type, value + 'A')])).rejects.toMatchObject({
    code: 'render_failure', metadata: { value_length: max + 1, max_length: max },
  });
});

test('QR keeps its existing M encoder capacity errors and rejects inputs beyond the shared 2953 bound', async () => {
  const value = 'A'.repeat(barcode.BARCODE_MAX_CHARS.qr);
  expect(validateBarcodeData('qr', value)).toBe(true);
  let capacityError;
  try { await render([barcodeBlock('qr', value)]); } catch (error) { capacityError = String(error); }
  expect(capacityError).toMatch(/code length overflow/i);
  expect(validateBarcodeData('qr', value + 'A')).toBe(false);
  await expect(render([barcodeBlock('qr', value + 'A')])).rejects.toMatchObject({
    code: 'render_failure', metadata: { value_length: 2954, max_length: 2953 },
  });
});

test.each(['unknown', 'constructor', '__proto__'])('unknown type %s never falls through to another encoder', async (type) => {
  expect(validateBarcodeData(type, '123')).toBe(false);
  await expect(render([barcodeBlock(type, '123')])).rejects.toThrow('Unsupported barcode type');
});

test.each([['ean13', '5901234123450'], ['upca', '012345678900']])('invalid %s check digits fail honestly', async (type, value) => {
  await expect(render([barcodeBlock(type, value)])).rejects.toThrow();
});

test.each([
  { type: 'text', x: 270, y: 100, align: 'right', fallback: 'sender_phone' },
  { type: 'text', x: 276, y: 100, width: 264, height: 20, align: 'right', fallback: 'Address' },
  { type: 'text', x: 144, y: 100, width: 264, height: 20, align: 'center', fallback: 'Title' },
])('font property edits retain the renderer anchor and legacy dimensions: %p', async (original) => {
  const edited = fitBlockToPage({ ...original, font_size: 14 }, { width_inch: 4, height_inch: 6 }, original);
  expect(edited).toEqual({ ...original, font_size: 14 });
  const { text } = await render([edited]);
  const [printed, options] = text.mock.calls[0];
  const width = options.font.widthOfTextAtSize(printed, options.size);
  expect(options.x + width / (original.align === 'right' ? 1 : 2)).toBeCloseTo(original.x);
  expect(options.x).toBeGreaterThanOrEqual(0);
});
