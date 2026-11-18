"use client";

import { useState } from "react";
import {
  useQuery,
  useQueryClient,
  keepPreviousData,
  hashKey,
  type QueryKey,
} from "@tanstack/react-query";
import { createUiClient, type UiResourceList, type UiSort } from "@masarx/api";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ResourceQueryParams = {
  /** The resource key to query (e.g. "orders", "products"). */
  resourceKey: string;
  /** Active filter tree or flat filters. Defaults to `{}` when null/undefined. */
  filters?: Record<string, unknown> | null;
  /** Active sort column and direction. */
  sort?: UiSort | null;
  /** Page size. */
  limit: number;
  /** Pagination offset. */
  offset: number;
  /** Server-rendered data for the initial query parameters only. */
  initialData?: UiResourceList | null;
  /** Whether the query is enabled. Defaults to `true`. */
  enabled?: boolean;
};

// ---------------------------------------------------------------------------
// Query-key builder (exported so consumers can invalidate deterministically)
// ---------------------------------------------------------------------------

export function resourceQueryKey(
  resourceKey: string,
  params: {
    filters?: Record<string, unknown> | null;
    sort?: UiSort | null;
    limit: number;
    offset: number;
  }
): QueryKey {
  return [
    "resource",
    resourceKey,
    {
      filters: params.filters ?? {},
      sort: params.sort ?? null,
      limit: params.limit,
      offset: params.offset,
    },
  ] as const;
}

// ---------------------------------------------------------------------------
// useResourceQuery
// ---------------------------------------------------------------------------

export function useResourceQuery({
  resourceKey,
  filters,
  sort,
  limit,
  offset,
  initialData,
  enabled,
}: ResourceQueryParams) {
  const queryKey = resourceQueryKey(resourceKey, {
    filters,
    sort,
    limit,
    offset,
  });
  // The server list belongs to the initial filters/sort/page. Seeding a new
  // query key with it would mark the wrong page fresh and suppress its fetch.
  const [initialQueryHash] = useState(() => hashKey(queryKey));
  const canSeedInitialData = hashKey(queryKey) === initialQueryHash;

  return useQuery<UiResourceList>({
    queryKey,
    queryFn: async () => {
      const ui = createUiClient();
      return ui.listResource(
        resourceKey,
        filters ?? {},
        limit,
        offset,
        sort ?? null
      );
    },
    enabled: Boolean(resourceKey) && (enabled ?? true),
    staleTime: 30_000,
    placeholderData: keepPreviousData,
    ...(initialData && canSeedInitialData ? { initialData } : {}),
  });
}

// ---------------------------------------------------------------------------
// useResourceListInvalidate — invalidate / refetch after mutations
// ---------------------------------------------------------------------------

/**
 * Returns a helper that invalidates all cached queries for a given resource,
 * regardless of their filter/sort/pagination parameters.
 *
 * Usage:
 * ```ts
 * const invalidateOrders = useResourceListInvalidate("orders");
 * // after a mutation succeeds:
 * await invalidateOrders();
 * ```
 */
export function useResourceListInvalidate(resourceKey: string) {
  const queryClient = useQueryClient();

  return async () => {
    await queryClient.invalidateQueries(
      {
        queryKey: ["resource", resourceKey],
      },
      {
        throwOnError: true,
      }
    );
  };
}
