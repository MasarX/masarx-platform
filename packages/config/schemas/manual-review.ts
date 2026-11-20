import { z } from "zod";
import { lookupValueSchema, optionalString, uuidSchema } from "./fields";

/** Manual review resolve form validation schema. */
export const manualReviewSchema = z.object({
  task_id: uuidSchema,
  resolution_outcome: lookupValueSchema,
  resolution_notes: optionalString,
});

export type ManualReviewFormValues = z.infer<typeof manualReviewSchema>;
