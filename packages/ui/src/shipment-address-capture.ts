import type { UiShipmentDestinationAddress } from "@masarx/api";

// Browser/server-action validation is UX; canonical SQL remains authoritative.
export function normalizeShipmentAddressCapture(
  shortCode: string,
  latitude: string,
  longitude: string,
): UiShipmentDestinationAddress | undefined {
  const code = shortCode.trim().toUpperCase();
  const latText = latitude.trim();
  const lngText = longitude.trim();
  if (!code && !latText && !lngText) return undefined;
  if (Boolean(latText) !== Boolean(lngText)) {
    throw new Error("Enter both latitude and longitude.");
  }
  const address: UiShipmentDestinationAddress = {};
  if (code) address.sa_short_code = code;
  if (latText && lngText) {
    const lat = Number(latText);
    const lng = Number(lngText);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
      throw new Error("Latitude must be between -90 and 90; longitude between -180 and 180.");
    }
    address.latitude = lat;
    address.longitude = lng;
    address.coordinates = { latitude: lat, longitude: lng };
  }
  return address;
}

export function assertShipmentAddressCapture(
  expected: UiShipmentDestinationAddress | undefined,
  proof: unknown,
) {
  if (!expected) return;
  const capture = proof && typeof proof === "object" && !Array.isArray(proof)
    ? proof as Record<string, unknown> : null;
  if (capture?.status !== "verified" || typeof capture.address_id !== "string" || !capture.address_id.trim()) {
    throw new Error("Shipment address capture is not yet verified.");
  }
  if (expected.sa_short_code && (
    typeof capture.sa_short_code !== "string" ||
    capture.sa_short_code.trim().toUpperCase() !== expected.sa_short_code
  )) {
    throw new Error("Persisted shipment short address does not match the submitted value.");
  }
  if (expected.coordinates) {
    const coordinates = capture.coordinates && typeof capture.coordinates === "object" && !Array.isArray(capture.coordinates)
      ? capture.coordinates as Record<string, unknown> : null;
    const lat = coordinates?.latitude;
    const lng = coordinates?.longitude;
    if (typeof lat !== "number" || typeof lng !== "number" || !Number.isFinite(lat) || !Number.isFinite(lng) ||
      Math.abs(lat) > 90 || Math.abs(lng) > 180 ||
      Math.abs(lat - expected.coordinates.latitude) > 0.00001 ||
      Math.abs(lng - expected.coordinates.longitude) > 0.00001) {
      throw new Error("Persisted shipment coordinates do not match the submitted values.");
    }
  }
}
