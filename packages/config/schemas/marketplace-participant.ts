import { z } from "zod";
import { lookupValueSchema, optionalString, uuidSchema } from "./fields";

/** Marketplace participant review form validation schema. */
export const marketplaceParticipantSchema = z.object({
  request_id: uuidSchema,
  participant_type_key: optionalString,
  decision: lookupValueSchema,
  reason: optionalString,
  invite_redirect_to: z.string().url("Must be a valid URL").or(z.literal("")).optional(),
});

export type MarketplaceParticipantFormValues = z.infer<typeof marketplaceParticipantSchema>;
