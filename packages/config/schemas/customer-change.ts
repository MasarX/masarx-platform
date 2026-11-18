import { z } from "zod";
import { lookupValueSchema, optionalString, uuidSchema } from "./fields";

/** Customer shipment change review form validation schema. */
export const customerChangeSchema = z.object({
  support_case_id: uuidSchema,
  decision: lookupValueSchema,
  reason: optionalString,
});

export type CustomerChangeFormValues = z.infer<typeof customerChangeSchema>;
