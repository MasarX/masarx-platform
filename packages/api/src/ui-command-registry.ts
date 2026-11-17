import type { UiCommandDefinition, UiCommandRegistry } from "./index";

export function normalizeCommandRegistry(
  registry: UiCommandRegistry | null | undefined
): UiCommandDefinition[] {
  if (!Array.isArray(registry?.commands)) return [];
  return registry.commands.filter(Boolean) as UiCommandDefinition[];
}

export function matchesResourceCategory(
  schemaCategory: string | null | undefined,
  resourceKey: string
) {
  if (!schemaCategory) return false;
  const normalizedCategory = schemaCategory.trim().toLowerCase();
  const normalizedKey = resourceKey.trim().toLowerCase();
  if (!normalizedCategory || !normalizedKey) return false;
  const prefixes = [
    `resource:${normalizedKey}`,
    `resource/${normalizedKey}`,
    `resource.${normalizedKey}`,
    normalizedKey,
  ];
  return prefixes.some((prefix) => {
    if (normalizedCategory === prefix) return true;
    return (
      normalizedCategory.startsWith(`${prefix}.`) ||
      normalizedCategory.startsWith(`${prefix}/`) ||
      normalizedCategory.startsWith(`${prefix}:`)
    );
  });
}

export function resolveResourceCommandCategory(params: {
  resourceKey: string;
  commands: UiCommandDefinition[];
}) {
  const normalizedKey = params.resourceKey.trim();
  if (!normalizedKey) return null;
  const normalizedKeyLower = normalizedKey.toLowerCase();
  const prefixes = [
    `resource:${normalizedKeyLower}`,
    `resource/${normalizedKeyLower}`,
    `resource.${normalizedKeyLower}`,
    normalizedKeyLower,
  ];
  let bestCategory: string | null = null;
  let bestScore = Number.POSITIVE_INFINITY;

  params.commands.forEach((command) => {
    const raw = command.schema_category?.trim();
    if (!raw) return;
    const normalized = raw.toLowerCase();
    const exactIndex = prefixes.findIndex((prefix) => normalized === prefix);
    if (exactIndex !== -1 && exactIndex < bestScore) {
      bestScore = exactIndex;
      bestCategory = raw;
      return;
    }
    prefixes.forEach((prefix, index) => {
      if (
        normalized.startsWith(`${prefix}.`) ||
        normalized.startsWith(`${prefix}/`) ||
        normalized.startsWith(`${prefix}:`)
      ) {
        if (index < bestScore) {
          bestScore = index;
          bestCategory = raw;
        }
      }
    });
  });

  return bestCategory ?? `resource:${normalizedKeyLower}`;
}

