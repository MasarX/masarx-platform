import { expect, test } from "@playwright/test";
import { DEMO_USERS, signIn } from "./helpers/app";

test("FieldOps prevents queuing a scan without a barcode", async ({ page }) => {
  await signIn(page, DEMO_USERS.driver.email, DEMO_USERS.driver.password);
  await page.getByTestId("mobile-shell-tab-scan").click();
  const queue = page.getByTestId("mobile-scan-queue");
  await expect(queue).toBeVisible();
  await expect(queue).toBeDisabled();
  await expect(page.getByTestId("mobile-shell-ready")).toBeVisible();
});
