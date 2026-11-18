import { expect, test } from "@playwright/test";
import { DEMO_USERS, signIn } from "./helpers/app";

test("FieldOps shows task cards or the route's empty state", async ({ page }) => {
  await signIn(page, DEMO_USERS.driver.email, DEMO_USERS.driver.password);
  await page.getByTestId("mobile-shell-tab-tasks").click();
  const card = page.getByTestId(/^mobile-task-card-/).first();
  const empty = page.getByText(/no (?:assigned (?:route )?stops|tasks)/i).first();
  await expect(card.or(empty).first()).toBeVisible();
  await expect(page.getByTestId("mobile-shell-ready")).toBeVisible();
});
