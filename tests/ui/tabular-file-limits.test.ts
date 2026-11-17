import JSZip from "jszip";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Blob as NodeBlob } from "node:buffer";
import { ReadableStream, DecompressionStream } from "node:stream/web";
import { deflateRawSync } from "node:zlib";
import { parseTabularFile } from "../../packages/ui/src/tabular-file";
import { TABULAR_LIMITS, parseBoundedCsv, assertXlsxExpansionLimits } from "../../packages/ui/src/resource-import/tabular-file-limits";

let mockWorkbook: Record<string, unknown>;
jest.mock("exceljs", () => ({ Workbook: jest.fn(() => mockWorkbook) }));
const originalBlob = global.Blob;
const originalStream = global.ReadableStream;
const originalDecompression = global.DecompressionStream;
beforeAll(() => {
  global.ReadableStream = ReadableStream as unknown as typeof global.ReadableStream;
  global.Blob = NodeBlob as unknown as typeof Blob;
  global.DecompressionStream = DecompressionStream as unknown as typeof global.DecompressionStream;
});
afterAll(() => { global.ReadableStream = originalStream; global.Blob = originalBlob; global.DecompressionStream = originalDecompression; });
function csv(text: string, chunkSize = 1024): File {
  const bytes = new TextEncoder().encode(text);
  return { name: "import.csv", size: bytes.length, stream: () => new ReadableStream({ start(controller) {
    for (let offset = 0; offset < bytes.length; offset += chunkSize) controller.enqueue(bytes.slice(offset, offset + chunkSize));
    controller.close();
  } }) } as unknown as File;
}
function archive(text: string, options: { declared?: number; method?: number; name?: string; localName?: string; localExtra?: Buffer; centralExtra?: Buffer } = {}) {
  const source = Buffer.from(text);
  const method = options.method ?? 8;
  const zipped = method === 8 ? deflateRawSync(source) : source;
  const name = Buffer.from(options.name ?? "xl/worksheets/sheet1.xml");
  const localName = Buffer.from(options.localName ?? name.toString());
  const localExtra = options.localExtra ?? Buffer.alloc(0);
  const centralExtra = options.centralExtra ?? Buffer.alloc(0);
  const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50); local.writeUInt16LE(method, 8);
  local.writeUInt32LE(zipped.length, 18); local.writeUInt32LE(source.length, 22); local.writeUInt16LE(localName.length, 26); local.writeUInt16LE(localExtra.length, 28);
  const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50); central.writeUInt16LE(method, 10);
  central.writeUInt32LE(zipped.length, 20); central.writeUInt32LE(options.declared ?? source.length, 24); central.writeUInt16LE(name.length, 28); central.writeUInt16LE(centralExtra.length, 30);
  const eocd = Buffer.alloc(22); eocd.writeUInt32LE(0x06054b50); eocd.writeUInt16LE(1, 8); eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(central.length + name.length + centralExtra.length, 12); eocd.writeUInt32LE(local.length + localName.length + localExtra.length + zipped.length, 16);
  const bytes = Buffer.concat([local, localName, localExtra, zipped, central, name, centralExtra, eocd]);
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}
test("rejects an oversized file before reading or starting workbook load", async () => {
  const stream = jest.fn(); const arrayBuffer = jest.fn();
  await expect(parseTabularFile({ name: "large.xlsx", size: TABULAR_LIMITS.fileBytes + 1, stream, arrayBuffer } as unknown as File))
    .rejects.toThrow("fileSize");
  expect(stream).not.toHaveBeenCalled(); expect(arrayBuffer).not.toHaveBeenCalled();
});
test("streams quoted multiline/escaped CSV fields correctly across byte boundaries", async () => {
  await expect(parseBoundedCsv(csv('name,note\r\n"one","line1\nline2 with ""quotes"""\r\n', 1))).resolves.toEqual([
    ["name", "note"], ["one", 'line1\nline2 with "quotes"'],
  ]);
});
test.each([
  ["rows", 'header\n' + 'value\n'.repeat(TABULAR_LIMITS.rows + 1)],
  ["columns", Array(TABULAR_LIMITS.columns + 1).fill('x').join(',')],
  ["cellLength", 'x'.repeat(TABULAR_LIMITS.cellLength + 1)],
  ["cellLength", '"' + '""'.repeat(TABULAR_LIMITS.cellLength + 1) + '"'],
  ["cells", (Array(200).fill('x').join(',') + '\n').repeat(501)],
])("rejects CSV exceeding %s during the stream", async (reason, text) => {
  await expect(parseBoundedCsv(csv(text))).rejects.toThrow(reason);
});
test.each([0, 8])("accepts a small XLSX entry with compression method %s", async (method) => {
  await expect(assertXlsxExpansionLimits(archive('<worksheet><row><c/></row></worksheet>', { method }))).resolves.toBeUndefined();
});
test("rejects declared XLSX expansion bombs before decompressing", async () => {
  await expect(assertXlsxExpansionLimits(archive('small', { declared: TABULAR_LIMITS.expandedBytes + 1 }))).rejects.toThrow("archive");
});
test("rejects actual expansion even when the ZIP directory lies about its size", async () => {
  await expect(assertXlsxExpansionLimits(archive('x'.repeat(100_000), { declared: 1 }))).rejects.toThrow("archive");
});
test.each([
  ["rows", '<row/>'.repeat(TABULAR_LIMITS.rows + 2)],
  ["cells", '<c/>'.repeat(TABULAR_LIMITS.cells + 1)],
])("rejects XLSX exceeding %s before ExcelJS allocation", async (reason, text) => {
  await expect(assertXlsxExpansionLimits(archive(text))).rejects.toThrow(reason);
});
test("rejects malformed ZIP boundaries", async () => {
  await expect(assertXlsxExpansionLimits(new ArrayBuffer(8))).rejects.toThrow("archive");
});


test("rejects archive path normalization that could bypass worksheet limits", async () => {
  await expect(assertXlsxExpansionLimits(archive('<row/>', { name: 'other/../xl/worksheets/sheet1.xml' })))
    .rejects.toThrow("archive");
});


test.each(["z/xl/worksheets/sheet1.xml", "xl/worksheets/a/sheet1.xml", "xl/worksheets/sheet1.xml.extra"])("pre-scans non-canonical worksheet path %s before ExcelJS can load it", async (name) => {
  await expect(assertXlsxExpansionLimits(archive('<c/>'.repeat(TABULAR_LIMITS.cells + 1), { name })))
    .rejects.toThrow("cells");
});
test("rejects a long XLSX cell before creating any worksheet matrix", async () => {
  const getRow = jest.fn(() => { throw new Error("matrix allocated"); });
  const sheet = { name: "Sheet1", state: "visible", rowCount: 1, columnCount: 1, getRow,
    eachRow: (visit: (row: unknown) => void) => visit({ eachCell: (visitCell: (cell: unknown) => void) =>
      visitCell({ text: 'x'.repeat(TABULAR_LIMITS.cellLength + 1) }) }),
  };
  mockWorkbook = { worksheets: [sheet], getWorksheet: () => sheet, xlsx: { load: jest.fn().mockResolvedValue(undefined) } };
  const buffer = archive('<worksheet/>');
  await expect(parseTabularFile({ name: "long-cell.xlsx", size: buffer.byteLength, arrayBuffer: async () => buffer } as File))
    .rejects.toThrow("cellLength");
  expect(getRow).not.toHaveBeenCalled();
});


test("counts dense cell payloads even in an entry with no XML name", async () => {
  await expect(assertXlsxExpansionLimits(archive('<c/>'.repeat(TABULAR_LIMITS.cells + 1), { name: 'a.bin' })))
    .rejects.toThrow("cells");
});
test.each([0x7075, 0x6375])("rejects Unicode ZIP remapping extra field %s in either header", async (type) => {
  const payload = Buffer.concat([Buffer.from([1, 0, 0, 0, 0]), Buffer.from('xl/worksheets/sheet1.xml')]);
  const extra = Buffer.alloc(4 + payload.length); extra.writeUInt16LE(type); extra.writeUInt16LE(payload.length, 2); payload.copy(extra, 4);
  for (const location of ['localExtra', 'centralExtra'] as const) {
    await expect(assertXlsxExpansionLimits(archive('<c/>', { name: 'a.bin', [location]: extra })))
      .rejects.toThrow("archive");
  }
});
test("rejects local/central filename disagreement", async () => {
  await expect(assertXlsxExpansionLimits(archive('<c/>', { name: 'a.bin', localName: 'b.bin' })))
    .rejects.toThrow("archive");
});


test("bounds non-cell object allocation in any ZIP entry", async () => {
  await expect(assertXlsxExpansionLimits(archive('<si/>'.repeat(TABULAR_LIMITS.elements + 1), { name: 'shared.bin' })))
    .rejects.toThrow("elements");
});


test("rejects the reviewer EOCD differential fixture while JSZip selects its hidden million-cell sheet", async () => {
  const bytes = readFileSync(resolve(__dirname, '../fixtures/tabular-import/eocd-differential.zip'));
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const parsed = await JSZip.loadAsync(new Uint8Array(buffer));
  expect(parsed.file('xl/worksheets/sheet1.xml')).not.toBeNull();
  await expect(assertXlsxExpansionLimits(buffer)).rejects.toThrow("archive");
});
test("accepts normal archives generated by the same JSZip version ExcelJS uses", async () => {
  const zip = new JSZip();
  zip.file('xl/worksheets/sheet1.xml', '<worksheet><row><c/></row></worksheet>');
  const buffer = await zip.generateAsync({ type: 'arraybuffer', compression: 'DEFLATE' });
  await expect(assertXlsxExpansionLimits(buffer)).resolves.toBeUndefined();
});


test("rejects an archive behind a non-ZIP prefix that JSZip would still open", async () => {
  const zip = new JSZip();
  zip.file('xl/worksheets/sheet1.xml', '<worksheet><row><c/></row></worksheet>');
  const bytes = new Uint8Array(await zip.generateAsync({ type: 'arraybuffer', compression: 'DEFLATE' }));
  for (const prefix of [[0], [0x50, 0x4b, 0x03]]) {
    const prefixed = new Uint8Array(prefix.length + bytes.length);
    prefixed.set(prefix);
    prefixed.set(bytes, prefix.length);
    await expect(JSZip.loadAsync(prefixed)).resolves.toBeDefined();
    await expect(assertXlsxExpansionLimits(prefixed.buffer)).rejects.toThrow("archive");
  }
  const bomb = new Uint8Array(archive('<c/>'.repeat(TABULAR_LIMITS.cells + 1)));
  const prefixedBomb = new Uint8Array(bomb.length + 1);
  prefixedBomb.set(bomb, 1);
  await expect(assertXlsxExpansionLimits(prefixedBomb.buffer)).rejects.toThrow("archive");
});

test("non-ZIP input without an EOCD signature still reaches the workbook parser", async () => {
  const text = new TextEncoder().encode("External ID,Status\next-1,active\n");
  await expect(assertXlsxExpansionLimits(text.buffer.slice(0) as ArrayBuffer)).resolves.toBeUndefined();
});

test.each([0x06054b50, 0x02014b50])("rejects a second ZIP structural signature %s outside its declared header", async (signature) => {
  const text = String.fromCharCode(signature & 255, (signature >>> 8) & 255, (signature >>> 16) & 255, signature >>> 24);
  await expect(assertXlsxExpansionLimits(archive(text, { method: 0 }))).rejects.toThrow("archive");
});
