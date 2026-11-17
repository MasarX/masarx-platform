"use client";

import * as React from "react";

type UseComboboxSearchParams = {
  fetcher: (query: string) => Promise<{ label: string; value: string }[]>;
  debounceMs?: number;
  enabled?: boolean;
};

/**
 * Async debounced search hook for Combobox server-side filtering.
 */
export function useComboboxSearch({
  fetcher,
  debounceMs = 300,
  enabled = true,
}: UseComboboxSearchParams) {
  const [query, setQuery] = React.useState("");
  const [loading, setLoading] = React.useState(false);
  const [results, setResults] = React.useState<
    { label: string; value: string }[]
  >([]);
  const abortRef = React.useRef<AbortController | null>(null);
  const timerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  const cancelPending = React.useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
    }
  }, []);

  const search = React.useCallback(
    (nextQuery: string) => {
      setQuery(nextQuery);
      cancelPending();

      if (!enabled || !nextQuery.trim()) {
        setResults([]);
        setLoading(false);
        return;
      }

      setLoading(true);
      timerRef.current = setTimeout(async () => {
        timerRef.current = null;
        const controller = new AbortController();
        abortRef.current = controller;
        try {
          const data = await fetcher(nextQuery.trim());
          if (!controller.signal.aborted) {
            setResults(data);
            setLoading(false);
          }
        } catch {
          if (!controller.signal.aborted) {
            setResults([]);
            setLoading(false);
          }
        }
      }, debounceMs);
    },
    [cancelPending, debounceMs, enabled, fetcher]
  );

  React.useEffect(() => {
    if (!enabled) {
      cancelPending();
      setLoading(false);
      setResults([]);
    }
    return cancelPending;
  }, [cancelPending, enabled]);

  return { query, search, results, loading };
}
