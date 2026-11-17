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

  const search = React.useCallback(
    (nextQuery: string) => {
      setQuery(nextQuery);
      if (!enabled) return;

      // Clear pending timer
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }

      // Abort pending request
      if (abortRef.current) {
        abortRef.current.abort();
        abortRef.current = null;
      }

      if (!nextQuery.trim()) {
        setResults([]);
        setLoading(false);
        return;
      }

      setLoading(true);
      timerRef.current = setTimeout(async () => {
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
    [debounceMs, enabled, fetcher]
  );

  React.useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      if (abortRef.current) abortRef.current.abort();
    };
  }, []);

  return { query, search, results, loading };
}
