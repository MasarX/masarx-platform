const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const JSZip = require('jszip');

const moduleExports = { exports: {} };
const source = fs.readFileSync(path.resolve(__dirname, '../../supabase/functions/resource-import-studio/upload-limits.ts'), 'utf8');
vm.runInNewContext(ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText, { exports: moduleExports.exports, module: moduleExports, TextDecoder, Uint8Array, Error });
const { TABULAR_LIMITS: limits, assertXlsxExpansionLimits, parseBoundedCsv } = moduleExports.exports;
const bytes = (buffer) => buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
async function archive(content, name = 'xl/worksheets/sheet1.xml') {
  return new JSZip().file(name, content).generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

test.each([false, true])('bounds actual inflate bytes even when declared size lies: %s', async (lying) => {
  const buffer = await archive('x'.repeat(limits.expandedBytes + 1), 'media.bin');
  if (lying) {
    const central = buffer.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    buffer.writeUInt32LE(1, central + 24);
    buffer.writeUInt32LE(1, 22);
  }
  await expect(assertXlsxExpansionLimits(bytes(buffer), JSZip)).rejects.toMatchObject({ status: 413 });
});

test.each([
  ['cells', '<c/>'.repeat(limits.cells + 1)],
  ['rows', '<row/>'.repeat(limits.rows + 2)],
  ['elements', '<v/>'.repeat(limits.elements + 1)],
  ['cellLength', `<si><t>${'x'.repeat(limits.cellLength + 1)}</t></si>`],
])('bounds XML %s before workbook materialization', async (code, xml) => {
  await expect(assertXlsxExpansionLimits(bytes(await archive(xml)), JSZip)).rejects.toMatchObject({ status: 422, code: `import_${code}` });
});

test('caps all ZIP entries', async () => {
  const zip = new JSZip();
  for (let i = 0; i <= limits.entries; i++) zip.file(`entry${i}`, '');
  await expect(assertXlsxExpansionLimits(bytes(await zip.generateAsync({ type: 'nodebuffer' })), JSZip)).rejects.toMatchObject({ code: 'import_entries' });
});

test('valid chunk-boundary XML and binary entries pass', async () => {
  const zip = new JSZip().file('xl/sharedStrings.xml', `<sst><si><t>${'x'.repeat(limits.cellLength)}</t></si></sst>`).file('media.bin', 'binary data');
  await expect(assertXlsxExpansionLimits(bytes(await zip.generateAsync({ type: 'nodebuffer' })), JSZip)).resolves.toBeUndefined();
});

test('rejects oversize CSV before opening its stream', async () => {
  const file = { size: limits.fileBytes + 1, stream: jest.fn() };
  await expect(parseBoundedCsv(file)).rejects.toMatchObject({ status: 413 });
  expect(file.stream).not.toHaveBeenCalled();
});

test.each([
  ['columns', ','.repeat(limits.columns)],
  ['rows', 'a\n'.repeat(limits.rows + 2)],
  ['cells', ('a,'.repeat(249) + 'a\n').repeat(401)],
  ['cellLength', 'a'.repeat(limits.cellLength + 1)],
])('bounds streamed CSV %s', async (code, csv) => {
  await expect(parseBoundedCsv(new File([csv], 'data.csv'))).rejects.toMatchObject({ status: 422, code: `import_${code}` });
});

test('CSV chunked quotes, CRLF, BOM and multibyte text retain their values', async () => {
  const encoded = new TextEncoder().encode('\ufeffa,b\r\n"one\nline","a""b"\r\n');
  const file = { size: encoded.length, stream: () => new ReadableStream({ start(controller) {
    for (const byte of encoded) controller.enqueue(new Uint8Array([byte]));
    controller.close();
  } }) };
  await expect(parseBoundedCsv(file)).resolves.toEqual([['a', 'b'], ['one\nline', 'a"b']]);
});

test('stream byte accounting rejects a lying CSV size and cancels the stream', async () => {
  const cancel = jest.fn();
  const file = { size: 1, stream: () => new ReadableStream({ pull(controller) {
    controller.enqueue(new Uint8Array(limits.fileBytes + 1));
  }, cancel }) };
  await expect(parseBoundedCsv(file)).rejects.toMatchObject({ status: 413 });
  expect(cancel).toHaveBeenCalled();
});

test('public limit messages include real Arabic and no stack trace', async () => {
  try { await parseBoundedCsv({ size: limits.fileBytes + 1 }); } catch (error) {
    expect(error.message).toMatch(/[\u0600-\u06ff]/);
    expect(error.message).not.toMatch(/\\u060|\bat .*\.ts/);
  }
});

test.each(['a.bin', 'z/xl/worksheets/sheet1.xml', 'xl/worksheets/a/sheet1.xml', 'xl/worksheets/sheet1.xml.extra'])('counts dense cells regardless of parser-visible name %s', async (name) => {
  await expect(assertXlsxExpansionLimits(bytes(await archive('<c/>'.repeat(limits.cells + 1), name)), JSZip)).rejects.toMatchObject({ code: 'import_cells' });
});

test.each([
  ['cells', '<c/>', 99000],
  ['rows', '<row/>', 6000],
  ['elements', '<v/>', 260000],
])('XML %s budget spans the entire archive', async (code, tag, count) => {
  const zip = new JSZip();
  for (let i = 1; i <= 10; i++) zip.file(`xl/worksheets/sheet${i}.xml`, tag.repeat(count));
  await expect(assertXlsxExpansionLimits(bytes(await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })), JSZip))
    .rejects.toMatchObject({ code: `import_${code}` });
});

test('real image workbook survives preflight and ExcelJS load', async () => {
  const { Workbook } = require('exceljs');
  const { crc32 } = require('node:zlib');
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
  const data = Buffer.from('Comment\0<!binary marker and unclosed <');
  const text = Buffer.concat([Buffer.from('tEXt'), data]);
  const chunk = Buffer.alloc(data.length + 12);
  chunk.writeUInt32BE(data.length); text.copy(chunk, 4); chunk.writeUInt32BE(crc32(text), chunk.length - 4);
  const image = Buffer.concat([png.subarray(0, -12), chunk, png.subarray(-12)]);
  const workbook = new Workbook();
  const sheet = workbook.addWorksheet('Data'); sheet.addRow(['id']); sheet.addRow(['1']);
  const id = workbook.addImage({ buffer: image, extension: 'png' });
  sheet.addImage(id, 'B1:C3');
  const buffer = await workbook.xlsx.writeBuffer();
  await expect(assertXlsxExpansionLimits(bytes(buffer), JSZip)).resolves.toBeUndefined();
  const loaded = new Workbook(); await loaded.xlsx.load(buffer);
  expect(loaded.worksheets[0].getImages()).toHaveLength(1);
  expect(Buffer.from(loaded.getImage(id).buffer)).toEqual(image);
});

test.each([
  'xl/media/../worksheets/sheet1.xml',
  'xl/media/z/xl/worksheets/sheet1.xml.extra',
  'xl/media/z/xl/worksheets/_rels/sheet1.xml.rels',
  'xl/media/z/xl/theme/theme1.xml',
  'xl/media/z/xl/drawings/drawing1.xml',
  'xl/media/z/xl/drawings/_rels/drawing1.xml.rels',
  'xl/media/z/xl/comments1.xml',
  'xl/media/z/xl/tables/table1.xml',
  'xl/media/z/xl/drawings/vmlDrawing1.vml',
])('media exemption cannot hide ExcelJS XML dispatch: %s', async (name) => {
  await expect(assertXlsxExpansionLimits(bytes(await archive('<c/>'.repeat(limits.cells + 1), name)), JSZip))
    .rejects.toMatchObject({ code: 'import_cells' });
});

test('binary media still consumes the archive inflate budget', async () => {
  await expect(assertXlsxExpansionLimits(bytes(await archive('x'.repeat(limits.expandedBytes + 1), 'xl/media/image1.png')), JSZip))
    .rejects.toMatchObject({ status: 413 });
});

test.each([
  '<worksheet><sheetData><row r="1"><c r="XFD1048576"/></row></sheetData></worksheet>',
  '<worksheet><sheetData><row r="1048576"/></sheetData></worksheet>',
  '<worksheet><dimension ref="A1:XFD1048576"/><sheetData><row r="1"><c r="A1"/></row></sheetData></worksheet>',
  "<row r='10001'/>", '<c r="IW1"/>', '<c custom=">" r="XFD1048576"/>',
])('rejects far XML coordinates before ExcelJS: %s', async (xml) => {
  await expect(assertXlsxExpansionLimits(bytes(await archive(xml)), JSZip)).rejects.toMatchObject({ status: 422, code: 'import_dimensions' });
});

test('coordinate boundary accepts row10000/column256 with quoted attributes', async () => {
  await expect(assertXlsxExpansionLimits(bytes(await archive('<dimension ref="A1:IV10000"/><row r="10000"><c custom=">" r="IV10000"/></row>')), JSZip)).resolves.toBeUndefined();
});

test.each([[10001, 1], [1, 257], [10000, 201], [Infinity, 1]])('shared matrix builder rejects dimensions %s x %s before getRow', (rowCount, columnCount) => {
  const api = { exports: {} };
  const apiSource = fs.readFileSync(path.resolve(__dirname, '../../packages/api/src/tabular-import.ts'), 'utf8');
  vm.runInNewContext(ts.transpileModule(apiSource, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText, { exports: api.exports, module: api, require: () => moduleExports.exports });
  const getRow = jest.fn();
  expect(() => api.exports.worksheetToMatrix({ rowCount, columnCount, getRow })).toThrow('safe worksheet limits');
  expect(getRow).not.toHaveBeenCalled();
});

test.each(['<mergeCell ref="A1:A10001"/>', '<mergeCell ref="A1:XFD1"/>', '<col min="1" max="16384"/>'])('early coordinate guard covers pre-matrix range allocation: %s', async (xml) => {
  await expect(assertXlsxExpansionLimits(bytes(await archive(`<dimension ref="A1:A1"/>${xml}`)), JSZip)).rejects.toMatchObject({ code: 'import_dimensions' });
});

test('merged rectangle expansion consumes the archive cell budget', async () => {
  const zip = new JSZip().file('xl/worksheets/sheet1.xml', '<mergeCell ref="A1:CB1000"/>')
    .file('xl/worksheets/sheet2.xml', '<mergeCell ref="A1:CB1000"/>').file('xl/worksheets/sheet3.xml', '<mergeCell ref="A1:CB1000"/>');
  await expect(assertXlsxExpansionLimits(bytes(await zip.generateAsync({ type: 'nodebuffer' })), JSZip)).rejects.toMatchObject({ code: 'import_dimensions' });
});

test('ordinary merged cells and column definitions remain supported', async () => {
  const { Workbook } = require('exceljs'); const workbook = new Workbook();
  const sheet = workbook.addWorksheet('Data'); sheet.columns = [{ width: 20 }, { width: 10 }];
  sheet.getCell('A1').value = 'Header'; sheet.mergeCells('A1:B1');
  const buffer = await workbook.xlsx.writeBuffer();
  await expect(assertXlsxExpansionLimits(bytes(buffer), JSZip)).resolves.toBeUndefined();
  const loaded = new Workbook(); await loaded.xlsx.load(buffer);
  expect(loaded.worksheets[0].getCell('B1').master.address).toBe('A1');
});

test.each([
  '<hyperlink ref="IW1"/>', '<dataValidation sqref="A1 B1:XFD1048576"/>',
  '<conditionalFormatting sqref="A1:A10001"/>', '<autoFilter ref="A1:IW2"/>',
  '<definedName name="_xlnm.Print_Area">&apos;Sheet 1&apos;!$A$1:$XFD$1048576</definedName>',
  '<definedName name="Range">Sheet1!$A$1:$IW$2</definedName>',
  '<printArea>Sheet1!A1:A10001</printArea>', '<definedName name="Range">Sheet1!A:XFD</definedName>',
  '<dataValidation sqref="A1 &#88;FD1048576"/>',
])('all ExcelJS-consumed range endpoints are bounded: %s', async (xml) => {
  await expect(assertXlsxExpansionLimits(bytes(await archive(xml)), JSZip)).rejects.toMatchObject({ status: 422, code: 'import_dimensions' });
});

test('bounded defined names, print areas and reference lists stay supported', async () => {
  const xml = '<definedName name="Empty"/><definedName name="Range">&apos;Sheet 1&apos;!$A$1:$IV$100,Sheet2!B2</definedName>'
    + '<printArea>Sheet1!A1:C3</printArea><dataValidation sqref="A1 B2:C3"/><autoFilter ref="A1:C3"/>';
  await expect(assertXlsxExpansionLimits(bytes(await archive(xml)), JSZip)).resolves.toBeUndefined();
});

test.each([
  `<mergeCell ignored=" ref='A1:A1' " ref="A1:A10001"/>`,
  `<c ignored=" r='A1' " r="XFD1048576"/>`,
  '<mergeCell ref="A1:A1" ref="A1:A10001"/>',
])('XML attributes inside quoted values cannot mask the actual range: %s', async (xml) => {
  await expect(assertXlsxExpansionLimits(bytes(await archive(xml)), JSZip)).rejects.toMatchObject({ code: 'import_dimensions' });
});

test.each(['dataValidation', 'definedName'])('repeated in-bounds %s ranges consume the aggregate allocation budget', async (tag) => {
  const xml = tag === 'dataValidation' ? '<dataValidation sqref="A1:CB1000"/>'.repeat(3)
    : '<definedName name="Range">Sheet1!$A$1:$CB$10000</definedName>'.repeat(3);
  await expect(assertXlsxExpansionLimits(bytes(await archive(xml)), JSZip)).rejects.toMatchObject({ code: 'import_dimensions' });
});

test('all duplicate XML attributes are rejected, not just duplicate target names', async () => {
  await expect(assertXlsxExpansionLimits(bytes(await archive('<mergeCell x="one" x="two" ref="A1:A1"/>')), JSZip))
    .rejects.toMatchObject({ code: 'import_dimensions' });
});
