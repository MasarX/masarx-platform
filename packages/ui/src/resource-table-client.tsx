"use client";
import * as React from "react";
import type { UiResourceList } from "@masarx/api";
import { useRouter } from "next/navigation";
import { ResourceBulkActions, type ResourceBulkActionsProps } from "./resource-bulk-actions";
import { ResourceTable } from "./resource-table";
import { BulkActionResultReadback, type BatchResultReadback } from "./bulk-action-result-readback";
import { stableStringify } from "./utils";
import {
  useResourceListInvalidate,
  useResourceQuery,
} from "./hooks/use-resource-query";
import { Button } from "./button";
import { Input } from "./input";
import { ErrorState } from "./error-state";
import { createUiTranslator } from "./i18n";
import { decodeFilterTree, type SearchParams } from "./resource-query";
import { resolvePaginationDisplay } from "./pagination-utils";

const t = createUiTranslator("ui.resourcePage");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Configuration for hybrid server/client data fetching. When provided,
 * ResourceTableClient will manage data fetching client-side via React Query
 * instead of relying on full-page server navigation.
 */
export type ServerFetchConfig = {
  /** The resource key being displayed. */
  resourceKey: string;
  /** Base href for URL construction. */
  baseHref: string;
  /** Initial data from the server render. */
  initialList: UiResourceList | null;
  /** Initial pagination limit (page size). */
  initialLimit: number;
  /** Initial pagination offset. */
  initialOffset: number;
  /** Initial sort state. */
  initialSort: { key: string; direction: "asc" | "desc" } | null;
  /** Initial filter tree/map. */
  initialFilters: Record<string, unknown> | null;
  /** Whether the total is an estimate. */
  initialTotalIsEstimate: boolean;
  /** Current search params for URL reconstruction. */
  searchParams: SearchParams;
};

type ResourceTableClientProps = Omit<
  React.ComponentProps<typeof ResourceTable>,
  "renderBulkActions"
> & {
  bulkActions?: Omit<ResourceBulkActionsProps, "selectedIds"> | null;
  /**
   * When provided, enables hybrid server/client mode: the table fetches data
   * client-side on sort/filter/pagination changes, avoiding full page reloads.
   */
  serverFetch?: ServerFetchConfig | null;
};

// ---------------------------------------------------------------------------
// URL param parsing helpers
// ---------------------------------------------------------------------------

function parseHrefParams(href: string) {
  const questionMark = href.indexOf("?");
  if (questionMark < 0) return new URLSearchParams();
  return new URLSearchParams(href.slice(questionMark + 1));
}

function parseSortFromParams(
  params: URLSearchParams
): { key: string; direction: "asc" | "desc" } | null {
  const key = params.get("sort")?.trim();
  const direction = params.get("direction")?.trim()?.toLowerCase();
  if (!key) return null;
  return {
    key,
    direction: direction === "asc" || direction === "desc" ? direction : "asc",
  };
}

function parseIntParam(params: URLSearchParams, key: string, fallback: number) {
  const raw = params.get(key);
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

// ---------------------------------------------------------------------------
// Client-side pagination (buttons, no <a> links)
// ---------------------------------------------------------------------------

type ClientPaginationBarProps = {
  limit: number;
  offset: number;
  total: number | null;
  totalIsEstimate: boolean;
  itemsCount: number;
  onPageChange: (page: number, offset: number) => void;
  testIdPrefix?: string | null;
};

function ClientPaginationBar({
  limit,
  offset,
  total,
  totalIsEstimate,
  itemsCount,
  onPageChange,
  testIdPrefix,
}: ClientPaginationBarProps) {
  const safeLimit = Math.max(1, limit);
  const safeOffset = Math.max(0, offset);
  const testId = testIdPrefix ? `${testIdPrefix}-pagination` : undefined;
  const { start, end, total: displayTotal } = resolvePaginationDisplay({
    total, totalIsEstimate, offset: safeOffset, itemsCount,
  });
  const hasExactTotal = !totalIsEstimate && displayTotal !== null;
  const totalPagesValue =
    hasExactTotal
      ? Math.max(1, Math.ceil(displayTotal / safeLimit))
      : null;
  const rawCurrentPage = Math.max(1, Math.floor(safeOffset / safeLimit) + 1);
  const currentPage = totalPagesValue
    ? Math.min(totalPagesValue, rawCurrentPage)
    : rawCurrentPage;
  const [goToPage, setGoToPage] = React.useState(() => String(currentPage));

  React.useEffect(() => {
    setGoToPage(String(currentPage));
  }, [currentPage]);

  if (hasExactTotal) {
    if (displayTotal <= safeLimit && safeOffset === 0) return null;

    if (totalPagesValue === null) return null;
    const totalPages = totalPagesValue;
    const prevPage = currentPage > 1 ? currentPage - 1 : null;
    const nextPage = currentPage < totalPages ? currentPage + 1 : null;

    const handleGoTo = (e: React.FormEvent) => {
      e.preventDefault();
      const parsed = Number.parseInt(goToPage, 10);
      if (!Number.isFinite(parsed) || parsed < 1 || parsed > totalPages) return;
      onPageChange(parsed, (parsed - 1) * safeLimit);
    };

    return (
      <div
        className="flex flex-wrap items-center justify-between gap-4 rounded-lg border border-ui-border/30 bg-ui-surface/50 px-4 py-3 text-sm"
        data-testid={testId}
      >
        <div className="flex flex-col gap-1 text-xs text-ui-muted">
          <span>{t("pagination.showing", { start, end, total: displayTotal })}</span>
          <span>{t("pagination.page", { current: currentPage, total: totalPages })}</span>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            disabled={!prevPage}
            onClick={() => prevPage && onPageChange(1, 0)}
          >
            {t("pagination.first")}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={!prevPage}
            onClick={() => prevPage && onPageChange(prevPage, (prevPage - 1) * safeLimit)}
          >
            {t("pagination.prev")}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={!nextPage}
            onClick={() => nextPage && onPageChange(nextPage, (nextPage - 1) * safeLimit)}
          >
            {t("pagination.next")}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={!nextPage}
            onClick={() => onPageChange(totalPages, (totalPages - 1) * safeLimit)}
          >
            {t("pagination.last")}
          </Button>
          {totalPages > 1 ? (
            <form onSubmit={handleGoTo} className="flex items-center gap-2">
              <label className="flex items-center gap-2 text-[10px] uppercase tracking-wide text-ui-muted">
                <span>{t("pagination.goto")}</span>
                <Input
                  type="number"
                  min={1}
                  max={totalPages}
                  value={goToPage}
                  onChange={(e) => setGoToPage(e.target.value)}
                  className="w-16 rounded-lg bg-ui-surface/80 px-2 py-1 text-xs"
                />
              </label>
              <Button type="submit" variant="ghost" size="sm">
                {t("pagination.go")}
              </Button>
            </form>
          ) : null}
        </div>
      </div>
    );
  }

  // Estimates and unknown totals use observed page fullness for navigation.
  const prevPage = currentPage > 1 ? currentPage - 1 : null;
  const nextPage = itemsCount >= safeLimit ? currentPage + 1 : null;
  if (!prevPage && !nextPage) return null;

  return (
    <div
      className="flex flex-wrap items-center justify-between gap-4 rounded-lg border border-ui-border/30 bg-ui-surface/50 px-4 py-3 text-sm"
      data-testid={testId}
    >
      <div className="flex flex-col gap-1 text-xs text-ui-muted">
        <span>
          {displayTotal !== null
            ? t("pagination.showingEstimated", { start, end, total: displayTotal })
            : t("pagination.showingUnknownTotal", { start, end })}
        </span>
        <span>{t("pagination.pageEstimated", { current: currentPage })}</span>
      </div>
      <div className="flex items-center gap-2">
        <Button
          variant="ghost"
          size="sm"
          disabled={!prevPage}
          onClick={() => prevPage && onPageChange(1, 0)}
        >
          {t("pagination.first")}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          disabled={!prevPage}
          onClick={() =>
            prevPage && onPageChange(prevPage, (prevPage - 1) * safeLimit)
          }
        >
          {t("pagination.prev")}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          disabled={!nextPage}
          onClick={() =>
            nextPage && onPageChange(nextPage, (nextPage - 1) * safeLimit)
          }
        >
          {t("pagination.next")}
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// ResourceTableClient
// ---------------------------------------------------------------------------

export function ResourceTableClient({
  bulkActions,
  serverFetch,
  ...tableProps
}: ResourceTableClientProps) {
  const router = useRouter();
  const tableTestIdPrefix = tableProps.testIdPrefix?.trim()
    ? `${tableProps.testIdPrefix}-table`
    : undefined;
  const hybridEnabled = Boolean(serverFetch);
  const batchResultOwnerKey = stableStringify({
    resourceKey: bulkActions?.resourceKey ?? serverFetch?.resourceKey ?? tableProps.resourceKey ?? null,
    appKey: bulkActions?.appKey ?? null,
    appBasePath: bulkActions?.appBasePath ?? tableProps.appBasePath ?? null,
    settingsResolutionId: bulkActions?.telemetry?.settingsResolutionId ?? null,
    scopeType: bulkActions?.telemetry?.scopeType ?? null,
    scopeId: bulkActions?.telemetry?.scopeId ?? null,
    scopeValue: bulkActions?.telemetry?.scopeValue ?? null,
  });
  const batchResultOwner = React.useMemo(() => ({ key: batchResultOwnerKey }), [batchResultOwnerKey]);
  const [ownedBatchResultReadback, setOwnedBatchResultReadback] = React.useState<{
    owner: typeof batchResultOwner; result: BatchResultReadback;
  } | null>(null);
  const currentBatchResultOwnerRef = React.useRef(batchResultOwner);
  React.useLayoutEffect(() => {
    currentBatchResultOwnerRef.current = batchResultOwner;
  }, [batchResultOwner]);
  const handleBatchResultReadbackChange = React.useCallback((result: BatchResultReadback | null) => {
    setOwnedBatchResultReadback((current) => currentBatchResultOwnerRef.current === batchResultOwner
      ? result ? { owner: batchResultOwner, result } : null
      : current);
  }, [batchResultOwner]);
  const batchResultReadback = ownedBatchResultReadback?.owner === batchResultOwner
    ? ownedBatchResultReadback.result : null;
  const invalidationResourceKey =
    bulkActions?.resourceKey || serverFetch?.resourceKey || tableProps.resourceKey || "";
  const invalidateResourceList = useResourceListInvalidate(invalidationResourceKey);
  const handleBulkActionSuccess = React.useCallback(async () => {
    if (hybridEnabled && invalidationResourceKey) {
      await invalidateResourceList();
      return;
    }
    router.refresh();
  }, [
    hybridEnabled,
    invalidationResourceKey,
    invalidateResourceList,
    router,
  ]);
  const renderBulkActions = React.useCallback(
    (selectedIds: string[]) =>
      bulkActions ? (
        <ResourceBulkActions
          {...bulkActions}
          selectedIds={selectedIds}
          testIdPrefix={tableTestIdPrefix}
          onSuccess={handleBulkActionSuccess}
          onBatchResultReadbackChange={handleBatchResultReadbackChange}
          renderBatchResultReadback={false}
        />
      ) : null,
    [bulkActions, handleBulkActionSuccess, handleBatchResultReadbackChange, tableTestIdPrefix]
  );

  // ---------------------------------------------------------------------------
  // Hybrid mode: client-side data fetching with React Query
  // ---------------------------------------------------------------------------

  const [querySort, setQuerySort] = React.useState(
    () => serverFetch?.initialSort ?? null
  );
  const [queryFilters, setQueryFilters] = React.useState(
    () => serverFetch?.initialFilters ?? null
  );
  const [queryLimit, setQueryLimit] = React.useState(
    () => serverFetch?.initialLimit ?? 50
  );
  const [queryOffset, setQueryOffset] = React.useState(
    () => serverFetch?.initialOffset ?? 0
  );

  const resourceKey = serverFetch?.resourceKey ?? "";

  const { data: queryData, isFetching, isError, error, refetch } = useResourceQuery({
    resourceKey,
    filters: queryFilters,
    sort: querySort,
    limit: queryLimit,
    offset: queryOffset,
    initialData: serverFetch?.initialList ?? undefined,
    enabled: hybridEnabled,
  });

  // Rows and pagination metadata must describe the same response, including
  // previous-page placeholder data while the next request is still loading.
  const displayedList = queryData ?? serverFetch?.initialList;
  const resolvedItems = hybridEnabled
    ? displayedList?.items ?? tableProps.items
    : tableProps.items;
  const resolvedTotal = hybridEnabled
    ? displayedList?.total ?? null
    : null;
  const resolvedTotalIsEstimate = hybridEnabled
    ? displayedList?.total_is_estimate ?? false
    : false;

  // Handle server navigation: parse params, update local state, sync URL
  const handleServerNavigate = React.useCallback(
    (href: string) => {
      if (!serverFetch) return;

      const params = parseHrefParams(href);
      const nextSort = parseSortFromParams(params);
      const nextLimit = parseIntParam(params, "limit", serverFetch.initialLimit);
      const nextOffset = parseIntParam(params, "offset", 0);
      const filtersParam = params.get("filters");

      // Update query state (triggers React Query refetch)
      setQuerySort(nextSort);
      setQueryLimit(nextLimit);
      setQueryOffset(nextOffset);

      // Handle filters: decode the filter tree or extract flat filters
      if (filtersParam) {
        const decodedTree = decodeFilterTree(filtersParam);
        if (decodedTree) {
          setQueryFilters(decodedTree as unknown as Record<string, unknown>);
        } else {
          setQueryFilters(serverFetch.initialFilters);
        }
      } else {
        // Check for flat filter params
        const flatFilters: Record<string, string> = {};
        params.forEach((value, key) => {
          if (
            key === "page" ||
            key === "offset" ||
            key === "limit" ||
            key === "sort" ||
            key === "direction" ||
            key === "view" ||
            key === "paging_mode" ||
            key === "filters" ||
            key === "id" ||
            key === "detail_open" ||
            key === "detail_layout"
          ) {
            return;
          }
          flatFilters[key] = value;
        });
        setQueryFilters(
          Object.keys(flatFilters).length > 0 ? flatFilters : null
        );
      }

      // Sync URL without triggering navigation.
      // The href has the base path stripped (for Next.js router), so use
      // window.location.pathname to preserve the full browser path.
      if (typeof window !== "undefined") {
        const qIndex = href.indexOf("?");
        const search = qIndex >= 0 ? href.substring(qIndex) : "";
        window.history.replaceState(
          window.history.state,
          "",
          window.location.pathname + search
        );
      }
    },
    [serverFetch]
  );

  // Handle client-side page changes from the pagination bar
  const handlePageChange = React.useCallback(
    (_page: number, offset: number) => {
      if (!serverFetch) return;
      setQueryOffset(offset);

      // Sync URL
      if (typeof window !== "undefined") {
        const url = new URL(window.location.href);
        url.searchParams.set("page", String(_page));
        url.searchParams.set("offset", String(offset));
        window.history.replaceState(window.history.state, "", url.pathname + url.search);
      }
    },
    [serverFetch]
  );

  if (hybridEnabled && isError && !queryData) {
    return (
      <div role="alert">
        <ErrorState
          error={error}
          variant="inline"
          onAction={() => { void refetch(); }}
          testId={tableTestIdPrefix ? `${tableTestIdPrefix}-fetch-error` : undefined}
        />
      </div>
    );
  }

  return (
    <>
      <div className="relative">
        {hybridEnabled && isFetching ? (
          <div className="pointer-events-none absolute inset-0 z-10 flex items-start justify-center pt-16">
            <div className="h-1 w-24 animate-pulse rounded-full bg-ui-accent/30" />
          </div>
        ) : null}
        <ResourceTable
          {...tableProps}
          items={resolvedItems}
          renderBulkActions={bulkActions ? renderBulkActions : undefined}
          onServerNavigate={hybridEnabled ? handleServerNavigate : undefined}
        />
        {batchResultReadback ? (
          <div className="mt-3">
            <BulkActionResultReadback result={batchResultReadback}
              testId={tableTestIdPrefix ? `${tableTestIdPrefix}-bulk-actions-result` : "bulk-action-result"} />
          </div>
        ) : null}
      </div>
      {hybridEnabled && !tableProps.clientPagination ? (
        <ClientPaginationBar
          limit={displayedList?.limit ?? queryLimit}
          offset={displayedList?.offset ?? queryOffset}
          total={resolvedTotal ?? null}
          totalIsEstimate={resolvedTotalIsEstimate}
          itemsCount={resolvedItems.length}
          onPageChange={handlePageChange}
          testIdPrefix={tableProps.testIdPrefix}
        />
      ) : null}
    </>
  );
}
