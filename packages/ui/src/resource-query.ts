import type { UiReadFilter } from "@masarx/api";
import { getUiDefaults } from "@masarx/config";
import { resolveRowDisplayText } from "./i18n";

export type SearchParams = Record<string, string | string[] | undefined>;

export type FilterRuleValue = string | string[] | null;

export type FilterRule = {
  id: string;
  type: "rule";
  key: string;
  op?: string | null;
  value: FilterRuleValue;
};

export type FilterGroup = {
  id: string;
  type: "group";
  op: "and" | "or";
  rules: FilterNode[];
};

export type FilterNode = FilterRule | FilterGroup;

const uiDefaults = getUiDefaults();
const FILTER_OP_LABELS = uiDefaults.filterOpLabels;
const FILTER_OP_KEYS = Object.keys(FILTER_OP_LABELS);

export type FilterOpLabels = Record<string, string>;
export type FilterOperatorRegistry = {
  labels: FilterOpLabels;
  keys: string[];
};

function normalizeOperatorKey(value: unknown) {
  return String(value ?? "").trim().toLowerCase();
}

export function resolveFilterOperatorRegistry(value: unknown, locale?: string | null): FilterOperatorRegistry {
  const raw =
    value && typeof value === "object"
      ? (value as Record<string, unknown>)
      : {};
  const operators = Array.isArray(raw.operators) ? raw.operators : [];
  if (!operators.length) {
    return { labels: FILTER_OP_LABELS, keys: FILTER_OP_KEYS };
  }
  const labels: FilterOpLabels = { ...FILTER_OP_LABELS };
  const keys: string[] = [];
  operators.forEach((entry) => {
    if (!entry || typeof entry !== "object") return;
    const operator = entry as Record<string, unknown>;
    const key = normalizeOperatorKey(operator.key);
    if (!key) return;
    keys.push(key);
    const label = String(operator.label ?? "").trim();
    if (label) labels[key] = resolveRowDisplayText(label, operator.label_ar, locale);
  });
  const uniqueKeys = Array.from(new Set(keys));
  return {
    labels,
    keys: uniqueKeys.length > 0 ? uniqueKeys : FILTER_OP_KEYS,
  };
}

export function labelFromKey(key: string) {
  const normalized = key
    .replace(/[_-]+/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .trim()
    .replace(/\s+/g, " ");
  if (!normalized) return key;
  return normalized
    .split(" ")
    .map((part) => {
      if (!part) return part;
      const lower = part.toLowerCase();
      if (lower === "id") return "ID";
      return lower.charAt(0).toUpperCase() + lower.slice(1);
    })
    .join(" ");
}

function normalizeOps(value: unknown) {
  if (!Array.isArray(value)) return [];
  return Array.from(
    new Set(
      value
        .map((entry) => String(entry ?? "").trim().toLowerCase())
        .filter(Boolean)
    )
  );
}

function resolveDefaultOp(filter?: UiReadFilter | null) {
  const ops = normalizeOps(filter?.ops);
  if (ops.length > 0) return ops[0];
  const fallback = String(filter?.op ?? "").trim();
  return fallback || "eq";
}

export function formatFilterOp(
  op?: string | null,
  labels: FilterOpLabels = FILTER_OP_LABELS
) {
  if (!op) return null;
  const normalized = op.toLowerCase();
  return labels[normalized] ?? normalized;
}

type NormalizedFlatValue = {
  op?: string | null;
  value: FilterRuleValue;
};

function normalizeDelimitedValue(value: string) {
  const values = value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  return values.length > 0 ? values : null;
}

export function normalizeFlatFilterValue(value: unknown): NormalizedFlatValue | null {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) {
    const normalized = value
      .map((entry) => String(entry ?? "").trim())
      .filter(Boolean);
    return normalized.length > 0 ? { value: normalized } : null;
  }

  const text = String(value).trim();
  if (!text) return null;

  const prefixed = /^(not[\s_-]*in|in)\s*:\s*(.*)$/i.exec(text);
  if (!prefixed) return { value: text };

  const values = normalizeDelimitedValue(prefixed[2] ?? "");
  if (!values) return null;
  return {
    op: prefixed[1]?.toLowerCase().startsWith("not") ? "ne" : "eq",
    value: values,
  };
}

export function formatFilterOp(
  op?: string | null,
  labels: FilterOpLabels = FILTER_OP_LABELS
) {
  if (!op) return null;
  const normalized = op.toLowerCase();
  return labels[normalized] ?? normalized;
}

export function flattenSearchParams(params: SearchParams) {
  const entries: Array<[string, string]> = [];
  Object.entries(params).forEach(([key, raw]) => {
    if (raw === undefined) return;
    if (Array.isArray(raw)) {
      raw.forEach((value) => {
        if (value === undefined) return;
        entries.push([key, value]);
      });
      return;
    }
    entries.push([key, raw]);
  });
  return entries;
}

export function resolveFilterKeys(filters: UiReadFilter[] | null | undefined) {
  return new Set((filters ?? []).map((filter) => filter.key));
}

function normalizeOp(value: unknown): "and" | "or" {
  return String(value ?? "").toLowerCase() === "or" ? "or" : "and";
}

function normalizeValue(value: unknown): FilterRuleValue {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) {
    const values = value
      .map((entry) => String(entry ?? "").trim())
      .filter(Boolean);
    return values.length > 0 ? values : null;
  }
  const trimmed = String(value).trim();
  return trimmed ? trimmed : null;
}

function makeId() {
  return globalThis.crypto?.randomUUID?.() ?? `filter_${Date.now().toString(10)}`;
}

function normalizeRule(raw: Record<string, unknown>): FilterRule | null {
  const key = String(raw.key ?? "").trim();
  if (!key) return null;
  const value = normalizeValue(raw.value);
  if (!value) return null;
  return {
    id: String(raw.id ?? makeId()),
    type: "rule",
    key,
    op: raw.op ? String(raw.op) : null,
    value,
  };
}

function normalizeGroup(raw: Record<string, unknown>): FilterGroup | null {
  const rulesRaw = Array.isArray(raw.rules) ? raw.rules : [];
  const rules = rulesRaw
    .map((entry) => normalizeFilterNode(entry))
    .filter(Boolean) as FilterNode[];
  if (rules.length === 0) return null;
  return {
    id: String(raw.id ?? makeId()),
    type: "group",
    op: normalizeOp(raw.op),
    rules,
  };
}

export function normalizeFilterNode(value: unknown): FilterNode | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  if (raw.type === "group" || Array.isArray(raw.rules)) {
    return normalizeGroup(raw);
  }
  return normalizeRule(raw);
}

export function decodeFilterTree(value?: string | null): FilterGroup | null {
  if (!value) return null;
  try {
    const decoded = JSON.parse(decodeURIComponent(value));
    const normalized = normalizeFilterNode(decoded);
    if (normalized && normalized.type === "group") {
      return normalized;
    }
    return null;
  } catch {
    return null;
  }
}

export function encodeFilterTree(tree: FilterGroup): string {
  return encodeURIComponent(JSON.stringify(tree));
}

export function buildFilterTreeFromFlat(
  filters: Record<string, string>,
  definitions: UiReadFilter[] | null | undefined
): FilterGroup {
  const definitionMap = new Map(
    (definitions ?? []).map((filter) => [filter.key, filter])
  );
  const rules = Object.entries(filters).flatMap(([key, value]): FilterRule[] => {
    const normalized = normalizeFlatFilterValue(value);
    if (!normalized) return [];
    return [{
      id: makeId(),
      type: "rule",
      key,
      op: normalized.op ?? resolveDefaultOp(definitionMap.get(key)),
      value: normalized.value,
    }];
  });
  return {
    id: makeId(),
    type: "group",
    op: "and",
    rules,
  };
}

export function flattenFilterTree(tree: FilterGroup | null): FilterRule[] {
  if (!tree) return [];
  const entries: FilterRule[] = [];
  const walk = (node: FilterNode) => {
    if (node.type === "rule") {
      entries.push(node);
      return;
    }
    node.rules.forEach(walk);
  };
  walk(tree);
  return entries;
}
