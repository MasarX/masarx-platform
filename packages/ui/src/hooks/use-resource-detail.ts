"use client";

import { useQuery, type QueryKey } from "@tanstack/react-query";
import { createUiClient } from "@masarx/api";

// ---------------------------------------------------------------------------
// Query-key builder
// ---------------------------------------------------------------------------

export function resourceDetailQueryKey(
  resourceKey: string,
  detailId: string
): QueryKey {
  return ["resource-detail", resourceKey, detailId] as const;
}

// ---------------------------------------------------------------------------
// useResourceDetail
// ---------------------------------------------------------------------------

type ResourceDetailParams = {
  resourceKey: string;
  detailId: string | null;
  initialData?: Record<string, unknown> | null;
  enabled?: boolean;
};

export function useResourceDetail({
  resourceKey,
  detailId,
  initialData,
  enabled,
}: ResourceDetailParams) {
  const queryKey = resourceDetailQueryKey(resourceKey, detailId ?? "");

  return useQuery<Record<string, unknown> | null>({
    queryKey,
    queryFn: async () => {
      if (!detailId) return null;
      const ui = createUiClient();
      return ui.getResource(resourceKey, detailId);
    },
    enabled: Boolean(resourceKey && detailId) && (enabled ?? true),
    staleTime: 30_000,
    ...(initialData !== undefined ? { initialData } : {}),
  });
}
