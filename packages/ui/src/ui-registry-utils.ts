import type { UiReadRegistry } from "@masarx/api";

export type UiRegistryResource = NonNullable<UiReadRegistry["resources"]>[number];

export function findRegistryResource(
  registry: UiReadRegistry | null,
  key: string
): UiRegistryResource | null {
  const resources = Array.isArray(registry?.resources) ? registry!.resources : [];
  return resources.find((resource) => resource.key === key) ?? null;
}

