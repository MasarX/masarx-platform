"use client";

import { stableStringify } from "../utils";
import type { SortState } from "./sorting";
import type { ConditionalFormattingRule, ResourceViewEntry } from "./view-types";
import type { DetailOpenMode } from "./open-mode";

type ColumnWidthMap = Record<string, number>;

type ViewPayloadParams = {
  viewId: string;
  label: string;
  columnOrder: string[];
  visibleColumns: Set<string>;
  pinnedColumns: string[];
  columnWidths: ColumnWidthMap;
  rowDensity: "comfortable" | "compact";
  openMode: DetailOpenMode;
  showInternalIdHints: boolean;
  analyticsEnabled: boolean;
  summaryRowEnabled: boolean;
  activeFilters: Record<string, unknown> | null;
  sortState: SortState[];
  resolvedGroupBy: string[];
  pageSize: number | null;
  paginationMode: string;
  searchDebounceMs: number;
  conditionalFormatting: ConditionalFormattingRule[] | null;
};

type BuildNextValueParams = {
  scopeValue: unknown;
  resourceKey: string;
  viewId: string;
  payload: ReturnType<typeof buildViewPayload>;
  makeDefault: boolean;
};

type BuildDeleteValueParams = {
  scopeValue: unknown;
  resourceKey: string;
  viewEntries: { id: string }[];
  viewId: string;
};

type ViewSettings = {
  columns: {
    order: string[];
    hidden: string[];
    pinned: string[];
    widths: Record<string, number>;
  };
  density: string | null;
  open_mode: string | null;
  show_internal_id_hints: boolean | null;
  analytics: boolean | null;
  summary_row: boolean | null;
  filters: Record<string, unknown> | null;
  sort: Array<{ key: string; direction: string | null }> | null;
  group_by: string[] | null;
  page_size: number | null;
  pagination_mode: string | null;
  search_debounce_ms: number | null;
  conditional_formatting: ConditionalFormattingRule[] | null;
};

function normalizeList(values: string[] | null | undefined) {
  return Array.isArray(values) ? values.filter(Boolean) : [];
}

function normalizeWidths(
  widths: Record<string, number> | null | undefined
): Record<string, number> {
  if (!widths) return {};
  return Object.keys(widths)
    .filter((key) => Number.isFinite(widths[key]))
    .sort()
    .reduce<Record<string, number>>((acc, key) => {
      acc[key] = widths[key]!;
      return acc;
    }, {});
}

function normalizeSort(
  sort:
    | { key: string; direction?: string | null }
    | { key: string; direction?: string | null }[]
    | null
    | undefined
) {
  if (!sort) return null;
  const list = Array.isArray(sort) ? sort : [sort];
  return list
    .filter((entry) => Boolean(entry?.key))
    .map((entry) => ({
      key: entry.key,
      direction: entry.direction ?? null,
    }));
}

function normalizeViewSettings(input: {
  columns?: {
    order?: string[] | null;
    hidden?: string[] | null;
    pinned?: string[] | null;
    widths?: Record<string, number> | null;
  } | null;
  density?: string | null;
  open_mode?: string | null;
  show_internal_id_hints?: boolean | null;
  analytics?: boolean | null;
  summary_row?: boolean | null;
  filters?: Record<string, unknown> | null;
  sort?:
    | { key: string; direction?: string | null }
    | { key: string; direction?: string | null }[]
    | null;
  group_by?: string[] | string | null;
  page_size?: number | null;
  pagination_mode?: string | null;
  search_debounce_ms?: number | null;
  conditional_formatting?: ConditionalFormattingRule[] | null;
}): ViewSettings {
  const order = normalizeList(input.columns?.order);
  const hidden = normalizeList(input.columns?.hidden);
  const pinned = normalizeList(input.columns?.pinned);
  const widths = normalizeWidths(input.columns?.widths);
  const groupBy =
    typeof input.group_by === "string"
      ? [input.group_by]
      : normalizeList(input.group_by ?? []);
  return {
    columns: {
      order,
      hidden,
      pinned,
      widths,
    },
    density: input.density ?? null,
    open_mode: input.open_mode ?? null,
    show_internal_id_hints: input.show_internal_id_hints ?? null,
    analytics: input.analytics ?? null,
    summary_row: input.summary_row ?? null,
    filters: input.filters ?? null,
    sort: normalizeSort(input.sort),
    group_by: groupBy.length > 0 ? groupBy : null,
    page_size: input.page_size ?? null,
    pagination_mode: input.pagination_mode ?? null,
    search_debounce_ms: input.search_debounce_ms ?? null,
    conditional_formatting: Array.isArray(input.conditional_formatting)
      ? input.conditional_formatting
      : null,
  };
}

export function viewSettingsFromEntry(entry: ResourceViewEntry | null) {
  if (!entry) return null;
  return normalizeViewSettings(entry);
}

export function viewSettingsFromPayload(
  payload: ReturnType<typeof buildViewPayload>
) {
  return normalizeViewSettings(payload);
}

export function areViewSettingsEqual(
  left: ViewSettings | null,
  right: ViewSettings | null
) {
  if (!left || !right) return false;
  return stableStringify(left) === stableStringify(right);
}

export function buildViewPayload({
  viewId,
  label,
  columnOrder,
  visibleColumns,
  pinnedColumns,
  columnWidths,
  rowDensity,
  openMode,
  showInternalIdHints,
  analyticsEnabled,
  summaryRowEnabled,
  activeFilters,
  sortState,
  resolvedGroupBy,
  pageSize,
  paginationMode,
  searchDebounceMs,
  conditionalFormatting,
}: ViewPayloadParams) {
  const hidden = columnOrder.filter((key) => !visibleColumns.has(key));
  const pinned = pinnedColumns.filter((key) => visibleColumns.has(key));
  const widths = Object.entries(columnWidths).reduce<ColumnWidthMap>(
    (acc, [key, value]) => {
      if (!visibleColumns.has(key)) return acc;
      if (!Number.isFinite(value) || value <= 0) return acc;
      acc[key] = value;
      return acc;
    },
    {}
  );
  return {
    id: viewId,
    label,
    columns: {
      order: [...columnOrder],
      hidden,
      pinned,
      widths: Object.keys(widths).length > 0 ? widths : null,
    },
    density: rowDensity,
    open_mode: openMode,
    show_internal_id_hints: showInternalIdHints,
    analytics: analyticsEnabled,
    summary_row: summaryRowEnabled,
    filters: activeFilters ?? null,
    sort:
      sortState.length === 0
        ? null
        : sortState.length === 1
          ? sortState[0]
          : sortState,
    group_by: resolvedGroupBy.length > 0 ? resolvedGroupBy : null,
    page_size: pageSize ?? null,
    pagination_mode: paginationMode,
    search_debounce_ms: searchDebounceMs,
    conditional_formatting: Array.isArray(conditionalFormatting) && conditionalFormatting.length > 0
      ? conditionalFormatting
      : null,
  };
}

export function buildNextValue({
  scopeValue,
  resourceKey,
  viewId,
  payload,
  makeDefault,
}: BuildNextValueParams) {
  const base =
    scopeValue && typeof scopeValue === "object"
      ? { ...(scopeValue as Record<string, unknown>) }
      : {};
  const resources =
    base.resources && typeof base.resources === "object"
      ? { ...(base.resources as Record<string, unknown>) }
      : {};
  const resourceConfig =
    resources[resourceKey] && typeof resources[resourceKey] === "object"
      ? { ...(resources[resourceKey] as Record<string, unknown>) }
      : {};
  const views =
    resourceConfig.views && typeof resourceConfig.views === "object"
      ? { ...(resourceConfig.views as Record<string, unknown>) }
      : {};
  views[viewId] = payload;
  resourceConfig.views = views;
  if (makeDefault) {
    resourceConfig.default_view_id = viewId;
  }
  resources[resourceKey] = resourceConfig;
  base.resources = resources;
  return base;
}

export function buildDeleteValue({
  scopeValue,
  resourceKey,
  viewEntries,
  viewId,
}: BuildDeleteValueParams) {
  const base =
    scopeValue && typeof scopeValue === "object"
      ? { ...(scopeValue as Record<string, unknown>) }
      : {};
  const resources =
    base.resources && typeof base.resources === "object"
      ? { ...(base.resources as Record<string, unknown>) }
      : {};
  const resourceConfig =
    resources[resourceKey] && typeof resources[resourceKey] === "object"
      ? { ...(resources[resourceKey] as Record<string, unknown>) }
      : {};
  const views =
    resourceConfig.views && typeof resourceConfig.views === "object"
      ? { ...(resourceConfig.views as Record<string, unknown>) }
      : {};
  if (Object.keys(views).length === 0 && viewEntries.length > 0) {
    viewEntries.forEach((view) => {
      views[view.id] = view;
    });
  }
  delete views[viewId];
  const remainingViewIds = Object.keys(views);
  resourceConfig.views = remainingViewIds.length > 0 ? views : null;
  if (resourceConfig.default_view_id === viewId) {
    resourceConfig.default_view_id = remainingViewIds[0] ?? null;
  }
  resources[resourceKey] = resourceConfig;
  base.resources = resources;
  return base;
}
