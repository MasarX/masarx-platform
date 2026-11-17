import { buildExcelExportBlob } from "../../packages/ui/src/tabular-file";

const mockAddRow = jest.fn();
const mockAddWorksheet = jest.fn(() => ({ addRow: mockAddRow }));
const mockWriteBuffer = jest.fn();

jest.mock("exceljs", () => ({
  Workbook: jest.fn(() => ({
    addWorksheet: mockAddWorksheet,
    xlsx: {
      load: jest.fn(),
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
