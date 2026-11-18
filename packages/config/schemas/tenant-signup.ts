import { z } from "zod";
import { lookupValueSchema, optionalString, uuidSchema } from "./fields";

/** Tenant signup review form validation schema. */
export const tenantSignupSchema = z.object({
  request_id: uuidSchema,
  decision: lookupValueSchema,
  reason: optionalString,
  invite_redirect_to: z.string().url("Must be a valid URL").or(z.literal("")).optional(),
});

export type TenantSignupFormValues = z.infer<typeof tenantSignupSchema>;
