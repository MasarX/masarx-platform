import { test } from "@playwright/test";
import { loadDemoContext } from "../utils/demo-accounts";
import { getConsoleBasePath } from "../utils/base-paths";
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
const consoleBasePath = getConsoleBasePath();

function enforceDemoContext() {
  if (demoContext.available) return;
  if (strict) {
    throw new Error(
      `Demo accounts missing for strict E2E: ${demoContext.reason ?? "unknown"}`
    );
  }
}

function pickConsoleGateUser() {
  return (
    demoContext.users.find((user) => user.user_type === "super_admin") ??
    demoContext.users.find((user) =>
      ["platform", "tenant"].includes(user.scope_type ?? "")
    ) ??
    demoContext.users[0] ??
    null
  );
}

test.describe("@gate console smoke", () => {
  test.skip(
    !demoContext.available && !strict,
    demoContext.reason ?? "Demo accounts missing."
  );

  test.beforeAll(enforceDemoContext);

  test("console loads a resource list with an authenticated session", async ({ page }) => {
    test.setTimeout(180_000);

    const user = pickConsoleGateUser();
    if (!user?.email) throw new Error("No demo user available for console gate.");
    if (!demoContext.password) throw new Error("Demo password missing for console gate.");

    await page.goto(consoleBasePath || "/");
    await signInIfAuthRequired({
      page,
      authTestId: "console-auth-required",
      email: user.email,
      password: demoContext.password,
      timeoutMs: 15_000,
    });

    await waitForAppShellHydrated(page, "console");
    await ensureNavigationVisible(page);
    await assertNoAppErrorReload(page);

    const userContext = await fetchUserContext({
      app: "console",
      email: user.email,
      password: demoContext.password,
    });
    const sections = Array.isArray(userContext.navigation.sections)
      ? userContext.navigation.sections
      : [];
    const resourceCandidates = buildGateResourceCandidates({
      basePath: consoleBasePath,
      sections,
      readRegistry: userContext.readRegistry,
    });

    if (resourceCandidates.length === 0) {
      throw new Error("No console resource navigation link available for @gate profile.");
    }

    await openFirstReadyGateResource({
      page,
      candidates: resourceCandidates,
      selector:
        '[data-testid="console-resource-ready"], [data-testid="console-resource-error"], [data-testid="console-auth-required"]',
      authTestId: "console-auth-required",
      email: user.email,
      password: demoContext.password,
    });

    await waitForAppShellHydrated(page, "console");
    await assertNoAppErrorReload(page);
  });
});

