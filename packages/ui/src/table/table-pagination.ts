"use client";
import * as React from "react";
import { buildHref } from "../url";
import type { ResourceViewEntry, ResourceViewState } from "./view-types";

export type PaginationMode = "client" | "server";

export type ClientPaginationConfig = {
  pageSizes: number[];
  defaultPageSize?: number | null;
  defaultMode?: PaginationMode;
  modeOptions?: PaginationMode[];
  searchDebounceMs?: number | null;
  searchDebounceOptions?: number[];
};

type RouterLike = { replace: (href: string) => void };
type SearchParamsLike = { toString: () => string };

type TablePaginationParams = {
  clientPagination: ClientPaginationConfig | null;
  activeView: ResourceViewEntry | null;
  viewState: ResourceViewState | null;
  baseHref?: string | null;
  router: RouterLike;
  searchParams: SearchParamsLike;
  sortedItems: Record<string, unknown>[];
  normalizedSearch: string;
  sortSignature: string;
  activeFilters: Record<string, unknown> | null;
};

type TablePaginationState = {
  paginationModeOptions: PaginationMode[];
  paginationMode: PaginationMode;
  handlePaginationModeChange: (value: PaginationMode) => void;
  clientPaginationEnabled: boolean;
  clientPageSize: number | null;
  handleClientPageSizeChange: (value: number) => void;
  resolvedClientPageSizes: number[];
  resolvedClientPage: number;
  totalClientPages: number;
  showPageControls: boolean;
  canPageBack: boolean;
  canPageForward: boolean;
  pageInput: string;
  handlePageInputChange: (value: string) => void;
  resetPageInput: () => void;
  goToFirstPage: () => void;
  goToPrevPage: () => void;
  goToNextPage: () => void;
  goToLastPage: () => void;
  pageStartLabel: number;
  pageEndLabel: number;
  pagedItems: Record<string, unknown>[];
  resetPagination: () => void;
};

function resolvePaginationMode(
  value: string | null | undefined,
  options: PaginationMode[],
  fallback: PaginationMode
): PaginationMode {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase();
  if (!normalized) return fallback;
  return options.includes(normalized as PaginationMode)
    ? (normalized as PaginationMode)
    : fallback;
}

export function useTablePagination({
  clientPagination,
  activeView,
  viewState,
  baseHref,
  router,
  searchParams,
  sortedItems,
  normalizedSearch,
  sortSignature,
  activeFilters,
}: TablePaginationParams): TablePaginationState {
  const pagingModeParam =
    new URLSearchParams(searchParams.toString()).get("paging_mode")?.trim() ?? "";
  const clientPageSizes = React.useMemo(() => {
    const raw = clientPagination?.pageSizes ?? [];
    const normalized = raw
      .map((entry) => Number(entry))
      .filter((entry) => Number.isFinite(entry) && entry > 0);
    return Array.from(new Set(normalized)).sort((a, b) => a - b);
  }, [clientPagination?.pageSizes]);
  const clientPaginationAvailable = clientPageSizes.length > 0;
  const paginationModeOptions = React.useMemo<PaginationMode[]>(() => {
    const raw = clientPagination?.modeOptions ?? [];
    const normalized = raw
      .map((entry) => String(entry ?? "").trim().toLowerCase())
      .filter(
        (entry): entry is PaginationMode =>
          entry === "client" || entry === "server"
      );
    if (!clientPaginationAvailable) return ["server"];
    if (normalized.length === 0) return ["client", "server"];
    return Array.from(new Set(normalized));
  }, [clientPagination?.modeOptions, clientPaginationAvailable]);
  const defaultPaginationMode = React.useMemo(() => {
    const fallback: PaginationMode =
      clientPaginationAvailable && paginationModeOptions.includes("client")
        ? "client"
        : "server";
    return resolvePaginationMode(
      pagingModeParam || activeView?.pagination_mode || clientPagination?.defaultMode,
      paginationModeOptions,
      fallback
    );
  }, [
    pagingModeParam,
    activeView?.pagination_mode,
    clientPagination?.defaultMode,
    paginationModeOptions,
    clientPaginationAvailable,
  ]);
  const [paginationMode, setPaginationMode] = React.useState<PaginationMode>(
    () => defaultPaginationMode
  );

  React.useEffect(() => {
    setPaginationMode(defaultPaginationMode);
  }, [defaultPaginationMode]);

  const clientPaginationEnabled =
    clientPaginationAvailable && paginationMode === "client";
  const defaultClientPageSize = React.useMemo(() => {
    if (!clientPaginationAvailable) return null;
    const maxSize = clientPageSizes[clientPageSizes.length - 1] ?? 0;
    const preferred =
      clientPagination?.defaultPageSize ??
      viewState?.pageSize ??
      clientPageSizes[0] ??
      0;
    const safePreferred = Math.min(Math.max(Number(preferred) || 0, 1), maxSize);
    return safePreferred || clientPageSizes[0] || 1;
  }, [
    clientPaginationAvailable,
    clientPagination?.defaultPageSize,
    viewState?.pageSize,
    clientPageSizes,
  ]);
  const resolvedClientPageSizes = React.useMemo(() => {
    if (!clientPaginationAvailable) return [];
    if (!defaultClientPageSize) return clientPageSizes;
    if (clientPageSizes.includes(defaultClientPageSize)) return clientPageSizes;
    return [...clientPageSizes, defaultClientPageSize].sort((a, b) => a - b);
  }, [clientPaginationAvailable, clientPageSizes, defaultClientPageSize]);
  const [clientPageSize, setClientPageSize] = React.useState<number | null>(
    () => defaultClientPageSize
  );
  const [clientPage, setClientPage] = React.useState(1);
  const [pageInput, setPageInput] = React.useState("1");

  React.useEffect(() => {
    if (!clientPaginationEnabled) return;
    setClientPageSize((current) => {
      if (current && resolvedClientPageSizes.includes(current)) return current;
      return defaultClientPageSize ?? resolvedClientPageSizes[0] ?? null;
    });
  }, [clientPaginationEnabled, resolvedClientPageSizes, defaultClientPageSize]);

  React.useEffect(() => {
    if (!clientPaginationEnabled) return;
    setClientPage(1);
  }, [clientPaginationEnabled, normalizedSearch, activeFilters, sortSignature]);

  const totalClientPages =
    clientPaginationEnabled && clientPageSize
      ? Math.max(1, Math.ceil(sortedItems.length / clientPageSize))
      : 1;
  const resolvedClientPage = clientPaginationEnabled
    ? Math.min(Math.max(clientPage, 1), totalClientPages)
    : 1;
  const showPageControls = clientPaginationEnabled && totalClientPages > 1;
  const canPageBack = resolvedClientPage > 1;
  const canPageForward = resolvedClientPage < totalClientPages;
  const clientPageStart =
    clientPaginationEnabled && clientPageSize
      ? (resolvedClientPage - 1) * clientPageSize
      : 0;
  const clientPageEnd =
    clientPaginationEnabled && clientPageSize
      ? Math.min(clientPageStart + clientPageSize, sortedItems.length)
      : sortedItems.length;
  const pagedItems = clientPaginationEnabled
    ? sortedItems.slice(clientPageStart, clientPageEnd)
    : sortedItems;
  const pageStartLabel = pagedItems.length === 0 ? 0 : clientPageStart + 1;
  const pageEndLabel = pagedItems.length === 0 ? 0 : clientPageEnd;

  React.useEffect(() => {
    if (!clientPaginationEnabled) return;
    if (clientPage <= totalClientPages) return;
    setClientPage(totalClientPages);
  }, [clientPaginationEnabled, clientPage, totalClientPages]);

  React.useEffect(() => {
    if (!clientPaginationEnabled) return;
    setPageInput(String(resolvedClientPage));
  }, [clientPaginationEnabled, resolvedClientPage]);

  const handlePageInputChange = (value: string) => {
    setPageInput(value);
    if (!value.trim()) return;
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return;
    const nextPage = Math.min(Math.max(Math.floor(parsed), 1), totalClientPages);
    setClientPage(nextPage);
  };

  const resetPageInput = () => {
    setPageInput(String(resolvedClientPage));
  };

  const handleClientPageSizeChange = (value: number) => {
    if (!clientPaginationEnabled) return;
    setClientPageSize(value);
    setClientPage(1);
  };

  const handlePaginationModeChange = (value: PaginationMode) => {
    if (!paginationModeOptions.includes(value)) return;
    setPaginationMode(value);
    setClientPage(1);
    setPageInput("1");
    if (!baseHref) return;
    const params = new URLSearchParams(searchParams.toString());
    params.set("paging_mode", value);
    params.set("page", "1");
    params.set("offset", "0");
    router.replace(buildHref(baseHref, params));
  };

  const goToFirstPage = () => setClientPage(1);
  const goToPrevPage = () => setClientPage((page) => Math.max(1, page - 1));
  const goToNextPage = () =>
    setClientPage((page) => Math.min(totalClientPages, page + 1));
  const goToLastPage = () => setClientPage(totalClientPages);

  const resetPagination = () => {
    setPaginationMode(defaultPaginationMode);
    setPageInput("1");
    if (clientPaginationAvailable && defaultPaginationMode === "client") {
      setClientPage(1);
      setClientPageSize(
        defaultClientPageSize ?? resolvedClientPageSizes[0] ?? null
      );
    } else if (clientPaginationAvailable) {
      setClientPage(1);
    }
  };

  return {
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
  };
}
