import type { ShipmentAmendCancelOptions } from "./shipment-amend-cancel-form";

// Match the backend's exact field membership. Missing or malformed policy grants nothing.
export function getShipmentModifyAllowedFields(
  options: ShipmentAmendCancelOptions,
): ReadonlySet<string> {
  const fields: unknown = options.policy?.modify_allowed_fields;
  return new Set(Array.isArray(fields) ? fields.filter((field): field is string => typeof field === "string") : []);
}
