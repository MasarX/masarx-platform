import { test } from "@playwright/test";
import { loadDemoContext } from "./utils/demo-accounts";
import { getConsoleBasePath } from "./utils/base-paths";
import { isStrictE2EEnv } from "./utils/env";
import { runWithRuntimeErrors } from "./utils/runtime-errors";
import { ensureSignedIn } from "./utils/session";
import { installCopyViaUi, publishWorkflowListingViaUi, resolveDemoMarketplaceScopeIds } from "./utils/automation-marketplace";

test("console automation marketplace publishes a tenant-shared asset and reloads its isolated install", async ({ page }) => {
  const demo = loadDemoContext();
  if (!demo.available && !isStrictE2EEnv()) test.skip(true, demo.reason);
  const user = demo.users.find(entry => entry.user_type === "super_admin" && entry.scope_type === "platform");
  if (!demo.available || !user || !demo.password) throw new Error("Marketplace smoke requires an authorized freshly provisioned demo actor.");
  const basePath = getConsoleBasePath();
  const { organizationId } = await resolveDemoMarketplaceScopeIds();
  await ensureSignedIn({ page, basePath, authTestId: "console-auth-required", email: user.email, password: demo.password, scopeType: user.scope_type ?? null });
  await runWithRuntimeErrors(page, { label: "console-automation-marketplace-smoke" }, async () => {
    const listing = await publishWorkflowListingViaUi({ page, basePath, visibility: "tenant_shared", titlePrefix: "synthetic_marketplace_smoke" });
    await installCopyViaUi(page, basePath, listing.listingVersionId, organizationId);
  });
});
