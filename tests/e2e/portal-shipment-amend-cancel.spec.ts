import { test } from "@playwright/test";
import { exerciseShipmentChange } from "./utils/shipment-amend-cancel";

test("Portal amends a shipment and verifies the saved change", async ({ page }) => {
  await exerciseShipmentChange(page, "portal", "modify");
});

test("Portal soft-cancels an eligible shipment and blocks expired cancellation", async ({ page }) => {
  await exerciseShipmentChange(page, "portal", "cancel");
});
