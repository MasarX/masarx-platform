import { z } from "zod";
import { optionalString, uuidSchema } from "./fields";

/** Shipment modify operation sub-schema. */
export const shipmentModifySchema = z.object({
  shipment_id: uuidSchema,
  operation: z.literal("modify"),
  service_type: optionalString,
  service_level: optionalString,
  client_reference_number: optionalString,
  carrier_reference_number: optionalString,
  special_instructions: optionalString,
  cod_amount: optionalString,
  metadata_json: optionalString,
  references_json: optionalString,
});

/** Shipment reschedule operation sub-schema. */
export const shipmentRescheduleSchema = z.object({
  shipment_id: uuidSchema,
  operation: z.literal("reschedule"),
  slot_date: z.string().min(1, "Slot date is required"),
});

/** Shipment address update operation sub-schema. */
export const shipmentAddressSchema = z.object({
  shipment_id: uuidSchema,
  operation: z.literal("address"),
  line1: optionalString,
  line2: optionalString,
  city: optionalString,
  province: optionalString,
  country: optionalString,
  postal_code: optionalString,
  district: optionalString,
  building_number: optionalString,
  raw_input: optionalString,
  additional_directions: optionalString,
});

/** Shipment cancel operation sub-schema. */
export const shipmentCancelSchema = z.object({
  shipment_id: uuidSchema,
  operation: z.literal("cancel"),
  cancel_reason: optionalString,
});

/** Discriminated union of all shipment amend/cancel operations. */
export const shipmentAmendSchema = z.discriminatedUnion("operation", [
  shipmentModifySchema,
  shipmentRescheduleSchema,
  shipmentAddressSchema,
  shipmentCancelSchema,
]);

export type ShipmentModifyFormValues = z.infer<typeof shipmentModifySchema>;
export type ShipmentRescheduleFormValues = z.infer<typeof shipmentRescheduleSchema>;
export type ShipmentAddressFormValues = z.infer<typeof shipmentAddressSchema>;
export type ShipmentCancelFormValues = z.infer<typeof shipmentCancelSchema>;
export type ShipmentAmendFormValues = z.infer<typeof shipmentAmendSchema>;
