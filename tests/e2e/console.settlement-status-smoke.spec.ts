import { expect, test } from "@playwright/test";
import { getConsoleBasePath } from "./utils/base-paths";
import { loadDemoContext, pickConsoleUser } from "./utils/demo-accounts";
import { assertNoAppErrorReload } from "./utils/error-guards";
import { fetchLookupValueStrings } from "./utils/lookup";
import { gotoEnsuringSignedIn } from "./utils/session";

test("Console renders settlement statuses from the lookup", async ({ page }) => {
  const demo = loadDemoContext();
  const user = pickConsoleUser(demo);
  if (!user?.email || !demo.password) throw new Error("A Console demo account is required.");
  const statuses = await fetchLookupValueStrings("settlement_status");
  const normalize = (text: string) => text.trim().toLowerCase().replace(/[\s_-]+/g, "_");
  const validStatuses = new Set(statuses.map(normalize));
  expect(validStatuses.size).toBeGreaterThan(0);
  await gotoEnsuringSignedIn({
    page,
    url: `${getConsoleBasePath()}/marketplace/settlements`,
    authTestId: "console-auth-required",
    email: user.email,
    password: demo.password,
  });
  const ready = page.getByTestId("console-marketplace-settlements-ready");
  await expect(ready).toBeVisible();
  const cells = ready.locator('td[data-column-key="status"]');
  await expect(cells.first()).toBeVisible();
  for (const label of await cells.allTextContents()) {
    expect(validStatuses).toContain(normalize(label));
  }
  await assertNoAppErrorReload(page);
});
