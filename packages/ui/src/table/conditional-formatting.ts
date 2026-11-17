import type { ConditionalFormattingRule } from "./view-types";

export type ConditionalStyle = {
  bgColor?: string | null;
  textColor?: string | null;
  bold?: boolean | null;
};

export type CellConditionalStyle = {
  row: ConditionalStyle | null;
  cells: Record<string, ConditionalStyle>;
};

function evaluateCondition(
  cellValue: unknown,
  operator: ConditionalFormattingRule["operator"],
  ruleValue: string | number | null | undefined
): boolean {
  const strVal = cellValue == null ? "" : String(cellValue);
  const numVal =
    cellValue != null && cellValue !== "" ? Number(cellValue) : null;
  const ruleNum =
    ruleValue != null && ruleValue !== "" ? Number(ruleValue) : null;

  switch (operator) {
    case "eq":
      return strVal === String(ruleValue ?? "");
    case "ne":
      return strVal !== String(ruleValue ?? "");
    case "gt":
      return numVal !== null && ruleNum !== null && numVal > ruleNum;
    case "gte":
      return numVal !== null && ruleNum !== null && numVal >= ruleNum;
    case "lt":
      return numVal !== null && ruleNum !== null && numVal < ruleNum;
    case "lte":
      return numVal !== null && ruleNum !== null && numVal <= ruleNum;
    case "contains":
      return strVal.toLowerCase().includes(String(ruleValue ?? "").toLowerCase());
    case "empty":
      return strVal === "" || cellValue == null;
    case "notEmpty":
      return strVal !== "" && cellValue != null;
    default:
      return false;
  }
}

/**
 * Evaluate conditional formatting rules for a row and return styles.
 */
export function evaluateConditionalFormatting(
  row: Record<string, unknown>,
  rules: ConditionalFormattingRule[] | null | undefined
): CellConditionalStyle {
  const result: CellConditionalStyle = { row: null, cells: {} };
  if (!rules || rules.length === 0) return result;

  for (const rule of rules) {
    const cellValue = row[rule.field];
    if (!evaluateCondition(cellValue, rule.operator, rule.value)) continue;

    const style: ConditionalStyle = {
      bgColor: rule.style.bgColor ?? null,
      textColor: rule.style.textColor ?? null,
      bold: rule.style.bold ?? null,
    };

    if (rule.scope === "row") {
      result.row = style;
    } else {
      result.cells[rule.field] = style;
    }
  }

  return result;
}

/**
 * Convert ConditionalStyle to inline CSS style object.
 */
export function conditionalStyleToCss(
  style: ConditionalStyle | null | undefined
): React.CSSProperties | undefined {
  if (!style) return undefined;
  const css: React.CSSProperties = {};
  if (style.bgColor) css.backgroundColor = style.bgColor;
  if (style.textColor) css.color = style.textColor;
  if (style.bold) css.fontWeight = "bold";
  return Object.keys(css).length > 0 ? css : undefined;
}
