import { z } from "zod";
import { optionalString, requiredString } from "./fields";

/** Settings request form validation schema. */
export const settingsRequestSchema = z.object({
  category: requiredString,
  scope_type: requiredString,
  scope_id: optionalString,
  settings_json: z.string().min(1, "Settings JSON is required"),
  change_reason: optionalString,
  effective_from: optionalString,
});

export type SettingsRequestFormValues = z.infer<typeof settingsRequestSchema>;
