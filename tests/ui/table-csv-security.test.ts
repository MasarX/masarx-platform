import { parseCsvTextMatrix } from "@masarx/api";
import { buildCsv, toCsvRow } from "../../packages/ui/src/table/columns";
import { buildMetricsCsv } from "../../packages/ui/src/table/metrics";

test.each([
  '=HYPERLINK("https://example.test", "Click")',
  "+SUM(1,2)",
  "-2+3",
  "@SUM(A1:A2)",
  "  =1+1",
  "\t=1+1",
  "\r=1+1",
  "\n=1+1",
  "\u0000=1+1",
])("CSV exports neutralize formula-like value %j", (value) => {
  expect(parseCsvTextMatrix(toCsvRow([value]))).toEqual([[`'${value}`]]);
});

test("CSV exports preserve signed numbers, ordinary text, delimiters and line breaks", () => {
  const values = ["-12.50", "+12", "-.5", "-1e-5", "Alpha", "one,two", 'say "hello"', "first\nsecond"];
  expect(parseCsvTextMatrix(toCsvRow(values))).toEqual([values]);
});

test("resource CSV exports protect both user-controlled headers and cell values", () => {
  const csv = buildCsv([{ label: "=1+1" }], [{ key: "label", label: "+SUM(1,2)" }]);
  expect(parseCsvTextMatrix(csv)).toEqual([["'+SUM(1,2)"], ["'=1+1"]]);
});

test("metrics CSV protects custom column names and retains negative numeric metrics", () => {
  const csv = buildMetricsCsv(["amount"], {
    total: 1,
    columns: { amount: { count: 1, sum: -12.5, avg: -12.5, min: -12.5, max: -12.5 } },
  }, null, new Map([["amount", { key: "amount", label: "=1+1" }]]));
  expect(parseCsvTextMatrix(csv)[1]).toEqual(["'=1+1", "1", "-12.5", "-12.5", "-12.5", "-12.5"]);
});
