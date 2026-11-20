import { expect, test } from "@playwright/test";
import { getConsoleBasePath } from "./utils/base-paths";
import { loadDemoContext, pickConsoleUser } from "./utils/demo-accounts";
import { assertNoAppErrorReload } from "./utils/error-guards";
import { discoverResourcePath } from "./utils/navigation";
import { captureRuntimeErrors, expectNoRuntimeErrors } from "./utils/runtime-errors";
import { gotoEnsuringSignedIn } from "./utils/session";

test("Console restores access after session cookies are cleared", async ({ page }) => {
  const demo = loadDemoContext();
  const user = pickConsoleUser(demo);
  if (!user?.email || !demo.password) throw new Error("A Console demo account is required.");
  const resourcePath = (await discoverResourcePath("console")) ?? "/resources/shipments";
  const url = `${getConsoleBasePath()}${resourcePath}`;
  const authTestId = "console-auth-required";
  const session = { page, url, authTestId, email: user.email, password: demo.password };
  const ready = page.getByTestId("console-resource-ready");
  const capture = captureRuntimeErrors(page);
  try {
    await gotoEnsuringSignedIn(session);
    await expect(ready).toBeVisible();
    await page.context().clearCookies();
    await page.goto(url, { waitUntil: "domcontentloaded" });
    await expect(page.getByTestId(authTestId)).toBeVisible();
    await gotoEnsuringSignedIn(session);
    await expect(ready).toBeVisible();
    await assertNoAppErrorReload(page);
  } finally {
    capture.dispose();
  }
  await expectNoRuntimeErrors(capture, { label: "error-recovery-session" });
});
