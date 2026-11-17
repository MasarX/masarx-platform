"use client";

import * as React from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import type { UiReadFilter } from "@masarx/api";
import { getUiDefaults } from "@masarx/config";
import { hasCapability, resolveCapabilitySet } from "./capabilities";
import { formatResourceSearchValue } from "./resource-utils";
import {
  normalizeFilterNode,
  flattenSearchParams,
  resolveFilterKeys,
  type FilterGroup,
  type SearchParams,
} from "./resource-query";
import { buildHref } from "./url";
import { openTrustedInNewTab, resolveSafeAppBasePath } from "./url-guard";
import { stripBasePath } from "./navigation-paths";
import { Button } from "./button";
import {
  resolveColumnLabel,
  resolveColumnLabelByKey,
  type ResourceColumn,
} from "./table/columns";
import {
  computePageMetrics,
  formatMetricValue,
  formatPercentValue,
  type AggregationType,
  type ColumnMetric,
  type ResourceMetrics,
} from "./table/metrics";
import { normalizeGroupBy } from "./table/grouping";
import {
  compareValues,
  normalizeDebounceOptions,
  normalizeSortState,
  resolveActiveView,
  resolveCellDisplay,
  useDebouncedValue,
} from "./table/resource-table-utils";
import { TableColumnPanel } from "./table/column-panel";
import { TableDataRow } from "./table/data-row";
import type { RowDensity } from "./table/density";
import {
  buildRowHrefForDetailOpenMode,
  normalizeDetailOpenMode,
  type DetailOpenMode,
} from "./table/open-mode";
import { TableDetailRow } from "./table/detail-row";
import { TableGroupingPanel } from "./table/grouping-panel";
import { TableGroupRow } from "./table/group-row";
import { moveItem } from "./table/list-utils";
import { useTableColumns } from "./table/table-columns";
import { useTableSelection } from "./table/table-selection";
import { TableSelectionBar } from "./table/selection-bar";
const TableExportPanel = React.lazy(() =>
  import("./table/export-panel").then((mod) => ({ default: mod.TableExportPanel }))
);
import { TableFilterPanel } from "./table/filter-panel";
import { TableSortPanel } from "./table/sort-panel";
import { buildScopeMeta, reportUiEvent, resolveScopeDigest } from "./reporting";
import { useTableExport } from "./table/table-export";
import { useTableRows } from "./table/table-rows";
import {
  useTablePagination,
  type ClientPaginationConfig,
} from "./table/table-pagination";
import {
  filterColumnsByLabel,
  resolveActiveFilterCount,
} from "./table/table-filters";
import { useInlineEdit } from "./table/table-inline-edit";
import {
  TableContextMenu,
  type ContextMenuAction,
  type ContextMenuState,
} from "./table/table-context-menu";
const ConditionalFormattingPanel = React.lazy(() =>
  import("./table/conditional-formatting-panel").then((mod) => ({ default: mod.ConditionalFormattingPanel }))
);
import { useTableViews } from "./table/table-view-actions";
import {
  readDetailOpenMode,
  persistDetailOpenMode,
  subscribeDetailOpenModeChange,
} from "./detail/detail-preferences";
import { TableToolbar } from "./table/toolbar";
import type { ColumnMenuAction } from "./table/column-header-menu";
import type { ChipItem } from "./table/filter-chips";
import {
  TableViewBar,
  type TablePanelKey,
  type ViewMenuAction,
} from "./table/view-bar";
import { TableViewport } from "./table/viewport";
import { TableViewPanel } from "./table/view-panel";
import type { ResourceViewEntry, ResourceViewState } from "./table/view-types";
import type { SortDirection, SortInput, SortState } from "./table/sorting";
import { buildEditConfigByKey } from "./table/edit-config";
import {
  buildViewPayload,
  areViewSettingsEqual,
  viewSettingsFromEntry,
  viewSettingsFromPayload,
} from "./table/table-views";

export type { ResourceColumn } from "./table/columns";
import { useToast } from "./use-toast";

const uiDefaults = getUiDefaults();
const tableDefaults = uiDefaults.table;

type ResourceTableProps = {
  columns: ResourceColumn[];
  items: Record<string, unknown>[];
  idKey?: string | null;
  baseHref?: string | null;
  appBasePath?: string | null;
  emptyMessage?: string | null;
  defaultSort?: SortState | SortState[] | null;
  viewState?: ResourceViewState | null;
  filters?: UiReadFilter[] | null;
  filterOperatorLabels?: Record<string, string> | null;
  filterOperatorKeys?: string[] | null;
  serverPageSizes?: number[] | null;
  resourceKey?: string | null;
  capabilities?: string[] | null;
  capabilityWrite?: string | null;
  enableSelection?: boolean;
  renderBulkActions?: (selectedIds: string[]) => React.ReactNode;
  onSelectionChange?: (selectedIds: string[]) => void;
  testIdPrefix?: string | null;
  datasetMetrics?: ResourceMetrics | null;
  showAnalytics?: boolean;
  clientPagination?: ClientPaginationConfig | null;
  onCreateRow?: () => void;
  toolbarAction?: React.ReactNode;
  /**
   * When provided, called instead of router.replace() for server-mode table
   * interactions (sort, filter, page size, pagination mode). This allows the
   * parent to handle data fetching client-side and update the URL via
   * history.replaceState() instead of triggering full-page navigation.
   */
  onServerNavigate?: (href: string) => void;
};

/**
 * Resource table with sorting, filtering, grouping, views, and inline editing.
 */
export function ResourceTable({
  columns,
  items,
  idKey,
  baseHref,
  appBasePath,
  emptyMessage,
  defaultSort,
  viewState,
  filters,
  filterOperatorLabels,
  filterOperatorKeys,
  serverPageSizes,
  resourceKey,
  capabilities,
  capabilityWrite,
  enableSelection,
  renderBulkActions,
  onSelectionChange,
  testIdPrefix,
  datasetMetrics,
  showAnalytics,
  clientPagination,
  onCreateRow,
  toolbarAction,
  onServerNavigate,
}: ResourceTableProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const navigateReplace = React.useMemo(
    () => onServerNavigate ?? ((href: string) => router.replace(href)),
    [onServerNavigate, router]
  );
  const effectiveRouter = React.useMemo(
    () => (onServerNavigate ? { replace: onServerNavigate } : router),
    [onServerNavigate, router]
  );
  const searchParamString = searchParams.toString();
  const searchParamsRecord = React.useMemo<SearchParams>(() => {
    const record: SearchParams = {};
    const params = new URLSearchParams(searchParamString);
    params.forEach((value, key) => {
      const existing = record[key];
      if (existing === undefined) {
        record[key] = value;
        return;
      }
      record[key] = Array.isArray(existing)
        ? [...existing, value]
        : [existing, value];
    });
    return record;
  }, [searchParamString]);
  const filterKeys = React.useMemo(
    () => resolveFilterKeys(filters),
    [filters]
  );
  const safeBasePath = React.useMemo(
    () => resolveSafeAppBasePath(appBasePath ?? ""),
    [appBasePath]
  );
  const routerBaseHref = React.useMemo(
    () =>
      baseHref ? stripBasePath(baseHref, safeBasePath ?? undefined) : null,
    [baseHref, safeBasePath]
  );
  const t = useTranslations("ui.resourceTable");
  const scopeMeta = React.useMemo(
    () =>
      buildScopeMeta({
        settingsResolutionId: viewState?.settingsResolutionId,
        scopeType: viewState?.scopeType,
        scopeId: viewState?.scopeId,
        scopeValue: viewState?.scopeValue,
      }),
    [
      viewState?.scopeId,
      viewState?.scopeType,
      viewState?.scopeValue,
      viewState?.settingsResolutionId,
    ]
  );
  const scopeDigest = React.useMemo(
    () =>
      resolveScopeDigest({
        settingsResolutionId: viewState?.settingsResolutionId,
      }),
    [viewState?.settingsResolutionId]
  );
  const reportTableEvent = React.useCallback(
    (type: string, name?: string, message?: string) => {
      reportUiEvent({
        type,
        timestamp: new Date().toISOString(),
        context: resourceKey ?? undefined,
        name,
        message,
        digest: scopeDigest,
        meta: scopeMeta,
      });
    },
    [resourceKey, scopeDigest, scopeMeta]
  );
  const { toast } = useToast();
  const [activePanel, setActivePanel] = React.useState<TablePanelKey | null>(
    null
  );
  const [editPending, startEditTransition] = React.useTransition();
  const [rowOverrides, setRowOverrides] = React.useState<
    Record<string, Record<string, unknown>>
  >(() => ({}));
  const selectAllRef = React.useRef<HTMLInputElement | null>(null);
  const [columnFilter, setColumnFilter] = React.useState("");
  const groupLabels = React.useMemo(
    () => ({ empty: t("group.empty"), all: t("group.all") }),
    [t]
  );
  const capabilitySet = React.useMemo(
    () => resolveCapabilitySet(capabilities),
    [capabilities]
  );
  const resolvedResourceKey =
    typeof resourceKey === "string" && resourceKey.trim()
      ? resourceKey.trim()
      : null;
  const resolvedCapabilityWrite =
    typeof capabilityWrite === "string" && capabilityWrite.trim()
      ? capabilityWrite.trim()
      : null;
  const canWrite =
    !resolvedCapabilityWrite || hasCapability(capabilitySet, resolvedCapabilityWrite);

  const viewEntries = React.useMemo(
    () => viewState?.views ?? [],
    [viewState?.views]
  );
  const activeView = React.useMemo(
    () => resolveActiveView(viewEntries, viewState?.activeViewId ?? null),
    [viewEntries, viewState?.activeViewId]
  );
  const initialFilterTree = React.useMemo<FilterGroup | null>(() => {
    const normalized = normalizeFilterNode(viewState?.activeFilters ?? null);
    return normalized && normalized.type === "group" ? normalized : null;
  }, [viewState?.activeFilters]);
  const columnKeys = React.useMemo(
    () => columns.map((column) => column.key),
    [columns]
  );
  const columnSignature = React.useMemo(
    () => columnKeys.join("|"),
    [columnKeys]
  );
  const resolvedItems = React.useMemo(() => {
    if (!idKey || Object.keys(rowOverrides).length === 0) return items;
    return items.map((item) => {
      const rawId = item[idKey];
      if (rawId === null || rawId === undefined) return item;
      const override = rowOverrides[String(rawId)];
      return override ? { ...item, ...override } : item;
    });
  }, [items, rowOverrides, idKey]);
  const [searchTerm, setSearchTerm] = React.useState("");
  const [rowDensity, setRowDensity] = React.useState<RowDensity>(() =>
    activeView?.density === "comfortable" ? "comfortable" : "compact"
  );
  const [detailOpenMode, setDetailOpenModeRaw] = React.useState<DetailOpenMode>(() => {
    const persisted = resolvedResourceKey ? readDetailOpenMode(resolvedResourceKey) : null;
    return normalizeDetailOpenMode(persisted ?? activeView?.open_mode ?? null);
  });
  const setDetailOpenMode = React.useCallback(
    (next: DetailOpenMode) => {
      setDetailOpenModeRaw(next);
      if (resolvedResourceKey) {
        persistDetailOpenMode(resolvedResourceKey, next);
      }
    },
    [resolvedResourceKey]
  );
  React.useEffect(() => {
    if (!resolvedResourceKey) return undefined;
    return subscribeDetailOpenModeChange(resolvedResourceKey, (mode) => {
      setDetailOpenModeRaw(normalizeDetailOpenMode(mode));
    });
  }, [resolvedResourceKey]);
  const [showRowNumbers, setShowRowNumbers] = React.useState<boolean>(() => {
    if (typeof activeView?.show_row_numbers === "boolean") {
      return activeView.show_row_numbers;
    }
    return false;
  });
  const [conditionalFormatting, setConditionalFormatting] = React.useState(
    () => activeView?.conditional_formatting ?? null
  );
  const [columnAggregations, setColumnAggregations] = React.useState<
    Record<string, AggregationType>
  >({});
  const handleSelectAggregation = React.useCallback(
    (columnKey: string, aggregation: AggregationType) => {
      setColumnAggregations((prev) => ({ ...prev, [columnKey]: aggregation }));
    },
    []
  );
  const [contextMenu, setContextMenu] = React.useState<ContextMenuState>(null);
  const [showInternalIdHints, setShowInternalIdHints] = React.useState<boolean>(() => {
    if (typeof activeView?.show_internal_id_hints === "boolean") {
      return activeView.show_internal_id_hints;
    }
    return uiDefaults.table.showInternalIdHints;
  });
  const resolveRowHref = React.useCallback(
    (rowId: string) => {
      return buildRowHrefForDetailOpenMode({
        baseHref,
        searchParamString,
        rowId,
        openMode: detailOpenMode,
        resourceKey: resolvedResourceKey,
      });
    },
    [baseHref, searchParamString, detailOpenMode, resolvedResourceKey]
  );
  const analyticsPreference =
    typeof showAnalytics === "boolean" ? showAnalytics : activeView?.analytics;
  const [analyticsEnabled, setAnalyticsEnabled] = React.useState<boolean>(
    () => analyticsPreference ?? true
  );
  const summaryRowPreference =
    typeof activeView?.summary_row === "boolean" ? activeView.summary_row : true;
  const [summaryRowEnabled, setSummaryRowEnabled] = React.useState<boolean>(
    () => summaryRowPreference
  );
  const [sortState, setSortState] = React.useState<SortState[]>(() =>
    normalizeSortState(
      viewState?.activeSort ?? activeView?.sort ?? defaultSort ?? null
    )
  );
  const [groupBy, setGroupBy] = React.useState<string[]>(
    () => normalizeGroupBy(activeView?.group_by, columnKeys)
  );
  const selectionEnabled = Boolean(idKey) && (enableSelection ?? true);
  const tableContainerRef = React.useRef<HTMLDivElement | null>(null);
  const selectHeaderRef = React.useRef<HTMLTableHeaderCellElement | null>(null);
  const panelIdPrefixRaw = React.useId();
  const panelIdPrefix = React.useMemo(() => {
    const normalized = panelIdPrefixRaw.replace(/[^a-zA-Z0-9_-]/g, "");
    return normalized ? `table-panel-${normalized}` : "table-panel";
  }, [panelIdPrefixRaw]);
  const tableTestIdPrefix = testIdPrefix?.trim()
    ? `${testIdPrefix}-table`
    : undefined;
  const {
    initialColumns,
    columnOrder,
    setColumnOrder,
    visibleColumns,
    setVisibleColumns,
    pinnedColumns,
    setPinnedColumns,
    columnWidths,
    setColumnWidths,
    columnsByKey,
    orderedColumns,
    activeColumns,
    displayColumns,
    detailColumns,
    pinnedSet,
    draggingColumn,
    dragOverColumn,
    handleColumnDragStart,
    handleColumnDragOver,
    handleColumnDrop,
    handleColumnDragEnd,
    handleMoveColumn,
    updateColumnWidth,
    toggleColumn,
    togglePin,
    registerHeaderRef,
    pinnedOffsets,
    resizeGuide,
    handleResizeStart,
    handleResizeKey,
  } = useTableColumns({
    columns,
    columnKeys,
    activeView,
    selectionEnabled,
    selectHeaderRef,
    tableContainerRef,
    minColumnWidth: tableDefaults.minColumnWidth,
    defaultColumnWidth: tableDefaults.defaultColumnWidth,
    resizeStep: tableDefaults.resizeStep,
    resizeStepLarge: tableDefaults.resizeStepLarge,
  });
  const metricColumns = React.useMemo(() => {
    const enabled = activeColumns.filter((column) => column.aggregation?.enabled);
    return enabled.length > 0 ? enabled : activeColumns;
  }, [activeColumns]);
  const inlineEditEnabled = Boolean(resolvedResourceKey && idKey && canWrite);
  const editConfigByKey = React.useMemo(
    () => buildEditConfigByKey(columns, inlineEditEnabled, capabilitySet),
    [columns, inlineEditEnabled, capabilitySet]
  );
  const {
    inlineEdit,
    startInlineEdit,
    updateInlineEditValue,
    cancelInlineEdit,
    commitInlineEdit,
  } = useInlineEdit({
    editConfigByKey,
    inlineEditEnabled,
    columnsByKey,
    resolvedResourceKey: resolvedResourceKey ?? null,
    resolvedItems,
    idKey: idKey ?? null,
    t,
    toast,
    startTransition: startEditTransition,
    setRowOverrides,
  });
  const searchDebounceOptions = React.useMemo(() => {
    const fallback = clientPagination?.searchDebounceMs ?? 0;
    const viewValue = Number(activeView?.search_debounce_ms);
    const raw = normalizeDebounceOptions(
      clientPagination?.searchDebounceOptions
    );
    const merged = raw.length > 0 ? raw : [fallback];
    if (Number.isFinite(viewValue) && viewValue >= 0) merged.push(viewValue);
    if (!merged.includes(fallback)) merged.push(fallback);
    return normalizeDebounceOptions(merged);
  }, [
    activeView?.search_debounce_ms,
    clientPagination?.searchDebounceOptions,
    clientPagination?.searchDebounceMs,
  ]);
  const defaultSearchDebounceMs = React.useMemo(() => {
    const fallback = clientPagination?.searchDebounceMs ?? 0;
    const candidate = Number(activeView?.search_debounce_ms ?? fallback);
    if (!Number.isFinite(candidate) || candidate < 0) return fallback;
    if (searchDebounceOptions.includes(candidate)) return candidate;
    return fallback;
  }, [
    activeView?.search_debounce_ms,
    clientPagination?.searchDebounceMs,
    searchDebounceOptions,
  ]);
  const [searchDebounceMs, setSearchDebounceMs] = React.useState(
    () => defaultSearchDebounceMs
  );

  React.useEffect(() => {
    setSearchDebounceMs(defaultSearchDebounceMs);
  }, [defaultSearchDebounceMs]);
  const activeFilterCount = React.useMemo(
    () => resolveActiveFilterCount(viewState?.activeFilters ?? null),
    [viewState?.activeFilters]
  );
  const clearFilters = React.useCallback(() => {
    if (!routerBaseHref) return;
    const nextParams = new URLSearchParams();
    flattenSearchParams(searchParamsRecord).forEach(([key, value]) => {
      if (key === "page" || key === "offset" || key === "filters") return;
      if (filterKeys.has(key)) return;
      nextParams.append(key, value);
    });
    nextParams.set("page", "1");
    nextParams.set("offset", "0");
    navigateReplace(buildHref(routerBaseHref, nextParams));
    reportTableEvent("ui.table.filter.clear", "toolbar");
  }, [
    filterKeys,
    reportTableEvent,
    routerBaseHref,
    navigateReplace,
    searchParamsRecord,
  ]);
  const handleFilterApply = React.useCallback(
    (payload: { encoded: string | null; ruleCount: number }) => {
      reportTableEvent(
        "ui.table.filter.apply",
        payload.encoded ? "tree" : "flat",
        String(payload.ruleCount)
      );
    },
    [reportTableEvent]
  );
  const handleFilterClear = React.useCallback(() => {
    reportTableEvent("ui.table.filter.clear", "panel");
  }, [reportTableEvent]);

  const cellPadding = rowDensity === "compact" ? "px-3 py-2" : "px-4 py-2.5";
  const resolveCellDisplayForTable = React.useCallback(
    (item: Record<string, unknown>, column: ResourceColumn) =>
      resolveCellDisplay(
        item,
        column,
        tableDefaults.truncateLength,
        uiDefaults.resourceLabelKeys,
        uiDefaults.resourceDescriptorKeys,
        showInternalIdHints
      ),
    [
      tableDefaults.truncateLength,
      uiDefaults.resourceLabelKeys,
      uiDefaults.resourceDescriptorKeys,
      showInternalIdHints,
    ]
  );

  const debouncedSearchTerm = useDebouncedValue(searchTerm, searchDebounceMs);
  const normalizedSearch = debouncedSearchTerm.trim().toLowerCase();
  const sortSignature = React.useMemo(
    () => sortState.map((entry) => `${entry.key}:${entry.direction}`).join("|"),
    [sortState]
  );
  const searchIndex = React.useMemo(() => {
    if (!activeColumns.length) return null;
    return resolvedItems.map((item) =>
      activeColumns
        .map((column) =>
          formatResourceSearchValue(item[column.key] ?? "", {
            renderType: column.renderType ?? null,
            formatOptions: column.formatOptions ?? null,
          }).toLowerCase()
        )
        .join("\n")
    );
  }, [resolvedItems, activeColumns]);
  const filteredItems = React.useMemo(() => {
    if (!normalizedSearch) return resolvedItems;
    if (!searchIndex) return resolvedItems;
    return resolvedItems.filter((_item, index) =>
      (searchIndex[index] ?? "").includes(normalizedSearch)
    );
  }, [normalizedSearch, resolvedItems, searchIndex]);

  const resolvedGroupBy = React.useMemo(
    () => groupBy.filter((key) => columnKeys.includes(key)),
    [groupBy, columnKeys]
  );

  const groupLabel = React.useMemo(() => {
    if (resolvedGroupBy.length === 0) return null;
    return resolvedGroupBy
      .map((key) => resolveColumnLabelByKey(columnsByKey, key))
      .join(" > ");
  }, [columnsByKey, resolvedGroupBy]);

  const sortedItems = React.useMemo(() => {
    if (sortState.length === 0) return filteredItems;
    const next = [...filteredItems];
    next.sort((a, b) => {
      for (const sort of sortState) {
        const result = compareValues(a[sort.key], b[sort.key], sort.direction);
        if (result !== 0) return result;
      }
      return 0;
    });
    return next;
  }, [filteredItems, sortSignature]);

  const {
    paginationModeOptions,
    paginationMode,
    handlePaginationModeChange,
    clientPaginationEnabled,
    clientPageSize,
    handleClientPageSizeChange,
    resolvedClientPageSizes,
    resolvedClientPage,
    totalClientPages,
    showPageControls,
    canPageBack,
    canPageForward,
    pageInput,
    handlePageInputChange,
    resetPageInput,
    goToFirstPage,
    goToPrevPage,
    goToNextPage,
    goToLastPage,
    pageStartLabel,
    pageEndLabel,
    pagedItems,
    resetPagination,
  } = useTablePagination({
    clientPagination: clientPagination ?? null,
    activeView,
    viewState: viewState ?? null,
    baseHref: routerBaseHref,
    router: effectiveRouter,
    searchParams,
    sortedItems,
    normalizedSearch,
    sortSignature,
    activeFilters: viewState?.activeFilters ?? null,
  });
  const clearSearch = React.useCallback(() => {
    setSearchTerm("");
    resetPagination();
    reportTableEvent("ui.table.search.clear", "empty_state");
  }, [reportTableEvent, resetPagination]);
  const openColumnsPanel = React.useCallback(() => {
    setActivePanel("properties");
    reportTableEvent("ui.table.columns.open", "empty_state");
  }, [reportTableEvent]);
  const showAllColumns = React.useCallback(() => {
    if (columnOrder.length === 0) return;
    setVisibleColumns(new Set(columnOrder));
    reportTableEvent("ui.table.columns.show_all", String(columnOrder.length));
  }, [columnOrder, reportTableEvent, setVisibleColumns]);
  const hideAllColumns = React.useCallback(() => {
    const firstColumn = columnOrder[0];
    if (!firstColumn) return;
    setVisibleColumns(new Set([firstColumn]));
    reportTableEvent("ui.table.columns.hide_all", String(columnOrder.length));
  }, [columnOrder, reportTableEvent, setVisibleColumns]);
  const resolvedServerPageSizes = React.useMemo(() => {
    const normalized = Array.isArray(serverPageSizes)
      ? serverPageSizes
          .map((entry) => Number(entry))
          .filter((entry) => Number.isFinite(entry) && entry > 0)
      : [];
    const fallbackSizes =
      normalized.length > 0
        ? [...normalized]
        : [...uiDefaults.pagination.allowedPageSizes];
    const fallbackSize =
      viewState?.pageSize ?? uiDefaults.pagination.defaultPageSize ?? null;
    if (fallbackSize && !fallbackSizes.includes(fallbackSize)) {
      fallbackSizes.push(fallbackSize);
    }
    return Array.from(new Set(fallbackSizes)).sort((a, b) => a - b);
  }, [serverPageSizes, viewState?.pageSize]);
  const serverPageSize =
    viewState?.pageSize ?? resolvedServerPageSizes[0] ?? null;
  const resolvedPageSize =
    paginationMode === "client" ? clientPageSize : serverPageSize;
  const resolvedPageSizeOptions =
    paginationMode === "client"
      ? resolvedClientPageSizes
      : resolvedServerPageSizes;
  // When onServerNavigate is provided, useSearchParams() can become stale
  // after history.replaceState(). Read from the live browser URL instead.
  const getLiveSearchString = React.useCallback(() => {
    if (onServerNavigate && typeof window !== "undefined") {
      return window.location.search.replace(/^\?/, "");
    }
    return searchParamString;
  }, [onServerNavigate, searchParamString]);

  const handlePageSizeChange = React.useCallback(
    (value: number) => {
      if (!Number.isFinite(value) || value <= 0) return;
      if (paginationMode === "client") {
        handleClientPageSizeChange(value);
        return;
      }
      if (!routerBaseHref) return;
      const params = new URLSearchParams(getLiveSearchString());
      params.set("limit", String(value));
      params.set("page", "1");
      params.set("offset", "0");
      navigateReplace(buildHref(routerBaseHref, params));
    },
    [
      paginationMode,
      handleClientPageSizeChange,
      routerBaseHref,
      getLiveSearchString,
      navigateReplace,
    ]
  );
  const syncSortToUrl = React.useCallback(
    (nextSortState: SortState[]) => {
      if (!routerBaseHref || paginationMode !== "server") return;
      const params = new URLSearchParams(getLiveSearchString());
      params.set("page", "1");
      params.set("offset", "0");
      if (nextSortState.length === 0) {
        params.delete("sort");
        params.delete("direction");
      } else {
        const primary = nextSortState[0];
        if (!primary) return;
        params.set("sort", primary.key);
        params.set("direction", primary.direction);
      }
      navigateReplace(buildHref(routerBaseHref, params));
    },
    [paginationMode, routerBaseHref, getLiveSearchString, navigateReplace]
  );

  const rowHeights = React.useMemo(
    () => ({
      base:
        rowDensity === "compact"
          ? tableDefaults.rowHeightCompact
          : tableDefaults.rowHeightComfortable,
      group:
        rowDensity === "compact"
          ? tableDefaults.groupRowHeightCompact
          : tableDefaults.groupRowHeightComfortable,
      detail:
        rowDensity === "compact"
          ? tableDefaults.detailRowHeightCompact
          : tableDefaults.detailRowHeightComfortable,
    }),
    [rowDensity]
  );
  const {
    displayRows,
    rowsToRender,
    paddingTop,
    paddingBottom,
    groupIds,
    collapsedGroups,
    expandedRowIds,
    resolveRowKey,
    toggleGroupCollapse,
    collapseAllGroups,
    expandAllGroups,
    toggleRowExpanded,
    resetRowState,
  } = useTableRows({
    pagedItems,
    resolvedGroupBy,
    analyticsEnabled,
    activeColumns: metricColumns,
    groupLabels,
    idKey: idKey ?? null,
    rowHeights,
    tableContainerRef,
    overscan: tableDefaults.virtualizationOverscan,
  });
  const handleGroupCollapseToggle = React.useCallback(
    (groupId: string) => {
      toggleGroupCollapse(groupId);
      reportTableEvent("ui.table.group.collapse.toggle", groupId);
    },
    [reportTableEvent, toggleGroupCollapse]
  );
  const handleGroupCollapseAll = React.useCallback(() => {
    collapseAllGroups();
    reportTableEvent("ui.table.group.collapse_all");
  }, [collapseAllGroups, reportTableEvent]);
  const handleGroupExpandAll = React.useCallback(() => {
    expandAllGroups();
    reportTableEvent("ui.table.group.expand_all");
  }, [expandAllGroups, reportTableEvent]);
  const {
    selectedIds,
    selectedIdList,
    selectedCount,
    allSelected,
    toggleAllSelection,
    handleRowSelection,
    clearSelection,
  } = useTableSelection({
    idKey: idKey ?? null,
    selectionEnabled,
    pagedItems,
    displayRows,
    selectAllRef,
    onSelectionChange,
  });
  const handleClearSelection = React.useCallback(() => {
    clearSelection();
    reportTableEvent("ui.table.selection.clear", String(selectedCount));
  }, [clearSelection, reportTableEvent, selectedCount]);
  const activeViewId = activeView?.id ?? viewState?.activeViewId ?? null;
  React.useEffect(() => {
    if (typeof showAnalytics === "boolean") {
      setAnalyticsEnabled(showAnalytics);
    } else {
      setAnalyticsEnabled(activeView?.analytics ?? true);
    }
    setSummaryRowEnabled(
      typeof activeView?.summary_row === "boolean"
        ? activeView.summary_row
        : true
    );
  }, [activeViewId, showAnalytics, activeView?.analytics, activeView?.summary_row]);
  React.useEffect(() => {
    resetRowState();
  }, [columnSignature, activeViewId, showAnalytics, resetRowState]);

  const pageMetrics = React.useMemo(() => {
    if (!analyticsEnabled) {
      return {
        total: pagedItems.length,
        columns: {} as Record<string, ColumnMetric>,
      };
    }
    return computePageMetrics(pagedItems, metricColumns);
  }, [analyticsEnabled, pagedItems, metricColumns]);
  const selectedItems = React.useMemo(() => {
    if (!selectionEnabled || selectedIds.size === 0 || !idKey) return [];
    return pagedItems.filter((item) => {
      const raw = item[idKey];
      if (raw === null || raw === undefined) return false;
      return selectedIds.has(String(raw));
    });
  }, [selectionEnabled, selectedIds, pagedItems, idKey]);
  const selectedMetrics = React.useMemo(() => {
    if (!analyticsEnabled || selectedItems.length === 0) return null;
    return computePageMetrics(selectedItems, metricColumns);
  }, [analyticsEnabled, selectedItems, metricColumns]);
  const numericColumnSet = React.useMemo(() => {
    const pageKeys = Object.keys(pageMetrics.columns);
    const datasetKeys = datasetMetrics ? Object.keys(datasetMetrics.columns) : [];
    return new Set([...pageKeys, ...datasetKeys]);
  }, [pageMetrics.columns, datasetMetrics]);
  const metricKeys = React.useMemo(
    () =>
      metricColumns
        .map((column) => column.key)
        .filter((key) => numericColumnSet.has(key)),
    [metricColumns, numericColumnSet]
  );
  const selectedMetricKeys = React.useMemo(
    () => (selectedMetrics ? Object.keys(selectedMetrics.columns).sort() : []),
    [selectedMetrics]
  );
  const showSummaryRow =
    analyticsEnabled &&
    summaryRowEnabled &&
    resolvedGroupBy.length === 0 &&
    metricKeys.length > 0;
  const pageShareLabel =
    datasetMetrics && datasetMetrics.total > 0
      ? formatPercentValue((pageMetrics.total / datasetMetrics.total) * 100)
      : null;
  const selectedShareLabel =
    datasetMetrics && selectedMetrics && datasetMetrics.total > 0
      ? formatPercentValue(
          (selectedMetrics.total / datasetMetrics.total) * 100
        )
      : null;

  const filteredColumns = React.useMemo(
    () => filterColumnsByLabel(orderedColumns, columnFilter, resolveColumnLabel),
    [orderedColumns, columnFilter]
  );

  const addGroupKey = (key: string) => {
    setGroupBy((current) => {
      if (!key || current.includes(key)) return current;
      return [...current, key];
    });
    reportTableEvent("ui.table.group.add", key);
  };
  const removeGroupKey = (key: string) => {
    setGroupBy((current) => current.filter((entry) => entry !== key));
    reportTableEvent("ui.table.group.remove", key);
  };
  const moveGroupKey = (key: string, delta: number) => {
    setGroupBy((current) => {
      const index = current.indexOf(key);
      if (index < 0) return current;
      const nextIndex = Math.max(0, Math.min(current.length - 1, index + delta));
      return moveItem(current, index, nextIndex);
    });
    reportTableEvent("ui.table.group.move", key, String(delta));
  };
  const clearGroupBy = React.useCallback(() => {
    setGroupBy([]);
    reportTableEvent("ui.table.group.clear");
  }, [reportTableEvent]);

  const resetView = () => {
    setColumnOrder(initialColumns.ordered);
    setVisibleColumns(initialColumns.visible);
    setPinnedColumns(initialColumns.pinned);
    setColumnWidths(initialColumns.widths);
    setSortState(
      normalizeSortState(
        activeView?.sort ?? viewState?.activeSort ?? defaultSort ?? null
      )
    );
    setGroupBy(normalizeGroupBy(activeView?.group_by, columnKeys));
    setRowDensity(activeView?.density === "comfortable" ? "comfortable" : "compact");
    setDetailOpenModeRaw(normalizeDetailOpenMode(activeView?.open_mode ?? null));
    setShowRowNumbers(
      typeof activeView?.show_row_numbers === "boolean"
        ? activeView.show_row_numbers
        : false
    );
    setShowInternalIdHints(
      typeof activeView?.show_internal_id_hints === "boolean"
        ? activeView.show_internal_id_hints
        : uiDefaults.table.showInternalIdHints
    );
    resetRowState();
    setSearchDebounceMs(defaultSearchDebounceMs);
    resetPagination();
    if (typeof showAnalytics === "boolean") {
      setAnalyticsEnabled(showAnalytics);
    } else {
      setAnalyticsEnabled(activeView?.analytics ?? true);
    }
    setSummaryRowEnabled(
      typeof activeView?.summary_row === "boolean"
        ? activeView.summary_row
        : true
    );
  };

  const sortUrlSyncPendingRef = React.useRef(false);
  const updateSortState = React.useCallback(
    (updater: (current: SortState[]) => SortState[]) => {
      sortUrlSyncPendingRef.current = true;
      setSortState((current) => updater(current));
    },
    []
  );
  React.useEffect(() => {
    if (!sortUrlSyncPendingRef.current) return;
    sortUrlSyncPendingRef.current = false;
    syncSortToUrl(sortState);
  }, [sortState, syncSortToUrl]);

  const handleSort = React.useCallback(
    (key: string, isMulti: boolean) => {
      updateSortState((current) => {
        const next = [...current];
        const existingIndex = next.findIndex((entry) => entry.key === key);
        if (!isMulti) {
          if (existingIndex < 0) {
            return [{ key, direction: "asc" }];
          }
          const existing = next[existingIndex];
          if (!existing) {
            return [{ key, direction: "asc" }];
          }
          const nextDirection = existing.direction === "asc" ? "desc" : "asc";
          return [{ key, direction: nextDirection }];
        }
        if (existingIndex < 0) {
          return [...next, { key, direction: "asc" }];
        }
        const existing = next[existingIndex];
        if (!existing) {
          return next;
        }
        const nextDirection = existing.direction === "asc" ? "desc" : null;
        if (!nextDirection) {
          return next.filter((entry) => entry.key !== key);
        }
        next[existingIndex] = { key, direction: nextDirection };
        return next;
      });
    },
    [updateSortState]
  );

  const handleSearchDebounceChange = (value: number) => {
    if (!Number.isFinite(value) || value < 0) return;
    if (!searchDebounceOptions.includes(value)) return;
    setSearchDebounceMs(value);
  };

  const columnCount = activeColumns.length + (selectionEnabled ? 1 : 0) + (showRowNumbers ? 1 : 0);
  const safeColumnCount = Math.max(columnCount, 1);
  const noColumnsSelected = activeColumns.length === 0;
  const hasGrouping = resolvedGroupBy.length > 0;
  const filteredCount = sortedItems.length;
  const totalCount = resolvedItems.length;
  const clientFilterActive = Boolean(normalizedSearch);
  const emptyAction = React.useMemo(() => {
    if (clientFilterActive) {
      return (
        <Button size="sm" variant="ghost" onClick={clearSearch}>
          {t("table.clearSearch")}
        </Button>
      );
    }
    if (activeFilterCount > 0) {
      return (
        <Button size="sm" variant="ghost" onClick={clearFilters}>
          {t("table.clearFilters")}
        </Button>
      );
    }
    return null;
  }, [activeFilterCount, clearFilters, clearSearch, clientFilterActive, t]);
  const noColumnsAction = React.useMemo(() => {
    if (columns.length === 0) return null;
    return (
      <Button size="sm" variant="ghost" onClick={openColumnsPanel}>
        {t("table.showColumns")}
      </Button>
    );
  }, [columns.length, openColumnsPanel, t]);
  const sortLabelParts = sortState.map((entry) => {
    const label = columnsByKey.has(entry.key)
      ? resolveColumnLabelByKey(columnsByKey, entry.key)
      : entry.key;
    const directionLabel =
      entry.direction === "asc"
        ? t("toolbar.directionAsc")
        : t("toolbar.directionDesc");
    return `${label} ${directionLabel}`;
  });
  const sortLabel = sortLabelParts.join(", ");
  const primarySort = sortState[0] ?? null;
  const primarySortLabel = primarySort
    ? columnsByKey.has(primarySort.key)
      ? resolveColumnLabelByKey(columnsByKey, primarySort.key)
      : primarySort.key
    : null;
  const primarySortDirectionLabel = primarySort
    ? primarySort.direction === "asc"
      ? t("toolbar.directionAsc")
      : t("toolbar.directionDesc")
    : null;
  const pageSummaryLabel = clientPaginationEnabled
    ? t("paging.summary", {
        start: pageStartLabel,
        end: pageEndLabel,
        total: filteredCount,
      })
    : null;
    const sortingLabel =
      sortState.length > 0
        ? sortState.length === 1 && primarySort
          ? t("toolbar.sorting", {
              label: primarySortLabel ?? primarySort.key,
              direction:
                primarySortDirectionLabel ??
                (primarySort.direction === "asc"
                  ? t("toolbar.directionAsc")
                  : t("toolbar.directionDesc")),
            })
          : t("toolbar.sortingMulti", { labels: sortLabel })
        : t("toolbar.sortingDefault");
  const groupingLabel = groupLabel
    ? t("toolbar.groupedBy", { label: groupLabel })
    : t("toolbar.noGrouping");
  const filtersLabel =
    activeFilterCount > 0
      ? t("toolbar.filters", { count: activeFilterCount })
      : t("toolbar.noFilters");
  const pinnedHeaderClass =
    "sticky z-20 bg-ui-highlight/40 shadow-[1px_0_0_0_var(--ui-border)]";
  const pinnedCellClass =
    "sticky z-10 bg-ui-paper shadow-[1px_0_0_0_var(--ui-border)]";
  const pinnedGroupClass =
    "sticky z-10 bg-ui-highlight/40 shadow-[1px_0_0_0_var(--ui-border)]";
  const availableGroupKeys = orderedColumns
    .map((column) => column.key)
    .filter((key) => !resolvedGroupBy.includes(key));
  const {
    exportDisabled,
    excelExportDisabled,
    metricsExportDisabled,
    onExportCsv,
    onExportExcel,
    onExportMetrics,
  } = useTableExport({
    t,
    sortedItems,
    displayColumns,
    metricKeys,
    pageMetrics,
    datasetMetrics: datasetMetrics ?? null,
    columnsByKey,
    resourceKey: viewState?.resourceKey ?? resolvedResourceKey ?? null,
  });
  const {
    viewSelectValue,
    canManageViews,
    saveDisabled,
    hasViews,
    viewScopeValue,
    settingsResolutionValue,
    saveOpen,
    deleteOpen,
    saveName,
    saveDefault,
    saveStatus,
    toggleSaveOpen,
    toggleDeleteOpen,
    setSaveName,
    setSaveDefault,
    handleViewChange,
    handleSaveView,
    handleDeleteView,
  } = useTableViews({
    t,
    toast,
    viewState: viewState ?? null,
    viewEntries,
    activeView,
    baseHref: routerBaseHref,
    router: effectiveRouter,
    searchParams,
    columnOrder,
    visibleColumns,
    pinnedColumns,
    columnWidths,
    rowDensity,
    openMode: detailOpenMode,
    showInternalIdHints,
    analyticsEnabled,
    summaryRowEnabled,
    sortState,
    resolvedGroupBy,
    paginationMode,
    searchDebounceMs,
    pageSize: viewState?.pageSize ?? null,
    conditionalFormatting,
  });
  const viewDirty = React.useMemo(() => {
    if (!activeView) return false;
    const payload = buildViewPayload({
      viewId: activeView.id ?? "current",
      label: activeView.label ?? t("views.labelFallback"),
      columnOrder,
      visibleColumns,
      pinnedColumns,
      columnWidths,
      rowDensity,
      openMode: detailOpenMode,
      showInternalIdHints,
      analyticsEnabled,
      summaryRowEnabled,
      activeFilters: viewState?.activeFilters ?? null,
      sortState,
      resolvedGroupBy,
      pageSize: viewState?.pageSize ?? null,
      paginationMode,
      searchDebounceMs,
      conditionalFormatting,
    });
    return !areViewSettingsEqual(
      viewSettingsFromEntry(activeView),
      viewSettingsFromPayload(payload)
    );
  }, [
    activeView,
    columnOrder,
    visibleColumns,
    pinnedColumns,
    columnWidths,
    rowDensity,
    detailOpenMode,
    showInternalIdHints,
    analyticsEnabled,
    summaryRowEnabled,
    viewState?.activeFilters,
    viewState?.pageSize,
    sortState,
    resolvedGroupBy,
    paginationMode,
    searchDebounceMs,
    conditionalFormatting,
    t,
  ]);
  const handlePanelToggle = React.useCallback(
    (panel: TablePanelKey) => {
      setActivePanel((current) => {
        const next = current === panel ? null : panel;
        reportTableEvent(
          "ui.table.panel.toggle",
          panel,
          next ? "open" : "close"
        );
        return next;
      });
    },
    [reportTableEvent]
  );
  const handleViewMenuAction = React.useCallback(
    (action: ViewMenuAction) => {
      if (!activeView) return;
      reportTableEvent(
        "ui.table.view.menu.action",
        action,
        activeView.label ?? activeView.id
      );
      setActivePanel("views");
      if (action === "delete") {
        if (!deleteOpen) toggleDeleteOpen();
        return;
      }
      if (action === "setDefault") {
        handleSaveView("update", {
          forceDefault: true,
          nameOverride: activeView.label ?? "",
        });
        return;
      }
      const defaultLabel = activeView.label ?? t("views.labelFallback");
      const nextLabel =
        action === "duplicate"
          ? t("views.duplicateLabel", { label: defaultLabel })
          : defaultLabel;
      if (!saveOpen) toggleSaveOpen();
      setSaveName(nextLabel);
      setSaveDefault(false);
    },
    [
      activeView,
      deleteOpen,
      handleSaveView,
      saveOpen,
      setSaveDefault,
      setSaveName,
      setActivePanel,
      t,
      toggleDeleteOpen,
      toggleSaveOpen,
    ]
  );
  const handleSortAdd = React.useCallback((key: string) => {
    if (!key) return;
    updateSortState((current) => [...current, { key, direction: "asc" }]);
    reportTableEvent("ui.table.sort.add", key);
  }, [reportTableEvent, updateSortState]);
  const handleSortRemove = React.useCallback((key: string) => {
    updateSortState((current) => current.filter((entry) => entry.key !== key));
    reportTableEvent("ui.table.sort.remove", key);
  }, [reportTableEvent, updateSortState]);
  const handleSortDirectionToggle = React.useCallback((key: string) => {
    updateSortState((current) =>
      current.map((entry) =>
        entry.key === key
          ? {
              ...entry,
              direction: entry.direction === "asc" ? "desc" : "asc",
            }
          : entry
      )
    );
    reportTableEvent("ui.table.sort.toggle", key);
  }, [reportTableEvent, updateSortState]);
  const handleSortMove = React.useCallback((fromIndex: number, toIndex: number) => {
    updateSortState((current) => {
      if (toIndex < 0 || toIndex >= current.length) return current;
      const next = [...current];
      const [moved] = next.splice(fromIndex, 1);
      if (!moved) return current;
      next.splice(toIndex, 0, moved);
      return next;
    });
    reportTableEvent(
      "ui.table.sort.move",
      String(fromIndex),
      String(toIndex)
    );
  }, [reportTableEvent, updateSortState]);
  const clearSorts = React.useCallback(() => {
    updateSortState(() => []);
    reportTableEvent("ui.table.sort.clear");
  }, [reportTableEvent, updateSortState]);
  const handleColumnMenuAction = React.useCallback(
    (action: ColumnMenuAction, columnKey: string) => {
      switch (action) {
        case "sortAsc":
          updateSortState(() => [{ key: columnKey, direction: "asc" }]);
          reportTableEvent("ui.table.sort.set", columnKey, "asc");
          break;
        case "sortDesc":
          updateSortState(() => [{ key: columnKey, direction: "desc" }]);
          reportTableEvent("ui.table.sort.set", columnKey, "desc");
          break;
        case "hide":
          toggleColumn(columnKey);
          reportTableEvent("ui.table.column.hide", columnKey);
          break;
        case "pin":
          togglePin(columnKey);
          reportTableEvent("ui.table.column.pin", columnKey);
          break;
        case "unpin":
          togglePin(columnKey);
          reportTableEvent("ui.table.column.unpin", columnKey);
          break;
        case "autoWidth":
          updateColumnWidth(columnKey, null);
          reportTableEvent("ui.table.column.autoWidth", columnKey);
          break;
      }
    },
    [updateSortState, reportTableEvent, toggleColumn, togglePin, updateColumnWidth]
  );
  const handleRowNavigate = React.useCallback(
    (href: string) => {
      router.push(stripBasePath(href, safeBasePath ?? undefined));
    },
    [router, safeBasePath]
  );
  const handleContextMenu = React.useCallback(
    (event: React.MouseEvent, rowId: string, rowData: Record<string, unknown>) => {
      event.preventDefault();
      setContextMenu({ rowId, rowData, x: event.clientX, y: event.clientY });
    },
    []
  );
  const closeContextMenu = React.useCallback(() => {
    setContextMenu(null);
  }, []);
  const handleContextMenuAction = React.useCallback(
    (action: ContextMenuAction, rowId: string, rowData: Record<string, unknown>) => {
      const href = resolveRowHref(rowId);
      if (action === "open" && href) {
        handleRowNavigate(href);
      } else if (action === "openNewTab" && href) {
        const opened = openTrustedInNewTab(href);
        if (!opened) {
          reportTableEvent("ui.table.row.open_new_tab.blocked", href);
        }
      } else if (action === "copyId") {
        void navigator.clipboard.writeText(rowId);
        toast({ title: t("contextMenu.copyId"), tone: "success" });
      } else if (action === "copyRowJson") {
        void navigator.clipboard.writeText(JSON.stringify(rowData, null, 2));
        toast({ title: t("contextMenu.copyRowJson"), tone: "success" });
      }
    },
    [handleRowNavigate, resolveRowHref, reportTableEvent, t, toast]
  );
  const contextMenuRowHref = contextMenu ? resolveRowHref(contextMenu.rowId) : null;
  const renderRow = React.useCallback(
    (row: (typeof displayRows)[number], rowIndex: number) => {
      if (row.type === "group") {
        return (
          <TableGroupRow
            key={row.id}
            t={t}
            row={row}
            resolvedGroupBy={resolvedGroupBy}
            columnsByKey={columnsByKey}
            displayColumns={displayColumns}
            selectionEnabled={selectionEnabled}
            showRowNumbers={showRowNumbers}
            cellPadding={cellPadding}
            pinnedOffsets={pinnedOffsets}
            columnWidths={columnWidths}
            pinnedGroupClass={pinnedGroupClass}
            numericColumnSet={numericColumnSet}
            pageMetrics={pageMetrics}
            analyticsEnabled={analyticsEnabled}
            safeColumnCount={safeColumnCount}
            collapsedGroups={collapsedGroups}
            onToggleCollapse={handleGroupCollapseToggle}
          />
        );
      }
      if (row.type === "detail") {
        const detailSelected = row.parentId ? selectedIds.has(row.parentId) : false;
        return (
          <TableDetailRow
            key={row.id}
            t={t}
            row={row}
            detailColumns={detailColumns}
            detailSelected={detailSelected}
            safeColumnCount={safeColumnCount}
            cellPadding={cellPadding}
          />
        );
      }
      return (
        <TableDataRow
          key={row.id}
          t={t}
          row={row}
          rowIndex={rowIndex}
          showRowNumbers={showRowNumbers}
          idKey={idKey}
          baseHref={baseHref}
          resolveRowHref={resolveRowHref}
          selectionEnabled={selectionEnabled}
          selectedIds={selectedIds}
          cellPadding={cellPadding}
          displayColumns={displayColumns}
          pinnedOffsets={pinnedOffsets}
          columnWidths={columnWidths}
          pinnedCellClass={pinnedCellClass}
          numericColumnSet={numericColumnSet}
          hasGrouping={hasGrouping}
          inlineEdit={inlineEdit}
          editConfigByKey={editConfigByKey}
          editPending={editPending}
          updateInlineEditValue={updateInlineEditValue}
          cancelInlineEdit={cancelInlineEdit}
          commitInlineEdit={commitInlineEdit}
          startInlineEdit={startInlineEdit}
          toggleRowExpanded={toggleRowExpanded}
          resolveRowKey={resolveRowKey}
          resolveCellDisplay={resolveCellDisplayForTable}
          expandedRowIds={expandedRowIds}
          onSelectRow={handleRowSelection}
          onNavigate={handleRowNavigate}
          onContextMenu={handleContextMenu}
        />
      );
    },
    [
      analyticsEnabled,
      baseHref,
      cancelInlineEdit,
      cellPadding,
      collapsedGroups,
      columnWidths,
      columnsByKey,
      commitInlineEdit,
      detailColumns,
      displayColumns,
      editConfigByKey,
      editPending,
      expandedRowIds,
      handleRowNavigate,
      handleRowSelection,
      hasGrouping,
      idKey,
      inlineEdit,
      numericColumnSet,
      pageMetrics,
      pinnedCellClass,
      pinnedGroupClass,
      pinnedOffsets,
      resolveCellDisplayForTable,
      resolveRowHref,
      resolveRowKey,
      resolvedGroupBy,
      safeColumnCount,
      selectedIds,
      selectionEnabled,
      showRowNumbers,
      startInlineEdit,
      t,
      toggleGroupCollapse,
      toggleRowExpanded,
      updateInlineEditValue,
      handleContextMenu,
    ]
  );


  const filterChips = React.useMemo<ChipItem[]>(() => {
    const chips: ChipItem[] = [];
    if (activeFilterCount > 0) {
      chips.push({
        id: "__filters__",
        label: t("toolbar.filters", { count: activeFilterCount }),
        type: "filter",
      });
    }
    for (const entry of sortState) {
      const label = columnsByKey.has(entry.key)
        ? resolveColumnLabelByKey(columnsByKey, entry.key)
        : entry.key;
      const dir = entry.direction === "asc" ? t("toolbar.directionAsc") : t("toolbar.directionDesc");
      chips.push({ id: entry.key, label, detail: dir, type: "sort" });
    }
    for (const key of resolvedGroupBy) {
      const label = columnsByKey.has(key)
        ? resolveColumnLabelByKey(columnsByKey, key)
        : key;
      chips.push({ id: key, label, type: "group" });
    }
    return chips;
  }, [activeFilterCount, sortState, resolvedGroupBy, columnsByKey, t]);

  const handleRemoveChip = React.useCallback(
    (chip: ChipItem) => {
      if (chip.type === "filter" && chip.id === "__filters__") {
        clearFilters();
      } else if (chip.type === "sort") {
        handleSortRemove(chip.id);
      } else if (chip.type === "group") {
        removeGroupKey(chip.id);
      }
    },
    [clearFilters, handleSortRemove, removeGroupKey]
  );

  const handleClearAllChips = React.useCallback(() => {
    if (activeFilterCount > 0) clearFilters();
    if (sortState.length > 0) clearSorts();
    if (resolvedGroupBy.length > 0) clearGroupBy();
  }, [activeFilterCount, clearFilters, sortState.length, clearSorts, resolvedGroupBy.length, clearGroupBy]);

  return (
    <div className={rowDensity === "compact" ? "space-y-2" : "space-y-3"}>
      <TableViewBar
        t={t}
        views={viewEntries}
        activeViewId={viewSelectValue}
        onViewChange={handleViewChange}
        viewTabsMax={tableDefaults.viewTabsMax}
        viewDirty={viewDirty}
        hasBaseHref={Boolean(baseHref)}
        canManageViews={canManageViews}
        activePanel={activePanel}
        onPanelToggle={handlePanelToggle}
        panelIdPrefix={panelIdPrefix}
        testIdPrefix={tableTestIdPrefix}
        onResetView={resetView}
        sortingLabel={sortingLabel}
        groupingLabel={groupingLabel}
        filtersLabel={filtersLabel}
        filtersCount={activeFilterCount}
        sortCount={sortState.length}
        groupCount={resolvedGroupBy.length}
        visibleColumnsCount={visibleColumns.size}
        totalColumnsCount={orderedColumns.length}
        viewScopeValue={viewScopeValue}
        settingsResolutionValue={settingsResolutionValue}
        viewError={viewState?.error ?? null}
        viewMenu={{ activeView, onAction: handleViewMenuAction }}
        onClearFilters={activeFilterCount > 0 ? clearFilters : undefined}
        onClearSorts={sortState.length > 0 ? clearSorts : undefined}
        onClearGroups={
          resolvedGroupBy.length > 0 ? clearGroupBy : undefined
        }
        filterChips={filterChips}
        onRemoveChip={handleRemoveChip}
        onClearAllChips={filterChips.length > 1 ? handleClearAllChips : undefined}
        toolbar={
          <TableToolbar
            t={t}
            searchTerm={searchTerm}
            onSearchChange={setSearchTerm}
            onSearchClear={clearSearch}
            searchDebounceMs={searchDebounceMs}
            searchDebounceOptions={searchDebounceOptions}
            onSearchDebounceChange={handleSearchDebounceChange}
            clientFilterActive={clientFilterActive}
            filteredCount={filteredCount}
            totalCount={totalCount}
            clientPaginationEnabled={clientPaginationEnabled}
            pageSummaryLabel={pageSummaryLabel}
            resolvedClientPage={resolvedClientPage}
            totalClientPages={totalClientPages}
            canPageBack={canPageBack}
            canPageForward={canPageForward}
            showPageControls={showPageControls}
            pageInput={pageInput}
            onPageInputChange={handlePageInputChange}
            onPageInputBlur={resetPageInput}
            onFirstPage={goToFirstPage}
            onPrevPage={goToPrevPage}
            onNextPage={goToNextPage}
            onLastPage={goToLastPage}
            variant="embedded"
            testIdPrefix={tableTestIdPrefix}
            actionSlot={toolbarAction}
          />
        }
      />

      {selectionEnabled && selectedCount > 0 ? (
        <TableSelectionBar
          t={t}
          selectedCount={selectedCount}
          selectedIds={selectedIdList}
          renderBulkActions={renderBulkActions}
          onClear={handleClearSelection}
          testIdPrefix={tableTestIdPrefix}
        />
      ) : null}

      {activePanel ? (
        <div
          id={`${panelIdPrefix}-${activePanel}`}
          className="rounded-lg border border-ui-border/15 bg-ui-highlight/15 p-4 text-sm motion-safe:table-animate-slide-down"
          data-testid={
            tableTestIdPrefix
              ? `${tableTestIdPrefix}-panel-${activePanel}`
              : undefined
          }
        >
          {activePanel === "views" && viewState ? (
            <TableViewPanel
              t={t}
              viewScopeValue={viewScopeValue}
              settingsResolutionValue={settingsResolutionValue}
              viewError={viewState.error}
              canManageViews={canManageViews}
              activeView={activeView}
              viewsCount={viewEntries.length}
              saveOpen={saveOpen}
              deleteOpen={deleteOpen}
              saveName={saveName}
              saveDefault={saveDefault}
              saveStatus={saveStatus}
              saveDisabled={saveDisabled}
              onToggleSave={toggleSaveOpen}
              onToggleDelete={toggleDeleteOpen}
              onSaveNameChange={setSaveName}
              onSaveDefaultChange={setSaveDefault}
              onSaveView={handleSaveView}
              onDeleteView={handleDeleteView}
              testIdPrefix={tableTestIdPrefix}
            />
          ) : null}
          {activePanel === "group" ? (
            <TableGroupingPanel
              t={t}
              availableGroupKeys={availableGroupKeys}
              resolvedGroupBy={resolvedGroupBy}
              columnsByKey={columnsByKey}
              groupIds={groupIds}
              collapsedGroups={collapsedGroups}
              onAddGroupKey={addGroupKey}
              onMoveGroupKey={moveGroupKey}
              onRemoveGroupKey={removeGroupKey}
              onClearGroupBy={clearGroupBy}
              onCollapseAll={handleGroupCollapseAll}
              onExpandAll={handleGroupExpandAll}
              testIdPrefix={tableTestIdPrefix}
            />
          ) : null}
          {activePanel === "properties" ? (
            <TableColumnPanel
              t={t}
              columnFilter={columnFilter}
              onColumnFilterChange={setColumnFilter}
              onColumnFilterClear={() => setColumnFilter("")}
              onShowAllColumns={showAllColumns}
              onHideAllColumns={hideAllColumns}
              filteredColumns={filteredColumns}
              columnOrder={columnOrder}
              visibleColumns={visibleColumns}
              pinnedSet={pinnedSet}
              columnWidths={columnWidths}
              draggingColumn={draggingColumn}
              dragOverColumn={dragOverColumn}
              onDragStart={handleColumnDragStart}
              onDragOver={handleColumnDragOver}
              onDrop={handleColumnDrop}
              onDragEnd={handleColumnDragEnd}
              onToggleColumn={toggleColumn}
              onTogglePin={togglePin}
              onUpdateWidth={updateColumnWidth}
              onMoveColumn={handleMoveColumn}
              minColumnWidth={tableDefaults.minColumnWidth}
              resizeStep={tableDefaults.resizeStep}
              rowDensity={rowDensity}
              onRowDensityChange={setRowDensity}
              openMode={detailOpenMode}
              onOpenModeChange={setDetailOpenMode}
              showRowNumbers={showRowNumbers}
              onShowRowNumbersChange={setShowRowNumbers}
              showInternalIdHints={showInternalIdHints}
              onShowInternalIdHintsChange={setShowInternalIdHints}
              analyticsEnabled={analyticsEnabled}
              onAnalyticsToggle={setAnalyticsEnabled}
              summaryRowEnabled={summaryRowEnabled}
              onSummaryRowToggle={setSummaryRowEnabled}
              paginationModeOptions={paginationModeOptions}
              paginationMode={paginationMode}
              onPaginationModeChange={handlePaginationModeChange}
              pageSize={resolvedPageSize}
              pageSizeOptions={resolvedPageSizeOptions}
              onPageSizeChange={handlePageSizeChange}
            />
          ) : null}
          {activePanel === "export" ? (
            <React.Suspense fallback={null}>
              <TableExportPanel
                t={t}
                analyticsEnabled={analyticsEnabled}
                onExportMetrics={onExportMetrics}
                metricsExportDisabled={metricsExportDisabled}
                onExportExcel={onExportExcel}
                excelExportDisabled={excelExportDisabled}
                onExportCsv={onExportCsv}
                exportDisabled={exportDisabled}
                testIdPrefix={tableTestIdPrefix}
              />
            </React.Suspense>
          ) : null}
          {activePanel === "sort" ? (
            <TableSortPanel
              t={t}
              sortState={sortState}
              columnsByKey={columnsByKey}
              onAddSort={handleSortAdd}
              onRemoveSort={handleSortRemove}
              onToggleDirection={handleSortDirectionToggle}
              onMoveSort={handleSortMove}
              onClearSorts={clearSorts}
              testIdPrefix={tableTestIdPrefix}
            />
          ) : null}
          {activePanel === "formatting" ? (
            <React.Suspense fallback={null}>
              <ConditionalFormattingPanel
                t={t}
                columns={orderedColumns}
                rules={conditionalFormatting ?? []}
                onRulesChange={setConditionalFormatting}
              />
            </React.Suspense>
          ) : null}
          {activePanel === "filters" ? (
            <TableFilterPanel
              t={t}
              resourceKey={resourceKey}
              filters={filters ?? null}
              searchParams={searchParamsRecord}
              actionHref={routerBaseHref ?? undefined}
              limit={
                resolvedPageSize ??
                viewState?.pageSize ??
                uiDefaults.pagination.defaultPageSize
              }
              initialTree={initialFilterTree}
              activeFilterCount={activeFilterCount}
              opLabels={filterOperatorLabels ?? undefined}
              opKeys={filterOperatorKeys ?? undefined}
              filtersLabel={filtersLabel}
              panelLabel={t("viewBar.filters")}
              onResetView={resetView}
              onFilterApply={handleFilterApply}
              onFilterClear={handleFilterClear}
              testIdPrefix={tableTestIdPrefix}
              onNavigate={onServerNavigate}
            />
          ) : null}
        </div>
      ) : null}
      <TableViewport
        t={t}
        tableContainerRef={tableContainerRef}
        rowDensity={rowDensity}
        showRowNumbers={showRowNumbers}
        selectionEnabled={selectionEnabled}
        selectHeaderRef={selectHeaderRef}
        selectAllRef={selectAllRef}
        allSelected={allSelected}
        onToggleAll={toggleAllSelection}
        displayColumns={displayColumns}
        sortState={sortState}
        onSort={handleSort}
        numericColumnSet={numericColumnSet}
        pinnedOffsets={pinnedOffsets}
        columnWidths={columnWidths}
        pinnedHeaderClass={pinnedHeaderClass}
        pinnedCellClass={pinnedCellClass}
        cellPadding={cellPadding}
        registerHeaderRef={registerHeaderRef}
        onResizeStart={handleResizeStart}
        onResizeKey={handleResizeKey}
        onUpdateWidth={updateColumnWidth}
        noColumnsSelected={noColumnsSelected}
        isEmpty={sortedItems.length === 0}
        emptyMessage={emptyMessage}
        emptyAction={emptyAction}
        noColumnsAction={noColumnsAction}
        clientFilterActive={clientFilterActive}
        safeColumnCount={safeColumnCount}
        paddingTop={paddingTop}
        paddingBottom={paddingBottom}
        rowsToRender={rowsToRender}
        displayRows={displayRows}
        renderRow={renderRow}
        showSummaryRow={showSummaryRow}
        pageMetrics={pageMetrics}
        resizeGuide={resizeGuide}
        onCreateRow={onCreateRow}
        createRowLabel={onCreateRow ? t("table.newRow") : undefined}
        pinnedSet={pinnedSet}
        onColumnMenuAction={handleColumnMenuAction}
        columnAggregations={columnAggregations}
        onSelectAggregation={handleSelectAggregation}
      />
      <TableContextMenu
        t={t}
        state={contextMenu}
        onAction={handleContextMenuAction}
        onClose={closeContextMenu}
        rowHref={contextMenuRowHref}
        canEdit={inlineEditEnabled}
        canDelete={canWrite}
      />
    </div>
  );
}




