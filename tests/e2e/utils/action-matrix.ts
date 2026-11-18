import {
  matchesResourceCategory,
  resolveResourceActionStats,
} from "../../../packages/ui/src/resource-actions-core";
import { flattenNavigationSections } from "../../../packages/ui/src/navigation-utils";
import type {
  CommandDefinition,
  NavigationSection,
  ReadRegistry,
} from "./role-matrix";
import {
  hasCapability,
  isResourceReadScopeAllowed,
  resolveCapabilitySet,
} from "../../../packages/ui/src/capabilities";

type ActionStats = {
  total: number;
  allowed: number;
  blocked: number;
};

export function collectAccessibleResourceKeys(params: {
  sections: NavigationSection[];
  readRegistry?: ReadRegistry | null;
  capabilities?: string[] | null;
  scopeType?: string | null;
  scopeId?: string | null;
  organizationId?: string | null;
}) {
  const {
    sections,
    readRegistry,
    capabilities,
    scopeType,
    scopeId,
    organizationId,
  } = params;
  const capabilitySet = resolveCapabilitySet(capabilities);
  const flattened = flattenNavigationSections(
    sections.map((section) => ({
      ...section,
      label: section.label ?? "",
      items: section.items ?? [],
    })) as Parameters<typeof flattenNavigationSections>[0]
  );
  const keys = new Set<string>();
  for (const { item } of flattened) {
    const resourceKey = item.resource?.trim();
    if (!resourceKey) continue;
    const resource = readRegistry?.resources?.find(
      (entry) => entry?.key === resourceKey
    );
    if (
      readRegistry &&
      !isResourceReadScopeAllowed(
        resource as Parameters<typeof isResourceReadScopeAllowed>[0],
        scopeType,
        scopeId,
        organizationId
      )
    ) {
      continue;
    }
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
