import { z } from "zod";

/**
 * Marketplace action form validation schema.
 *
 * Like the pickup form, the marketplace action form is fully dynamic —
 * fields are provided at runtime via the `fields` prop.
 * This schema validates the generic shape.
 */
export const marketplaceActionSchema = z.record(z.string(), z.string());

export type MarketplaceActionFormValues = z.infer<typeof marketplaceActionSchema>;
