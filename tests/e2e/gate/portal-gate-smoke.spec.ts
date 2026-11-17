import { test } from "@playwright/test";
import { loadDemoContext } from "../utils/demo-accounts";
import { getPortalBasePath } from "../utils/base-paths";
import { isStrictE2EEnv } from "../utils/env";
import { assertNoAppErrorReload } from "../utils/error-guards";
import {
  buildGateResourceCandidates,
  openFirstReadyGateResource,
} from "../utils/gate-resource";
import { waitForAppShellHydrated } from "../utils/layout-guards";
import {
  ensureNavigationVisible,
  fetchUserContext,
} from "../utils/role-matrix";
import { signInIfAuthRequired } from "../utils/session";

const demoContext = loadDemoContext();
const strict = isStrictE2EEnv();
const portalBasePath = getPortalBasePath();

function enforceDemoContext() {
  if (demoContext.available) return;
  if (strict) {
    throw new Error(
      `Demo accounts missing for strict E2E: ${demoContext.reason ?? "unknown"}`
    );
  }
}

function pickPortalGateUser() {
  return (
    demoContext.users.find((user) =>
      ["client", "sender"].includes(user.scope_type ?? "")
    ) ??
    demoContext.users[0] ??
    null
  );
}

test.describe("@gate portal smoke", () => {
  test.skip(
    !demoContext.available && !strict,
    demoContext.reason ?? "Demo accounts missing."
  );

  test.beforeAll(enforceDemoContext);

  test("portal loads a resource list with an authenticated session", async ({ page }) => {
    test.setTimeout(180_000);

    const user = pickPortalGateUser();
    if (!user?.email) throw new Error("No demo user available for portal gate.");
    if (!demoContext.password) throw new Error("Demo password missing for portal gate.");

    await page.goto(portalBasePath || "/");
    await signInIfAuthRequired({
      page,
      authTestId: "portal-auth-required",
      email: user.email,
      password: demoContext.password,
      timeoutMs: 15_000,
    });

    await waitForAppShellHydrated(page, "portal");
    await ensureNavigationVisible(page);
    await assertNoAppErrorReload(page);

    const userContext = await fetchUserContext({
      app: "portal",
      email: user.email,
      password: demoContext.password,
    });
    const sections = Array.isArray(userContext.navigation.sections)
      ? userContext.navigation.sections
      : [];
    const resourceCandidates = buildGateResourceCandidates({
      basePath: portalBasePath,
      sections,
      readRegistry: userContext.readRegistry,
    });

    if (resourceCandidates.length === 0) {
      throw new Error("No portal resource navigation link available for @gate profile.");
    }

    await openFirstReadyGateResource({
      page,
      candidates: resourceCandidates,
      selector:
        '[data-testid="portal-resource-ready"], [data-testid="portal-resource-error"], [data-testid="portal-auth-required"]',
      authTestId: "portal-auth-required",
      email: user.email,
      password: demoContext.password,
    });

    await waitForAppShellHydrated(page, "portal");
    await assertNoAppErrorReload(page);
  });
});

