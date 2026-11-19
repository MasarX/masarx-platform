// Mobile V2 native-intent helpers — pure URL builders for the device
// intents the V2 shell triggers (phone, WhatsApp, maps navigation,
// share text). React-free so the jest unit runner can cover every
// builder without rendering a React Native tree.
//
// Engineering audit B1 (BLOCKER): `PreviewBody` previously stubbed
// every call / WhatsApp / navigate / copy / share handler with a toast
// that performed no real action. These builders are the SSOT the real
// handlers (in `mobile-v2-intents.ts`) use so the production shell
// actually launches the device intent.
//
// The builders deliberately mirror the canonical builders already used
// by the V1 shell (`buildChannelUrl` / `buildNavigationUrl` in
// `mobile-shell-surface-helpers.ts`) so both shells produce identical
// `tel:` / `wa.me` / maps URLs.

/**
 * Strip a phone string down to the `wa.me` digit form (E.164 without
 * the leading `+`). Returns null when no digits remain.
 */
export function normalizeMobileV2PhoneDigits(phone: string | null | undefined): string | null {
  if (typeof phone !== "string") return null;
  const digits = phone.replace(/[^0-9+]/g, "").replace(/^\+/, "");
  return digits.length > 0 ? digits : null;
}

/**
 * Build a `tel:` dial URL. Returns null when the phone has no usable
 * digits so callers can surface an "unavailable" message instead of
 * launching a broken intent.
 */
export function buildMobileV2TelUrl(phone: string | null | undefined): string | null {
  const digits = normalizeMobileV2PhoneDigits(phone);
  return digits === null ? null : `tel:${digits}`;
}

/**
 * Build a `https://wa.me/<digits>` WhatsApp URL with an optional
 * pre-filled message. Returns null when the phone has no usable digits.
 */
export function buildMobileV2WhatsAppUrl(
  phone: string | null | undefined,
  message?: string,
): string | null {
  const digits = normalizeMobileV2PhoneDigits(phone);
  if (digits === null) return null;
  const text = (message ?? "").trim();
  return text.length > 0
    ? `https://wa.me/${digits}?text=${encodeURIComponent(text)}`
    : `https://wa.me/${digits}`;
}

/**
 * Build a Google Maps directions URL for a free-text destination
 * (address string). Used by the stop / pickup screens where only a
 * formatted address is available (no lat/lng). Returns null when the
 * destination is empty.
 *
 * `https://www.google.com/maps/...` is cross-platform: it opens the
 * Google Maps app when installed and the browser map otherwise, on
 * both iOS and Android, and renders on web too.
 */
export function buildMobileV2MapsUrl(destination: string | null | undefined): string | null {
  if (typeof destination !== "string") return null;
  const query = destination.trim();
  if (query.length === 0) return null;
  return `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(
    query,
  )}&travelmode=driving`;
}

/**
 * Build a Google Maps URL for an explicit `lat,lng` coordinate. Returns
 * null when either coordinate is non-finite.
 */
export function buildMobileV2MapsUrlFromCoords(
  latitude: number,
  longitude: number,
): string | null {
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  const destination = `${latitude},${longitude}`;
  return `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(
    destination,
  )}&travelmode=driving`;
}

/**
 * Compose the address block of a stop into a single shareable / copyable
 * string — address lines joined by ` · `, with the optional note and
 * tracking code appended. Returns an empty string when no lines exist.
 */
export function composeMobileV2AddressText(input: {
  readonly addressLines: ReadonlyArray<string>;
  readonly addressNote?: string | null;
  readonly trackingCode?: string | null;
}): string {
  const lines = input.addressLines
    .map((l) => (typeof l === "string" ? l.trim() : ""))
    .filter((l) => l.length > 0);
  const parts: string[] = [];
  if (lines.length > 0) parts.push(lines.join(" · "));
  const note = (input.addressNote ?? "").trim();
  if (note.length > 0) parts.push(note);
  const tracking = (input.trackingCode ?? "").trim();
  if (tracking.length > 0) parts.push(tracking);
  return parts.join("\n");
}
