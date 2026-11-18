import { test } from "@playwright/test";
import { loadDemoContext } from "../utils/demo-accounts";
import { getConsoleBasePath } from "../utils/base-paths";
import { isStrictE2EEnv } from "../utils/env";
import { ensureSignedIn } from "../utils/session";
import { runWithRuntimeErrors } from "../utils/runtime-errors";
import { publicReviewInstallProof, resolveDemoMarketplaceScopeIds } from "../utils/automation-marketplace";

test("@gate console marketplace public review and copied install persist after reload", async ({ page }) => {
  const demo = loadDemoContext();
  if (!demo.available && !isStrictE2EEnv()) test.skip(true, demo.reason);
  const user = demo.users.find(entry => entry.user_type === "super_admin");
  if (!demo.available || !user || !demo.password) throw new Error("Marketplace gate requires an authorized super-admin fixture.");
  const basePath = getConsoleBasePath();
  const { organizationId } = await resolveDemoMarketplaceScopeIds();
  await ensureSignedIn({ page, basePath, authTestId: "console-auth-required", email: user.email, password: demo.password, scopeType: user.scope_type ?? null });
  await runWithRuntimeErrors(page, { label: "console-automation-marketplace-gate" }, () => publicReviewInstallProof(page, basePath, organizationId));
});
