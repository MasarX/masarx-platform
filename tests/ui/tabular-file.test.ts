import { buildExcelExportBlob, parseTabularFile, TABULAR_FILE_ACCEPT } from "../../packages/ui/src/tabular-file";

const mockAddRow = jest.fn();
const mockAddWorksheet = jest.fn(() => ({ addRow: mockAddRow }));
const mockWriteBuffer = jest.fn();
const mockSheetToJson = jest.fn();
const mockReadWorkbook = jest.fn();

jest.mock("exceljs", () => ({
  Workbook: jest.fn(() => ({
    addWorksheet: mockAddWorksheet,
    xlsx: {
      load: jest.fn(),
      writeBuffer: mockWriteBuffer,
    },
  })),
}));

jest.mock("xlsx", () => ({
  read: (...args: unknown[]) => mockReadWorkbook(...args),
  utils: {
    sheet_to_json: (...args: unknown[]) => mockSheetToJson(...args),
  },
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

describe("tabular file import", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test("advertises CSV, XLS, and XLSX imports", () => {
    expect(TABULAR_FILE_ACCEPT).toBe(".csv,.xls,.xlsx");
  });

  test("parses legacy XLS workbooks through the workbook runtime", async () => {
    const sheet = { "!ref": "A1:B2" };
    mockReadWorkbook.mockReturnValue({
      SheetNames: ["Shipments", "Hidden"],
      Sheets: { Shipments: sheet },
      Workbook: {
        Sheets: [
          { name: "Shipments", Hidden: 0 },
          { name: "Hidden", Hidden: 1 },
        ],
      },
    });
    mockSheetToJson.mockReturnValue([
      ["tracking_number", "recipient_name"],
      ["SHP-XLS-1", "Legacy Receiver"],
    ]);

    const parsed = await parseTabularFile({
      name: "shipments.xls",
      arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
    } as File);

    expect(mockReadWorkbook).toHaveBeenCalledWith(expect.any(ArrayBuffer), {
      type: "array",
      raw: false,
      cellDates: true,
    });
    expect(mockSheetToJson).toHaveBeenCalledWith(sheet, {
      header: 1,
      defval: "",
      blankrows: false,
    });
    expect(parsed).toEqual({
      format: "xls",
      fileName: "shipments.xls",
      workbookSheets: ["Shipments"],
      selectedSheet: "Shipments",
      headers: ["tracking_number", "recipient_name"],
      rows: [{ tracking_number: "SHP-XLS-1", recipient_name: "Legacy Receiver" }],
    });
  });
});
