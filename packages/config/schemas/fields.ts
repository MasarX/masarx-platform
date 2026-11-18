import { z } from "zod";

/** UUID v4 string. */
export const uuidSchema = z.string().uuid();

/** Standard email address. */
export const emailSchema = z.string().email();

/** Default SA phone pattern -- override via createPhoneSchema(pattern). */
export const DEFAULT_PHONE_PATTERN = /^(?:\+966|0)5\d{8}$/;

/** Saudi Arabia phone number (05XXXXXXXX or +9665XXXXXXXX). */
export const phoneSchema = z
  .string()
  .regex(
    DEFAULT_PHONE_PATTERN,
    "Phone must be a valid SA number (05XXXXXXXX or +9665XXXXXXXX)"
  );

/**
 * Create a phone schema with a custom regex pattern.
 * Use when tenants have non-SA phone formats or mixed-country requirements.
 */
export function createPhoneSchema(pattern: RegExp, message?: string) {
  return z.string().regex(pattern, message ?? "Invalid phone number");
}

/** Default tracking number pattern -- override via createTrackingNumberSchema(pattern). */
export const DEFAULT_TRACKING_PATTERN = /^[A-Z]{2,3}-\d{4}-\d{5}$/;

/** Tracking number in format XX(X)-DDDD-DDDDD. */
export const trackingNumberSchema = z
  .string()
  .regex(
    DEFAULT_TRACKING_PATTERN,
    "Tracking number must match format XX(X)-DDDD-DDDDD"
  );

/**
 * Create a tracking number schema with a custom regex pattern.
 * Use when tenants have different tracking number formats.
 */
export function createTrackingNumberSchema(pattern: RegExp, message?: string) {
  return z.string().regex(pattern, message ?? "Invalid tracking number format");
}

/**
 * Common lifecycle status field.
 *
 * This is a permissive string schema because valid status values are
 * tenant-specific and stored in the database `lookup_values` table.
 * Compile-time enums cannot capture the full set of allowed values.
 *
 * When the caller HAS the allowed statuses from the DB, use
 * `createStatusSchema(allowedStatuses)` for strict runtime validation.
 */
export const statusSchema = z.string().min(1);

/**
 * Common lookup-backed value field.
 *
 * Use this for form fields whose allowed values live in `lookup_values` or
 * another canonical query source. The base schema only proves a non-empty
 * canonical key is present; callers with DB rows should use
 * `createLookupValueSchema(allowedValues)` for strict runtime validation.
 */
export const lookupValueSchema = z.string().min(1);

/**
 * Create a strict status schema from a list of allowed status values
 * (typically fetched from DB `lookup_values` at runtime).
 *
 * @example
 *   const allowed = await fetchLookupValues("shipment_status");
 *   const schema = createStatusSchema(allowed);
 *   schema.parse("pending"); // ok if "pending" is in allowed list
 */
export function createStatusSchema(allowedStatuses: [string, ...string[]]) {
  return z.enum(allowedStatuses);
}

export function createLookupValueSchema(allowedValues: [string, ...string[]]) {
  return z.enum(allowedValues);
}

/** Non-empty required string. */
export const requiredString = z.string().min(1, "Required");

/** Optional string (undefined allowed). */
export const optionalString = z.string().optional();
