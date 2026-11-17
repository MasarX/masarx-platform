"use client";

import {
  detectWorkbookVisibleSheets,
  matrixToTabularPreview,
  resolveWorkbookWorksheet,
  worksheetToTabularPreview,
} from "../../api/src/tabular-import";

import { TABULAR_LIMITS, parseBoundedCsv, assertXlsxExpansionLimits } from "./resource-import/tabular-file-limits";

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

export type ParsedTabularFile = {
  format: string;
  fileName: string;
  workbookSheets: string[];
  selectedSheet: string;
  headers: string[];
  // Preview records only; the original file remains the source for full import.
  rows: Array<Record<string, unknown>>;
  totalRows: number;
};

export const TABULAR_FILE_ACCEPT = ".csv,.xlsx";
const PREVIEW_ROW_LIMIT = 20;
export const LEGACY_XLS_UNSUPPORTED_MESSAGE = "Legacy .xls workbooks are not supported. Upload a CSV or XLSX file.";

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

function validateTabularFileFormat(fileName: string) {
  const format = resolveTabularFileExtension(fileName);
  if (format === "xls") throw new Error(LEGACY_XLS_UNSUPPORTED_MESSAGE);
  if (format !== "csv" && format !== "xlsx") {
    throw new Error("Unsupported file format. Upload a CSV or XLSX file.");
  }
  return format;
}

async function loadExcelWorkbook(arrayBuffer: ArrayBuffer) {
  const runtime = resolveExcelWorkbookRuntime(await import("exceljs"));
  const workbook = new runtime.Workbook();
  await workbook.xlsx.load(arrayBuffer);
  return workbook;
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
  validateTabularFileFormat(file.name);
  if (file.size > TABULAR_LIMITS.fileBytes) throw new Error("fileSize");
  if (resolveTabularFileExtension(file.name) === "csv") {
    const parsed = matrixToTabularPreview(await parseBoundedCsv(file), PREVIEW_ROW_LIMIT);
    return {
      format: "csv",
      fileName: file.name,
      workbookSheets: [DEFAULT_SHEET_NAME],
      selectedSheet: DEFAULT_SHEET_NAME,
      headers: parsed.headers,
      rows: parsed.rows,
      totalRows: parsed.totalRows,
    };
  }
  return parseTabularFileBuffer(await file.arrayBuffer(), file.name, preferredSheet);
}

export async function parseTabularFileBuffer(
  buffer: ArrayBuffer,
  fileName: string,
  preferredSheet?: string | null,
): Promise<ParsedTabularFile> {
  const format = validateTabularFileFormat(fileName);
  if (format === "csv") {
    const parsed = matrixToTabularPreview(
      await parseBoundedCsv(buffer),
      PREVIEW_ROW_LIMIT,
    );
    return {
      format,
      fileName,
      workbookSheets: [DEFAULT_SHEET_NAME],
      selectedSheet: DEFAULT_SHEET_NAME,
      headers: parsed.headers,
      rows: parsed.rows,
      totalRows: parsed.totalRows,
    };
  }
  await assertXlsxExpansionLimits(buffer);
  const workbook = await loadExcelWorkbook(buffer);
  const worksheetLimit = TABULAR_LIMITS.rows + 1;
  const visibleSheets = detectWorkbookVisibleSheets(workbook as never);
  const selectedSheet =
    (preferredSheet && visibleSheets.includes(preferredSheet) ? preferredSheet : null)
    ?? visibleSheets[0]
    ?? DEFAULT_SHEET_NAME;
  const sheet = resolveWorkbookWorksheet(workbook as never, selectedSheet);
  if (!sheet) {
    throw new Error("The uploaded file did not contain a readable worksheet.");
  }
  const worksheet = sheet as { rowCount?: number; columnCount?: number; eachRow?: (visit: (row: { eachCell?: (visitCell: (cell: { text?: string }) => void) => void }) => void) => void };
  if ((worksheet.rowCount ?? 0) > worksheetLimit) throw new Error("rows");
  if ((worksheet.columnCount ?? 0) > TABULAR_LIMITS.columns) throw new Error("columns");
  worksheet.eachRow?.((row) => row.eachCell?.((cell) => {
    if ((cell.text ?? "").length > TABULAR_LIMITS.cellLength) throw new Error("cellLength");
  }));
  const parsed = worksheetToTabularPreview(sheet as never, PREVIEW_ROW_LIMIT);
  return {
    format,
    fileName,
    workbookSheets: visibleSheets.length > 0 ? visibleSheets : [selectedSheet],
    selectedSheet,
    headers: parsed.headers,
    rows: parsed.rows,
    totalRows: parsed.totalRows,
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
