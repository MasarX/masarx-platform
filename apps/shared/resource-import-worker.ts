import { Worker } from "node:worker_threads";
import { createRequire } from "node:module";
import { Workbook } from "exceljs";
import JSZip from "jszip";
import { ImportLimitError, TABULAR_LIMITS, createTabularGuards } from "../../supabase/functions/resource-import-studio/upload-limits";

type ParsedWorkbook = { headers: string[]; rows: Array<Record<string, unknown>>; selectedSheet: string; visibleSheets: string[] };

// Fixed code only: untrusted bytes travel as workerData, never as executable source.
const WORKER_SOURCE = String.raw`
const { parentPort, workerData } = require('node:worker_threads');
(async () => {
  try {
    // Host V8 flags can override resourceLimits; fail closed before parsing in that case.
    if (require('node:v8').getHeapStatistics().heap_size_limit > 288 * 1024 * 1024) throw new Error('resource_limit');
    const guards = (TABULAR_GUARDS_FACTORY)();
    if (workerData.format === 'csv') {
      const parse = guards.parseBoundedCsv;
      const bytes = workerData.bytes;
      const matrix = await parse({ size: bytes.byteLength, stream: () => new Blob([bytes]).stream() });
      parentPort.postMessage({ ...guards.matrixToTabularData(matrix), selectedSheet: 'Sheet1', visibleSheets: ['Sheet1'] });
      return;
    }
    await guards.assertXlsxExpansionLimits(workerData.bytes, require(workerData.jszipPath));
    const { Workbook } = require(workerData.exceljsPath);
    const workbook = new Workbook();
    await workbook.xlsx.load(workerData.bytes);
    const visible = workbook.worksheets.filter(sheet => sheet.state === 'visible').map(sheet => sheet.name);
    const visibleSheets = visible.length ? visible : workbook.worksheets.map(sheet => sheet.name);
    const selectedSheet = visibleSheets.includes(workerData.preferredSheet) ? workerData.preferredSheet : visibleSheets[0];
    const sheet = workbook.getWorksheet(selectedSheet);
    if (!sheet) throw new Error('invalid');
    const rows = sheet.rowCount, columns = sheet.columnCount;
    const dimensions = guards.assertMatrixDimensions;
    dimensions(rows, columns);
    const matrix = [];
    for (let index = 1; index <= rows; index++) {
      const row = sheet.getRow(index);
      const count = Math.max(columns, row.actualCellCount, row.cellCount);
      dimensions(rows, count);
      const values = [];
      for (let col = 1; col <= count; col++) {
        const cell = row.getCell(col);
        const raw = cell.text || cell.value;
        const value = raw == null ? '' : raw instanceof Date ? raw.toISOString()
          : ['string', 'number', 'boolean'].includes(typeof raw) ? raw : String(raw);
        if (typeof value === 'string' && value.length > workerData.limits.cellLength) throw new Error('invalid');
        values.push(value);
      }
      while (values.length && String(values[values.length - 1] ?? '') === '') values.pop();
      if (values.length) matrix.push(values);
    }
    parentPort.postMessage({ ...guards.matrixToTabularData(matrix), selectedSheet, visibleSheets });
  } catch (error) {
    parentPort.postMessage({ error: error && typeof error.code === 'string' ? error.code : error && error.message === 'dimensions' ? 'import_dimensions' : 'import_resource_limit', status: error && error.status === 413 ? 413 : 422 });
  } finally { parentPort.close(); }
})();
`;

function workerError(code = "import_resource_limit", status = 422) {
  const allowed = /^import_(?:dimensions|resource_limit|fileSize|expandedBytes|entries|rows|columns|cells|elements|cellLength|archive)$/;
  return new ImportLimitError(status === 413 ? 413 : 422, allowed.test(code) ? code : "import_resource_limit",
    "The workbook exceeds safe processing limits or is invalid. / ملف العمل غير صالح أو يتجاوز حدود المعالجة الآمنة.");
}

export async function parseUploadInWorker(bytes: ArrayBuffer, format: "csv" | "xlsx", preferredSheet?: string | null): Promise<ParsedWorkbook> {
  // The static external import keeps ExcelJS and its dependencies in Next's deployment trace.
  if (typeof Workbook !== "function" || typeof JSZip.loadAsync !== "function") throw workerError();
  let worker: Worker;
  try {
    const resolve = createRequire(`${process.cwd()}/package.json`).resolve;
    const exceljsPath = resolve("exceljs"), jszipPath = resolve("jszip");
    worker = new Worker(WORKER_SOURCE.replace("TABULAR_GUARDS_FACTORY", () => createTabularGuards.toString()), {
      eval: true, execArgv: [], env: { ...process.env, NODE_OPTIONS: "" },
      resourceLimits: { maxOldGenerationSizeMb: 256, maxYoungGenerationSizeMb: 16 },
      workerData: { bytes, format, preferredSheet, exceljsPath, jszipPath, limits: TABULAR_LIMITS }, transferList: [bytes],
    });
  } catch { throw workerError(); }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await new Promise<ParsedWorkbook>((resolve, reject) => {
      timer = setTimeout(() => reject(workerError()), 10_000);
      worker.once("error", () => reject(workerError()));
      worker.once("exit", () => reject(workerError()));
      worker.once("message", (message: ParsedWorkbook & { error?: string; status?: number }) => {
        if (message?.error) reject(workerError(message.error, message.status));
        else if (!Array.isArray(message?.headers) || !Array.isArray(message?.rows) || !Array.isArray(message?.visibleSheets) || typeof message?.selectedSheet !== "string") reject(workerError());
        else resolve(message);
      });
    });
  } finally {
    clearTimeout(timer);
    await worker.terminate();
  }
}
