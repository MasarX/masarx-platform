import "server-only";
import { createUiServerClient } from "@masarx/api/server";
import { resolvePaginationSettings } from "./pagination-utils";

export type TrackingPin = { id: string; latitude: number; longitude: number; label: string | null; status: string | null };
export type TrackingLocation = { id: string; trackingNumber: string | null; status: string | null; originCity: string | null; destinationCity: string | null; serviceType: string | null; updatedAt: string | null };
export type TrackingDataset = {
  identity: string; resource: string; pins: TrackingPin[]; locations: TrackingLocation[];
  offset: number; limit: number; hasNext: boolean; datasetEmpty: boolean;
};
const text = (value: unknown) => typeof value === "string" && value.trim() ? value : null;
const resources = ["tracking_geocode_pins", "tracking_address_pins", "tracking_shipments"] as const;

/** Request-scoped registry reads only. Query errors deliberately propagate to the page. */
export async function loadTrackingDataset(
  params: { limit?: string; offset?: string },
  ui = createUiServerClient(),
): Promise<TrackingDataset> {
  const me = await ui.me();
  const scopeType = me?.access_scope?.scope_type;
  const scopeId = me?.access_scope?.scope_id ?? null;
  if (!me?.user?.id || !scopeType) throw new Error("tracking_scope_unavailable");
  let pagination = resolvePaginationSettings(null);
  try {
    const preview = await ui.settingsPreview({ category: "ui_pagination", scopeType, scopeId });
    pagination = resolvePaginationSettings(preview?.value);
  } catch { /* Optional administrative preview; resource reads enforce their own limits and access. */ }
  const requestedLimit = Number(params.limit);
  let limit = pagination.allowedSizes.includes(requestedLimit) ? requestedLimit : pagination.defaultPageSize;
  const requestedOffset = Number(params.offset ?? 0);
  let offset = Number.isSafeInteger(requestedOffset) && requestedOffset >= 0 ? Math.floor(requestedOffset / limit) * limit : 0;
  for (const resource of resources) {
    const first = await ui.listResource(resource, {}, limit, 0, { key: "id", direction: "asc" });
    if (!first || !Array.isArray(first.items)) throw new Error("tracking_invalid_resource_result");
    if (first.limit != null) {
      if (!Number.isSafeInteger(first.limit) || first.limit < 1 || first.limit > limit) throw new Error("tracking_invalid_page_limit");
      limit = first.limit;
      offset = Number.isSafeInteger(requestedOffset) && requestedOffset >= 0 ? Math.floor(requestedOffset / limit) * limit : 0;
    }
    if (!first.items.length && first.total && first.total > 0) throw new Error("tracking_inconsistent_first_page");
    if (!first.items.length && resource !== "tracking_shipments") continue;
    let page = first;
    if (offset && first.items.length) {
      page = await ui.listResource(resource, {}, limit, offset, { key: "id", direction: "asc" });
      if (!page || !Array.isArray(page.items)) throw new Error("tracking_invalid_resource_result");
      if (!page.items.length) { page = first; offset = 0; }
    } else offset = 0;
    const pins: TrackingPin[] = [];
    const locations: TrackingLocation[] = [];
    const identities = new Set<string>();
    for (const item of page.items) {
      const id = text(item.id);
      if (!id) throw new Error("tracking_identity_unavailable");
      if (resource === "tracking_shipments") {
        const originCity = text(item.origin_city), destinationCity = text(item.destination_city);
        if (!originCity && !destinationCity) continue;
        locations.push({ id, trackingNumber: text(item.tracking_number), status: text(item.status), originCity, destinationCity, serviceType: text(item.service_type), updatedAt: text(item.updated_at) });
      } else {
        const addressId = text(item.address_id);
        if (!addressId || typeof item.latitude !== "number" || !Number.isFinite(item.latitude) || Math.abs(item.latitude) > 90 || typeof item.longitude !== "number" || !Number.isFinite(item.longitude) || Math.abs(item.longitude) > 180) throw new Error("tracking_coordinates_unavailable");
        const identity = JSON.stringify([resource, id, addressId]);
        if (identities.has(identity)) throw new Error("tracking_duplicate_identity");
        identities.add(identity);
        pins.push({ id: identity, latitude: item.latitude, longitude: item.longitude, label: text(item.label), status: resource === "tracking_geocode_pins" ? text(item.source) : null });
      }
    }
    return {
      identity: JSON.stringify([me.user.id, scopeType, scopeId, resource, offset, limit, pins, locations]),
      resource, pins, locations, offset, limit,
      hasNext: typeof page.total === "number" ? offset + page.items.length < page.total : page.items.length === limit,
      datasetEmpty: first.items.length === 0,
    };
  }
  throw new Error("tracking_dataset_unavailable");
}
