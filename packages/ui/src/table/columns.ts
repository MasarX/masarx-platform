import { formatResourceValue } from "../resource-utils";
import { labelFromKey } from "../resource-query";

export type ResourceColumn = {
  key: string;
  label?: string | null;
  renderType?: string | null;
  formatOptions?: Record<string, unknown> | null;
  editMode?: string | null;
  editType?: string | null;
  editAllowId?: boolean | null;
  editPermission?: string | null;
  editOptions?:
    | Array<
        | string
        | number
        | {
            label?: string | number | null;
            value?: string | number | null;
          }
      >
    | null;
  aggregation?: {
    enabled?: boolean | null;
    methods?: string[] | null;
  } | null;
};

export function resolveColumnLabel(column: ResourceColumn) {
  const label = typeof column.label === "string" ? column.label.trim() : "";
  return label || labelFromKey(column.key);
}

export function resolveColumnLabelByKey(
  columnsByKey: Map<string, ResourceColumn>,
  key: string
) {
  const column = columnsByKey.get(key);
  return column ? resolveColumnLabel(column) : labelFromKey(key);
}

export function toCsvRow(values: string[]) {
  return values
    .map((value) => {
      // CSV quoting does not stop spreadsheet programs from evaluating formulas.
      // Keep ordinary signed numbers numeric while treating formula-like text as text.
      const isSignedNumber = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(value);
      const isFormula = /^[\s\u0000-\u001f]*[=+@-]/.test(value) || /^[\t\r\n]/.test(value);
      const safeValue = isFormula && !isSignedNumber ? `'${value}` : value;
      const escaped = safeValue.replace(/"/g, '""');
      return /[",\n\r]/.test(escaped) ? `"${escaped}"` : escaped;
    })
    .join(",");
}

export function buildCsv(rows: Record<string, unknown>[], columns: ResourceColumn[]) {
  const headers = columns.map((column) => resolveColumnLabel(column));
  const lines = [toCsvRow(headers)];
  rows.forEach((item) => {
    const values = columns.map((column) =>
      formatResourceValue(item[column.key] ?? "", {
        renderType: column.renderType ?? null,
        formatOptions: column.formatOptions ?? null,
      })
    );
    lines.push(toCsvRow(values));
  });
  return lines.join("\r\n");
}
