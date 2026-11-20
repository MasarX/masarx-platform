import { expect, test } from "@playwright/test";
import { getConsoleBasePath } from "./utils/base-paths";
import { hasCapability, resolveCapabilitySet } from "./utils/capabilities";
import { fetchResourcesWithMetadata } from "./utils/coverage-routes";
import { loadDemoContext } from "./utils/demo-accounts";
import { assertNoAppErrorReload } from "./utils/error-guards";
import { fetchUserContext } from "./utils/role-matrix";
import { gotoEnsuringSignedIn } from "./utils/session";

test("Console rejects a direct route when the test account lacks its read capability", async ({ page }) => {
  const demo = loadDemoContext();
  const user = demo.users.find(({ scope_type }) => scope_type === "client" || scope_type === "sender");
  if (!user?.email || !demo.password) throw new Error("A restricted demo account is required.");
  const [context, resources] = await Promise.all([
    fetchUserContext({ app: "console", email: user.email, password: demo.password }),
    fetchResourcesWithMetadata(),
  ]);
  expect(context.me?.capabilities).toBeDefined();
  const capabilities = resolveCapabilitySet(context.me?.capabilities);
  const target = resources.find(({ capabilities: required }) =>
    required.read && !hasCapability(capabilities, required.read)
  );
  if (!target) throw new Error("The test account requires at least one denied resource.");
  await gotoEnsuringSignedIn({
    page,
    url: `${getConsoleBasePath()}/resources/${encodeURIComponent(target.key)}`,
    authTestId: "console-auth-required",
    email: user.email,
    password: demo.password,
  });
  await expect(page.getByTestId("console-resource-blocked").or(page.getByTestId("console-resource-not-found"))).toBeVisible();
  await expect(page.getByTestId("console-resource-ready")).toHaveCount(0);
  await assertNoAppErrorReload(page);
});
