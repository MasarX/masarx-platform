import { expect, test } from "@playwright/test";
import { getPortalBasePath } from "./utils/base-paths";
import { loadDemoContext } from "./utils/demo-accounts";
import { gotoEnsuringSignedIn } from "./utils/session";

for (const resource of ["recipients", "shipments"]) {
  test(`client scope without write access cannot import ${resource}`, async ({ page }) => {
    const { users, password } = loadDemoContext();
    const user = users.find((entry) => entry.scope_type === "client");
    if (!user || !password) throw new Error("Portal client identity fixture is required.");

    await gotoEnsuringSignedIn({
      page,
      url: `${getPortalBasePath()}/resources/${resource}`,
      authTestId: "portal-auth-required",
      email: user.email,
      password,
    });

    const button = page.getByRole("button", { name: "Import", exact: true }).first();
    await expect(button).toBeVisible();
    await expect(button).toBeDisabled();
  });
}
