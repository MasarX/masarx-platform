"use client";
import type { UiReadFilter } from "@masarx/api";
import { ResourceFilterBuilder } from "../resource-filter-builder";
import type { FilterGroup, SearchParams } from "../resource-query";
import { Button } from "../button";
import type { TranslateFn } from "./types";
import { TablePanelHeader } from "./panel-header";

type TableFilterPanelProps = {
  t: TranslateFn;
  resourceKey?: string | null;
  filters: UiReadFilter[] | null | undefined;
  searchParams: SearchParams;
  actionHref?: string | null;
  limit: number;
  initialTree: FilterGroup | null;
  activeFilterCount?: number;
  opLabels?: Record<string, string>;
  opKeys?: string[];
  filtersLabel: string;
  panelLabel?: string;
  onResetView: () => void;
  onFilterApply?: (payload: { encoded: string | null; ruleCount: number }) => void;
  onFilterClear?: () => void;
  testIdPrefix?: string | null;
  /** When provided, called instead of router.replace() for filter navigation. */
  onNavigate?: (href: string) => void;
};

export function TableFilterPanel({
  t,
  resourceKey,
  filters,
  searchParams,
  actionHref,
  limit,
  initialTree,
  activeFilterCount = 0,
  opLabels,
  opKeys,
  filtersLabel,
  panelLabel,
  onResetView,
  onFilterApply,
  onFilterClear,
  testIdPrefix,
  onNavigate,
}: TableFilterPanelProps) {
  const canClear = Boolean(onFilterClear && activeFilterCount > 0);
  const headerLabel = panelLabel ?? filtersLabel;

  return (
    <div className="space-y-3">
      <TablePanelHeader
        label={headerLabel}
        count={activeFilterCount}
        hint={t("viewBar.filtersHint")}
        actions={
          <>
            {onFilterClear ? (
              <Button
                type="button"
                variant="ghost"
                onClick={onFilterClear}
                disabled={!canClear}
              >
                {t("viewBar.clearFilters")}
              </Button>
            ) : null}
            <Button type="button" variant="ghost" onClick={onResetView}>
              {t("toolbar.resetView")}
            </Button>
          </>
        }
      />
      {actionHref ? (
        <ResourceFilterBuilder
          resourceKey={resourceKey ?? undefined}
          filters={filters}
          searchParams={searchParams}
          initialTree={initialTree ?? undefined}
          actionHref={actionHref}
          limit={limit}
          testIdPrefix={testIdPrefix?.trim() || undefined}
          opLabels={opLabels}
          opKeys={opKeys}
          onApply={onFilterApply}
          onClear={onFilterClear}
          onNavigate={onNavigate}
        />
      ) : (
        <p className="text-xs text-ui-muted">{t("viewBar.filtersUnavailable")}</p>
      )}
    </div>
  );
}
