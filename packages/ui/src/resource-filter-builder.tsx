"use client";

import * as React from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { reportUiEvent } from "./reporting";
import { createUiClient, type UiReadFilter } from "@masarx/api";
import { Button } from "./button";
import { Combobox } from "./combobox";
import { Input } from "./input";
import { Select } from "./select";
import { useComboboxSearch } from "./use-combobox-search";
import { resolveRowDisplayText } from "./i18n";
import {
  buildFilterTreeFromFlat,
  decodeFilterTree,
  encodeFilterTree,
  flattenSearchParams,
  formatFilterOp,
  labelFromKey,
  resolveFilterKeys,
  type FilterGroup,
  type FilterNode,
  type FilterRule,
  type SearchParams,
} from "./resource-query";
import { buildHref } from "./url";

type FilterBuilderProps = {
  resourceKey?: string;
  filters: UiReadFilter[] | null | undefined;
  searchParams: SearchParams;
  initialTree?: FilterGroup | null;
  actionHref: string;
  limit: number;
  testIdPrefix?: string;
  opLabels?: Record<string, string>;
  opKeys?: string[];
  onApply?: (payload: { encoded: string | null; ruleCount: number }) => void;
  onClear?: () => void;
  /** When provided, called instead of router.replace() for filter navigation. */
  onNavigate?: (href: string) => void;
};

const FALLBACK_OPS = ["eq", "ne", "gt", "gte", "lt", "lte", "ilike"];
const EMPTY_FILTERS: UiReadFilter[] = [];

const RESERVED_KEYS = new Set(["limit", "offset", "page", "filters"]);

type Translator = ReturnType<typeof useTranslations>;
type UiClient = ReturnType<typeof createUiClient>;

function makeId() {
  return globalThis.crypto?.randomUUID?.() ?? `filter_${Date.now().toString(10)}`;
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

function resolveFilterOps(filter: UiReadFilter | null | undefined, fallbackOps: string[]) {
  const ops = normalizeOps(filter?.ops);
  return ops.length > 0 ? ops : fallbackOps;
}

function resolveDefaultOp(filter: UiReadFilter | null | undefined, fallbackOps: string[]) {
  const ops = resolveFilterOps(filter, fallbackOps);
  return ops[0] ?? "eq";
}

function buildDefaultTree(
  filters: Record<string, string>,
  defs: UiReadFilter[] | null | undefined,
  fallbackOps: string[]
) {
  const hasFilters = Object.keys(filters).length > 0;
  if (hasFilters) return buildFilterTreeFromFlat(filters, defs);
  const firstFilter = defs?.[0] ?? null;
  return {
    id: makeId(),
    type: "group",
    op: "and",
    rules: [
      {
        id: makeId(),
        type: "rule",
        key: firstFilter?.key ?? "",
        op: resolveDefaultOp(firstFilter, fallbackOps),
        value: "",
      },
    ],
  } satisfies FilterGroup;
}

function extractFlatFilters(params: SearchParams, keys: Set<string>) {
  const output: Record<string, string> = {};
  flattenSearchParams(params).forEach(([key, value]) => {
    if (RESERVED_KEYS.has(key)) return;
    if (keys.size > 0 && !keys.has(key)) return;
    const trimmed = value.trim();
    if (!trimmed) return;
    output[key] = trimmed;
  });
  return output;
}

function updateGroupTree(
  tree: FilterGroup,
  groupId: string,
  updater: (group: FilterGroup) => FilterGroup
): FilterGroup {
  if (tree.id === groupId) return updater(tree);
  const nextRules: FilterNode[] = tree.rules.map((node): FilterNode => {
    if (node.type === "group") {
      return updateGroupTree(node, groupId, updater);
    }
    return node;
  });
  return { ...tree, rules: nextRules };
}

function updateRuleTree(tree: FilterGroup, ruleId: string, updater: (rule: FilterRule) => FilterRule) {
  const walk = (node: FilterNode): FilterNode => {
    if (node.type === "rule") {
      return node.id === ruleId ? updater(node) : node;
    }
    return { ...node, rules: node.rules.map(walk) };
  };
  return walk(tree) as FilterGroup;
}

function removeNode(tree: FilterGroup, nodeId: string): FilterGroup {
  const walk = (node: FilterNode): FilterNode | null => {
    if (node.id === nodeId) return null;
    if (node.type === "group") {
      const nextRules = node.rules.map(walk).filter(Boolean) as FilterNode[];
      if (nextRules.length === 0) return null;
      return { ...node, rules: nextRules };
    }
    return node;
  };
  const next = walk(tree);
  return next && next.type === "group" ? next : tree;
}

function normalizeFilterValue(raw: string) {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (!trimmed.includes(",")) return trimmed;
  const values = trimmed
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  return values.length > 0 ? values : null;
}

function sanitizeTree(tree: FilterGroup) {
  const walk = (node: FilterNode): FilterNode | null => {
    if (node.type === "rule") {
      const key = node.key.trim();
      const value =
        typeof node.value === "string"
          ? normalizeFilterValue(node.value)
          : Array.isArray(node.value)
            ? node.value.map((entry) => String(entry ?? "").trim()).filter(Boolean)
            : node.value;
      if (!key || !value || (Array.isArray(value) && value.length === 0)) return null;
      return { ...node, key, value };
    }
    const rules = node.rules.map(walk).filter(Boolean) as FilterNode[];
    if (rules.length === 0) return null;
    return { ...node, rules };
  };
  const normalized = walk(tree);
  return normalized && normalized.type === "group" ? normalized : null;
}

function countRules(tree: FilterGroup) {
  const walk = (node: FilterNode): number => {
    if (node.type === "rule") return 1;
    return node.rules.reduce((sum, child) => sum + walk(child), 0);
  };
  return walk(tree);
}

function buildTreeSignature(tree: FilterGroup | null) {
  if (!tree) return "";
  const walk = (node: FilterNode): unknown => {
    if (node.type === "rule") {
      return {
        type: "rule",
        key: node.key,
        op: node.op ?? null,
        value: node.value,
      };
    }
    return {
      type: "group",
      op: node.op,
      rules: node.rules.map(walk),
    };
  };
  return JSON.stringify(walk(tree));
}

function serializeFlatFilters(filters: Record<string, string>) {
  return JSON.stringify(
    Object.keys(filters)
      .sort()
      .map((key) => [key, filters[key]])
  );
}

function FilterRuleRow({
  rule,
  resourceKey,
  ui,
  filterDefs,
  filterOptions,
  fallbackOps,
  opLabels,
  t,
  onChange,
  onRemove,
  testIdPrefix,
}: {
  rule: FilterRule;
  resourceKey?: string;
  ui: UiClient;
  filterDefs: UiReadFilter[];
  filterOptions: Map<string, { label: string; ops: string[] }>;
  fallbackOps: string[];
  opLabels?: Record<string, string>;
  t: Translator;
  onChange: (rule: FilterRule) => void;
  onRemove: () => void;
  testIdPrefix?: string;
}) {
  const filterDef = React.useMemo(
    () => filterDefs.find((filter) => filter.key === rule.key) ?? null,
    [filterDefs, rule.key]
  );
  const resolvedOps =
    filterOptions.get(rule.key)?.ops ??
    resolveFilterOps(filterDefs.find((filter) => filter.key === rule.key), fallbackOps);
  const normalizedOps = resolvedOps.length > 0 ? resolvedOps : fallbackOps;
  const normalizedOp = String(rule.op ?? normalizedOps[0] ?? "eq")
    .trim()
    .toLowerCase();

  const autocomplete = filterDef?.value_autocomplete ?? null;
  const autocompleteEnabled = Boolean(
    resourceKey &&
      autocomplete?.enabled &&
      (autocomplete?.source ?? "distinct_values") === "distinct_values"
  );
  const minQueryLength = Math.max(1, Number(autocomplete?.min_query_length) || 1);
  const limit = Math.max(1, Math.min(Number(autocomplete?.limit) || 25, 200));
  const supportsArrayValue = normalizedOp === "eq" || normalizedOp === "ne" || normalizedOp === "ilike";
  const canUseCombobox = autocompleteEnabled && (supportsArrayValue || !Array.isArray(rule.value));
  const fetchAutocompleteOptions = React.useCallback(
    async (queryValue: string) => {
      const normalizedQuery = queryValue.trim();
      if (normalizedQuery.length < minQueryLength) return [];
      if (!resourceKey) return [];

      const values = await ui.filterDistinctValues({
        resource: resourceKey,
        filterKey: rule.key,
        query: normalizedQuery,
        limit,
      });
      const normalized = Array.isArray(values)
        ? Array.from(
            new Set(
              values.map((entry) => String(entry ?? "").trim()).filter(Boolean)
            )
          )
        : [];
      return normalized.map((value) => ({ label: value, value }));
    },
    [limit, minQueryLength, resourceKey, rule.key, ui]
  );

  const comboboxMode: "single" | "multi" = supportsArrayValue ? "multi" : "single";
  const comboboxValue = React.useMemo(() => {
    if (comboboxMode === "multi") {
      if (Array.isArray(rule.value)) return rule.value;
      const single = typeof rule.value === "string" ? rule.value.trim() : "";
      return single ? [single] : [];
    }
    if (Array.isArray(rule.value)) return rule.value.join(", ");
    return typeof rule.value === "string" ? rule.value : "";
  }, [comboboxMode, rule.value]);

  const { query, search, results, loading } = useComboboxSearch({
    enabled: canUseCombobox,
    debounceMs: 250,
    fetcher: fetchAutocompleteOptions,
  });

  const emptyMessage =
    query.trim().length < minQueryLength
      ? t("rule.valueAutocompleteHint", { min: minQueryLength })
      : t("rule.valueAutocompleteEmpty");

  return (
    <div className="flex flex-wrap items-end gap-3 rounded-lg border border-ui-border/40 bg-transparent p-2">
      <label className="flex min-w-[180px] flex-1 flex-col gap-2 text-xs text-ui-ink">
        <span className="text-ui-muted">
          {t("rule.field")}
        </span>
        <Select
          value={rule.key}
          onChange={(event) => {
            const nextKey = event.target.value;
            const options =
              filterOptions.get(nextKey)?.ops ??
              resolveFilterOps(filterDefs.find((filter) => filter.key === nextKey), fallbackOps);
            const nextOps = options.length > 0 ? options : fallbackOps;
            const nextOp = nextOps.includes(rule.op ?? "")
              ? (rule.op ?? nextOps[0])
              : nextOps[0];
            onChange({
              ...rule,
              key: nextKey,
              op: nextOp ?? "eq",
            });
          }}
          className="rounded-md"
          data-testid={
            testIdPrefix ? `${testIdPrefix}-filter-field` : undefined
          }
        >
          <option value="">{t("rule.fieldPlaceholder")}</option>
          {filterDefs.map((filter) => (
            <option key={filter.key} value={filter.key}>
              {filterOptions.get(filter.key)?.label ?? labelFromKey(filter.key)}
            </option>
          ))}
        </Select>
      </label>
      <label className="flex min-w-[140px] flex-1 flex-col gap-2 text-xs text-ui-ink">
        <span className="text-ui-muted">
          {t("rule.operator")}
        </span>
        <Select
          value={rule.op ?? normalizedOps[0] ?? "eq"}
          onChange={(event) => onChange({ ...rule, op: event.target.value })}
          className="rounded-md"
          data-testid={
            testIdPrefix ? `${testIdPrefix}-filter-operator` : undefined
          }
        >
          {normalizedOps.map((op) => (
            <option key={op} value={op}>
              {formatFilterOp(op, opLabels) ?? op}
            </option>
          ))}
        </Select>
      </label>
      <label className="flex min-w-[220px] flex-[2] flex-col gap-2 text-xs text-ui-ink">
        <span className="text-ui-muted">
          {t("rule.value")}
        </span>
        {canUseCombobox ? (
          <Combobox
            key={`${rule.id}:${rule.key}:${comboboxMode}`}
            mode={comboboxMode}
            options={results}
            value={comboboxValue}
            onChange={(nextValue) => {
              if (comboboxMode === "multi") {
                onChange({
                  ...rule,
                  value: Array.isArray(nextValue)
                    ? nextValue
                    : nextValue
                      ? [nextValue]
                      : [],
                });
                return;
              }
              onChange({
                ...rule,
                value: Array.isArray(nextValue) ? nextValue[0] ?? "" : nextValue,
              });
            }}
            onSearch={search}
            loading={loading}
            loadingMessage={t("rule.valueAutocompleteLoading")}
            placeholder={t("rule.valuePlaceholder")}
            emptyMessage={emptyMessage}
            className="min-h-[38px] rounded-md"
          />
        ) : (
          <Input
            value={
              typeof rule.value === "string"
                ? rule.value
                : Array.isArray(rule.value)
                  ? rule.value.join(", ")
                  : ""
            }
            onChange={(event) => onChange({ ...rule, value: event.target.value })}
            placeholder={t("rule.valuePlaceholder")}
            className="rounded-md"
            data-testid={
              testIdPrefix ? `${testIdPrefix}-filter-value` : undefined
            }
          />
        )}
      </label>
      <Button type="button" variant="ghost" onClick={onRemove}>
        {t("rule.remove")}
      </Button>
    </div>
  );
}

function FilterGroupEditor({
  group,
  resourceKey,
  ui,
  filterDefs,
  filterOptions,
  fallbackOps,
  opLabels,
  t,
  onUpdate,
  onRemove,
  testIdPrefix,
  depth = 0,
}: {
  group: FilterGroup;
  resourceKey?: string;
  ui: UiClient;
  filterDefs: UiReadFilter[];
  filterOptions: Map<string, { label: string; ops: string[] }>;
  fallbackOps: string[];
  opLabels?: Record<string, string>;
  t: Translator;
  onUpdate: (next: FilterGroup) => void;
  onRemove?: () => void;
  testIdPrefix?: string;
  depth?: number;
}) {
  return (
    <div className="space-y-3 rounded-lg border border-ui-border/30 bg-ui-highlight/20 p-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3 text-xs text-ui-muted">
          <span>{t("group.title", { index: depth + 1 })}</span>
          <Select
            value={group.op}
            onChange={(event) => onUpdate({ ...group, op: event.target.value === "or" ? "or" : "and" })}
            className="rounded-md bg-transparent px-2 py-1 text-xs"
            aria-label={t("rule.operator")}
          >
            <option value="and">{t("group.matchAll")}</option>
            <option value="or">{t("group.matchAny")}</option>
          </Select>
        </div>
        {onRemove ? (
          <Button type="button" variant="ghost" onClick={onRemove}>
            {t("group.remove")}
          </Button>
        ) : null}
      </div>
      <div className="space-y-3">
        {group.rules.map((node) =>
          node.type === "group" ? (
            <FilterGroupEditor
              key={node.id}
              group={node}
              resourceKey={resourceKey}
              ui={ui}
              filterDefs={filterDefs}
              filterOptions={filterOptions}
              fallbackOps={fallbackOps}
              opLabels={opLabels}
              t={t}
              depth={depth + 1}
              testIdPrefix={testIdPrefix}
              onUpdate={(next) => onUpdate(updateGroupTree(group, node.id, () => next))}
              onRemove={() => onUpdate(removeNode(group, node.id))}
            />
          ) : (
            <FilterRuleRow
              key={node.id}
              rule={node}
              resourceKey={resourceKey}
              ui={ui}
              filterDefs={filterDefs}
              filterOptions={filterOptions}
              fallbackOps={fallbackOps}
              opLabels={opLabels}
              t={t}
              testIdPrefix={testIdPrefix}
              onChange={(nextRule) => onUpdate(updateRuleTree(group, node.id, () => nextRule))}
              onRemove={() => onUpdate(removeNode(group, node.id))}
            />
          )
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant="ghost"
          onClick={() =>
            onUpdate(
              updateGroupTree(group, group.id, (current) => ({
                ...current,
                rules: [
                  ...current.rules,
                  {
                    id: makeId(),
                    type: "rule",
                    key: filterDefs[0]?.key ?? "",
                    op: resolveDefaultOp(filterDefs[0], fallbackOps),
                    value: "",
                  },
                ],
              }))
            )
          }
        >
          {t("group.addRule")}
        </Button>
        <Button
          type="button"
          variant="ghost"
          onClick={() =>
            onUpdate(
              updateGroupTree(group, group.id, (current) => ({
                ...current,
                rules: [
                  ...current.rules,
                  {
                    id: makeId(),
                    type: "group",
                    op: "and",
                    rules: [
                      {
                        id: makeId(),
                        type: "rule",
                        key: filterDefs[0]?.key ?? "",
                        op: resolveDefaultOp(filterDefs[0], fallbackOps),
                        value: "",
                      },
                    ],
                  },
                ],
              }))
            )
          }
        >
          {t("group.addGroup")}
        </Button>
      </div>
    </div>
  );
}

export function ResourceFilterBuilder({
  resourceKey,
  filters,
  searchParams,
  initialTree,
  actionHref,
  limit,
  testIdPrefix,
  opLabels,
  opKeys,
  onApply,
  onClear,
  onNavigate,
}: FilterBuilderProps) {
  const router = useRouter();
  const navigateReplace = React.useMemo(
    () => onNavigate ?? ((href: string) => router.replace(href)),
    [onNavigate, router]
  );
  const params = useSearchParams();
  const locale = useLocale();
  const t = useTranslations("ui.resourceFilter");
  const ui = React.useMemo(() => createUiClient(), []);
  const filterDefs = React.useMemo(
    () =>
      Array.isArray(filters) && filters.length > 0 ? filters : EMPTY_FILTERS,
    [filters]
  );
  const fallbackOps = React.useMemo(
    () => (Array.isArray(opKeys) && opKeys.length > 0 ? opKeys : FALLBACK_OPS),
    [opKeys]
  );
  const filterKeys = resolveFilterKeys(filterDefs);
  const filterOptions = React.useMemo(() => {
    const entries = new Map<string, { label: string; ops: string[] }>();
    filterDefs.forEach((filter) => {
      const english =
        typeof filter.label === "string" && filter.label.trim()
          ? filter.label.trim()
          : labelFromKey(filter.key);
      const label = resolveRowDisplayText(english, filter.label_ar, locale);
      const ops = resolveFilterOps(filter, fallbackOps);
      entries.set(filter.key, { label, ops });
    });
    return entries;
  }, [filterDefs, fallbackOps, locale]);
  const rawFilterParam = params.get("filters") ?? undefined;
  const decodedTree = React.useMemo(
    () => decodeFilterTree(rawFilterParam),
    [rawFilterParam]
  );
  const flatFilters = extractFlatFilters(searchParams, filterKeys);
  const flatFiltersKey = React.useMemo(
    () => serializeFlatFilters(flatFilters),
    [flatFilters]
  );
  const defaultTree = React.useMemo(
    () => buildDefaultTree(flatFilters, filterDefs, fallbackOps),
    [flatFiltersKey, filterDefs, fallbackOps]
  );
  const externalTree = React.useMemo(() => {
    if (rawFilterParam) {
      return decodeFilterTree(rawFilterParam) ?? null;
    }
    return initialTree ?? defaultTree;
  }, [defaultTree, initialTree, rawFilterParam]);
  const [tree, setTree] = React.useState<FilterGroup>(() => {
    return decodedTree ?? initialTree ?? buildDefaultTree(flatFilters, filterDefs, fallbackOps);
  });
  const normalizedTestIdPrefix = testIdPrefix?.trim() || "";
  const testId = normalizedTestIdPrefix
    ? `${normalizedTestIdPrefix}-filter-builder`
    : undefined;
  const sanitizedTree = React.useMemo(() => sanitizeTree(tree), [tree]);
  const treeSignature = React.useMemo(() => buildTreeSignature(tree), [tree]);
  const externalSignature = React.useMemo(
    () => buildTreeSignature(externalTree),
    [externalTree]
  );
  const lastExternalSignature = React.useRef(externalSignature);
  const guardSkips = React.useRef(0);
  const canApply = Boolean(sanitizedTree);

  React.useEffect(() => {
    if (!externalTree) return;
    if (externalSignature === lastExternalSignature.current) {
      if (externalSignature !== treeSignature && guardSkips.current === 0) {
        reportUiEvent({
          type: "ui.table.filters.sync.skip",
          timestamp: new Date().toISOString(),
          name: "guard",
          message: "external signature unchanged; skipping reset",
        });
      }
      guardSkips.current += 1;
      return;
    }
    guardSkips.current = 0;
    lastExternalSignature.current = externalSignature;
    if (externalSignature !== treeSignature) {
      setTree(externalTree);
    }
  }, [externalSignature, externalTree, treeSignature]);

  if (!filters || filters.length === 0) return null;

  const applyFilters = () => {
    const normalized = sanitizedTree;
    const encoded = normalized ? encodeFilterTree(normalized) : null;
    const ruleCount = normalized ? countRules(normalized) : 0;
    const nextParams = new URLSearchParams();
    flattenSearchParams(searchParams).forEach(([key, value]) => {
      if (RESERVED_KEYS.has(key)) return;
      if (filterKeys.has(key)) return;
      nextParams.append(key, value);
    });
    nextParams.set("page", "1");
    nextParams.set("offset", "0");
    nextParams.set("limit", String(Math.max(1, limit)));
    if (encoded) {
      nextParams.set("filters", encoded);
    }
    navigateReplace(buildHref(actionHref, nextParams));
    onApply?.({ encoded, ruleCount });
  };

  const clearFilters = () => {
    const nextParams = new URLSearchParams();
    flattenSearchParams(searchParams).forEach(([key, value]) => {
      if (RESERVED_KEYS.has(key)) return;
      if (filterKeys.has(key)) return;
      nextParams.append(key, value);
    });
    nextParams.set("page", "1");
    nextParams.set("offset", "0");
    nextParams.set("limit", String(Math.max(1, limit)));
    navigateReplace(buildHref(actionHref, nextParams));
    setTree(buildDefaultTree({}, filterDefs, fallbackOps));
    onClear?.();
  };

  return (
    <div className="space-y-3" data-testid={testId}>
      <FilterGroupEditor
        group={tree}
        resourceKey={resourceKey}
        ui={ui}
        filterDefs={filterDefs}
        filterOptions={filterOptions}
        fallbackOps={fallbackOps}
        opLabels={opLabels}
        t={t}
        testIdPrefix={normalizedTestIdPrefix || undefined}
        onUpdate={(next) => setTree(next)}
      />
      {!canApply ? (
        <div className="text-xs text-ui-muted">
          {t("builder.ruleRequired")}
        </div>
      ) : null}
      <div className="flex flex-wrap items-center gap-3">
        <Button
          type="button"
          onClick={applyFilters}
          disabled={!canApply}
          data-testid={
            normalizedTestIdPrefix ? `${normalizedTestIdPrefix}-filter-apply` : undefined
          }
        >
          {t("builder.apply")}
        </Button>
        <Button
          type="button"
          variant="ghost"
          onClick={clearFilters}
          data-testid={
            normalizedTestIdPrefix ? `${normalizedTestIdPrefix}-filter-clear` : undefined
          }
        >
          {t("builder.clear")}
        </Button>
      </div>
    </div>
  );
}
