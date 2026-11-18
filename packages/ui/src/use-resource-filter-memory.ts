"use client";

import { useEffect, useCallback } from "react";

const STORAGE_PREFIX = "masarx:resource-filters:";

type FilterMemoryState = {
  search: string;
  page: string;
  offset: string;
  filters: string;
  sort: string;
  direction: string;
  savedAt: number;
};

const FILTER_KEYS = ["search", "page", "offset", "filters", "sort", "direction"] as const;

/**
 * Saves the current filter/pagination state for a resource to sessionStorage.
 * When the user navigates back to the resource page, the filters can be restored
 * instead of showing an unfiltered view.
 *
 * Call `restoreFilters()` on mount to check for saved state.
 * The hook auto-saves on URL changes.
 */
export function useResourceFilterMemory(resourceKey: string) {
  // Auto-save current URL filter state on changes
  useEffect(() => {
    if (typeof window === "undefined") return;
    const saveCurrentState = () => {
      try {
        const params = new URLSearchParams(window.location.search);
        const state: FilterMemoryState = {
          search: params.get("search") ?? "",
          page: params.get("page") ?? "",
          offset: params.get("offset") ?? "",
          filters: params.get("filters") ?? "",
          sort: params.get("sort") ?? "",
          direction: params.get("direction") ?? "",
          savedAt: Date.now(),
        };
        // Only save if there are actual filter params
        const hasFilters = FILTER_KEYS.some((k) => state[k]);
        if (hasFilters) {
          window.sessionStorage.setItem(
            `${STORAGE_PREFIX}${resourceKey}`,
            JSON.stringify(state),
          );
        }
      } catch {
        // ignore
      }
    };

    // Save on popstate (browser back/forward)
    window.addEventListener("popstate", saveCurrentState);
    // Save on beforeunload (page close/refresh)
    window.addEventListener("beforeunload", saveCurrentState);
    // Save initial state
    saveCurrentState();

    return () => {
      saveCurrentState();
      window.removeEventListener("popstate", saveCurrentState);
      window.removeEventListener("beforeunload", saveCurrentState);
    };
  }, [resourceKey]);

  /**
   * Returns saved filter state if available and less than 30 minutes old.
   * Clears the saved state after reading.
   */
  const restoreFilters = useCallback((): Record<string, string> | null => {
    if (typeof window === "undefined") return null;
    try {
      const raw = window.sessionStorage.getItem(`${STORAGE_PREFIX}${resourceKey}`);
      if (!raw) return null;
      const state = JSON.parse(raw) as FilterMemoryState;
      // Discard if older than 30 minutes
      if (Date.now() - state.savedAt > 30 * 60 * 1000) {
        window.sessionStorage.removeItem(`${STORAGE_PREFIX}${resourceKey}`);
        return null;
      }
      const result: Record<string, string> = {};
      for (const key of FILTER_KEYS) {
        if (state[key]) {
          result[key] = state[key];
        }
      }
      return Object.keys(result).length > 0 ? result : null;
    } catch {
      return null;
    }
  }, [resourceKey]);

  const clearFilters = useCallback(() => {
    if (typeof window === "undefined") return;
    try {
      window.sessionStorage.removeItem(`${STORAGE_PREFIX}${resourceKey}`);
    } catch {
      // ignore
    }
  }, [resourceKey]);

  return { restoreFilters, clearFilters };
}
