import { z } from "zod";
import { optionalString, requiredString } from "./fields";

/** Marketplace request create form validation schema. */
export const marketplaceRequestSchema = z.object({
  request_kind_key: requiredString,
  title: requiredString,
  summary: optionalString,
  private_pool_csv: optionalString,
  payload_json: z.string().default("{}"),
  publish_after_create: z.boolean().default(false),
});

export type MarketplaceRequestFormValues = z.infer<typeof marketplaceRequestSchema>;
