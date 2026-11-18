import { expect, test } from "@playwright/test";
import { getConsoleBasePath } from "./utils/base-paths";
import { loadDemoContext, pickConsoleUser } from "./utils/demo-accounts";
import { assertNoAppErrorReload } from "./utils/error-guards";
import { captureRuntimeErrors, expectNoRuntimeErrors } from "./utils/runtime-errors";
import { gotoEnsuringSignedIn } from "./utils/session";

test("Console manual shipment intake stays usable after empty submission", async ({ page }) => {
  const demo = loadDemoContext();
  const user = pickConsoleUser(demo);
  if (!user?.email || !demo.password) throw new Error("A Console demo account is required.");
  const prefix = "console-shipment-manual-create";
  const capture = captureRuntimeErrors(page);
  try {
    await gotoEnsuringSignedIn({
      page,
      url: `${getConsoleBasePath()}/resources/shipments/new`,
      authTestId: "console-auth-required",
      email: user.email,
      password: demo.password,
    });
    await expect(page.getByTestId(`${prefix}-ready`)).toBeVisible();
    const submit = page.getByTestId(`${prefix}-submit`);
    await expect(submit).toBeEnabled();
    await submit.click();
    await expect(page.getByTestId(`${prefix}-error`)).toBeVisible();
    await expect(page.getByTestId(`${prefix}-accepted`)).toHaveCount(0);
    await expect(submit).toBeEnabled();
    await assertNoAppErrorReload(page);
  } finally {
    capture.dispose();
  }
  await expectNoRuntimeErrors(capture, { label: "error-recovery-validation" });
});
