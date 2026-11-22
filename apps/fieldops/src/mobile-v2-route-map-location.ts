import { redactOutboxErrorText } from "@masarx/mobile-core";
import type {
  MobileV2MapLocationReadback,
  MobileV2MapStop,
} from "./mobile-v2-map-screen";
import type { MobileV2LocationPingReadback } from "./mobile-v2-rpc-hooks";

export interface MobileV2RouteMapPositionLike {
  readonly coords: {
    readonly latitude: number | null | undefined;
    readonly longitude: number | null | undefined;
    readonly accuracy?: number | null | undefined;
    readonly speed?: number | null | undefined;
    readonly heading?: number | null | undefined;
  };
  readonly timestamp?: number | null | undefined;
}

export interface MobileV2StopLocationReadback {
  readonly shortAddress: string | null;
  readonly coordinateLine: string | null;
  readonly geocodeLine: string | null;
}

export interface MobileV2NativeDeviceRegistrationPayloadInput {
  readonly deviceIdentifierSha256: string;
  readonly platform: string;
  readonly deviceLabel: string | null;
  readonly appVersion: string | null;
  readonly osVersion: string | null;
  readonly expoSdk: string | null;
  readonly expoRuntime: string | null;
}

export const MOBILE_V2_ROUTE_MAP_LAST_KNOWN_POSITION_OPTIONS = Object.freeze({
  maxAge: 120_000,
  requiredAccuracy: 100,
});

export function formatMobileV2RouteMapLocationError(error: unknown): string {
  return error instanceof Error && error.message.trim() !== ""
    ? redactOutboxErrorText(error.message)
    : "Unable to save location";
}

export function buildMobileV2RouteMapReadback(
  readback: MobileV2LocationPingReadback,
  routeStopLabel: string | null,
): MobileV2MapLocationReadback {
  return Object.freeze({
    status: "saved",
    pingId: readback.locationPingId,
    capturedAt: readback.capturedAt,
    latitude: readback.latitude,
    longitude: readback.longitude,
    accuracyM: readback.accuracyM,
    routeStopLabel,
    message: "Location saved",
  });
}

export function mobileV2MapStopHasGeocodeReadback(stop: MobileV2MapStop): boolean {
  const hasCoordinatePair =
    typeof stop.latitude === "number" &&
    Number.isFinite(stop.latitude) &&
    typeof stop.longitude === "number" &&
    Number.isFinite(stop.longitude);
  return (
    hasCoordinatePair ||
    (typeof stop.shortAddress === "string" && stop.shortAddress.trim() !== "") ||
    (typeof stop.geocodingStatus === "string" && stop.geocodingStatus.trim() !== "") ||
    (typeof stop.geocodingAccuracy === "string" && stop.geocodingAccuracy.trim() !== "") ||
    (typeof stop.geocodingProvider === "string" && stop.geocodingProvider.trim() !== "") ||
    (typeof stop.geocodingMatch === "string" && stop.geocodingMatch.trim() !== "")
  );
}

export function resolveMobileV2RouteMapGeocodeReadbackStop(
  active: MobileV2MapStop | null,
  mapStops: ReadonlyArray<MobileV2MapStop>,
): MobileV2MapStop | null {
  if (active !== null && mobileV2MapStopHasGeocodeReadback(active)) return active;
  return mapStops.find(mobileV2MapStopHasGeocodeReadback) ?? null;
}

export function formatMobileV2MapStopCoordinateLine(stop: MobileV2MapStop): string | null {
  if (
    typeof stop.latitude !== "number" ||
    !Number.isFinite(stop.latitude) ||
    typeof stop.longitude !== "number" ||
    !Number.isFinite(stop.longitude)
  ) {
    return null;
  }
  const accuracy =
    typeof stop.accuracyM === "number" && Number.isFinite(stop.accuracyM)
      ? ` - +/-${Math.round(stop.accuracyM)} m`
      : "";
  return `${stop.latitude.toFixed(5)}, ${stop.longitude.toFixed(5)}${accuracy}`;
}

function normalizeMobileV2GeocodeToken(value: string | null | undefined): string | null {
  const normalized =
    typeof value === "string"
      ? value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "")
      : "";
  return normalized !== "" ? normalized : null;
}

function formatMobileV2GeocodeStatusLabel(value: string | null | undefined): string | null {
  const token = normalizeMobileV2GeocodeToken(value);
  if (token === null) return null;
  if (token === "geocoded" || token === "verified" || token === "resolved" || token === "matched") {
    return "Verified";
  }
  if (token === "review_required" || token === "needs_review") return "Needs review";
  if (token === "failed" || token === "error") return "Location needs review";
  if (token === "pending") return "Verification pending";
  return null;
}

function formatMobileV2GeocodeAccuracyLabel(value: string | null | undefined): string | null {
  const token = normalizeMobileV2GeocodeToken(value);
  if (token === null) return null;
  if (token.includes("rooftop")) return "Rooftop";
  if (token.includes("entrance")) return "Entrance";
  if (token.includes("parcel")) return "Parcel";
  if (token.includes("centroid")) return "Locality centroid";
  if (token.includes("street")) return "Street";
  if (token.includes("district")) return "District";
  if (token.includes("city")) return "City";
  return null;
}

function formatMobileV2GeocodeMatchLabel(value: string | null | undefined): string | null {
  const token = normalizeMobileV2GeocodeToken(value);
  if (token === null) return null;
  if (token.includes("sa_short_code") || (token.includes("short") && token.includes("code"))) {
    return "Short address match";
  }
  if (token.includes("district")) return "District match";
  if (token.includes("locality")) return "Locality match";
  if (token.includes("address")) return "Address match";
  if (token.includes("exact")) return "Exact match";
  if (token.includes("fuzzy")) return "Close match";
  return null;
}

function pushUniqueMobileV2LocationLabel(labels: string[], value: string | null): void {
  if (value !== null && !labels.includes(value)) labels.push(value);
}

export function formatMobileV2MapStopGeocodeLine(stop: MobileV2MapStop): string | null {
  const parts: string[] = [];
  pushUniqueMobileV2LocationLabel(parts, formatMobileV2GeocodeStatusLabel(stop.geocodingStatus));
  pushUniqueMobileV2LocationLabel(parts, formatMobileV2GeocodeAccuracyLabel(stop.geocodingAccuracy));
  pushUniqueMobileV2LocationLabel(parts, formatMobileV2GeocodeMatchLabel(stop.geocodingMatch));
  return parts.length > 0 ? parts.join(" - ") : null;
}

export function formatMobileV2MapStopShortAddress(stop: MobileV2MapStop): string | null {
  return typeof stop.shortAddress === "string" && stop.shortAddress.trim().length > 0
    ? stop.shortAddress.trim()
    : null;
}

export function buildMobileV2StopLocationReadback(
  stop: Pick<
    MobileV2MapStop,
    | "latitude"
    | "longitude"
    | "accuracyM"
    | "shortAddress"
    | "geocodingStatus"
    | "geocodingAccuracy"
    | "geocodingProvider"
    | "geocodingMatch"
  > | null,
): MobileV2StopLocationReadback | null {
  if (stop === null) return null;
  const shortAddress = formatMobileV2MapStopShortAddress(stop as MobileV2MapStop);
  const coordinateLine = formatMobileV2MapStopCoordinateLine(stop as MobileV2MapStop);
  const geocodeLine = formatMobileV2MapStopGeocodeLine(stop as MobileV2MapStop);
  if (shortAddress === null && coordinateLine === null && geocodeLine === null) return null;
  return Object.freeze({
    shortAddress,
    coordinateLine,
    geocodeLine,
  });
}

export async function resolveMobileV2RouteMapPosition(input: {
  readonly getCurrentPosition: () => Promise<MobileV2RouteMapPositionLike>;
  readonly getLastKnownPosition: () => Promise<MobileV2RouteMapPositionLike | null>;
  readonly currentTimeoutMs?: number;
}): Promise<MobileV2RouteMapPositionLike> {
  // Cached positions are accepted only after Expo applies
  // MOBILE_V2_ROUTE_MAP_LAST_KNOWN_POSITION_OPTIONS at the caller boundary.
  const lastKnownBeforeCurrent = await input.getLastKnownPosition();
  if (lastKnownBeforeCurrent !== null) return lastKnownBeforeCurrent;

  const timeoutMs =
    typeof input.currentTimeoutMs === "number" && Number.isFinite(input.currentTimeoutMs)
      ? Math.max(1, input.currentTimeoutMs)
      : 8_000;
  let currentError: unknown = null;
  let currentTimeout: ReturnType<typeof setTimeout> | null = null;
  try {
    const currentTimeoutPromise = new Promise<never>((_, reject) => {
      currentTimeout = setTimeout(() => {
        reject(new Error("Current location is unavailable. Make sure that location services are enabled"));
      }, timeoutMs);
    });
    return await Promise.race([
      input.getCurrentPosition(),
      currentTimeoutPromise,
    ]);
  } catch (error) {
    currentError = error;
  } finally {
    if (currentTimeout !== null) {
      clearTimeout(currentTimeout);
    }
  }

  const lastKnownAfterCurrent = await input.getLastKnownPosition();
  if (lastKnownAfterCurrent !== null) return lastKnownAfterCurrent;
  throw currentError;
}

export function normalizeMobileV2DeviceId(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed !== "" ? trimmed : null;
}

export function resolveMobileV2NativeShellDeviceId(
  providedDeviceId: string | null | undefined,
  storedDeviceId: string | null | undefined,
): string | null {
  return normalizeMobileV2DeviceId(providedDeviceId) ?? normalizeMobileV2DeviceId(storedDeviceId);
}

export function buildMobileV2NativeDeviceRegistrationPayload(
  input: MobileV2NativeDeviceRegistrationPayloadInput,
): Record<string, unknown> {
  return Object.freeze({
    device_platform: input.platform,
    device_identifier_sha256: input.deviceIdentifierSha256,
    device_label: input.deviceLabel,
    push_token: null,
    app_version: input.appVersion,
    os_version: input.osVersion,
    metadata: Object.freeze({
      app: "fieldops",
      platform: input.platform,
      source: "mobile_v2_native_shell",
      expo_sdk: input.expoSdk,
      expo_runtime: input.expoRuntime,
    }),
  });
}

export function normalizeMobileV2LocationNumber(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function normalizeMobileV2LocationAccuracy(value: number | null | undefined): number | null {
  const n = normalizeMobileV2LocationNumber(value);
  return n === null ? null : Math.max(0, Math.round(n));
}

export function normalizeMobileV2LocationHeading(value: number | null | undefined): number | null {
  const n = normalizeMobileV2LocationNumber(value);
  return n !== null && n >= 0 && n <= 360 ? Math.round(n) : null;
}

export function normalizeMobileV2RouteMapStopId(stop: MobileV2MapStop | null): string | null {
  const raw = stop?.id ?? null;
  if (raw === null) return null;
  return raw.startsWith("stop:") ? raw.slice("stop:".length) : raw;
}

export function buildMobileV2RouteMapLocationError(message: string): MobileV2MapLocationReadback {
  return Object.freeze({
    status: "error",
    pingId: null,
    capturedAt: null,
    latitude: null,
    longitude: null,
    accuracyM: null,
    routeStopLabel: null,
    message,
  });
}

export function formatMobileV2MapLocationChipLabel(
  location: MobileV2MapLocationReadback,
): string {
  if (location.status === "saving") return "Saving location";
  if (location.status === "error") return location.message ?? "Location failed";
  return "Location saved";
}

export function formatMobileV2MapLocationIdentityLine(
  location: MobileV2MapLocationReadback,
  fallbackStopSeq: number,
): string {
  return location.routeStopLabel ?? `Stop ${fallbackStopSeq}`;
}

export function formatMobileV2MapLocationCoordinateLine(
  location: MobileV2MapLocationReadback,
): string {
  const lat = location.latitude?.toFixed(5) ?? "?";
  const lng = location.longitude?.toFixed(5) ?? "?";
  const accuracy = location.accuracyM !== null ? ` - ${Math.round(location.accuracyM)}m` : "";
  return `${lat}, ${lng}${accuracy}`;
}
