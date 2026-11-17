export type LabelExpr =
  | LabelExprLiteral
  | LabelExprPath
  | LabelExprConcat
  | LabelExprCoalesce
  | LabelExprNumberFormat;

export type LabelExprLiteral = {
  op: "literal";
  value: string | number | boolean | null;
};

export type LabelExprPath = {
  op: "path";
  path: string;
  default?: unknown;
};

export type LabelExprConcat = {
  op: "concat";
  args: LabelExpr[];
};

export type LabelExprCoalesce = {
  op: "coalesce";
  args: LabelExpr[];
};

export type LabelExprNumberFormat = {
  op: "number_format";
  value: LabelExpr;
  decimals?: number;
  trim_trailing_zeros?: boolean;
};

export const resolvePathValue = (root: unknown, path?: string | null): unknown => {
  if (!root || typeof root !== "object" || !path || path.trim().length === 0) return undefined;
  const iterator = path.matchAll(/([^[.\]]+)|\[(\d+)\]/g);
  let current: any = root;
  for (const match of iterator) {
    if (current === undefined || current === null) return undefined;
    if (match[1] !== undefined) {
      current = current?.[match[1]];
    } else if (match[2] !== undefined) {
      const index = Number(match[2]);
      current = Array.isArray(current) ? current[index] : undefined;
    }
  }
  return current;
};

export const stringifyValue = (value: unknown, fallback = ""): string => {
  if (value === undefined || value === null) return fallback;
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    return value.map((item) => (item == null ? "" : String(item))).join(", ");
  }
  return fallback;
};

const isEmpty = (value: unknown): boolean => {
  if (value === undefined || value === null) return true;
  if (typeof value === "string") return value.trim().length === 0;
  return false;
};

const normalizeDecimals = (raw: unknown): number | undefined => {
  const n = Number(raw);
  if (!Number.isFinite(n)) return undefined;
  const floored = Math.floor(n);
  if (floored < 0) return 0;
  if (floored > 6) return 6;
  return floored;
};

const formatNumber = (value: unknown, opts: { decimals?: number; trimTrailingZeros?: boolean }): string => {
  if (value === undefined || value === null) return "";
  const n = Number(value);
  if (!Number.isFinite(n)) return "";
  const decimals = normalizeDecimals(opts.decimals) ?? undefined;
  if (decimals == null) return String(n);
  const fixed = n.toFixed(decimals);
  if (!opts.trimTrailingZeros) return fixed;
  if (!fixed.includes(".")) return fixed;
  return fixed.replace(/\.?0+$/, "");
};

export const evaluateLabelExpr = (
  expr: unknown,
  root: Record<string, any>,
  opts: { maxDepth?: number } = {},
): unknown => {
  const maxDepth = Number.isFinite(Number(opts.maxDepth)) ? Math.max(4, Math.floor(Number(opts.maxDepth))) : 64;

  const evalInner = (node: unknown, depth: number): unknown => {
    if (depth > maxDepth) return undefined;
    if (!node || typeof node !== "object") return undefined;

    const op = (node as any).op;
    if (op === "literal") return (node as any).value ?? null;

    if (op === "path") {
      const path = typeof (node as any).path === "string" ? (node as any).path : "";
      const v = resolvePathValue(root, path);
      if (v === undefined || v === null) return (node as any).default ?? undefined;
      return v;
    }

    if (op === "concat") {
      const args = Array.isArray((node as any).args) ? (node as any).args : [];
      let out = "";
      for (const a of args) out += stringifyValue(evalInner(a, depth + 1), "");
      return out;
    }

    if (op === "coalesce") {
      const args = Array.isArray((node as any).args) ? (node as any).args : [];
      for (const a of args) {
        const v = evalInner(a, depth + 1);
        if (!isEmpty(v)) return v;
      }
      return undefined;
    }

    if (op === "number_format") {
      const value = evalInner((node as any).value, depth + 1);
      const decimals = (node as any).decimals;
      const trimTrailingZeros = (node as any).trim_trailing_zeros === true;
      return formatNumber(value, { decimals, trimTrailingZeros });
    }

    return undefined;
  };

  return evalInner(expr, 0);
};

export const evaluateLabelExprToString = (
  expr: unknown,
  root: Record<string, any>,
  fallback = "",
): string => stringifyValue(evaluateLabelExpr(expr, root), fallback);

