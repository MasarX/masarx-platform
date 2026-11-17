"use client";
import { useQuery } from "@tanstack/react-query";
import { createUiClient } from "@masarx/api";
import { resolveResourceReadScopeId } from "./capabilities";

type ReadRegistryOptions = {
  organizationId?: string | null;
  userId?: string | null;
  scopeType?: string | null;
  scopeId?: string | null;
  enabled?: boolean;
  staleTime?: number;
};

export function useReadRegistry(options?: ReadRegistryOptions) {
  const readScopeId = resolveResourceReadScopeId(options?.scopeType, options?.scopeId, options?.organizationId);
  return useQuery({
    queryKey: ["ui_read_registry_v1", options?.userId ?? null, options?.scopeType ?? null, readScopeId] as const,
    queryFn: async () => {
      const ui = createUiClient();
      return ui.readRegistry();
    },
    enabled: (options?.enabled ?? true) && Boolean(options?.userId)
      && (options?.scopeType !== "tenant" || Boolean(readScopeId)),
    staleTime: options?.staleTime,
  });
}
