"use client";

import { buildLookupFriendlyLabel, normalizeLookupText } from "./lookup-friendly-label";

type ResourceLookupClient = {
  listResource: (
    resource: string,
    filters: Record<string, unknown>,
    limit: number,
  ) => Promise<{ items?: Record<string, unknown>[] | null } | null>;
};

export type ShipmentCreateRelationOption = {
  label: string;
  value: string;
};

function buildSlugSearchPattern(query: string) {
  const slug = normalizeLookupText(query)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug ? `%${slug}%` : "";
}

function isUuidLike(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value,
  );
}

function matchesLookupQuery(parts: Array<unknown>, query: string) {
  const normalizedQuery = normalizeLookupText(query).toLowerCase();
  if (!normalizedQuery) return true;
  return parts.some((part) => normalizeLookupText(part).toLowerCase().includes(normalizedQuery));
}

function uniqueOptions(options: ShipmentCreateRelationOption[]) {
  const seen = new Set<string>();
  return options.filter((option) => {
    const value = normalizeLookupText(option.value);
    if (!value || seen.has(value)) return false;
    seen.add(value);
    return true;
  });
}

export async function loadShipmentCreateClientOptions(
  ui: ResourceLookupClient,
  query: string,
  limit = 100,
  organizationId?: string | null,
): Promise<ShipmentCreateRelationOption[]> {
  try {
    const normalizedOrganizationId = normalizeLookupText(organizationId);
    if (!normalizedOrganizationId) return [];

    const normalizedQuery = normalizeLookupText(query);
    const baseFilters = { organization_id: normalizedOrganizationId };
    const loadItems = async (filters: Record<string, unknown>) => {
      const result = await ui.listResource("clients", filters, limit);
      return Array.isArray(result?.items) ? result.items : [];
    };

    let items: Record<string, unknown>[] = [];
    if (isUuidLike(normalizedQuery)) {
      items = await loadItems({ ...baseFilters, id: normalizedQuery });
    } else if (normalizedQuery) {
      const slugPattern = buildSlugSearchPattern(normalizedQuery);
      const searchCalls: Array<Promise<Record<string, unknown>[]>> = [
        loadItems({ ...baseFilters, name: `%${normalizedQuery}%` }),
      ];
      if (slugPattern) {
        searchCalls.push(loadItems({ ...baseFilters, slug: slugPattern }));
      }
      items = (await Promise.all(searchCalls)).flat();
    } else {
      items = await loadItems(baseFilters);
    }
    const options = uniqueOptions(
      items
        .map((item) => {
          const value = normalizeLookupText(item.id);
          const name = normalizeLookupText(item.name);
          const slug = normalizeLookupText(item.slug);
          const label = name || slug || buildLookupFriendlyLabel("Client", value);
          if (!value || !label) return null;
          return { value, label } satisfies ShipmentCreateRelationOption;
        })
        .filter((option): option is ShipmentCreateRelationOption => option !== null),
    );
    return options.filter((option) =>
      matchesLookupQuery([option.label, option.value, items.find((item) => normalizeLookupText(item.id) === option.value)?.slug], query),
    );
  } catch {
    return [];
  }
}

export async function loadShipmentCreateSenderOptions(
  ui: ResourceLookupClient,
  clientId: string,
  query: string,
  limit = 100,
): Promise<ShipmentCreateRelationOption[]> {
  try {
    const filters: Record<string, unknown> = {};
    if (normalizeLookupText(clientId)) {
      filters.client_id = normalizeLookupText(clientId);
    }
    const result = await ui.listResource("senders", filters, limit);
    const items = Array.isArray(result?.items) ? result.items : [];
    const options = uniqueOptions(
      items
        .map((item) => {
          const value = normalizeLookupText(item.id);
          const name = normalizeLookupText(item.name);
          const brandName = normalizeLookupText(item.brand_name);
          const label = name || brandName || buildLookupFriendlyLabel("Sender", value);
          if (!value || !label) return null;
          return { value, label } satisfies ShipmentCreateRelationOption;
        })
        .filter((option): option is ShipmentCreateRelationOption => option !== null),
    );
    return options.filter((option) => {
      const source = items.find((item) => normalizeLookupText(item.id) === option.value);
      return matchesLookupQuery(
        [option.label, option.value, source?.name, source?.brand_name],
        query,
      );
    });
  } catch {
    return [];
  }
}
