import type { UiReadFilter } from "@masarx/api";
import { Badge } from "./badge";
import { Button } from "./button";
import {
  flattenSearchParams,
  formatFilterOp,
  labelFromKey,
  resolveFilterKeys,
  type SearchParams,
} from "./resource-query";
import { createUiTranslator, resolveRowDisplayText } from "./i18n";
import { buildHref } from "./url";

const t = createUiTranslator("ui.resourceFilter");

export type AppliedFilter = {
  key: string;
  value: string;
  op?: string | null;
  source: "query" | "view";
};

type ResourceFilterChipsProps = {
  filters: UiReadFilter[] | null | undefined;
  appliedFilters: AppliedFilter[];
  searchParams: SearchParams;
  actionHref: string;
  testIdPrefix?: string;
  canRemove?: boolean;
  opLabels?: Record<string, string>;
  locale?: string;
};

function buildFilterHref(
  searchParams: SearchParams,
  filterKeys: Set<string>,
  actionHref: string,
  removeKey?: string
) {
  const params = new URLSearchParams();
  flattenSearchParams(searchParams).forEach(([key, value]) => {
    if (key === "page" || key === "offset" || key === "filters") return;
    if (filterKeys.has(key)) {
      if (!removeKey || key === removeKey) return;
    }
    params.append(key, value);
  });
  params.set("page", "1");
  params.set("offset", "0");
  return buildHref(actionHref, params);
}

function resolveFilterLabel(filter: UiReadFilter | null | undefined, key: string, locale?: string) {
  const english = filter?.label?.trim() || labelFromKey(filter?.key ?? key);
  return resolveRowDisplayText(english, filter?.label_ar, locale);
}

function resolveFilterOp(definition: UiReadFilter | null | undefined, op?: string | null) {
  if (op) return op;
  const opsRaw = Array.isArray(definition?.ops) ? definition?.ops : [];
  const normalizedOps = opsRaw
    .map((entry) => String(entry ?? "").trim().toLowerCase())
    .filter(Boolean);
  if (normalizedOps.length > 0) return normalizedOps[0];
  return definition?.op ?? null;
}

function formatFilterValue(value: string, maxLength = 64) {
  const normalized = String(value ?? "").trim();
  if (!normalized) return "-";
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength - 1)}\u2026`;
}

export function ResourceFilterChips({
  filters,
  appliedFilters,
  searchParams,
  actionHref,
  testIdPrefix,
  canRemove = true,
  opLabels,
  locale,
}: ResourceFilterChipsProps) {
  if (!appliedFilters || appliedFilters.length === 0) return null;

  const filterKeys = resolveFilterKeys(filters);
  const filterMap = new Map((filters ?? []).map((filter) => [filter.key, filter]));
  const ordered = [...appliedFilters].sort((a, b) => {
    const labelA = resolveFilterLabel(filterMap.get(a.key), a.key, locale);
    const labelB = resolveFilterLabel(filterMap.get(b.key), b.key, locale);
    return labelA.localeCompare(labelB);
  });
  const hasQueryFilters = ordered.some((filter) => filter.source === "query");
  const hasViewFilters = ordered.some((filter) => filter.source === "view");
  const clearHref = buildFilterHref(searchParams, filterKeys, actionHref);      
  const testId = testIdPrefix ? `${testIdPrefix}-filter-chips` : undefined;     

  return (
    <div
      className="space-y-3 text-xs text-ui-muted"
      data-testid={testId}
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <span className="text-[11px] font-medium text-ui-muted">
          {t("chips.active", { count: ordered.length })}
        </span>
        {hasQueryFilters ? (
          <Button asChild variant="ghost">
            <a href={clearHref}>{t("chips.clearQuery")}</a>
          </Button>
        ) : null}
      </div>
      {hasViewFilters ? (
        <div className="text-xs text-ui-muted">
          {t("chips.viewManaged")}
        </div>
      ) : null}
      <div className="flex flex-wrap gap-2">
        {ordered.map((filter) => {
          const definition = filterMap.get(filter.key);
          const label = resolveFilterLabel(definition, filter.key, locale);
          const opLabel =
            formatFilterOp(resolveFilterOp(definition, filter.op), opLabels) ??
            t("chips.equals");
          const removeHref = buildFilterHref(
            searchParams,
            filterKeys,
            actionHref,
            filter.key
          );
          return (
            <div
              key={`${filter.key}-${filter.value}`}
              className="flex min-h-8 flex-wrap items-center gap-2 rounded-md border border-ui-border/50 bg-ui-paper/70 px-2.5 py-1 text-xs"
            >
              <span className="max-w-[12rem] truncate font-semibold text-ui-ink" title={label}>
                {label}
              </span>
              <span className="rounded border border-ui-border/40 bg-ui-highlight/60 px-1.5 py-0.5 text-[10px] text-ui-muted">
                {opLabel}
              </span>
              <span
                className="max-w-[24rem] truncate text-ui-ink"
                title={filter.value}
              >
                {formatFilterValue(filter.value)}
              </span>
              {filter.source === "view" || !canRemove ? (
                <Badge tone="neutral">
                  {filter.source === "view"
                    ? t("chips.viewLabel")
                    : t("chips.queryLabel")}
                </Badge>
              ) : (
                <Button asChild variant="ghost">
                  <a
                    href={removeHref}
                    aria-label={t("chips.removeLabel", { label })}
                  >
                    {t("chips.remove")}
                  </a>
                </Button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
