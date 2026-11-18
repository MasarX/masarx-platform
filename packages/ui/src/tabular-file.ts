"use client";

import {
  detectWorkbookVisibleSheets,
  matrixToTabularData,
  parseCsvTextMatrix,
  resolveWorkbookWorksheet,
  worksheetToMatrix,
} from "@masarx/api";

const XLSX_MIME_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const DEFAULT_SHEET_NAME = "Sheet1";

type ExcelWorkbookBuffer = ArrayBuffer | Uint8Array;

type ExcelWorkbookRuntime = {
  Workbook: new () => {
    worksheets?: Array<unknown>;
    getWorksheet?: (name: string) => unknown;
    addWorksheet: (name: string) => { addRow: (values: readonly unknown[]) => void };
    xlsx: {
      load: (buffer: ArrayBuffer) => Promise<unknown>;
      writeBuffer: () => Promise<ExcelWorkbookBuffer>;
    };
  };
};

type SheetJsWorksheet = unknown;

type SheetJsWorkbook = {
  SheetNames?: string[];
  Sheets?: Record<string, SheetJsWorksheet>;
  Workbook?: {
    Sheets?: Array<{
      name?: string;
      Hidden?: number;
    }>;
  };
};

type SheetJsRuntime = {
  read: (
    buffer: ArrayBuffer,
    options: { type: "array"; raw: false; cellDates: true },
  ) => SheetJsWorkbook;
  utils: {
    sheet_to_json: <T>(
      sheet: SheetJsWorksheet,
      options: { header?: 1; defval: string; blankrows?: false; raw?: false },
    ) => T[];
  };
};

export type ParsedTabularFile = {
  format: string;
  fileName: string;
  workbookSheets: string[];
  selectedSheet: string;
  headers: string[];
  rows: Array<Record<string, unknown>>;
};

export const TABULAR_FILE_ACCEPT = ".csv,.xls,.xlsx";

function resolveExcelWorkbookRuntime(moduleValue: unknown): ExcelWorkbookRuntime {
  const candidate = (moduleValue as { Workbook?: unknown })?.Workbook
    ? moduleValue
    : (moduleValue as { default?: unknown })?.default
      ?? (moduleValue as { "module.exports"?: unknown })?.["module.exports"]
      ?? {};
  if (typeof (candidate as { Workbook?: unknown }).Workbook !== "function") {
    throw new Error("Excel workbook runtime is unavailable.");
  }
  return candidate as ExcelWorkbookRuntime;
}

function resolveTabularFileExtension(fileName: string) {
  return fileName.split(".").pop()?.trim().toLowerCase() || "csv";
}

async function loadExcelWorkbook(arrayBuffer: ArrayBuffer) {
  const runtime = resolveExcelWorkbookRuntime(await import("exceljs"));
  const workbook = new runtime.Workbook();
  await workbook.xlsx.load(arrayBuffer);
  return workbook;
}

function resolveSheetJsRuntime(moduleValue: unknown): SheetJsRuntime {
  const candidate = (moduleValue as { read?: unknown })?.read
    ? moduleValue
    : (moduleValue as { default?: unknown })?.default
      ?? (moduleValue as { "module.exports"?: unknown })?.["module.exports"]
      ?? {};
  if (
    typeof (candidate as { read?: unknown }).read !== "function"
    || typeof (candidate as { utils?: { sheet_to_json?: unknown } }).utils?.sheet_to_json !== "function"
  ) {
    throw new Error("Workbook runtime is unavailable.");
  }
  return candidate as SheetJsRuntime;
}

function detectSheetJsVisibleSheets(workbook: SheetJsWorkbook): string[] {
  const sheetNames = workbook.SheetNames ?? [];
  const sheetMetadata = workbook.Workbook?.Sheets ?? [];
  if (sheetMetadata.length === 0) return sheetNames;
  return sheetMetadata
    .filter((sheet) => Number(sheet.Hidden ?? 0) === 0)
    .map((sheet) => String(sheet.name ?? "").trim())
    .filter((name) => name.length > 0 && sheetNames.includes(name));
}

async function parseSheetJsWorkbook(
  file: File,
  format: string,
  preferredSheet?: string | null,
): Promise<ParsedTabularFile> {
  const runtime = resolveSheetJsRuntime(await import("xlsx"));
  const workbook = runtime.read(await file.arrayBuffer(), {
    type: "array",
    raw: false,
    cellDates: true,
  });
  const visibleSheets = detectSheetJsVisibleSheets(workbook);
  const selectedSheet =
    (preferredSheet && visibleSheets.includes(preferredSheet) ? preferredSheet : null)
    ?? visibleSheets[0]
    ?? workbook.SheetNames?.[0]
    ?? DEFAULT_SHEET_NAME;
  const sheet = workbook.Sheets?.[selectedSheet];
  if (!sheet) {
    throw new Error("The uploaded file did not contain a readable worksheet.");
  }
  const matrix = runtime.utils.sheet_to_json<Array<unknown>>(sheet, {
    header: 1,
    defval: "",
    blankrows: false,
  });
  const parsed = matrixToTabularData(matrix);
  return {
    format,
    fileName: file.name,
    workbookSheets: visibleSheets.length > 0 ? visibleSheets : [selectedSheet],
    selectedSheet,
    headers: parsed.headers,
    rows: parsed.rows,
  };
}

function toBlobArrayBuffer(buffer: ExcelWorkbookBuffer): ArrayBuffer {
  if (buffer instanceof ArrayBuffer) {
    return buffer;
  }
  const copy = new Uint8Array(buffer.byteLength);
  copy.set(buffer);
  return copy.buffer;
}

export async function parseTabularFile(
  file: File,
  preferredSheet?: string | null,
): Promise<ParsedTabularFile> {
  const format = resolveTabularFileExtension(file.name);
  if (format === "csv") {
    const parsed = matrixToTabularData(parseCsvTextMatrix(await file.text()));
    return {
      format,
      fileName: file.name,
      workbookSheets: [DEFAULT_SHEET_NAME],
      selectedSheet: DEFAULT_SHEET_NAME,
      headers: parsed.headers,
      rows: parsed.rows,
    };
  }
  if (format === "xls") {
    return parseSheetJsWorkbook(file, format, preferredSheet);
  }
  if (format !== "xlsx") {
    throw new Error("Unsupported file format. Upload a CSV, XLS, or XLSX file.");
  }

  const workbook = await loadExcelWorkbook(await file.arrayBuffer());
  const visibleSheets = detectWorkbookVisibleSheets(workbook as never);
  const selectedSheet =
    (preferredSheet && visibleSheets.includes(preferredSheet) ? preferredSheet : null)
    ?? visibleSheets[0]
    ?? DEFAULT_SHEET_NAME;
  const sheet = resolveWorkbookWorksheet(workbook as never, selectedSheet);
  if (!sheet) {
    throw new Error("The uploaded file did not contain a readable worksheet.");
  }
  const parsed = matrixToTabularData(worksheetToMatrix(sheet as never));
  return {
    format,
    fileName: file.name,
    workbookSheets: visibleSheets.length > 0 ? visibleSheets : [selectedSheet],
    selectedSheet,
    headers: parsed.headers,
    rows: parsed.rows,
  };
}

export async function buildExcelExportBlob({
  header,
  rows,
  sheetName,
}: {
  header: string[];
  rows: Array<Array<unknown>>;
  sheetName: string;
}) {
  const runtime = resolveExcelWorkbookRuntime(await import("exceljs"));
  const workbook = new runtime.Workbook();
  const worksheet = workbook.addWorksheet(sheetName || DEFAULT_SHEET_NAME);
  worksheet.addRow(header);
  rows.forEach((row) => worksheet.addRow(row));
  const buffer = await workbook.xlsx.writeBuffer();
  return new Blob([toBlobArrayBuffer(buffer)], { type: XLSX_MIME_TYPE });
}
