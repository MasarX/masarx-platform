import { test } from "@playwright/test";
import { exerciseShipmentChange } from "./utils/shipment-amend-cancel";

test("Console amends a shipment and verifies the saved change", async ({ page }) => {
  await exerciseShipmentChange(page, "console", "modify");
});

test("Console soft-cancels an eligible shipment and blocks expired cancellation", async ({ page }) => {
  await exerciseShipmentChange(page, "console", "cancel");
});
