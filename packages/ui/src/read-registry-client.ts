"use client";
import { useQuery } from "@tanstack/react-query";
import { createUiClient } from "@masarx/api";

type ReadRegistryOptions = {
  enabled?: boolean;
  staleTime?: number;
};

export function useReadRegistry(options?: ReadRegistryOptions) {
  return useQuery({
    queryKey: ["ui_read_registry_v1"] as const,
    queryFn: async () => {
      const ui = createUiClient();
      return ui.readRegistry();
    },
    enabled: options?.enabled ?? true,
    staleTime: options?.staleTime,
  });
}
