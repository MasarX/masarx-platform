import { z } from "zod";

/**
 * Pickup operations form validation schema.
 *
 * The pickup form is fully dynamic — fields are provided at runtime
 * via the `fields` prop. This schema validates the generic shape:
 * a record of field-name to string value entries.
 */
export const pickupSchema = z.record(z.string(), z.string());

export type PickupFormValues = z.infer<typeof pickupSchema>;
