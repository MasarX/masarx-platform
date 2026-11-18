import JSZip from "jszip";

export const TABULAR_LIMITS = {
  fileBytes: 10 * 1024 * 1024,
  expandedBytes: 16 * 1024 * 1024,
  rows: 10_000,
  columns: 256,
  cells: 100_000,
  elements: 500_000,
  cellLength: 32_767,
} as const;

export const TABULAR_LIMIT_ERRORS = ["fileSize", "rows", "columns", "cells", "elements", "cellLength", "archive", "compression"] as const;
export function isTabularLimitError(message: string): message is typeof TABULAR_LIMIT_ERRORS[number] {
  return (TABULAR_LIMIT_ERRORS as readonly string[]).includes(message);
}

export async function parseBoundedCsv(input: File | ArrayBuffer): Promise<string[][]> {
  const isBuffer = input instanceof ArrayBuffer || Object.prototype.toString.call(input) === "[object ArrayBuffer]";
  let buffer: ArrayBuffer;
  if (isBuffer) buffer = input as ArrayBuffer;
  else if (typeof input.arrayBuffer === "function") buffer = await input.arrayBuffer();
  else {
    const reader = input.stream().getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (true) {
      const { value, done } = await reader.read();
      if (value) { total += value.byteLength; if (total > TABULAR_LIMITS.fileBytes) throw new Error("fileSize"); chunks.push(value); }
      if (done) break;
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    buffer = bytes.buffer;
  }
  if (buffer.byteLength > TABULAR_LIMITS.fileBytes) throw new Error("fileSize");
  const decoder = new TextDecoder();
  const matrix: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let quotePending = false;
  let skipLf = false;
  let cells = 0;
  const pushField = () => {
    if (field.length > TABULAR_LIMITS.cellLength) throw new Error("cellLength");
    if (row.length >= TABULAR_LIMITS.columns) throw new Error("columns");
    if (++cells > TABULAR_LIMITS.cells) throw new Error("cells");
    row.push(field); field = "";
  };
  const pushRow = () => {
    pushField();
    if (row.some((value) => value.trim())) {
      if (matrix.length > TABULAR_LIMITS.rows) throw new Error("rows");
      matrix.push(row);
    }
    row = [];
  };
  const consume = (text: string) => {
    for (const char of text) {
      if (quotePending) {
        quotePending = false;
        if (char === '"') { field += char; continue; }
        quoted = false;
      }
      if (quoted) {
        if (char === '"') quotePending = true;
        else field += char;
      } else if (skipLf && char === "\n") {
        skipLf = false;
      } else {
        skipLf = false;
        if (char === '"') quoted = true;
        else if (char === ",") pushField();
        else if (char === "\r" || char === "\n") { pushRow(); skipLf = char === "\r"; }
        else field += char;
      }
      if (field.length > TABULAR_LIMITS.cellLength) throw new Error("cellLength");
    }
  };
  const bytes = new Uint8Array(buffer);
  const chunkSize = 64 * 1024;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    consume(decoder.decode(bytes.subarray(offset, offset + chunkSize), { stream: offset + chunkSize < bytes.length }));
  }
  consume(decoder.decode());
  pushRow();
  return matrix;
}

function assertZipExtraFields(view: DataView, start: number, length: number) {
  const end = start + length;
  while (start < end) {
    if (start + 4 > end) throw new Error("archive");
    const type = view.getUint16(start, true);
    const size = view.getUint16(start + 2, true);
    if (type === 0x7075 || type === 0x6375 || start + 4 + size > end) throw new Error("archive");
    start += 4 + size;
  }
}

export async function assertXlsxExpansionLimits(buffer: ArrayBuffer): Promise<void> {
  if (buffer.byteLength > TABULAR_LIMITS.fileBytes) throw new Error("fileSize");
  if (buffer.byteLength === 0) return;
  const view = new DataView(buffer);
  if (buffer.byteLength < 22) throw new Error("archive");
  if (view.getUint32(0, true) !== 0x04034b50) {
    // JSZip finds the EOCD anywhere and accepts prepended bytes, so only EOCD-free (non-zip) input may skip these checks.
    for (let at = 0; at <= buffer.byteLength - 4; at++) {
      if (view.getUint32(at, true) === 0x06054b50) throw new Error("archive");
    }
    return;
  }
  const eocdMin = Math.max(0, buffer.byteLength - 22 - 65_535);
  const eocdMax = buffer.byteLength - 22;
  let eocd = -1;
  for (let candidate = eocdMax; candidate >= eocdMin; candidate--) {
    if (view.getUint32(candidate, true) === 0x06054b50
      && candidate + 22 + view.getUint16(candidate + 20, true) === buffer.byteLength) {
      eocd = candidate;
      break;
    }
  }
  if (eocd < 0) throw new Error("archive");
  const entries = view.getUint16(eocd + 10, true);
  let offset = view.getUint32(eocd + 16, true);
  const centralEnd = offset + view.getUint32(eocd + 12, true);
  if (!entries || entries > 4096 || centralEnd !== eocd || view.getUint32(eocd + 4, true) !== 0
    || view.getUint16(eocd + 8, true) !== entries) throw new Error("archive");
  const centralHeaders = new Set<number>();
  const names = new Set<string>();
  for (let index = 0; index < entries; index++) {
    if (offset + 46 > centralEnd || view.getUint32(offset, true) !== 0x02014b50) throw new Error("archive");
    centralHeaders.add(offset);
    const flags = view.getUint16(offset + 8, true);
    const method = view.getUint16(offset + 10, true);
    const compressed = view.getUint32(offset + 20, true);
    const declared = view.getUint32(offset + 24, true);
    const nameLength = view.getUint16(offset + 28, true);
    const next = offset + 46 + nameLength + view.getUint16(offset + 30, true) + view.getUint16(offset + 32, true);
    const local = view.getUint32(offset + 42, true);
    if (next > centralEnd || local + 30 > offset || view.getUint32(local, true) !== 0x04034b50
      || (flags & 1) || ![0, 8].includes(method) || declared > TABULAR_LIMITS.expandedBytes) throw new Error("archive");
    const name = new TextDecoder().decode(new Uint8Array(buffer, offset + 46, nameLength));
    if (name.startsWith("/") || name.includes("\\") || name.split("/").includes("..") || names.has(name)) throw new Error("archive");
    names.add(name);
    const localNameLength = view.getUint16(local + 26, true);
    const localExtraLength = view.getUint16(local + 28, true);
    const centralExtraLength = view.getUint16(offset + 30, true);
    const start = local + 30 + localNameLength + localExtraLength;
    if (start + compressed > view.getUint32(eocd + 16, true)) throw new Error("archive");
    if (localNameLength !== nameLength) throw new Error("archive");
    for (let byte = 0; byte < nameLength; byte++) {
      if (view.getUint8(local + 30 + byte) !== view.getUint8(offset + 46 + byte)) throw new Error("archive");
    }
    assertZipExtraFields(view, local + 30 + localNameLength, localExtraLength);
    assertZipExtraFields(view, offset + 46 + nameLength, centralExtraLength);
    offset = next;
  }
  if (offset !== centralEnd) throw new Error("archive");
  const bytes = new Uint8Array(buffer);
  for (let at = 0; at <= bytes.length - 4; at++) {
    if (bytes[at] !== 0x50 || bytes[at + 1] !== 0x4b) continue;
    const signature = view.getUint32(at, true);
    if ((signature === 0x06054b50 && at !== eocd)
      || (signature === 0x02014b50 && !centralHeaders.has(at))) throw new Error("archive");
  }

  // Match ExcelJS's pinned parser, including its entry selection and lazy decompression.
  const zip = await JSZip.loadAsync(new Uint8Array(buffer), { checkCRC32: false }).catch(() => { throw new Error("archive"); });
  let expanded = 0;
  let cellCount = 0;
  let elements = 0;
  for (const entry of Object.values(zip.files)) {
    if (entry.dir) continue;
    const declared = (entry as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize;
    if (!Number.isSafeInteger(declared) || declared! < 0 || declared! > TABULAR_LIMITS.expandedBytes - expanded) throw new Error("archive");
    // JSZip 3.10.1's runtime streaming method is missing from its object typings.
    const stream = (entry as unknown as {
      internalStream(type: "uint8array"): JSZip.JSZipStreamHelper<Uint8Array>;
    }).internalStream("uint8array");
    const decoder = new TextDecoder();
    let actual = 0;
    let carry = "";
    let rows = 0;
    const scan = (text: string, done: boolean) => {
      text = carry + text;
      const boundary = done ? text.length : Math.max(0, text.length - 64);
      for (const tag of text.matchAll(/<(?:[\w.-]+:)?([\w.-]+)(?=[\s/>])/g)) {
        if (tag.index >= boundary) break;
        if (++elements > TABULAR_LIMITS.elements) throw new Error("elements");
        if (tag[1] === "c" && ++cellCount > TABULAR_LIMITS.cells) throw new Error("cells");
        if (tag[1] === "row" && ++rows > TABULAR_LIMITS.rows + 1) throw new Error("rows");
      }
      carry = text.slice(boundary);
    };
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        stream.pause();
        reject(error);
      };
      stream.on("data", (chunk) => {
        if (settled) return;
        try {
          actual += chunk.byteLength;
          if (actual > declared! || expanded + actual > TABULAR_LIMITS.expandedBytes) throw new Error("archive");
          scan(decoder.decode(chunk, { stream: true }), false);
        } catch (error) { fail(error instanceof Error ? error : new Error("archive")); }
      });
      stream.on("error", () => fail(new Error("archive")));
      stream.on("end", () => {
        if (settled) return;
        try {
          if (actual !== declared) throw new Error("archive");
          scan(decoder.decode(), true);
          settled = true;
          resolve();
        } catch (error) { fail(error instanceof Error ? error : new Error("archive")); }
      });
      stream.resume();
    });
    expanded += actual;
  }
}
