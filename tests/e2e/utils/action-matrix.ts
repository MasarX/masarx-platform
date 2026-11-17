import {
  matchesResourceCategory,
  resolveResourceActionStats,
} from "../../../packages/ui/src/resource-actions-core";
import {
  flattenNavigationSections,
  type CommandDefinition,
  type NavigationSection,
  type ReadRegistry,
} from "./role-matrix";
import { hasCapability, resolveCapabilitySet } from "./capabilities";

type ActionStats = {
  total: number;
  allowed: number;
  blocked: number;
};

export function collectAccessibleResourceKeys(params: {
  sections: NavigationSection[];
  capabilities?: string[] | null;
}) {
  const { sections, capabilities } = params;
  const capabilitySet = resolveCapabilitySet(capabilities);
  const flattened = flattenNavigationSections(sections);
  const keys = new Set<string>();
  for (const { item } of flattened) {
    const resourceKey = item.resource?.trim();
    if (!resourceKey) continue;
    const capability = item.capability?.trim() ?? "";
    const missingCapability =
      capability && !hasCapability(capabilitySet, capability);
    const disabled = !item.href || Boolean(item.disabled_reason) || missingCapability;
    if (!disabled) {
      keys.add(resourceKey);
    }
  }
  return Array.from(keys);
}

export function resolveExpectedActionStats(params: {
  resourceKey: string;
  readRegistry: ReadRegistry | null;
  commandRegistry: CommandDefinition[];
  capabilities?: string[] | null;
}): ActionStats {
  const { resourceKey, readRegistry, commandRegistry, capabilities } = params;
  const resources = Array.isArray(readRegistry?.resources)
    ? readRegistry?.resources
    : [];
  const resource = resources.find((entry) => entry?.key === resourceKey) ?? null;
  const commands = commandRegistry.filter((command) =>
    matchesResourceCategory(command?.schema_category ?? null, resourceKey)
  );
  return resolveResourceActionStats({
    resource,
    commands,
    userCapabilities: capabilities ?? [],
  });
}
