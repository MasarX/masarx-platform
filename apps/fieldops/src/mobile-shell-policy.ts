import { normalizeMobileOpenMapPolicy, type MobileOpenMapPolicy } from "./mobile-open-map-policy";
export type MobileVisibilityMode = "assigned_only" | "branch" | "zone" | "organization";
export type MobileRouteViewMode = "list" | "orders_map";
export type MobilePlatform = "android" | "ios" | "scanner";

export type MobileMapTileProvider = {
  engine: string;
  provider: string;
  dataProvider: string;
  urlTemplate: string;
  attributionLabel: string;
  attributionUrl: string | null;
  license: string;
  usageTier: string;
  cacheRequired: boolean;
  allowedHosts: string[];
};

export type MobileMapLogisticsStack = {
  spatialSourceOfTruth: string;
  routingEngine: string;
  optimizationEngine: string;
};

export type MobileMapViewport = {
  latitude: number;
  longitude: number;
  zoom: number;
};

export type MobileMapZoomPadding = {
  top: number;
  right: number;
  bottom: number;
  left: number;
};

export type MobileVisibilityPolicy = {
  enabled: boolean;
  defaultVisibility: MobileVisibilityMode;
  allowedVisibility: MobileVisibilityMode[];
  allowUserSelect: boolean;
};

export type MobileMapPolicy = {
  openMap: MobileOpenMapPolicy;
  routeViews: MobileRouteViewMode[];
  defaultRouteView: MobileRouteViewMode;
  clusteringEnabled: boolean;
  clusteringGridPx: number;
  clusteringMinCount: number;
  showLegend: boolean;
  tileProvider: MobileMapTileProvider;
  logisticsStack: MobileMapLogisticsStack;
  defaultViewport: MobileMapViewport;
  zoomPadding: MobileMapZoomPadding;
};

export type MobileDriverSafetyPolicy = {
  enabled: boolean;
  lockWhenMoving: boolean;
  lockThresholdKph: number;
  allowedNavKeysWhileMoving: string[];
  maxSingleGlanceSec: number;
  maxTotalGlanceSec: number;
};

export type MobileUxSafetyPolicy = {
  requireDoubleTapFor: string[];
};

export type MobileDevicePolicy = {
  allowedPlatforms: MobilePlatform[];
  defaultPlatform: MobilePlatform;
};

export type MobileNavigationPolicy = {
  providerByPlatform: Record<MobilePlatform, string>;
};

export type MobileCommunicationTemplate = {
  id: string;
  label: string;
  message: string;
};

export type MobileCommunicationContact = {
  id: string;
  role: string;
  label: string;
  name: string | null;
  phone: string | null;
  allowedChannels: string[];
  notes: string | null;
};

export type MobileCommunicationPolicy = {
  allowedChannels: string[];
  templates: MobileCommunicationTemplate[];
  supportContacts: MobileCommunicationContact[];
};

export type MobileAddressField = {
  key: string;
  label: string;
  required: boolean;
};

export type MobileAddressPolicy = {
  fields: MobileAddressField[];
  showCoordinates: boolean;
  showAccuracy: boolean;
};

export type MobileDiagnosticsPolicy = {
  enabled: boolean;
  allowUserToggle: boolean;
  defaultOn: boolean;
  exposeResolution: boolean;
};

export const DEFAULT_MOBILE_VISIBILITY_POLICY: MobileVisibilityPolicy = {
  enabled: true,
  defaultVisibility: "assigned_only",
  allowedVisibility: ["assigned_only", "branch", "zone", "organization"],
  allowUserSelect: true,
};

export const DEFAULT_MOBILE_MAP_POLICY: MobileMapPolicy = {
  openMap: normalizeMobileOpenMapPolicy(null),
  routeViews: ["list", "orders_map"],
  defaultRouteView: "list",
  clusteringEnabled: true,
  clusteringGridPx: 120,
  clusteringMinCount: 2,
  showLegend: true,
  tileProvider: {
    engine: "maplibre",
    provider: "openstreetmap",
    dataProvider: "openstreetmap",
    urlTemplate: "/map-tiles/openstreetmap/{z}/{x}/{y}.png",
    attributionLabel: "OpenStreetMap contributors",
    attributionUrl: "https://www.openstreetmap.org/copyright",
    license: "ODbL-1.0",
    usageTier: "production_cached",
    cacheRequired: true,
    allowedHosts: ["same-origin"],
  },
  logisticsStack: {
    spatialSourceOfTruth: "postgis",
    routingEngine: "valhalla",
    optimizationEngine: "vroom",
  },
  defaultViewport: {
    latitude: 24.7136,
    longitude: 46.6753,
    zoom: 11,
  },
  zoomPadding: {
    top: 80,
    right: 48,
    bottom: 220,
    left: 48,
  },
};

export const DEFAULT_MOBILE_DRIVER_SAFETY_POLICY: MobileDriverSafetyPolicy = {
  enabled: false,
  lockWhenMoving: true,
  lockThresholdKph: 8,
  allowedNavKeysWhileMoving: ["route"],
  maxSingleGlanceSec: 2,
  maxTotalGlanceSec: 12,
};

export const DEFAULT_MOBILE_UX_SAFETY_POLICY: MobileUxSafetyPolicy = {
  requireDoubleTapFor: ["task_completed", "task_exception", "settlement_counted"],
};

export const DEFAULT_MOBILE_DEVICE_POLICY: MobileDevicePolicy = {
  allowedPlatforms: ["android", "ios", "scanner"],
  defaultPlatform: "android",
};

export const DEFAULT_MOBILE_NAVIGATION_POLICY: MobileNavigationPolicy = {
  providerByPlatform: {
    ios: "apple",
    android: "google",
    scanner: "google",
  },
};

export const DEFAULT_MOBILE_COMMUNICATION_POLICY: MobileCommunicationPolicy = {
  allowedChannels: ["call", "sms", "whatsapp"],
  templates: [],
  supportContacts: [],
};

export const DEFAULT_MOBILE_ADDRESS_POLICY: MobileAddressPolicy = {
  fields: [{ key: "address", label: "Address", required: true }],
  showCoordinates: true,
  showAccuracy: true,
};

export const DEFAULT_MOBILE_DIAGNOSTICS_POLICY: MobileDiagnosticsPolicy = {
  enabled: false,
  allowUserToggle: false,
  defaultOn: false,
  exposeResolution: false,
};

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function readBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  return fallback;
}

function readPositiveInt(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  const next = Math.floor(value);
  if (next < 0) return fallback;
  return next;
}

function readFiniteNumber(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function readString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function readLocalizedString(value: unknown): string | null {
  const direct = readString(value);
  if (direct) return direct;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const orderedCandidates: unknown[] = [record.en, record.ar, record.default];
  for (const candidate of Object.values(record)) orderedCandidates.push(candidate);
  for (const candidate of orderedCandidates) {
    const next = readString(candidate);
    if (next) return next;
  }
  return null;
}

function normalizeVisibilityMode(value: unknown): MobileVisibilityMode | null {
  const next = readString(value)?.toLowerCase();
  if (
    next === "assigned_only" ||
    next === "branch" ||
    next === "zone" ||
    next === "organization"
  ) {
    return next;
  }
  return null;
}

function normalizeRouteViewMode(value: unknown): MobileRouteViewMode | null {
  const next = readString(value)?.toLowerCase();
  if (next === "list" || next === "orders_map") return next;
  return null;
}

function normalizePlatform(value: unknown): MobilePlatform | null {
  const next = readString(value)?.toLowerCase();
  if (next === "android" || next === "ios" || next === "scanner") return next;
  return null;
}

function normalizeUniqueStrings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out = value
    .map((entry) => readString(entry))
    .filter((entry): entry is string => Boolean(entry))
    .map((entry) => entry.toLowerCase());
  return Array.from(new Set(out));
}

function readStringWithFallback(value: unknown, fallback: string): string {
  return readString(value) ?? fallback;
}

function readStringArray(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value)) return fallback;
  const next = value
    .map((entry) => readString(entry))
    .filter((entry): entry is string => Boolean(entry));
  return next.length > 0 ? Array.from(new Set(next)) : fallback;
}

function requirePolicyRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} is required`);
  }
  return value as Record<string, unknown>;
}

function requirePolicyString(value: unknown, label: string): string {
  const next = readString(value);
  if (!next) throw new Error(`${label} is required`);
  return next;
}

function requirePolicyBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${label} is required`);
  return value;
}

function requirePolicyPositiveNumber(value: unknown, label: string): number {
  const next = readFiniteNumber(value, Number.NaN);
  if (!Number.isFinite(next) || next <= 0) throw new Error(`${label} is required`);
  return next;
}

function requirePolicyStringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${label} is required`);
  const next = value
    .map((entry) => readString(entry))
    .filter((entry): entry is string => Boolean(entry));
  if (!next.length) throw new Error(`${label} is required`);
  return next;
}

function normalizeUniqueModes<T>(input: unknown[], normalizer: (value: unknown) => T | null): T[] {
  const out: T[] = [];
  for (const candidate of input) {
    const next = normalizer(candidate);
    if (next && !out.includes(next)) out.push(next);
  }
  return out;
}

export function normalizeMobileVisibilityPolicy(value: unknown): MobileVisibilityPolicy {
  const input = asRecord(value);
  const allowedRaw = Array.isArray(input.allowed_visibility)
    ? input.allowed_visibility
    : Array.isArray(input.allowed_modes)
      ? input.allowed_modes
      : [];
  const allowedVisibility = normalizeUniqueModes(allowedRaw, normalizeVisibilityMode);
  const fallbackAllowed = DEFAULT_MOBILE_VISIBILITY_POLICY.allowedVisibility;
  const resolvedAllowed = allowedVisibility.length ? allowedVisibility : fallbackAllowed;
  const requestedDefault =
    normalizeVisibilityMode(input.default_visibility) ??
    normalizeVisibilityMode(input.default_mode);
  const defaultVisibility =
    requestedDefault && resolvedAllowed.includes(requestedDefault)
      ? requestedDefault
      : resolvedAllowed[0] ?? DEFAULT_MOBILE_VISIBILITY_POLICY.defaultVisibility;

  return {
    enabled: readBoolean(input.enabled, DEFAULT_MOBILE_VISIBILITY_POLICY.enabled),
    defaultVisibility,
    allowedVisibility: resolvedAllowed,
    allowUserSelect: readBoolean(
      input.allow_user_select,
      DEFAULT_MOBILE_VISIBILITY_POLICY.allowUserSelect
    ),
  };
}

export function normalizeMobileMapPolicy(value: unknown): MobileMapPolicy {
  const input = asRecord(value);
  const routeViewsRaw = Array.isArray(input.route_views) ? input.route_views : [];
  const routeViews = normalizeUniqueModes(routeViewsRaw, normalizeRouteViewMode);
  const resolvedRouteViews = routeViews.length ? routeViews : DEFAULT_MOBILE_MAP_POLICY.routeViews;
  const layoutDefaults = asRecord(input.default_route_view_by_layout);
  const candidateDefault =
    normalizeRouteViewMode(layoutDefaults.mobile) ??
    normalizeRouteViewMode(layoutDefaults.c) ??
    normalizeRouteViewMode(layoutDefaults.C);
  const defaultRouteView =
    candidateDefault && resolvedRouteViews.includes(candidateDefault)
      ? candidateDefault
      : resolvedRouteViews[0] ?? DEFAULT_MOBILE_MAP_POLICY.defaultRouteView;
  const clustering = asRecord(input.clustering);

  return {
    openMap: normalizeMobileOpenMapPolicy(input),
    routeViews: resolvedRouteViews,
    defaultRouteView,
    clusteringEnabled: readBoolean(clustering.enabled, DEFAULT_MOBILE_MAP_POLICY.clusteringEnabled),
    clusteringGridPx: readPositiveInt(clustering.grid_px ?? clustering.grid, DEFAULT_MOBILE_MAP_POLICY.clusteringGridPx),
    clusteringMinCount: readPositiveInt(
      clustering.min_count,
      DEFAULT_MOBILE_MAP_POLICY.clusteringMinCount
    ),
    showLegend: readBoolean(input.show_legend, DEFAULT_MOBILE_MAP_POLICY.showLegend),
    tileProvider: normalizeMobileMapTileProvider(input.tile_provider),
    logisticsStack: normalizeMobileMapLogisticsStack(input.logistics_stack),
    defaultViewport: normalizeMobileMapViewport(input.default_viewport),
    zoomPadding: normalizeMobileMapZoomPadding(input.zoom_padding),
  };
}

export function normalizeResolvedMobileMapPolicy(value: unknown): MobileMapPolicy {
  const input = requirePolicyRecord(value, "map_policy");
  const clustering = requirePolicyRecord(input.clustering, "map_policy.clustering");
  requirePolicyPositiveNumber(clustering.grid_px ?? clustering.grid, "map_policy.clustering.grid_px");
  requirePolicyPositiveNumber(clustering.min_count, "map_policy.clustering.min_count");

  const tileProvider = requirePolicyRecord(input.tile_provider, "map_policy.tile_provider");
  requirePolicyString(tileProvider.engine, "map_policy.tile_provider.engine");
  requirePolicyString(tileProvider.provider, "map_policy.tile_provider.provider");
  requirePolicyString(tileProvider.data_provider ?? tileProvider.dataProvider, "map_policy.tile_provider.data_provider");
  requirePolicyString(tileProvider.url_template ?? tileProvider.urlTemplate, "map_policy.tile_provider.url_template");
  requirePolicyString(tileProvider.attribution_label ?? tileProvider.attributionLabel, "map_policy.tile_provider.attribution_label");
  requirePolicyString(tileProvider.attribution_url ?? tileProvider.attributionUrl, "map_policy.tile_provider.attribution_url");
  requirePolicyString(tileProvider.license, "map_policy.tile_provider.license");
  requirePolicyString(tileProvider.usage_tier ?? tileProvider.usageTier, "map_policy.tile_provider.usage_tier");
  requirePolicyBoolean(tileProvider.cache_required ?? tileProvider.cacheRequired, "map_policy.tile_provider.cache_required");
  requirePolicyStringArray(tileProvider.allowed_hosts ?? tileProvider.allowedHosts, "map_policy.tile_provider.allowed_hosts");

  const logisticsStack = requirePolicyRecord(input.logistics_stack, "map_policy.logistics_stack");
  requirePolicyString(
    logisticsStack.spatial_source_of_truth ?? logisticsStack.spatialSourceOfTruth,
    "map_policy.logistics_stack.spatial_source_of_truth",
  );
  requirePolicyString(
    logisticsStack.routing_engine ?? logisticsStack.routingEngine,
    "map_policy.logistics_stack.routing_engine",
  );
  requirePolicyString(
    logisticsStack.optimization_engine ?? logisticsStack.optimizationEngine,
    "map_policy.logistics_stack.optimization_engine",
  );

  return normalizeMobileMapPolicy(input);
}

function normalizeMobileMapTileProvider(value: unknown): MobileMapTileProvider {
  const input = asRecord(value);
  const fallback = DEFAULT_MOBILE_MAP_POLICY.tileProvider;
  return {
    engine: readStringWithFallback(input.engine, fallback.engine),
    provider: readStringWithFallback(input.provider, fallback.provider),
    dataProvider: readStringWithFallback(input.data_provider ?? input.dataProvider, fallback.dataProvider),
    urlTemplate: readStringWithFallback(input.url_template ?? input.urlTemplate, fallback.urlTemplate),
    attributionLabel: readStringWithFallback(
      input.attribution_label ?? input.attributionLabel,
      fallback.attributionLabel
    ),
    attributionUrl: readString(input.attribution_url ?? input.attributionUrl) ?? fallback.attributionUrl,
    license: readStringWithFallback(input.license, fallback.license),
    usageTier: readStringWithFallback(input.usage_tier ?? input.usageTier, fallback.usageTier),
    cacheRequired: readBoolean(input.cache_required ?? input.cacheRequired, fallback.cacheRequired),
    allowedHosts: readStringArray(input.allowed_hosts ?? input.allowedHosts, fallback.allowedHosts),
  };
}

function normalizeMobileMapLogisticsStack(value: unknown): MobileMapLogisticsStack {
  const input = asRecord(value);
  const fallback = DEFAULT_MOBILE_MAP_POLICY.logisticsStack;
  return {
    spatialSourceOfTruth: readStringWithFallback(
      input.spatial_source_of_truth ?? input.spatialSourceOfTruth,
      fallback.spatialSourceOfTruth
    ),
    routingEngine: readStringWithFallback(input.routing_engine ?? input.routingEngine, fallback.routingEngine),
    optimizationEngine: readStringWithFallback(
      input.optimization_engine ?? input.optimizationEngine,
      fallback.optimizationEngine
    ),
  };
}

function normalizeMobileMapViewport(value: unknown): MobileMapViewport {
  const input = asRecord(value);
  const fallback = DEFAULT_MOBILE_MAP_POLICY.defaultViewport;
  return {
    latitude: readFiniteNumber(input.latitude ?? input.lat, fallback.latitude),
    longitude: readFiniteNumber(input.longitude ?? input.lng ?? input.lon, fallback.longitude),
    zoom: readFiniteNumber(input.zoom, fallback.zoom),
  };
}

function normalizeMobileMapZoomPadding(value: unknown): MobileMapZoomPadding {
  const input = asRecord(value);
  const fallback = DEFAULT_MOBILE_MAP_POLICY.zoomPadding;
  const all = input.all ?? input.value;
  const allPadding =
    typeof all === "number" || typeof all === "string" ? readFiniteNumber(all, fallback.top) : null;
  return {
    top: readFiniteNumber(input.top, allPadding ?? fallback.top),
    right: readFiniteNumber(input.right, allPadding ?? fallback.right),
    bottom: readFiniteNumber(input.bottom, allPadding ?? fallback.bottom),
    left: readFiniteNumber(input.left, allPadding ?? fallback.left),
  };
}

export function normalizeMobileDriverSafetyPolicy(value: unknown): MobileDriverSafetyPolicy {
  const input = asRecord(value);
  const drivingMode = asRecord(input.driving_mode);
  const allowedNav = normalizeUniqueStrings(drivingMode.allowed_nav_keys_while_moving);

  return {
    enabled: readBoolean(drivingMode.enabled, DEFAULT_MOBILE_DRIVER_SAFETY_POLICY.enabled),
    lockWhenMoving: readBoolean(
      drivingMode.lock_when_moving,
      DEFAULT_MOBILE_DRIVER_SAFETY_POLICY.lockWhenMoving
    ),
    lockThresholdKph: readPositiveInt(
      drivingMode.lock_threshold_kph,
      DEFAULT_MOBILE_DRIVER_SAFETY_POLICY.lockThresholdKph
    ),
    allowedNavKeysWhileMoving:
      allowedNav.length > 0
        ? allowedNav
        : DEFAULT_MOBILE_DRIVER_SAFETY_POLICY.allowedNavKeysWhileMoving,
    maxSingleGlanceSec: readPositiveInt(
      drivingMode.max_single_glance_sec,
      DEFAULT_MOBILE_DRIVER_SAFETY_POLICY.maxSingleGlanceSec
    ),
    maxTotalGlanceSec: readPositiveInt(
      drivingMode.max_total_glance_sec,
      DEFAULT_MOBILE_DRIVER_SAFETY_POLICY.maxTotalGlanceSec
    ),
  };
}

export function normalizeMobileUxSafetyPolicy(value: unknown): MobileUxSafetyPolicy {
  const input = asRecord(value);
  const rules = normalizeUniqueStrings(input.require_double_tap_for);
  return {
    requireDoubleTapFor:
      rules.length > 0 ? rules : DEFAULT_MOBILE_UX_SAFETY_POLICY.requireDoubleTapFor,
  };
}

export function normalizeMobileDevicePolicy(value: unknown): MobileDevicePolicy {
  const input = asRecord(value);
  const allowedRaw = Array.isArray(input.allowed_platforms) ? input.allowed_platforms : [];
  const allowedPlatforms = normalizeUniqueModes(allowedRaw, normalizePlatform);
  const resolvedAllowed =
    allowedPlatforms.length > 0 ? allowedPlatforms : DEFAULT_MOBILE_DEVICE_POLICY.allowedPlatforms;
  const candidateDefault = normalizePlatform(input.default_platform);
  const defaultPlatform =
    candidateDefault && resolvedAllowed.includes(candidateDefault)
      ? candidateDefault
      : resolvedAllowed[0] ?? DEFAULT_MOBILE_DEVICE_POLICY.defaultPlatform;

  return {
    allowedPlatforms: resolvedAllowed,
    defaultPlatform,
  };
}

export function normalizeMobileNavigationPolicy(value: unknown): MobileNavigationPolicy {
  const input = asRecord(value);
  const providerByPlatformRaw = asRecord(input.provider_by_platform);
  const fallback = DEFAULT_MOBILE_NAVIGATION_POLICY.providerByPlatform;
  const readProvider = (platform: MobilePlatform) =>
    readString(providerByPlatformRaw[platform]) ?? fallback[platform];

  return {
    providerByPlatform: {
      ios: readProvider("ios"),
      android: readProvider("android"),
      scanner: readProvider("scanner"),
    },
  };
}

export function normalizeMobileCommunicationPolicy(value: unknown): MobileCommunicationPolicy {
  const input = asRecord(value);
  const allowedChannels = normalizeUniqueStrings(input.allowed_channels);
  const templatesRaw = Array.isArray(input.templates) ? input.templates : [];
  const supportContactsRaw = Array.isArray(input.support_contacts) ? input.support_contacts : [];
  const templates: MobileCommunicationTemplate[] = [];
  const supportContacts: MobileCommunicationContact[] = [];

  for (const templateValue of templatesRaw) {
    const template = asRecord(templateValue);
    const id = readString(template.id);
    if (!id) continue;
    const label = readLocalizedString(template.label) ?? id;
    const message = readLocalizedString(template.message) ?? "";
    templates.push({ id, label, message });
  }

  for (let index = 0; index < supportContactsRaw.length; index += 1) {
    const contact = asRecord(supportContactsRaw[index]);
    const role = readString(contact.role) ?? "support";
    const name = readLocalizedString(contact.name);
    const phone =
      readString(contact.phone_number) ??
      readString(contact.phone) ??
      readString(contact.mobile);
    const label =
      readLocalizedString(contact.label) ??
      name ??
      role;
    const id = readString(contact.id) ?? `${role}-${index + 1}`;
    const notes = readLocalizedString(contact.notes);
    const contactChannels = normalizeUniqueStrings(contact.allowed_channels);

    supportContacts.push({
      id,
      role,
      label,
      name,
      phone,
      allowedChannels: contactChannels,
      notes,
    });
  }

  return {
    allowedChannels:
      allowedChannels.length > 0
        ? allowedChannels
        : DEFAULT_MOBILE_COMMUNICATION_POLICY.allowedChannels,
    templates,
    supportContacts,
  };
}

export function normalizeMobileAddressPolicy(value: unknown): MobileAddressPolicy {
  const input = asRecord(value);
  const fieldsRaw = Array.isArray(input.fields) ? input.fields : [];
  const fields: MobileAddressField[] = [];

  for (const fieldValue of fieldsRaw) {
    const field = asRecord(fieldValue);
    const key = readString(field.key);
    if (!key) continue;
    fields.push({
      key,
      label: readLocalizedString(field.label) ?? key,
      required: readBoolean(field.required, false),
    });
  }

  return {
    fields: fields.length > 0 ? fields : DEFAULT_MOBILE_ADDRESS_POLICY.fields,
    showCoordinates: readBoolean(
      input.show_coordinates,
      DEFAULT_MOBILE_ADDRESS_POLICY.showCoordinates
    ),
    showAccuracy: readBoolean(input.show_accuracy, DEFAULT_MOBILE_ADDRESS_POLICY.showAccuracy),
  };
}

export function normalizeMobileDiagnosticsPolicy(value: unknown): MobileDiagnosticsPolicy {
  const input = asRecord(value);
  return {
    enabled: readBoolean(input.enabled, DEFAULT_MOBILE_DIAGNOSTICS_POLICY.enabled),
    allowUserToggle: readBoolean(
      input.allow_user_toggle,
      DEFAULT_MOBILE_DIAGNOSTICS_POLICY.allowUserToggle
    ),
    defaultOn: readBoolean(
      input.default_on,
      readBoolean(input.default_enabled, DEFAULT_MOBILE_DIAGNOSTICS_POLICY.defaultOn)
    ),
    exposeResolution: readBoolean(
      input.expose_resolution,
      DEFAULT_MOBILE_DIAGNOSTICS_POLICY.exposeResolution
    ),
  };
}
