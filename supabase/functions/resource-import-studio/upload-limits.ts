// Self-contained so Node workers and the Edge bundle execute exactly the same guards.
export function createTabularGuards() {
  const TABULAR_LIMITS = {
    rangeCells: 200_000,
    fileBytes: 10 * 1024 * 1024, expandedBytes: 16 * 1024 * 1024,
    entries: 4096, rows: 10_000, columns: 256, cells: 100_000,
    elements: 500_000, cellLength: 32_767,
  } as const;

  class ImportLimitError extends Error {
    constructor(public readonly status: number, public readonly code: string, message: string) { super(message); }
  }
  function limit(code: string) {
    const size = code === "fileSize" || code === "expandedBytes";
    return new ImportLimitError(size ? 413 : 422, `import_${code}`,
      size ? "The import exceeds the safe size limit. / يتجاوز ملف الاستيراد حد الحجم الآمن."
        : "The import is invalid or exceeds safe worksheet limits. / ملف الاستيراد غير صالح أو يتجاوز حدود ورقة العمل الآمنة.");
  }
  function assertUploadSize(file: { size: number }) {
    if (!Number.isSafeInteger(file.size) || file.size < 0 || file.size > TABULAR_LIMITS.fileBytes) throw limit("fileSize");
  }

  function assertRequestSize(headers: Headers) {
    const length = headers.get("content-length");
    if (length !== null) assertUploadSize({ size: Number(length) });
  }

  function assertMatrixDimensions(rows: number, columns: number) {
    if (!Number.isSafeInteger(rows) || !Number.isSafeInteger(columns) || rows < 0 || columns < 0
      || rows > TABULAR_LIMITS.rows || columns > TABULAR_LIMITS.columns || rows * columns > 2_000_000) throw limit("dimensions");
  }

  function xmlAttribute(tag: string, attribute: string) {
    let value: string | null = null;
    const seen = new Set<string>();
    for (const match of tag.matchAll(/\s([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
      if (seen.has(match[1]!)) throw limit("dimensions");
      seen.add(match[1]!);
      if (match[1] !== attribute) continue;
      value = match[2] ?? match[3] ?? "";
    }
    return value;
  }

  function rangeText(value: string) {
    return value.replace(/&(?:amp|lt|gt|quot|apos);|&#(?:x[0-9a-f]+|[0-9]+);/gi, (entity) => {
      const named: Record<string, string> = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&apos;": "'" };
      if (named[entity]) return named[entity]!;
      const hex = entity.toLowerCase().startsWith("&#x");
      const code = Number.parseInt(entity.slice(hex ? 3 : 2, -1), hex ? 16 : 10);
      if (!Number.isSafeInteger(code) || code < 0 || code > 0x10ffff) throw limit("dimensions");
      return String.fromCodePoint(code);
    }).replace(/'(?:[^']|'')*'!|(?:\[[^\]]*\])?[A-Za-z0-9_.]+!/g, "");
  }

  function cellCoordinate(coordinate: string) {
    const match = /^\$?([A-Z]+)\$?([0-9]+)$/i.exec(coordinate);
    if (!match) throw limit("dimensions");
    let column = 0;
    for (const char of match[1]!.toUpperCase()) {
      column = column * 26 + char.charCodeAt(0) - 64;
      if (column > TABULAR_LIMITS.columns) throw limit("dimensions");
    }
    const row = Number(match[2]);
    if (row < 1 || row > TABULAR_LIMITS.rows) throw limit("dimensions");
    return { row, column };
  }

  function assertRangeText(value: string) {
    const text = rangeText(value).replace(/"(?:[^"]|"")*"/g, "");
    // Whole-axis ranges imply Excel's full axis, beyond this import's bounded grid.
    if (/(?:^|[\s,(])(?:\$?[A-Z]+:\$?[A-Z]+|\$?\d+:\$?\d+)(?=$|[\s,)])/i.test(text)) throw limit("dimensions");
    let cells = 0;
    for (const match of text.matchAll(/(?<![\w.])(\$?[A-Z]+\$?\d+)(?::(\$?[A-Z]+\$?\d+))?(?![\w.!])/gi)) {
      if (text[match.index + match[0].length] === "(") continue;
      const first = cellCoordinate(match[1]!), last = match[2] ? cellCoordinate(match[2]) : first;
      cells += (Math.abs(last.row - first.row) + 1) * (Math.abs(last.column - first.column) + 1);
      if (cells > TABULAR_LIMITS.rangeCells) throw limit("dimensions");
    }
    return cells;
  }

  function assertXmlCoordinates(name: string, tag: string): number {
    if (name === "col") {
      const minValue = xmlAttribute(tag, "min"), maxValue = xmlAttribute(tag, "max");
      if (minValue === null && maxValue === null) return 0; // Drawing anchors also use col elements.
      const min = Number(minValue), max = Number(maxValue);
      if (!Number.isSafeInteger(min) || !Number.isSafeInteger(max) || min < 1 || max < min || max > TABULAR_LIMITS.columns) throw limit("dimensions");
      return 0;
    }
    if (["hyperlink", "dataValidation", "conditionalFormatting", "autoFilter"].includes(name)) {
      const reference = xmlAttribute(tag, name === "dataValidation" || name === "conditionalFormatting" ? "sqref" : "ref");
      return reference !== null ? assertRangeText(reference) : 0;
    }
    if (!["row", "c", "dimension", "mergeCell"].includes(name)) return 0;
    const reference = xmlAttribute(tag, name === "dimension" || name === "mergeCell" ? "ref" : "r");
    if (reference === null) return 0;
    if (name === "row") {
      if (!/^\d+$/.test(reference) || Number(reference) < 1 || Number(reference) > TABULAR_LIMITS.rows) throw limit("dimensions");
      return 0;
    }
    const coordinates = rangeText(reference).split(":");
    if (coordinates.length > (name === "c" ? 1 : 2)) throw limit("dimensions");
    const bounds = coordinates.map(cellCoordinate);
    if (name !== "mergeCell") return 0;
    const first = bounds[0]!, last = bounds[1] ?? first;
    if (last.row < first.row || last.column < first.column) throw limit("dimensions");
    // ExcelJS materializes merged cells before matrix conversion; budget that expansion too.
    return (last.row - first.row + 1) * (last.column - first.column + 1);
  }

  type EntryStream = {
    on(event: "data", callback: (chunk: Uint8Array) => void): unknown;
    on(event: "error" | "end", callback: () => void): unknown;
    pause(): unknown; resume(): unknown;
  };
  type ZipLoader = { loadAsync(bytes: Uint8Array, options: { checkCRC32: false }): Promise<{
    files: Record<string, { dir: boolean }>;
  }> };

  // Incremental lexical counts bound ExcelJS's later object construction, including shared strings.
  function xmlCounter(totals: { rows: number; cells: number; elements: number; rangeCells: number }) {
    let pending = "", cellLength = 0, inCell = false;
    let referenceText: string | null = null;
    const text = (value: string) => {
      if (referenceText !== null) {
        referenceText += value;
        if (referenceText.length > TABULAR_LIMITS.cellLength) throw limit("dimensions");
      }
      if (inCell && (cellLength += value.length) > TABULAR_LIMITS.cellLength) throw limit("cellLength");
    };
    return (chunk: string, done = false) => {
      pending += chunk;
      while (pending) {
        const start = pending.indexOf("<");
        if (start < 0) { text(pending); pending = ""; break; }
        text(pending.slice(0, start)); pending = pending.slice(start);
        const complete = /^<(?:[^<>"']|"[^"]*"|'[^']*')*>/.exec(pending);
        const end = complete ? complete[0].length - 1 : -1;
        if (end < 0) {
          if (pending.length > TABULAR_LIMITS.cellLength || done) throw limit("archive");
          break;
        }
        const tag = pending.slice(0, end + 1);
        pending = pending.slice(end + 1);
        // DTD/entity expansion is not needed by XLSX and must never reach ExcelJS.
        if (tag.startsWith("<!")) throw limit("archive");
        const match = /^<(\/?)(?:[\w.-]+:)?([\w.-]+)(?=[\s/>])/.exec(tag);
        if (!match) continue;
        const [, closing, name] = match;
        if (!closing) {
          totals.rangeCells += assertXmlCoordinates(name!, tag);
          if (totals.rangeCells > TABULAR_LIMITS.rangeCells) throw limit("dimensions");
          if ((name === "definedName" || name === "printArea") && !tag.endsWith("/>")) referenceText = "";
          if (++totals.elements > TABULAR_LIMITS.elements) throw limit("elements");
          if (name === "row" && ++totals.rows > TABULAR_LIMITS.rows + 1) throw limit("rows");
          if (name === "c" && ++totals.cells > TABULAR_LIMITS.cells) throw limit("cells");
          if (name === "c" || name === "si") { inCell = !tag.endsWith("/>"); cellLength = 0; }
        } else {
          if (name === "c" || name === "si") inCell = false;
          if ((name === "definedName" || name === "printArea") && referenceText !== null) {
            totals.rangeCells += assertRangeText(referenceText); referenceText = null;
            if (totals.rangeCells > TABULAR_LIMITS.rangeCells) throw limit("dimensions");
          }
        }
      }
    };
  }

  async function assertXlsxExpansionLimits(buffer: ArrayBuffer, JSZip: ZipLoader): Promise<void> {
    try {
      const zip = await JSZip.loadAsync(new Uint8Array(buffer), { checkCRC32: false });
      const entries = Object.values(zip.files);
      if (!entries.length || entries.length > TABULAR_LIMITS.entries) throw limit("entries");
      let expanded = 0;
      const totals = { rows: 0, cells: 0, elements: 0, rangeCells: 0 };
      for (const entry of entries) {
        if (entry.dir) continue;
        // JSZip 3.10.1 exposes this lazy method at runtime but omits it from its typings.
        const stream = (entry as unknown as { internalStream(type: "uint8array"): EntryStream }).internalStream("uint8array");
        const decoder = new TextDecoder();
        const name = (entry as { name?: string }).name ?? "";
        // Mirror ExcelJS 4.4.0's unanchored XML dispatch before exempting binary media.
        const xmlPath = /xl\/(?:worksheets\/(?:_rels\/)?sheet\d+[.]xml|theme\/[a-zA-Z0-9]+[.]xml|drawings\/(?:_rels\/)?[a-zA-Z0-9]+[.]xml|comments\d+[.]xml|tables\/table\d+[.]xml|drawings\/vmlDrawing\d+[.]vml)/;
        const scan = /^\/?xl\/media\//.test(name) && !xmlPath.test(name) ? null : xmlCounter(totals);
        await new Promise<void>((resolve, reject) => {
          let settled = false;
          const fail = (error: unknown) => {
            if (settled) return;
            settled = true; stream.pause(); reject(error);
          };
          stream.on("data", (chunk) => {
            if (settled) return;
            try {
              expanded += chunk.byteLength;
              if (expanded > TABULAR_LIMITS.expandedBytes) throw limit("expandedBytes");
              // All entries consume bytes; only binary media bypasses XML scanning.
              if (scan) scan(decoder.decode(chunk, { stream: true }));
            } catch (error) { fail(error); }
          });
          stream.on("error", () => fail(limit("archive")));
          stream.on("end", () => {
            if (settled) return;
            try { if (scan) scan(decoder.decode(), true); settled = true; resolve(); } catch (error) { fail(error); }
          });
          stream.resume();
        });
      }
    } catch (error) {
      throw error instanceof ImportLimitError ? error : limit("archive");
    }
  }

  async function parseBoundedCsv(file: File): Promise<string[][]> {
    assertUploadSize(file);
    const reader = file.stream().getReader();
    const decoder = new TextDecoder();
    const matrix: string[][] = [];
    let row: string[] = [];
    let field = "";
    let quoted = false;
    let quotePending = false;
    let skipLf = false;
    let cells = 0;
    const pushField = () => {
      if (field.length > TABULAR_LIMITS.cellLength) throw limit("cellLength");
      if (row.length >= TABULAR_LIMITS.columns) throw limit("columns");
      if (++cells > TABULAR_LIMITS.cells) throw limit("cells");
      row.push(field); field = "";
    };
    const pushRow = () => {
      pushField();
      if (row.some((value) => value.trim())) {
        if (matrix.length > TABULAR_LIMITS.rows) throw limit("rows");
        matrix.push(row);
      }
      row = [];
    };
    try {
      let bytes = 0;
      while (true) {
        const { value, done } = await reader.read();
        bytes += value?.byteLength ?? 0;
        if (bytes > TABULAR_LIMITS.fileBytes) throw limit("fileSize");
        const text = decoder.decode(value, { stream: !done });
        for (const char of text) {
          if (quotePending) {
            quotePending = false;
            if (char === '"') {
              field += char;
              if (field.length > TABULAR_LIMITS.cellLength) throw limit("cellLength");
              continue;
            }
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
          if (field.length > TABULAR_LIMITS.cellLength) throw limit("cellLength");
        }
        if (done) break;
      }
      pushRow();
      return matrix;
    } finally {
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  }

  function matrixToTabularData(matrix: Array<Array<unknown>>) {
    const rows = Array.isArray(matrix) ? matrix : [];
    const headerRow = Array.isArray(rows[0]) ? rows[0] : [];
    assertMatrixDimensions(Math.max(0, rows.length - 1), headerRow.length);
    let bytes = 0, fields = 0;
    const charge = (value: unknown) => {
      // Bound cloning/record overhead before postMessage; shared-string aliases can amplify output.
      bytes += 64 + String(value ?? "").length * 2;
      if (bytes > TABULAR_LIMITS.expandedBytes) throw limit("resource_limit");
    };
    const normalize = (value: unknown) => value == null ? "" : value instanceof Date ? value.toISOString()
      : ["string", "number", "boolean"].includes(typeof value) ? value : String(value);
    const headers = headerRow.map(value => String(value ?? "").trim()).filter(Boolean);
    headers.forEach(charge);
    const records: Array<Record<string, unknown>> = [];
    rows.slice(1).forEach(rawRow => {
      const values = Array.isArray(rawRow) ? rawRow : [];
      const record: Record<string, unknown> = {};
      let hasValue = false;
      headerRow.forEach((headerValue, index) => {
        const header = String(headerValue ?? "").trim();
        if (!header) return;
        if (++fields > TABULAR_LIMITS.cells) throw limit("resource_limit");
        const value = normalize(values[index]);
        charge(header); charge(value);
        record[header] = value;
        if (String(value ?? "").trim() !== "") hasValue = true;
      });
      if (hasValue && Object.keys(record).length) records.push(record);
    });
    return { headers, rows: records };
  }

  return { TABULAR_LIMITS, ImportLimitError, assertUploadSize, assertRequestSize, assertMatrixDimensions, assertXlsxExpansionLimits, parseBoundedCsv, matrixToTabularData };
}

export const { TABULAR_LIMITS, ImportLimitError, assertUploadSize, assertRequestSize, assertMatrixDimensions, assertXlsxExpansionLimits, parseBoundedCsv, matrixToTabularData } = createTabularGuards();
