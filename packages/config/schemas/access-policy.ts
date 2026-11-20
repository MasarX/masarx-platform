import { z } from "zod";
import { optionalString, requiredString } from "./fields";

/** Access policy request form validation schema. */
export const accessPolicySchema = z.object({
  scope_type: requiredString,
  scope_id: optionalString,
  policy_json: z.string().min(1, "Policy JSON is required"),
  change_reason: optionalString,
  effective_from: optionalString,
});

export type AccessPolicyFormValues = z.infer<typeof accessPolicySchema>;
