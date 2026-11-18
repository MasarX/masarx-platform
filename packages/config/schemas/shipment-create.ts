import { z } from "zod";
import { emailSchema, optionalString, phoneSchema, requiredString } from "./fields";

/** Address sub-schema shared by destination and origin. */
const addressSchema = z.object({
  rawInput: optionalString,
  city: optionalString,
  province: optionalString,
  country: optionalString,
  postalCode: optionalString,
  buildingNumber: optionalString,
  additionalDirections: optionalString,
});

/** Recipient sub-schema. */
const recipientSchema = z.object({
  name: z.string().optional(),
  phoneNumber: phoneSchema.or(z.literal("")).optional(),
  email: emailSchema.or(z.literal("")).optional(),
  preferredLanguage: optionalString,
});

/** Box row sub-schema. */
const boxSchema = z.object({
  key: requiredString,
  boxNumber: optionalString,
  weightKg: optionalString,
  lengthCm: optionalString,
  widthCm: optionalString,
  heightCm: optionalString,
  contentsDescription: optionalString,
  fragile: z.boolean().default(false),
});

/** Reference row sub-schema. */
const referenceSchema = z.object({
  key: requiredString,
  referenceType: optionalString,
  referenceValue: optionalString,
});

/** Shipment create form validation schema. */
export const shipmentCreateSchema = z.object({
  clientId: requiredString,
  senderId: optionalString,
  serviceType: requiredString,
  trackingNumber: optionalString,
  clientReferenceNumber: optionalString,
  carrierReferenceNumber: optionalString,
  // Status default should come from form initial values (read from DB policy),
  // not the validation schema. Callers provide the default via form state.
  status: z.string().optional(),
  recipient: recipientSchema,
  destinationAddress: addressSchema,
  originAddress: addressSchema,
  boxes: z.array(boxSchema).min(1, "At least one box is required"),
  references: z.array(referenceSchema).default([]),
});

export type ShipmentCreateFormValues = z.infer<typeof shipmentCreateSchema>;
