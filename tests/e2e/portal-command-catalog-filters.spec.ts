import { test } from "@playwright/test";
import { loadDemoContext } from "./utils/demo-accounts";
import { getPortalBasePath } from "./utils/base-paths";
import { isStrictE2EEnv } from "./utils/env";
import { runCommandCatalogFilters } from "./utils/command-catalog";

const demoContext = loadDemoContext();
const strict = isStrictE2EEnv();

function enforceDemoContext(scopeLabel: string, users: Array<{ email: string }>) {
  if (!demoContext.available) {
    if (strict) {
      throw new Error(`Demo accounts missing for ${scopeLabel}: ${demoContext.reason}`);
    }
    return;
  }
  if (users.length === 0 && strict) {
    throw new Error(`No demo users available for ${scopeLabel}.`);
  }
}

test.describe("portal command catalog filters", () => {
  test.skip(!demoContext.available && !strict, demoContext.reason ?? "Demo accounts missing.");

  const portalUsers = demoContext.users.filter((user) =>
    ["client", "sender"].includes(user.scope_type ?? "")
  );

  test.beforeAll(() => enforceDemoContext("portal", portalUsers));

  test("portal command catalog filters", async ({ page }) => {
    const user = portalUsers[0];
    test.skip(!user, "No portal demo user available.");
    await runCommandCatalogFilters({
      page,
      basePath: getPortalBasePath(),
      testIdPrefix: "portal",
      authTestId: "portal-auth-required",
      email: user.email,
      password: demoContext.password ?? "",
      scopeType: user.scope_type ?? null,
    });
  });
});
