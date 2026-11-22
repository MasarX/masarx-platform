import { buildExcelExportBlob, parseTabularFile, parseTabularFileBuffer } from "../../packages/ui/src/tabular-file";

const mockAddRow = jest.fn();
const mockAddWorksheet = jest.fn(() => ({ addRow: mockAddRow }));
const mockWriteBuffer = jest.fn();
const mockLoad = jest.fn();
const mockWorksheets: Array<unknown> = [];

jest.mock("exceljs", () => ({
  Workbook: jest.fn(() => ({
    addWorksheet: mockAddWorksheet,
    worksheets: mockWorksheets,
    xlsx: {
      load: mockLoad,
      writeBuffer: mockWriteBuffer,
    },
  })),
}));

describe("tabular file export", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test("normalizes ExcelJS Uint8Array output before creating the export Blob", async () => {
    mockWriteBuffer.mockResolvedValue(new Uint8Array([1, 2, 3, 4]));

    const blob = await buildExcelExportBlob({
      header: ["Tracking Number", "Status"],
      rows: [["trk-1", "ready"]],
      sheetName: "Shipments",
    });

    expect(mockAddWorksheet).toHaveBeenCalledWith("Shipments");
    expect(mockAddRow).toHaveBeenCalledWith(["Tracking Number", "Status"]);
    expect(mockAddRow).toHaveBeenCalledWith(["trk-1", "ready"]);
    expect(blob.type).toBe("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    expect(blob.size).toBe(4);
  });
});

describe("tabular file previews", () => {
  beforeEach(() => {
    mockWorksheets.length = 0;
    mockLoad.mockResolvedValue(undefined);
  });

  test.each(["csv", "xlsx"])("returns only 20 %s preview records with the exact 49-row total", async (format) => {
    const rows = [["External ID", "Status"], ...Array.from({ length: 49 }, (_, index) => [`ext-${index + 1}`, "active"])];
    mockWorksheets.push({
      name: "Hidden", state: "hidden",
    }, {
      name: "Visible", state: "visible", rowCount: rows.length, columnCount: 2,
      getRow: (index: number) => ({ getCell: (column: number) => ({ value: rows[index - 1]?.[column - 1] }) }),
    }, {
      name: "Selected", state: "visible", rowCount: rows.length, columnCount: 2,
      getRow: (index: number) => ({ getCell: (column: number) => ({ value: rows[index - 1]?.[column - 1] }) }),
    });
    const buffer = new TextEncoder().encode(rows.map((row) => row.join(",")).join("\n")).buffer as ArrayBuffer;
    const parsed = await parseTabularFileBuffer(buffer, `orders.${format}`, "Selected");
    expect(parsed.totalRows).toBe(49);
    expect(parsed.rows).toHaveLength(20);
    expect(parsed.rows[19]).toEqual({ "External ID": "ext-20", Status: "active" });
    expect(parsed.selectedSheet).toBe(format === "xlsx" ? "Selected" : "Sheet1");
    expect(parsed.workbookSheets).toEqual(format === "xlsx" ? ["Visible", "Selected"] : ["Sheet1"]);
    const text = jest.fn(() => { throw new Error("Preview must not buffer input as text"); });
    const file = {
      name: `orders.${format}`,
      size: buffer.byteLength,
      arrayBuffer: async () => buffer,
      text,
    } as unknown as File;
    await expect(parseTabularFile(file, "Selected")).resolves.toEqual(parsed);
    expect(text).not.toHaveBeenCalled();
  });

  test.each(["", "External ID,Status\n"])("empty buffered input stays empty (%p)", async (csv) => {
    const parsed = await parseTabularFileBuffer(new TextEncoder().encode(csv).buffer as ArrayBuffer, "orders.csv");
    expect(parsed.rows).toEqual([]);
    expect(parsed.totalRows).toBe(0);
  });

  test("preserves format and unreadable-sheet failures", async () => {
    await expect(parseTabularFileBuffer(new ArrayBuffer(0), "legacy.xls")).rejects.toThrow("Legacy .xls");
    await expect(parseTabularFileBuffer(new ArrayBuffer(0), "orders.txt")).rejects.toThrow("Unsupported file format");
    await expect(parseTabularFileBuffer(new ArrayBuffer(0), "orders.xlsx")).rejects.toThrow("readable worksheet");
  });
});
