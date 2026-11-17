"use client";

import { useQuery, type UseQueryOptions } from "@tanstack/react-query";
import { createUiClient } from "@masarx/api";
import { normalizeCommandRegistry } from "./command-registry";

type CommandRegistryOptions = {
  enabled?: boolean;
  staleTime?: number;
};

export function useCommandRegistry(options?: CommandRegistryOptions) {
  return useQuery<ReturnType<typeof normalizeCommandRegistry>>({
    queryKey: ["ui_command_registry_v1"] as const,
    queryFn: async () => {
      const ui = createUiClient();
      const registry = await ui.commandRegistry();
      return normalizeCommandRegistry(registry);
    },
    enabled: options?.enabled ?? true,
    staleTime: options?.staleTime,
  });
}
