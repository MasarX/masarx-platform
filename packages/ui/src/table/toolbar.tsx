import { Badge } from "../badge";
import { Button } from "../button";
import { Input } from "../input";
import { Select } from "../select";
import type { TranslateFn } from "./types";
import type { ReactNode } from "react";

type TableToolbarProps = {
  t: TranslateFn;
  searchTerm: string;
  onSearchChange: (value: string) => void;
  onSearchClear: () => void;
  searchDebounceMs: number;
  searchDebounceOptions: number[];
  onSearchDebounceChange: (value: number) => void;
  clientFilterActive: boolean;
  filteredCount: number;
  totalCount: number;
  clientPaginationEnabled: boolean;
  pageSummaryLabel?: string | null;
  resolvedClientPage: number;
  totalClientPages: number;
  canPageBack: boolean;
  canPageForward: boolean;
  showPageControls: boolean;
  pageInput: string;
  onPageInputChange: (value: string) => void;
  onPageInputBlur: () => void;
  onFirstPage: () => void;
  onPrevPage: () => void;
  onNextPage: () => void;
  onLastPage: () => void;
  variant?: "standalone" | "embedded";
  testIdPrefix?: string;
  actionSlot?: ReactNode;
};

export function TableToolbar({
  t,
  searchTerm,
  onSearchChange,
  onSearchClear,
  searchDebounceMs,
  searchDebounceOptions,
  onSearchDebounceChange,
  clientFilterActive,
  filteredCount,
  totalCount,
  clientPaginationEnabled,
  pageSummaryLabel,
  resolvedClientPage,
  totalClientPages,
  canPageBack,
  canPageForward,
  showPageControls,
  pageInput,
  onPageInputChange,
  onPageInputBlur,
  onFirstPage,
  onPrevPage,
  onNextPage,
  onLastPage,
  variant = "standalone",
  testIdPrefix,
  actionSlot,
}: TableToolbarProps) {
  const showDebounceSelect = searchDebounceOptions.length > 1;
  const resolvedTestIdPrefix = testIdPrefix?.trim() || "";
  const searchTestId = resolvedTestIdPrefix
    ? `${resolvedTestIdPrefix}-table-search`
    : undefined;
  const searchClearTestId = resolvedTestIdPrefix
    ? `${resolvedTestIdPrefix}-table-search-clear`
    : undefined;
  const debounceTestId = resolvedTestIdPrefix
    ? `${resolvedTestIdPrefix}-table-search-debounce`
    : undefined;
  const pageFirstTestId = resolvedTestIdPrefix
    ? `${resolvedTestIdPrefix}-table-page-first`
    : undefined;
  const pagePrevTestId = resolvedTestIdPrefix
    ? `${resolvedTestIdPrefix}-table-page-prev`
    : undefined;
  const pageNextTestId = resolvedTestIdPrefix
    ? `${resolvedTestIdPrefix}-table-page-next`
    : undefined;
  const pageLastTestId = resolvedTestIdPrefix
    ? `${resolvedTestIdPrefix}-table-page-last`
    : undefined;
  const pageInputTestId = resolvedTestIdPrefix
    ? `${resolvedTestIdPrefix}-table-page-input`
    : undefined;
  const containerClass =
    variant === "embedded"
      ? "flex flex-wrap items-center justify-between gap-3 text-xs text-ui-muted"
      : "flex flex-wrap items-center justify-between gap-3 rounded-lg border border-ui-border/40 bg-transparent px-3 py-2 text-xs text-ui-muted";

  return (
    <div className={containerClass}>
      <div className="relative min-w-[160px] flex-1">
        <svg
          aria-hidden
          viewBox="0 0 20 20"
          className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ui-muted"
          fill="none"
          stroke="currentColor"
          strokeWidth={1.8}
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <circle cx="8.5" cy="8.5" r="5" />
          <path d="M12.5 12.5l3.5 3.5" />
        </svg>
        <Input
          value={searchTerm}
          onChange={(event) => onSearchChange(event.target.value)}
          placeholder={t("search.placeholder")}
          aria-label={t("search.aria")}
          className="h-8 pl-8 pr-8 text-xs"
          data-testid={searchTestId}
        />
        {searchTerm ? (
          <button
            type="button"
            onClick={onSearchClear}
            aria-label={t("search.clearAria")}
            className="absolute right-2 top-1/2 -translate-y-1/2 rounded-full p-0.5 text-ui-muted transition-colors hover:text-ui-ink"
            data-testid={searchClearTestId}
          >
            <svg
              aria-hidden
              viewBox="0 0 12 12"
              className="h-3 w-3"
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
              strokeLinecap="round"
            >
              <path d="M3 3l6 6M9 3l-6 6" />
            </svg>
          </button>
        ) : null}
      </div>
      <div className="flex flex-wrap items-center gap-3">
        {actionSlot ? (
          <div className="flex items-center gap-2">{actionSlot}</div>
        ) : null}
        {clientFilterActive ? (
          <Badge tone="accent">
            {t("search.filtered", {
              filtered: filteredCount,
              total: totalCount,
            })}
            {!clientPaginationEnabled ? ` ${t("search.filteredPage")}` : ""}
          </Badge>
        ) : !clientPaginationEnabled ? (
          <Badge>{t("search.rows", { count: filteredCount })}</Badge>
        ) : null}
        {clientPaginationEnabled && pageSummaryLabel ? (
          <Badge>{pageSummaryLabel}</Badge>
        ) : null}
        {showDebounceSelect ? (
          <label className="flex items-center gap-2 text-[10px] font-medium text-ui-muted">
            <span>{t("search.debounceLabel")}</span>
            <Select
              value={String(searchDebounceMs)}
              onChange={(event) =>
                onSearchDebounceChange(Number(event.target.value))
              }
              className="px-2 py-1 text-xs"
              data-testid={debounceTestId}
            >
              {searchDebounceOptions.map((value) => (
                <option key={value} value={value}>
                  {value === 0
                    ? t("search.debounceInstant")
                    : t("search.debounceOption", { ms: value })}
                </option>
              ))}
            </Select>
          </label>
        ) : null}
        {clientPaginationEnabled ? (
          <div className="flex flex-wrap items-center gap-2">
            <Badge>
              {t("paging.page", {
                current: resolvedClientPage,
                total: totalClientPages,
              })}
            </Badge>
            {showPageControls ? (
              <div className="flex items-center gap-2">
                <Button
                  type="button"
                  variant="ghost"
                  onClick={onFirstPage}
                  disabled={!canPageBack}
                  aria-label={t("paging.firstAria")}
                  data-testid={pageFirstTestId}
                >
                  {t("paging.first")}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  onClick={onPrevPage}
                  disabled={!canPageBack}
                  aria-label={t("paging.prevAria")}
                  data-testid={pagePrevTestId}
                >
                  {t("paging.prev")}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  onClick={onNextPage}
                  disabled={!canPageForward}
                  aria-label={t("paging.nextAria")}
                  data-testid={pageNextTestId}
                >
                  {t("paging.next")}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  onClick={onLastPage}
                  disabled={!canPageForward}
                  aria-label={t("paging.lastAria")}
                  data-testid={pageLastTestId}
                >
                  {t("paging.last")}
                </Button>
              </div>
            ) : null}
            {showPageControls ? (
              <label className="flex items-center gap-2 text-[10px] font-medium text-ui-muted">
                <span>{t("paging.goto")}</span>
                <Input
                  type="number"
                  min={1}
                  max={totalClientPages}
                  value={pageInput}
                  onChange={(event) => onPageInputChange(event.target.value)}
                  onBlur={onPageInputBlur}
                  aria-label={t("paging.gotoAria")}
                  className="w-16 px-2 py-1 text-xs"
                  data-testid={pageInputTestId}
                />
              </label>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}
