import { expect, test } from "@playwright/test";
import { DEMO_USERS, signIn } from "./helpers/app";

test("opens the receiving shift summary and preferences through the modules menu", async ({ page }) => {
  await signIn(page, DEMO_USERS.driver.email, DEMO_USERS.driver.password);
  await page.getByTestId("mobile-menu-toggle").click();
  await page.getByTestId("mobile-module-more").click();
  await expect(page.getByTestId("mobile-driver-shift-status")).toBeVisible();
  await expect(page.getByTestId("mobile-start-driver-shift")).toBeVisible();
  await expect(page.getByTestId("mobile-end-driver-shift")).toBeVisible();
  await expect(page.getByText("Display preferences", { exact: true })).toBeVisible();
});
