import { getUiDefaults } from "@masarx/config";

const uiDefaults = getUiDefaults();
export const DEFAULT_LIMIT = uiDefaults.pagination.defaultPageSize;
const DEFAULT_PAGE_SIZES = uiDefaults.pagination.allowedPageSizes;
const DEFAULT_MAX_PAGE_SIZE = uiDefaults.pagination.maxPageSize;
const DEFAULT_SEARCH_DEBOUNCE_MS = uiDefaults.pagination.searchDebounceMs;
const DEFAULT_SEARCH_DEBOUNCE_OPTIONS =
  uiDefaults.pagination.searchDebounceOptions;
const DEFAULT_PAGING_MODE = uiDefaults.pagination.pagingMode;
const DEFAULT_PAGING_MODE_OPTIONS = uiDefaults.pagination.pagingModeOptions;

/** Describe the displayed response, without treating a planner estimate as a count. */
export function resolvePaginationDisplay({
  total,
  totalIsEstimate,
  offset,
  itemsCount,
}: {
  total: number | null;
  totalIsEstimate: boolean;
  offset: number;
  itemsCount: number;
}) {
  const safeOffset = Number.isFinite(offset) ? Math.max(0, Math.floor(offset)) : 0;
  const count = Number.isFinite(itemsCount) ? Math.max(0, Math.floor(itemsCount)) : 0;
  const knownTotal = typeof total === "number" && Number.isFinite(total) && total >= 0
    ? total
    : null;
  const displayTotal = totalIsEstimate && count > 0 && knownTotal !== null
    ? Math.max(knownTotal, safeOffset + count)
    : knownTotal;
  const start = count > 0 ? safeOffset + 1 : 0;
  const end = count > 0 ? safeOffset + count : 0;
  return {
    total: displayTotal,
    start: !totalIsEstimate && knownTotal !== null ? Math.min(start, knownTotal) : start,
    end: !totalIsEstimate && knownTotal !== null ? Math.min(end, knownTotal) : end,
  };
}

function normalizeSizes(values: unknown, fallback: number[]) {
  const raw = Array.isArray(values) ? values : fallback;
  return Array.from(
    new Set(
      raw
        .map((entry) => Number(entry))
        .filter((entry) => Number.isFinite(entry) && entry > 0)
    )
  ).sort((a, b) => a - b);
}

function normalizeDebounceOptions(values: unknown, fallback: number[]) {
  const raw = Array.isArray(values) ? values : fallback;
  return Array.from(
    new Set(
      raw
        .map((entry) => Number(entry))
        .filter((entry) => Number.isFinite(entry) && entry >= 0)
    )
  ).sort((a, b) => a - b);
}

const PAGING_MODES = ["server", "client"] as const;
type PagingMode = (typeof PAGING_MODES)[number];

function normalizePagingModes(values: unknown, fallback: PagingMode[]) {
  const raw = Array.isArray(values) ? values : fallback;
  return Array.from(
    new Set(
      raw
        .map((entry) => String(entry ?? "").trim().toLowerCase())
        .filter((entry): entry is PagingMode =>
          PAGING_MODES.includes(entry as PagingMode)
        )
    )
  );
}

function resolvePagingMode(
  value: unknown,
  options: PagingMode[],
  fallback: PagingMode
) {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (!normalized) return fallback;
  return options.includes(normalized as PagingMode)
    ? (normalized as PagingMode)
    : fallback;
}

function clampNumber(value: unknown, min: number, max: number) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  return Math.min(Math.max(parsed, min), max);
}

export function resolvePaginationSettings(value: unknown) {
  const raw =
    value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const maxPageSize =
    clampNumber(raw.max_page_size ?? DEFAULT_MAX_PAGE_SIZE, 1, 1000) ??
    DEFAULT_MAX_PAGE_SIZE;
  const allowedSizes = normalizeSizes(raw.allowed_sizes, DEFAULT_PAGE_SIZES)
    .filter((entry) => entry <= maxPageSize);
  const defaultPageSizeRaw =
    clampNumber(raw.default_page_size ?? DEFAULT_LIMIT, 1, maxPageSize) ??
    DEFAULT_LIMIT;
  const defaultPageSize = allowedSizes.includes(defaultPageSizeRaw)
    ? defaultPageSizeRaw
    : allowedSizes[0] ?? defaultPageSizeRaw;
  const clientMaxRows =
    clampNumber(raw.client_max_rows ?? maxPageSize, 1, maxPageSize) ??
    maxPageSize;
  const clientAllowedSizes = normalizeSizes(
    raw.client_allowed_sizes,
    allowedSizes
  ).filter((entry) => entry <= clientMaxRows);
  const clientDefaultRaw =
    clampNumber(
      raw.client_default_page_size ?? defaultPageSize,
      1,
      clientMaxRows
    ) ?? defaultPageSize;
  const clientDefaultPageSize = clientAllowedSizes.includes(clientDefaultRaw)
    ? clientDefaultRaw
    : clientAllowedSizes[0] ?? clientDefaultRaw;
  const searchDebounceOptions = normalizeDebounceOptions(
    raw.search_debounce_options,
    DEFAULT_SEARCH_DEBOUNCE_OPTIONS
  );
  const searchDebounceMs =
    clampNumber(
      raw.search_debounce_ms ?? DEFAULT_SEARCH_DEBOUNCE_MS,
      0,
      10000
    ) ?? DEFAULT_SEARCH_DEBOUNCE_MS;
  const pagingModeOptions = normalizePagingModes(
    raw.paging_mode_options,
    DEFAULT_PAGING_MODE_OPTIONS
  );
  const fallbackPagingMode = pagingModeOptions.includes(DEFAULT_PAGING_MODE)
    ? DEFAULT_PAGING_MODE
    : pagingModeOptions[0] ?? "server";
  const pagingMode = resolvePagingMode(
    raw.paging_mode,
    pagingModeOptions,
    fallbackPagingMode
  );
  return {
    maxPageSize,
    allowedSizes,
    defaultPageSize,
    clientMaxRows,
    clientAllowedSizes,
    clientDefaultPageSize,
    searchDebounceMs,
    searchDebounceOptions,
    pagingMode,
    pagingModeOptions,
  };
}
