import {
  matrixToTabularData,
  matrixToTabularPreview,
  parseCsvTextMatrix,
  prepareTabularRows,
  worksheetToMatrix,
  worksheetToTabularPreview,
} from "../../packages/api/src/tabular-import";

function worksheet(rows: unknown[][]) {
  return {
    rowCount: rows.length,
    columnCount: Math.max(0, ...rows.map((row) => row.length)),
    getRow: (index: number) => ({
      getCell: (column: number) => ({ value: rows[index - 1]?.[column - 1] }),
    }),
  };
}

test("worksheet previews normalize only 20 records while counting all 49 rows", () => {
  const reads: Array<[number, number]> = [];
  const sheet = {
    rowCount: 50, columnCount: 3,
    getRow: (row: number) => ({
      cellCount: 3,
      getCell: (column: number) => {
        reads.push([row, column]);
        if (row > 21 && column > 1) throw new Error("Count-only row was fully converted");
        return { text: row === 1 ? ["External ID", "Status", "Tags"][column - 1] : `${row - 1}-${column}` };
      },
    }),
  };
  const preview = worksheetToTabularPreview(sheet, 20);
  expect(preview.totalRows).toBe(49);
  expect(preview.rows).toHaveLength(20);
  expect(preview.rows[19]).toEqual({ "External ID": "20-1", Status: "20-2", Tags: "20-3" });
  expect(reads).toHaveLength(3 + 49 + 20 * 3);
  expect(reads.filter(([row]) => row > 21)).toEqual(Array.from({ length: 29 }, (_, index) => [index + 22, 1]));
});

test.each(["matrix", "worksheet"])("%s preview totals match complete conversion of blank, unnamed and typed cells", (format) => {
  const matrix = [
    ["External ID", "", "Status"], ["one", "ignored", "active"],
    [" ", "not an import row", "\t"], [false, "", ""], [0, "", ""],
    ["", "", "inactive"], [new Date("2026-10-19T00:00:00Z"), "", ""], [],
  ];
  const sheet = worksheet([[], ...matrix, []]);
  const full = matrixToTabularData(format === "matrix" ? matrix : worksheetToMatrix(sheet));
  const preview = format === "matrix" ? matrixToTabularPreview(matrix, 3) : worksheetToTabularPreview(sheet, 3);
  expect(preview).toEqual({ headers: full.headers, rows: full.rows.slice(0, 3), totalRows: 5 });
  expect(preview.rows[2]).toEqual({ "External ID": 0, Status: "" });
});

test("worksheet previews preserve formatted text and ignore unnamed-only records", () => {
  const cells = [[{ text: " ID " }, { text: " " }], [{ text: "formatted", value: 42 }], [{}, { text: "ignored" }]];
  const sheet = { rowCount: cells.length, columnCount: 2, getRow: (row: number) => ({ getCell: (column: number) => cells[row - 1]?.[column - 1] }) };
  expect(worksheetToTabularPreview(sheet, 20)).toEqual({ headers: ["ID"], rows: [{ ID: "formatted" }], totalRows: 1 });
});

test("CSV previews preserve quoted values while complete imports retain rows 35 and 49", () => {
  const matrix = parseCsvTextMatrix('\uFEFFExternal ID,Status\r\n"ext,1",active\r\n'
    + Array.from({ length: 48 }, (_, index) => `ext-${index + 2},active\r\n`).join(""));
  expect(matrixToTabularPreview(matrix, 20)).toMatchObject({ totalRows: 49, rows: expect.any(Array) });
  expect(matrixToTabularPreview(matrix, 20).rows).toHaveLength(20);
  const full = matrixToTabularData(worksheetToMatrix(worksheet(matrix)));
  expect(full.rows[0]).toEqual({ "External ID": "ext,1", Status: "active" });
  const prepared = prepareTabularRows({
    rows: full.rows, rules: [{ source_column: "External ID", target_field: "external_id" }],
    resource: { key: "recipients", relation: "public.recipients", columns: [{ key: "external_id", import: { enabled: true } }] },
  });
  expect(prepared).toHaveLength(49);
  expect(prepared[34]).toMatchObject({ row_number: 35, mapped_row: { external_id: "ext-35" } });
  expect(prepared[48]).toMatchObject({ row_number: 49, mapped_row: { external_id: "ext-49" } });
});

test("zero-record previews still return headers and the exact total", () => {
  const matrix = [["ID"], ["one"], ["two"]];
  const expected = { headers: ["ID"], rows: [], totalRows: 2 };
  expect(matrixToTabularPreview(matrix, 0)).toEqual(expected);
  expect(worksheetToTabularPreview(worksheet(matrix), 0)).toEqual(expected);
});

test("missing worksheets and unnamed headers remain empty", () => {
  const expected = { headers: [], rows: [], totalRows: 0 };
  expect(worksheetToTabularPreview(null, 20)).toEqual(expected);
  expect(worksheetToTabularPreview(worksheet([[" "], ["ignored"]]), 20)).toEqual(expected);
  expect(matrixToTabularPreview([[" "], ["ignored"]], 20)).toEqual(expected);
});

test("preview counts match canonical own-field behavior for reserved headers", () => {
  for (const matrix of [[["__proto__"], ["value"]], [["__proto__", "ID"], ["value", ""]]]) {
    const full = matrixToTabularData(matrix);
    const expected = { ...full, totalRows: full.rows.length };
    expect(matrixToTabularPreview(matrix, 20)).toEqual(expected);
    expect(worksheetToTabularPreview(worksheet(matrix), 20)).toEqual(expected);
  }
});

test.each([-1, 0.5, NaN, Infinity, 10001])("invalid preview limit %s fails before worksheet reads", (limit) => {
  const getRow = jest.fn();
  expect(() => worksheetToTabularPreview({ rowCount: 1, columnCount: 1, getRow }, limit)).toThrow("safe worksheet limits");
  expect(getRow).not.toHaveBeenCalled();
  expect(() => matrixToTabularPreview([["ID"], ["one"]], limit)).toThrow("safe worksheet limits");
});

test.each([[10001, 1], [1, 257], [10000, 201], [Infinity, 1]])("worksheet dimensions %s x %s fail before getRow", (rowCount, columnCount) => {
  const getRow = jest.fn();
  const sheet = { rowCount, columnCount, getRow };
  expect(() => worksheetToMatrix(sheet)).toThrow("safe worksheet limits");
  expect(() => worksheetToTabularPreview(sheet, 20)).toThrow("safe worksheet limits");
  expect(getRow).not.toHaveBeenCalled();
});

test("count-only rows retain per-row dimension checks before reading cells", () => {
  const getCell = jest.fn();
  const sheet = {
    rowCount: 2, columnCount: 1,
    getRow: (row: number) => row === 1 ? { getCell: () => ({ text: "ID" }) } : { cellCount: 257, getCell },
  };
  expect(() => worksheetToTabularPreview(sheet, 0)).toThrow("safe worksheet limits");
  expect(getCell).not.toHaveBeenCalled();
});

test("matrix dimensions are validated before preview truncation", () => {
  expect(() => matrixToTabularPreview(Array.from({ length: 10002 }, () => ["ID"]), 0)).toThrow("safe worksheet limits");
  expect(() => matrixToTabularPreview([Array(257).fill("ID")], 0)).toThrow("safe worksheet limits");
});

test("bounded previews retain canonical output resource guards", () => {
  const matrix = [["ID"], ["x".repeat(9 * 1024 * 1024)]];
  expect(() => matrixToTabularPreview(matrix, 1)).toThrow("safe worksheet limits");
  expect(() => worksheetToTabularPreview(worksheet(matrix), 1)).toThrow("safe worksheet limits");
});
