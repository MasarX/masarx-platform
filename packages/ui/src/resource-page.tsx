import "server-only";
import type { ReactNode } from "react";
import { createUiServerClient } from "@masarx/api/server";
import { getPublicConfig, getUiDefaults } from "@masarx/config";
import {
  UiCommandDefinition,
  UiMe,
  UiReadFilter,
  UiReadRegistry,
  UiReadResource,
  UiResourceList,
  UiResourceMetrics,
  UiTableView,
  UiTableViews,
  normalizeUiScope,
  resolveImportCapability,
  resolveImportEnabled,
} from "@masarx/api";
import { Button } from "./button";
import { ContextNotice } from "./context-notice";
import {
  ContextNoticeDiagnostics,
  type ContextNoticeDiagnosticsEntry,
} from "./context-notice-diagnostics";
import { EmptyState } from "./empty-state";
import { PageHeader } from "./page-header";
import {
  matchesResourceCategory,
  resolveResourceActionStats,
  resolveResourceCommandCategory,
} from "./resource-actions-core";
import { ResourceFilterChips, type AppliedFilter } from "./resource-filter-chips";
import { ResourceDetailActions } from "./resource-detail-actions";
import { ResourceDetailClient } from "./resource-detail-client";
import { fetchCommandRegistry } from "./command-registry";
import { RelatedResourceTableClient } from "./related-resource-table-client";
import {
  flattenSearchParams,
  resolveFilterKeys,
  resolveFilterOperatorRegistry,
  buildFilterTreeFromFlat,
  decodeFilterTree,
  flattenFilterTree,
  normalizeFilterNode,
  labelFromKey,
  type FilterGroup,
  type FilterRuleValue,
  type SearchParams,
} from "./resource-query";
import { ResourceDetail } from "./resource-detail";
import { ResourceDetailSkeleton } from "./resource-detail-skeleton";
import { ResourceImportLauncher } from "./resource-import-launcher";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "./tabs";
import { ResourceTable } from "./resource-table";
import { ResourceTableClient } from "./resource-table-client";
import {
  resolveColumns,
  suggestResourceKeys,
  type ResourceColumn,
} from "./resource-page-utils";
import { DEFAULT_LIMIT, resolvePaginationDisplay, resolvePaginationSettings } from "./pagination-utils";
import { createUiTranslator, resolveRowDisplayText } from "./i18n";
import { buildTestId } from "./test-ids";
import {
  cn,
  extractCapabilityDeniedKey,
  formatUiError,
  isCapabilityDeniedMessage,
  isStatementTimeoutUiError,
} from "./utils";
import {
  formatDisplayIdentifierValue,
  formatIdValue,
  formatReferenceValue,
  resolveRecordDescriptor,
  resolveRecordLabel,
} from "./resource-utils";
import { resolveDisplayIdentifier } from "./display-identifiers";
import { buildHref } from "./url";
import {
  isTrustedUrl,
  resolveSafeAppBasePath,
  resolveSafeHref,
} from "./url-guard";
import { hasCapability, resolveCapabilitySet, isResourceReadScopeAllowed } from "./capabilities";

type SortDirection = "asc" | "desc";
type ResourceViewEntry = UiTableView & {
  id: string;
  pagination_mode?: string | null;
  search_debounce_ms?: number | null;
  show_internal_id_hints?: boolean | null;
  summary_row?: boolean | null;
};

const t = createUiTranslator("ui.resourcePage");

type ResourcePageProps = {
  appKey: "console" | "portal";
  resourceKey: string;
  searchParams: SearchParams;
  appBasePath: string;
  description?: string;
  downloadBasePath?: string;
  baseHref?: string;
  testIdPrefix?: string;
  headerActions?: ReactNode;
  headerActionsCapability?: string | null;
  renderDetailFooter?: (context: ResourceDetailContext) => ReactNode;
};

const RESERVED_KEYS = new Set([
  "id",
  "detail_open",
  "detail_layout",
  "limit",
  "offset",
  "page",
  "paging_mode",
  "sort",
  "direction",
  "view",
  "filters",
]);

function firstValue(value: string | string[] | undefined) {
  if (Array.isArray(value)) return value[0];
  return value;
}

function parsePositiveInt(value: string | undefined, fallback: number) {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

function resolveSortDirection(
  value: string | undefined,
  fallback: SortDirection
): SortDirection {
  const normalized = value?.toLowerCase();
  if (normalized === "asc" || normalized === "desc") return normalized;
  return fallback;
}

function resolvePagingMode(
  value: string | undefined,
  options: string[],
  fallback: string
) {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return fallback;
  if (!options.includes(normalized)) return fallback;
  if (normalized !== "client" && normalized !== "server") return fallback;
  return normalized;
}

function buildFilters(
  params: SearchParams,
  resourceFilters: UiReadFilter[] | null | undefined,
  viewFilters: Record<string, unknown> | null | undefined
) {
  const filters: Record<string, string> = {};
  const applied: AppliedFilter[] = [];
  const filterKeys = resolveFilterKeys(resourceFilters);
  const treeParam = firstValue(params.filters);
  const decodedTree = decodeFilterTree(treeParam);
  const normalizedView =
    viewFilters && typeof viewFilters === "object"
      ? normalizeFilterNode(viewFilters)
      : null;
  const viewTree =
    normalizedView && normalizedView.type === "group" ? normalizedView : null;
  const toValue = (value: FilterRuleValue) =>
    Array.isArray(value) ? value.join(", ") : value ?? "";

  if (decodedTree) {
    const rules = flattenFilterTree(decodedTree);
    rules.forEach((rule) => {
      const value = toValue(rule.value);
      if (!value) return;
      filters[rule.key] = value;
      applied.push({
        key: rule.key,
        value,
        op: rule.op ?? null,
        source: "query",
      });
    });
    return { filters, tree: decodedTree, mode: "tree" as const, applied };
  }

  flattenSearchParams(params).forEach(([key, value]) => {
    if (RESERVED_KEYS.has(key)) return;
    if (filterKeys.size > 0 && !filterKeys.has(key)) return;
    const trimmed = value.trim();
    if (!trimmed) return;
    filters[key] = trimmed;
    applied.push({ key, value: trimmed, source: "query" });
  });

  if (viewTree) {
    const rules = flattenFilterTree(viewTree);
    rules.forEach((rule) => {
      if (filters[rule.key]) return;
      const value = toValue(rule.value);
      if (!value) return;
      filters[rule.key] = value;
      applied.push({
        key: rule.key,
        value,
        op: rule.op ?? null,
        source: "view",
      });
    });
    return { filters, tree: viewTree, mode: "tree" as const, applied };
  }

  if (viewFilters && typeof viewFilters === "object") {
    Object.entries(viewFilters).forEach(([key, value]) => {
      if (filters[key]) return;
      if (filterKeys.size > 0 && !filterKeys.has(key)) return;
      const trimmed = String(value ?? "").trim();
      if (!trimmed) return;
      filters[key] = trimmed;
      applied.push({ key, value: trimmed, source: "view" });
    });
  }

  const tree = Object.keys(filters).length
    ? buildFilterTreeFromFlat(filters, resourceFilters)
    : null;
  return { filters, tree, mode: "flat" as const, applied };
}

function normalizeViewEntries(
  value: UiTableViews | null | undefined
): ResourceViewEntry[] {
  const viewMap = value?.views;
  if (!viewMap || typeof viewMap !== "object") return [];

  return Object.entries(viewMap)
    .map(([key, raw]) => {
      const view =
        raw && typeof raw === "object" ? (raw as Partial<UiTableView>) : { label: key };
      const id = typeof view.id === "string" && view.id.trim() ? view.id : key;
      const label =
        typeof view.label === "string" && view.label.trim()
          ? view.label
          : id;
      return {
        ...view,
        id,
        label,
      };
    })
    .sort((a, b) =>
      (a.label ?? a.id).localeCompare(b.label ?? b.id)
    );
}

function resolveActiveView(
  views: ResourceViewEntry[],
  requestedId: string | null,
  defaultId: string | null | undefined
) {
  if (views.length === 0) return null;
  if (requestedId) {
    const match = views.find((view) => view.id === requestedId);
    if (match) return match;
  }
  if (defaultId) {
    const match = views.find((view) => view.id === defaultId);
    if (match) return match;
  }
  return views[0] ?? null;
}

type ResourceDetailContext = {
  resourceKey: string;
  detailId: string;
  detail: Record<string, unknown> | null;
  detailError: string | null;
  downloadHref: string | null;
  baseHref: string;
  resource: UiReadResource | undefined;
};

type RelatedResourceResult = {
  key: string;
  label: string;
  href: string;
  columns: ResourceColumn[];
  items: Record<string, unknown>[];
  idKey: string;
  countLabel: string | null;
  reorder: UiReadResource["reorder"] | null;
  capabilityWrite: string | null;
  error: string | null;
};

function buildDownloadHref(
  downloadBasePath: string,
  resourceKey: string,
  detailId: string
) {
  const params = new URLSearchParams({ resource: resourceKey, id: detailId });
  return buildHref(downloadBasePath, params);
}

/**
 * Resource page wrapper that wires ResourceTable with routing context.
 */
export async function ResourcePage({
  appKey,
  resourceKey,
  searchParams,
  appBasePath,
  description,
  downloadBasePath,
  baseHref: baseHrefOverride,
  testIdPrefix,
  headerActions,
  headerActionsCapability = null,
  renderDetailFooter,
}: ResourcePageProps) {
  const ui = createUiServerClient();
  const uiDefaults = getUiDefaults();
  const safeAppBasePath = resolveSafeAppBasePath(appBasePath);
  const baseHref =
    baseHrefOverride ??
    (safeAppBasePath
      ? `${safeAppBasePath}/resources/${resourceKey}`
      : `/resources/${resourceKey}`);
  const effectiveDownloadBase =
    downloadBasePath ??
    (safeAppBasePath
      ? `${safeAppBasePath}/api/resource-download`
      : "/api/resource-download");
  const safeBaseHref = isTrustedUrl(baseHref)
    ? baseHref
    : `/resources/${resourceKey}`;
  const safeDownloadBase = isTrustedUrl(effectiveDownloadBase)
    ? effectiveDownloadBase
    : "/api/resource-download";
  const safeResourceBase = resolveSafeHref(appBasePath, "/resources") ?? "/resources";
  const detailId = firstValue(searchParams.id);
  const detailOpen = detailId
    ? firstValue(searchParams.detail_open) !== "0"
    : false;
  const detailLayout = detailId ? firstValue(searchParams.detail_layout)?.trim() ?? "" : "";
  const detailLayoutMode = detailLayout === "full" ? ("full" as const) : ("peek" as const);
  const limitParam = firstValue(searchParams.limit);
  const pagingModeParam = firstValue(searchParams.paging_mode)?.trim() ?? "";
  const page = parsePositiveInt(firstValue(searchParams.page), 1);
  const sortKey = firstValue(searchParams.sort)?.trim() ?? "";
  const sortDirectionParam = firstValue(searchParams.direction);
  const requestedViewId = firstValue(searchParams.view)?.trim() ?? "";
  let filters: Record<string, string> = {};
  let filterTree: FilterGroup | null = null;
  let appliedFilters: AppliedFilter[] = [];
  let limit = DEFAULT_LIMIT;
  let offset = 0;

  const toPromise = <T,>(runner: () => Promise<T>) => Promise.resolve().then(runner);
  const locale = getPublicConfig().locale;

  let registry: UiReadRegistry | null = null;
  let me: UiMe | null = null;
  let meError: unknown | null = null;
  let resource: UiReadResource | undefined;
  let list: UiResourceList | null = null;
  let datasetMetrics: UiResourceMetrics | null = null;
  let detail: Record<string, unknown> | null = null;
  let tableViews: UiTableViews | null = null;
  let viewEntries: ResourceViewEntry[] = [];
  let activeView: ResourceViewEntry | null = null;
  let viewError: string | null = null;
  let paginationResolutionId: string | null = null;
  let canSaveViews = false;
  let userCapabilities: string[] = [];
  let capabilitySet = resolveCapabilitySet(null);
  let viewScopeType: string | null = null;
  let viewScopeId: string | null = null;
  let analyticsEnabled = true;
  let errorMessage: string | null = null;
  let isTimeoutError = false;
  let resourceKeySuggestions: string[] = [];
  let deniedMessage: string | null = null;
  let detailError: string | null = null;
  let detailRequestIssued = false;
  let metricsError: string | null = null;
  let requestedLimit = 0;
  const paginationDefaults = resolvePaginationSettings(null);
  let maxPageSize = paginationDefaults.maxPageSize;
  let allowedPageSizes = paginationDefaults.allowedSizes;
  let resolvedDefaultPageSize = paginationDefaults.defaultPageSize;
  let clientMaxRows = paginationDefaults.clientMaxRows;
  let clientAllowedSizes = paginationDefaults.clientAllowedSizes;
  let clientDefaultPageSize = paginationDefaults.clientDefaultPageSize;
  let searchDebounceMs = paginationDefaults.searchDebounceMs;
  let searchDebounceOptions = paginationDefaults.searchDebounceOptions;
  let pagingMode = paginationDefaults.pagingMode;
  let pagingModeOptions = paginationDefaults.pagingModeOptions;
  let defaultSortKey = "id";
  let defaultSortDirection: SortDirection = "desc";
  let sortState: { key: string; direction: SortDirection } | null = null;
  let commandRegistry: UiCommandDefinition[] = [];
  let commandError: string | null = null;
  let useClientPagination = false;
  const filterOperatorDefaults = resolveFilterOperatorRegistry(null, locale);
  let filterOperatorLabels = filterOperatorDefaults.labels;
  let filterOperatorKeys = filterOperatorDefaults.keys;
  let clientPagination:
    | {
        pageSizes: number[];
        defaultPageSize?: number | null;
        defaultMode?: "client" | "server";
        modeOptions?: Array<"client" | "server">;
        searchDebounceMs?: number;
        searchDebounceOptions?: number[];
      }
    | null = null;

  const [registryResult, meResult] = await Promise.allSettled([
    toPromise(() => ui.readRegistry()),
    toPromise(() => ui.me()),
  ]);

  if (registryResult.status === "fulfilled") {
    registry = registryResult.value;
    resource = registry?.resources?.find((entry) => entry.key === resourceKey);
    if (!resource) {
      resourceKeySuggestions = suggestResourceKeys(
        resourceKey,
        Array.isArray(registry?.resources) ? registry.resources : []
      );
      errorMessage =
        resourceKeySuggestions.length > 0
          ? t("errors.resourceNotRegisteredSuggested", {
              resourceKey,
              suggestions: resourceKeySuggestions.join(", "),
            })
          : t("errors.resourceNotRegistered", { resourceKey });
    }
  } else {
    isTimeoutError = isStatementTimeoutUiError(registryResult.reason);
    errorMessage = formatUiError(registryResult.reason, t("errors.loadRegistry"));
  }

  if (meResult.status === "fulfilled") {
    me = meResult.value;
  } else {
    meError = meResult.reason;
  }

  if (resource && !isResourceReadScopeAllowed(
    resource, me?.access_scope?.scope_type, me?.access_scope?.scope_id,
    me?.org?.id,
  )) {
    deniedMessage = t("blocked.action");
  }

  if (!errorMessage && !deniedMessage && resource) {
    if (meError) {
      viewError = formatUiError(meError, t("errors.loadCapabilities"));
    } else if (me) {
      userCapabilities = Array.isArray(me?.capabilities)
        ? me?.capabilities.filter((capability): capability is string => Boolean(capability))
        : [];
      capabilitySet = resolveCapabilitySet(userCapabilities);
      canSaveViews = hasCapability(capabilitySet, "settings.request");
      const normalizedScope = normalizeUiScope({
        scopeType: me?.access_scope?.scope_type ?? null,
        scopeId: me?.access_scope?.scope_id ?? null,
      });
      viewScopeType = normalizedScope.scopeType;
      viewScopeId = normalizedScope.scopeId;
    }

    const [previewResult, operatorsResult, viewsResult, commandRegistryResult] =
      await Promise.allSettled([
        toPromise(() =>
          ui.settingsPreview({
            category: "ui_pagination",
            scopeType: viewScopeType,
            scopeId: viewScopeId,
          })
        ),
        toPromise(() => ui.filterOperators()),
        toPromise(() => ui.tableViews(resourceKey, viewScopeType, viewScopeId)),
        toPromise(() => fetchCommandRegistry(ui)),
      ]);

    if (previewResult.status === "fulfilled") {
      const preview = previewResult.value;
      const settings = resolvePaginationSettings(preview?.value);
      maxPageSize = settings.maxPageSize;
      allowedPageSizes = settings.allowedSizes;
      resolvedDefaultPageSize = settings.defaultPageSize;
      clientMaxRows = settings.clientMaxRows;
      clientAllowedSizes = settings.clientAllowedSizes;
      clientDefaultPageSize = settings.clientDefaultPageSize;
      searchDebounceMs = settings.searchDebounceMs;
      searchDebounceOptions = settings.searchDebounceOptions;
      pagingMode = settings.pagingMode;
      pagingModeOptions = settings.pagingModeOptions;
      paginationResolutionId = preview?.settings_resolution_id ?? null;
    } else {
      maxPageSize = paginationDefaults.maxPageSize;
      allowedPageSizes = paginationDefaults.allowedSizes;
      resolvedDefaultPageSize = paginationDefaults.defaultPageSize;
      clientMaxRows = paginationDefaults.clientMaxRows;
      clientAllowedSizes = paginationDefaults.clientAllowedSizes;
      clientDefaultPageSize = paginationDefaults.clientDefaultPageSize;
      searchDebounceMs = paginationDefaults.searchDebounceMs;
      searchDebounceOptions = paginationDefaults.searchDebounceOptions;
      pagingMode = paginationDefaults.pagingMode;
      pagingModeOptions = paginationDefaults.pagingModeOptions;
    }

    if (operatorsResult.status === "fulfilled") {
      const resolved = resolveFilterOperatorRegistry(operatorsResult.value, locale);
      filterOperatorLabels = resolved.labels;
      filterOperatorKeys = resolved.keys;
    } else {
      filterOperatorLabels = filterOperatorDefaults.labels;
      filterOperatorKeys = filterOperatorDefaults.keys;
    }

    if (viewsResult.status === "fulfilled") {
      tableViews = viewsResult.value;
      viewEntries = normalizeViewEntries(tableViews);
      activeView = resolveActiveView(
        viewEntries,
        requestedViewId || null,
        tableViews?.default_view_id
      );
      analyticsEnabled = activeView?.analytics ?? true;
    } else {
      viewError = formatUiError(viewsResult.reason, t("errors.loadViews"));
    }

    if (commandRegistryResult.status === "fulfilled") {
      commandRegistry = commandRegistryResult.value.commands;
      if (commandRegistryResult.value.error) {
        commandError = formatUiError(
          commandRegistryResult.value.error,
          t("errors.loadCommandRegistry")
        );
      }
    } else {
      commandError = formatUiError(
        commandRegistryResult.reason,
        t("errors.loadCommandRegistry")
      );
    }

    try {
      const viewSort = activeView?.sort ?? null;
      const viewPageSize = activeView?.page_size ?? null;
      defaultSortKey =
        viewSort?.key ??
        resource.default_sort?.column ??
        resource.id_column ??
        defaultSortKey;
      defaultSortDirection = resolveSortDirection(
        viewSort?.direction ?? resource.default_sort?.direction ?? undefined,
        defaultSortDirection
      );
      const resolvedSortKey = sortKey || viewSort?.key || "";
      const resolvedDirection = resolveSortDirection(
        sortDirectionParam,
        defaultSortDirection
      );
      sortState = resolvedSortKey
        ? { key: resolvedSortKey, direction: resolvedDirection }
        : null;
      const rawLimit = limitParam
        ? parsePositiveInt(limitParam, resolvedDefaultPageSize)
        : viewPageSize && viewPageSize > 0
          ? viewPageSize
          : resolvedDefaultPageSize;
      requestedLimit = rawLimit;
      const allowedSet = new Set(allowedPageSizes);
      const normalizedLimit = allowedSet.has(rawLimit)
        ? rawLimit
        : resolvedDefaultPageSize;
      const fetchLimit = Math.min(normalizedLimit, maxPageSize);
      limit = fetchLimit;
      offset = parsePositiveInt(firstValue(searchParams.offset), (page - 1) * limit);
      const filterPayload = buildFilters(
        searchParams,
        resource.filters,
        activeView?.filters
      );
      filters = filterPayload.filters;
      filterTree = filterPayload.tree ?? null;
      appliedFilters = filterPayload.applied;
      list = await ui.listResource(
        resourceKey,
        filterTree ?? filters,
        fetchLimit,
        offset,
        sortState
      );
      const totalRows =
        typeof list?.total === "number" ? list.total : null;
      const clientReady =
        clientAllowedSizes.length > 0 &&
        typeof totalRows === "number" &&
        totalRows > 0 &&
        totalRows <= clientMaxRows;
      const pagingOptions = clientReady ? pagingModeOptions : ["server"];
      const fallbackPagingMode = pagingOptions.includes(pagingMode)
        ? pagingMode
        : pagingOptions[0] ?? "server";
      const resolvedPagingMode = resolvePagingMode(
        pagingModeParam || activeView?.pagination_mode || pagingMode,
        pagingOptions,
        fallbackPagingMode
      );
      useClientPagination = clientReady && resolvedPagingMode === "client";
      if (useClientPagination) {
        const clientAllowedSet = new Set(clientAllowedSizes);
        const normalizedClientLimit = clientAllowedSet.has(requestedLimit)
          ? requestedLimit
          : clientDefaultPageSize;
        limit = Math.min(normalizedClientLimit, clientMaxRows);
        maxPageSize = clientMaxRows;
        allowedPageSizes = clientAllowedSizes;
        resolvedDefaultPageSize = clientDefaultPageSize;
        if (list && totalRows && totalRows > list.items.length) {
          list = await ui.listResource(
            resourceKey,
            filterTree ?? filters,
            totalRows,
            0,
            sortState
          );
        }
      }
      clientPagination = {
        pageSizes: clientReady ? clientAllowedSizes : [],
        defaultPageSize: clientReady
          ? useClientPagination
            ? limit
            : clientDefaultPageSize
          : null,
        defaultMode: resolvedPagingMode as "client" | "server",
        modeOptions: pagingOptions as Array<"client" | "server">,
        searchDebounceMs,
        searchDebounceOptions,
      };

      const metricColumns = analyticsEnabled
        ? (resource.columns ?? [])
            .filter((column) => column.render_type === "number")
            .map((column) => column.key)
            .filter(Boolean)
        : [];
      const shouldFetchMetrics =
        analyticsEnabled && metricColumns.length > 0 && (list?.total ?? 0) > 0;
      const metricsPromise = shouldFetchMetrics
        ? toPromise(() =>
            ui.resourceMetrics(resourceKey, filterTree ?? filters, metricColumns)
          )
        : null;
      const requestedDetailId = detailId && detailOpen ? detailId : null;
      detailRequestIssued = Boolean(requestedDetailId);
      const detailPromise = requestedDetailId
        ? toPromise(() => ui.getResource(resourceKey, requestedDetailId))
        : null;

      if (metricsPromise || detailPromise) {
        const [metricsResult, detailResult] = await Promise.allSettled([
          metricsPromise ?? Promise.resolve(null),
          detailPromise ?? Promise.resolve(null),
        ]);

        if (metricsPromise) {
          if (metricsResult.status === "fulfilled") {
            datasetMetrics = metricsResult.value;
          } else {
            metricsError = formatUiError(metricsResult.reason, t("errors.loadMetrics"));
          }
        }

        if (detailPromise) {
          if (detailResult.status === "fulfilled") {
            detail = detailResult.value;
          } else {
            detailError = formatUiError(detailResult.reason, t("errors.loadRecord"));
          }
        }
      }
    } catch (error) {
      isTimeoutError = isStatementTimeoutUiError(error);
      errorMessage = formatUiError(error, t("errors.loadResourceList"));
    }
  }

  if (errorMessage && isCapabilityDeniedMessage(errorMessage)) {
    deniedMessage = errorMessage;
    errorMessage = null;
  }
  if (
    !errorMessage &&
    !deniedMessage &&
    detailRequestIssued &&
    detailId &&
    !detail &&
    !detailError
  ) {
    detailError = t("detail.notFound");
  }

  const columns = resolveColumns(resource, list, locale);
  const title = resolveRowDisplayText(resource?.label ?? resourceKey, resource?.label_ar, locale);
  const effectiveHeaderActions =
    deniedMessage || errorMessage
      ? null
      : headerActionsCapability
        ? hasCapability(capabilitySet, headerActionsCapability)
          ? headerActions
          : null
        : headerActions;
  const downloadCapability = resource?.download?.capability?.trim() ?? null;    
  const downloadAllowed = hasCapability(capabilitySet, downloadCapability);
  const downloadHref =
    detailId && detail && resource?.download && downloadAllowed
      ? buildDownloadHref(safeDownloadBase, resourceKey, detailId)
      : null;

  let relatedResults: RelatedResourceResult[] = [];
  const canResolveRelated =
    detailId &&
    detailOpen &&
    detail &&
    !detailError &&
    Array.isArray(registry?.resources);

  let relatedDefs: unknown[] = Array.isArray(resource?.related) ? resource.related : [];
  if (canResolveRelated && relatedDefs.length === 0) {
    try {
      const suggested = await ui.relatedResources(resourceKey, 12);
      relatedDefs = Array.isArray(suggested) ? suggested : [];
    } catch (_error) {
      relatedDefs = [];
    }
  }

  if (canResolveRelated && relatedDefs.length > 0) {
    const registryResources = registry!.resources!;
    const relatedEntries = relatedDefs
      .filter((entry) => entry && typeof entry === "object")
      .map((entry) => entry as Record<string, unknown>)
      .filter((entry) => entry.resource && entry.filter_key && entry.from)
      .slice(0, 12);

    relatedResults = (
      await Promise.all(
        relatedEntries.map(async (entry): Promise<RelatedResourceResult | null> => {
          const relatedKey = String(entry.resource ?? "").trim();
          if (!relatedKey) return null;

          const normalizeKeyList = (value: unknown): string[] => {
            if (Array.isArray(value)) {
              return value
                .map((entry) => String(entry ?? "").trim())
                .filter(Boolean);
            }
            const single = String(value ?? "").trim();
            return single ? [single] : [];
          };

          const filterKeys = normalizeKeyList(entry.filter_key);
          const fromKeys = normalizeKeyList(entry.from);
          if (filterKeys.length === 0 || fromKeys.length === 0) return null;
          if (filterKeys.length !== fromKeys.length) return null;

          const filters: Record<string, string> = {};
          for (let index = 0; index < filterKeys.length; index += 1) {
            const filterKey = filterKeys[index];
            const fromKey = fromKeys[index];
            if (!filterKey || !fromKey) return null;
            const rawValue = (detail as Record<string, unknown>)[fromKey];
            if (rawValue === null || rawValue === undefined) return null;
            const filterValue = String(rawValue).trim();
            if (!filterValue) return null;
            filters[filterKey] = filterValue;
          }

          const relatedResource = registryResources.find(
            (candidate) => candidate.key === relatedKey
          );
          const entryLabel = typeof entry.label === "string" ? entry.label.trim() : "";
          const limitRaw = Number(entry.limit);
          const limitDefault = uiDefaults.table.maxDownloadBatch;
          const limit =
            Number.isFinite(limitRaw) ? Math.max(1, Math.floor(limitRaw)) : limitDefault;

          try {
            const href = `${safeResourceBase}/${encodeURIComponent(relatedKey)}?${new URLSearchParams(
              filters
            ).toString()}`;
            const relatedList = await ui.listResource(
              relatedKey,
              filters,
              limit,
              0,
              null
            );
            const items = Array.isArray(relatedList?.items) ? relatedList.items : [];
            const columns = resolveColumns(relatedResource, relatedList, locale);
            const englishLabel =
              entryLabel ||
              relatedResource?.label?.trim() ||
              labelFromKey(relatedKey);
            const label = resolveRowDisplayText(
              englishLabel,
              entry.label_ar ?? relatedResource?.label_ar,
              locale
            );
            const total =
              typeof relatedList?.total === "number" ? relatedList.total : null;
            const countLabel =
              typeof total === "number"
                ? t("detail.related.countWithTotal", {
                    count: items.length,
                    total,
                  })
                : items.length > 0
                  ? t("detail.related.count", { count: items.length })
                  : null;

            return {
              key: relatedKey,
              label,
              href,
              columns,
              items,
              idKey: relatedResource?.id_column ?? "id",
              countLabel,
              reorder: relatedResource?.reorder ?? null,
              capabilityWrite:
                relatedResource?.capability_write ?? relatedResource?.capability_read ?? null,
              error: null,
            };
          } catch (error) {
            return {
              key: relatedKey,
              label:
                entryLabel ||
                relatedResource?.label?.trim() ||
                labelFromKey(relatedKey),
              href: `${safeResourceBase}/${encodeURIComponent(relatedKey)}?${new URLSearchParams(
                filters
              ).toString()}`,
              columns: [] as ResourceColumn[],
              items: [] as Record<string, unknown>[],
              idKey: relatedResource?.id_column ?? "id",
              countLabel: null,
              reorder: relatedResource?.reorder ?? null,
              capabilityWrite:
                relatedResource?.capability_write ?? relatedResource?.capability_read ?? null,
              error: formatUiError(error, t("detail.related.loadFailed")),
            };
          }
        })
      )
    )
      .filter((value): value is RelatedResourceResult => value !== null)
      .filter(
        (value, index, all) => all.findIndex((it) => it.key === value.key) === index
      );
  }
  const detailLabel = detail
    ? resolveRecordLabel(detail) ?? resolveRecordDescriptor(detail)
    : null;
  const detailDisplayIdentifier =
    detail && detailId
      ? resolveDisplayIdentifier(detail, {
          fallback: String(detailId),
        })?.value ?? null
      : null;
  const detailReadableId = detailId
    ? detailDisplayIdentifier
      ? formatDisplayIdentifierValue(detailDisplayIdentifier)
      : formatReferenceValue(String(detailId))
    : null;
  const detailTitle = detailId
    ? detailLabel
      ? t("detail.titleWithLabel", {
          label: detailLabel,
          id: detailReadableId ?? formatIdValue(String(detailId)),
        })
      : t("detail.titleWithId", {
          id: detailReadableId ?? formatIdValue(String(detailId)),
        })
    : t("detail.titleDefault");
  const detailNavigation = (() => {
    if (!detailId || !list?.items?.length) return { prevHref: null, nextHref: null, currentIndex: null, totalCount: null };
    const idColumn = resource?.id_column ?? "id";
    const items = list.items;
    const currentIndex = items.findIndex((item) => {
      const rawId = item[idColumn];
      return rawId !== null && rawId !== undefined && String(rawId) === detailId;
    });
    if (currentIndex < 0) return { prevHref: null, nextHref: null, currentIndex: null, totalCount: items.length };
    const buildNavHref = (targetId: string) => {
      const params = new URLSearchParams();
      flattenSearchParams(searchParams).forEach(([key, value]) => {
        if (key === "id") return;
        params.append(key, value);
      });
      params.set("id", targetId);
      return buildHref(safeBaseHref, params);
    };
    const prevItem = currentIndex > 0 ? items[currentIndex - 1] : null;
    const nextItem = currentIndex < items.length - 1 ? items[currentIndex + 1] : null;
    const prevId = prevItem ? String(prevItem[idColumn] ?? "") : null;
    const nextId = nextItem ? String(nextItem[idColumn] ?? "") : null;
    return {
      prevHref: prevId ? buildNavHref(prevId) : null,
      nextHref: nextId ? buildNavHref(nextId) : null,
      currentIndex,
      totalCount: items.length,
    };
  })();
  const listHref = (() => {
    const params = new URLSearchParams();
    flattenSearchParams(searchParams).forEach(([key, value]) => {
      if (key === "id" || key === "detail_open" || key === "detail_layout") return;
      params.append(key, value);
    });
    return buildHref(safeBaseHref, params);
  })();
  const listLimit = limit;
  const listOffset = useClientPagination ? 0 : list?.offset ?? offset;
  const listTotal = list?.total ?? null;
  const listTotalIsEstimate = list?.total_is_estimate ?? false;
  const summaryLabel = (() => {
    if (useClientPagination) {
      const count = list?.items?.length ?? 0;
      return t("summary.rows", { count });
    }
    const { start, end, total: displayTotal } = resolvePaginationDisplay({
      total: listTotal,
      totalIsEstimate: listTotalIsEstimate,
      offset: listOffset,
      itemsCount: list?.items?.length ?? 0,
    });
    if (displayTotal !== null) {
      if (listTotalIsEstimate) {
        return t("summary.rangeEstimated", { start, end, total: displayTotal });
      }
      if (displayTotal <= 0) return t("summary.zero");
      return t("summary.range", { start, end, total: displayTotal });
    }
    const count = list?.items?.length ?? 0;
    return t("summary.rows", { count });
  })();
  const tableSortCandidate =
    sortState ??
    (defaultSortKey
      ? { key: defaultSortKey, direction: defaultSortDirection }
      : null);
  const tableDefaultSort =
    tableSortCandidate && columns.some((column) => column.key === tableSortCandidate.key)
      ? tableSortCandidate
      : null;
  const viewState =
    tableViews || canSaveViews || viewError
      ? {
          resourceKey,
          activeViewId: activeView?.id ?? null,
          views: viewEntries,
          scopeType: viewScopeType,
          scopeId: viewScopeId,
          scopeValue: tableViews?.scope_value ?? null,
          settingsResolutionId: tableViews?.settings_resolution_id ?? null,
          canSave: canSaveViews,
          activeFilters: filterTree ?? filters,
          activeSort: sortState,
          pageSize: limit,
          error: viewError,
        }
      : null;
  const bulkActionsTelemetry = viewState
    ? {
        settingsResolutionId: viewState.settingsResolutionId ?? null,
        scopeType: viewState.scopeType ?? null,
        scopeId: viewState.scopeId ?? null,
        scopeValue: viewState.scopeValue ?? null,
      }
    : null;
  const actionCommands = commandRegistry.filter((command) =>
    matchesResourceCategory(command?.schema_category ?? null, resourceKey)      
  );
  const actionStats = resolveResourceActionStats({
    resource,
    commands: actionCommands,
    userCapabilities,
  });
  const commandCategory = resolveResourceCommandCategory({
    resourceKey,
    commands: actionCommands,
  });
  const commandsBaseHref = resolveSafeHref(appBasePath, "/commands");
  const commandCatalogHref = commandCategory
    ? (commandsBaseHref
        ? buildHref(commandsBaseHref, { category: commandCategory })
        : null)
    : commandsBaseHref;
  const commandCatalogAction = commandCatalogHref ? (
    <Button asChild variant="ghost" size="sm">
      <a href={commandCatalogHref}>{t("actions.manage")}</a>
    </Button>
  ) : null;
  const maxDownloadBatch = uiDefaults.table.maxDownloadBatch;
  const bulkActions = resource
    ? {
        resourceKey,
        resource,
        commands: actionCommands,
        appKey,
        appBasePath,
        downloadBasePath: safeDownloadBase,
        userCapabilities,
        maxDownloadBatch,
        telemetry: bulkActionsTelemetry,
        testIdPrefix: testIdPrefix ? `${testIdPrefix}-detail-actions` : null,
      }
    : null;
  const readyTestId = testIdPrefix
    ? buildTestId(testIdPrefix, "ready")
    : undefined;
  const blockedTestId = testIdPrefix
    ? buildTestId(testIdPrefix, "blocked")
    : undefined;
  const actionsTestIdBase = testIdPrefix
    ? `${testIdPrefix}-actions`
    : undefined;
  const errorTestId = testIdPrefix
    ? buildTestId(testIdPrefix, "error")
    : undefined;
  const detailDownloadTestId = testIdPrefix
    ? `${testIdPrefix}-detail-download`
    : undefined;
  const detailFooter =
    renderDetailFooter && detailId
      ? renderDetailFooter({
          resourceKey,
          detailId,
          detail,
          detailError,
          downloadHref,
          baseHref: safeBaseHref,
          resource,
        })
      : null;
  const importBaseHref = resolveSafeHref(appBasePath, "/imports/new");
  const importCapability = resolveImportCapability(resource);
  const importConfigured = resolveImportEnabled(resource);
  const importAllowed =
    importConfigured && hasCapability(capabilitySet, importCapability);
  const importDisabledReason =
    resource && !importConfigured
      ? t("actions.importDisabled")
      : resource && importCapability && !hasCapability(capabilitySet, importCapability)
        ? t("actions.importRequiresCapability", { capability: importCapability })
        : null;
  const importReturnHref = buildHref(safeBaseHref, (() => {
    const params = new URLSearchParams();
    flattenSearchParams(searchParams).forEach(([key, value]) => {
      params.append(key, value);
    });
    return params;
  })());
  const importHref = importBaseHref
    ? buildHref(importBaseHref, {
        resource: resourceKey,
        return_to: importReturnHref,
      })
    : null;
  const importAction =
    resource && importHref ? (
      <ResourceImportLauncher
        appBasePath={appBasePath}
        resourceKey={resourceKey}
        allowed={importAllowed}
        disabledReason={importDisabledReason}
        returnTo={importReturnHref}
        testIdPrefix={testIdPrefix}
      />
    ) : null;
  const detailActions =
    detailId && bulkActions ? (
      <ResourceDetailActions
        detailId={detailId}
        bulkActions={bulkActions}
      />
    ) : null;
  const detailBodyContent =
    detailId ? (
      <div className="space-y-3">
        {detailActions}
        <Tabs defaultValue="details">
          <TabsList>
            <TabsTrigger value="details">{t("detail.tabs.details")}</TabsTrigger>
            {relatedResults.map((entry) => (
              <TabsTrigger key={entry.key} value={`related:${entry.key}`}>
                {entry.label}
              </TabsTrigger>
            ))}
          </TabsList>
          <TabsContent value="details">
            {downloadHref ? (
              <div className="flex items-center gap-3 text-xs">
                <a
                  className="rounded-md bg-ui-highlight px-3 py-1 text-ui-ink transition hover:bg-ui-highlight/80"
                  href={downloadHref}
                  data-testid={detailDownloadTestId}
                >
                  {t("detail.download")}
                </a>
              </div>
            ) : null}
            {!detail && !detailError ? (
              <ResourceDetailSkeleton />
            ) : (
              <ResourceDetail
                title={detailTitle}
                data={detail}
                emptyMessage={detailError ?? t("detail.notFound")}
                columns={columns}
                showInternalIdHints={
                  typeof activeView?.show_internal_id_hints === "boolean"
                    ? activeView.show_internal_id_hints
                    : undefined
                }
                testIdPrefix={testIdPrefix}
              />
            )}
            {detailFooter}
          </TabsContent>
          {relatedResults.map((entry) => (
            <TabsContent key={entry.key} value={`related:${entry.key}`}>
              <div className="space-y-3">
                {entry.error ? (
                  <div className="space-y-2 text-sm text-ui-muted">
                    <p>{t("detail.related.unavailable")}</p>
                    <p className="text-xs text-ui-muted/70">{entry.error}</p>
                  </div>
                ) : (
                  <div className="space-y-2">
                    {entry.countLabel ? (
                      <div className="text-xs text-ui-muted">{entry.countLabel}</div>
                    ) : null}
                    <RelatedResourceTableClient
                      resourceKey={entry.key}
                      columns={entry.columns}
                      items={entry.items}
                      idKey={entry.idKey}
                      baseHref={entry.href}
                      appBasePath={appBasePath}
                      emptyMessage={t("detail.related.empty")}
                      reorder={entry.reorder}
                      capabilities={userCapabilities}
                      capabilityWrite={entry.capabilityWrite}
                      testIdPrefix={
                        testIdPrefix ? `${testIdPrefix}-related-${entry.key}` : null
                      }
                    />
                  </div>
                )}
                {entry.error ? (
                  <a
                    className="text-sm text-ui-ink underline underline-offset-4"
                    href={entry.href}
                  >
                    {t("detail.related.openFullView")}
                  </a>
                ) : null}
              </div>
            </TabsContent>
          ))}
        </Tabs>
      </div>
    ) : null;

  const suggestedResourceLinks =
    !isTimeoutError && errorMessage && resourceKeySuggestions.length > 0
      ? resourceKeySuggestions
          .map((suggestion) => {
            const suggestionHref = resolveSafeHref(
              appBasePath,
              `/resources/${encodeURIComponent(suggestion)}`
            );
            if (!suggestionHref) return null;
            return {
              href: suggestionHref,
              label: t("errors.openSuggestedResource", { resourceKey: suggestion }),
            };
          })
          .filter((entry): entry is { href: string; label: string } => Boolean(entry))
      : [];

  const normalizedScope = me
    ? normalizeUiScope({
        scopeType: me?.access_scope?.scope_type ?? null,
        scopeId: me?.access_scope?.scope_id ?? null,
      })
    : { scopeType: null, scopeId: null };
  const scopeLabel =
    normalizedScope.scopeType && normalizedScope.scopeId
      ? `${labelFromKey(normalizedScope.scopeType)}: ${formatReferenceValue(
          normalizedScope.scopeId
        )}`
      : normalizedScope.scopeType
        ? labelFromKey(normalizedScope.scopeType)
        : null;

  const buildNoticeDiagnostics = ({
    rawError,
    requiredCapability,
    testId,
  }: {
    rawError?: string | null;
    requiredCapability?: string | null;
    testId?: string;
  }) => {
    const entries: ContextNoticeDiagnosticsEntry[] = [
      {
        label: t("diagnostics.labels.resource"),
        value: resourceKey,
        copyValue: resourceKey,
        monospace: true,
      },
    ];

    if (scopeLabel) {
      entries.push({
        label: t("diagnostics.labels.scope"),
        value: scopeLabel,
        copyValue: normalizedScope.scopeId,
        monospace: true,
      });
    }

    if (paginationResolutionId) {
      entries.push({
        label: t("diagnostics.labels.settingsResolution"),
        value: formatReferenceValue(paginationResolutionId),
        copyValue: paginationResolutionId,
        monospace: true,
      });
    }

    if (activeView?.label || activeView?.id) {
      const viewLabel = String(activeView?.label ?? activeView?.id ?? "").trim();
      if (viewLabel) {
        entries.push({
          label: t("diagnostics.labels.view"),
          value: viewLabel,
          copyValue: activeView?.id ?? null,
          monospace: false,
        });
      }
    }

    if (requiredCapability) {
      entries.push({
        label: t("diagnostics.labels.requiredCapability"),
        value: requiredCapability,
        copyValue: requiredCapability,
        monospace: true,
      });
    }

    if (rawError) {
      entries.push({
        label: t("diagnostics.labels.rawError"),
        value: rawError,
        copyValue: rawError,
        monospace: true,
      });
    }

    return <ContextNoticeDiagnostics entries={entries} testId={testId} />;
  };

  const capabilityDeniedKey = extractCapabilityDeniedKey(deniedMessage);
  const blockedDetail = capabilityDeniedKey
    ? t("diagnostics.blockedDetailWithCapability", {
        capability: capabilityDeniedKey,
      })
    : deniedMessage;
  const blockedDetailNode = buildNoticeDiagnostics({
    rawError: deniedMessage,
    requiredCapability: capabilityDeniedKey,
    testId: blockedTestId ? `${blockedTestId}-diagnostics` : undefined,
  });
  const blockedNoticeDetail = (
    <div className="space-y-2 text-xs text-ui-muted">
      {blockedDetail ? <p>{blockedDetail}</p> : null}
      {blockedDetailNode}
    </div>
  );

  const unavailableDetailNode = buildNoticeDiagnostics({
    testId: errorTestId ? `${errorTestId}-diagnostics` : undefined,
  });
  const unavailableNoticeDetail = (
    <div className="space-y-2 text-xs text-ui-muted">
      {errorMessage ? <p>{errorMessage}</p> : null}
      {unavailableDetailNode}
    </div>
  );

  return (
    <div className="space-y-4">
      <PageHeader
        title={title}
        actions={effectiveHeaderActions}
      />
      {deniedMessage ? (
        <ContextNotice
          testId={blockedTestId}
          title={t("blocked.title")}
          action={t("blocked.action")}
          detailNode={blockedNoticeDetail}
        />
      ) : errorMessage ? (
        <ContextNotice
          testId={errorTestId}
          title={isTimeoutError ? t("timeout.title") : t("unavailable.title")}
          action={isTimeoutError ? t("timeout.action") : t("unavailable.action")}
          detailNode={unavailableNoticeDetail}
          links={suggestedResourceLinks}
          linksTitle={
            suggestedResourceLinks.length > 0
              ? t("errors.suggestedResources")
              : null
          }
        />
      ) : (
        <div className="space-y-4" data-testid={readyTestId}>
          <div className="flex flex-wrap items-center justify-between gap-4 text-xs text-ui-muted">
            <span
              data-testid={testIdPrefix ? `${testIdPrefix}-resource-summary` : undefined}
            >
              {summaryLabel}
            </span>
            <div className="flex flex-wrap items-center gap-2">
              {actionStats.total > 0 ? (
                <>
                  <div
                    className="inline-flex items-center gap-2 rounded-md px-2 py-1"
                    data-testid={
                      actionsTestIdBase
                        ? `${actionsTestIdBase}-configured`
                        : undefined
                    }
                  >
                    <span className="text-[11px] font-medium text-ui-muted">
                      {t("actions.label")}
                    </span>
                    <span className="text-ui-ink">
                      {t("actions.configured", { count: actionStats.total })}
                    </span>
                  </div>
                  <div
                    className="inline-flex items-center rounded-md px-2 py-1 text-ui-ink"
                    data-testid={
                      actionsTestIdBase
                        ? `${actionsTestIdBase}-available`
                        : undefined
                    }
                  >
                    {t("actions.available", { count: actionStats.allowed })}
                  </div>
                  {actionStats.blocked > 0 ? (
                    <div
                      className="inline-flex items-center rounded-md px-2 py-1 text-ui-ink"
                      data-testid={
                        actionsTestIdBase
                          ? `${actionsTestIdBase}-blocked`
                          : undefined
                      }
                    >
                      {t("actions.blocked", { count: actionStats.blocked })}
                    </div>
                  ) : null}
                </>
              ) : (
                <div
                  className="inline-flex items-center gap-2 rounded-md px-2 py-1"
                  data-testid={
                    actionsTestIdBase ? `${actionsTestIdBase}-empty` : undefined
                  }
                >
                  <span className="text-[11px] font-medium text-ui-muted">
                    {t("actions.label")}
                  </span>
                  <span className="text-ui-ink">{t("actions.empty")}</span>
                </div>
              )}
              {commandCatalogHref ? (
                <a
                  className="text-[11px] font-medium text-ui-muted underline underline-offset-4 transition hover:text-ui-ink"
                  href={commandCatalogHref}
                >
                  {t("actions.manage")}
                </a>
              ) : null}
            </div>
          </div>
          {metricsError && analyticsEnabled ? (
            <EmptyState
              variant="inline"
              title={t("errors.metricsTitle")}
              description={metricsError}
            />
          ) : null}
          {commandError ? (
            <EmptyState
              variant="inline"
              title={t("errors.commandTitle")}
              description={commandError}
              action={commandCatalogAction}
            />
          ) : null}
          <ResourceFilterChips
            filters={resource?.filters ?? null}
            appliedFilters={appliedFilters}
            searchParams={searchParams}
            actionHref={safeBaseHref}
            testIdPrefix={testIdPrefix}
            opLabels={filterOperatorLabels}
            locale={locale}
          />
          <ResourceDetailClient
            detailId={detailId ?? null}
            initialOpen={detailOpen}
            initialLayout={detailLayoutMode}
            detailTitle={detailTitle}
            detailBody={detailBodyContent}
            navigation={detailNavigation}
            listHref={listHref}
            splitLayoutStorageKey={`masarx:resource-detail-panel:v1:${appBasePath}:${me?.user?.id ?? "anonymous"}:${resourceKey}:${activeView?.id ?? "default"}`}
            appBasePath={appBasePath}
            detailPreferenceResourceKey={resourceKey}
            testIdPrefix={testIdPrefix}
            table={
              <ResourceTableClient
                key="resource-table"
                columns={columns}
                items={list?.items ?? []}
                idKey={resource?.id_column ?? "id"}
                resourceKey={resourceKey}
                filters={resource?.filters ?? null}
                filterOperatorLabels={filterOperatorLabels}
                filterOperatorKeys={filterOperatorKeys}
                serverPageSizes={allowedPageSizes}
                capabilities={userCapabilities}
                capabilityWrite={
                  resource?.capability_write ?? resource?.capability_read ?? null
                }
                baseHref={safeBaseHref}
                defaultSort={tableDefaultSort}
                emptyMessage={t("table.empty")}
                viewState={viewState}
                datasetMetrics={
                  datasetMetrics
                    ? { total: datasetMetrics.total, columns: datasetMetrics.columns }
                    : null
                }
                showAnalytics={analyticsEnabled}
                clientPagination={clientPagination}
                bulkActions={bulkActions}
                testIdPrefix={testIdPrefix}
                appBasePath={appBasePath}
                toolbarAction={importAction}
                serverFetch={{
                  resourceKey,
                  baseHref: safeBaseHref,
                  initialList: list,
                  initialLimit: listLimit,
                  initialOffset: listOffset,
                  initialSort: sortState,
                  initialFilters: filterTree ?? filters,
                  initialTotalIsEstimate: listTotalIsEstimate,
                  searchParams,
                }}
              />
            }
          />
        </div>
      )}
    </div>
  );
}
