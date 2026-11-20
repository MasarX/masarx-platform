import { expect, test } from "@playwright/test";
import { getConsoleBasePath } from "./utils/base-paths";
import { fetchResourceSampleRow } from "./utils/core-resource";
import { loadDemoContext, pickConsoleUser } from "./utils/demo-accounts";
import { assertNoAppErrorReload } from "./utils/error-guards";
import { fetchLookupValueStrings } from "./utils/lookup";
import { gotoEnsuringSignedIn } from "./utils/session";

test("Console renders the selected shipment and its supporting detail sections", async ({ page }) => {
  const demo = loadDemoContext();
  const user = pickConsoleUser(demo);
  if (!user?.email || !demo.password) throw new Error("A Console demo account is required.");
  const [sample, statuses] = await Promise.all([
    fetchResourceSampleRow({ resourceKey: "shipments", email: user.email, password: demo.password }),
    fetchLookupValueStrings("shipment_status"),
  ]);
  const id = sample.item?.id;
  if (typeof id !== "string" || !id) throw new Error("The Console test account requires a visible shipment.");
  expect(statuses).toContain(sample.item?.status);
  await gotoEnsuringSignedIn({
    page,
    url: `${getConsoleBasePath()}/resources/shipments?${new URLSearchParams({ id, detail_open: "1" })}`,
    authTestId: "console-auth-required",
    email: user.email,
    password: demo.password,
  });
  await expect(page.getByTestId("console-resource-ready")).toBeVisible();
  await expect(page.getByTestId("console-resource-shipment-timeline")).toBeVisible();
  await expect(page.getByTestId("console-resource-shipment-pod-assets")).toBeVisible();
  await assertNoAppErrorReload(page);
});
