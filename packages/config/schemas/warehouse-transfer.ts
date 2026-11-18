import { z } from "zod";
import { optionalString, requiredString, uuidSchema } from "./fields";

/** Warehouse transfer manifest create form validation schema. */
export const warehouseTransferSchema = z.object({
  transferCode: requiredString,
  fromBranchId: requiredString,
  toBranchId: requiredString,
  plannedDispatchAt: optionalString,
  plannedReceiveAt: optionalString,
  shipmentIds: z
    .array(uuidSchema)
    .min(1, "At least one shipment ID is required"),
});

export type WarehouseTransferFormValues = z.infer<typeof warehouseTransferSchema>;
