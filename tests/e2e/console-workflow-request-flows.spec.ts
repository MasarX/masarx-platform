import { test, expect } from "@playwright/test";
import { loadDemoContext } from "./utils/demo-accounts";
import { getConsoleBasePath } from "./utils/base-paths";
import { isStrictE2EEnv } from "./utils/env";
import { ensureSignedIn } from "./utils/session";
import {
  fetchUserContext,
  flattenNavigationSections,
  normalizeNavHref,
} from "./utils/role-matrix";
import { fetchResourceSampleId } from "./utils/core-resource";
import { assertNavigationPerformance } from "./utils/performance";

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

test.describe("console workflow request flows", () => {
  test.skip(!demoContext.available && !strict, demoContext.reason ?? "Demo accounts missing.");

  const consoleUsers = demoContext.users.filter((user) =>
    ["platform", "tenant"].includes(user.scope_type ?? "")
  );

  test.beforeAll(() => enforceDemoContext("console", consoleUsers));

  test("workflow requests list and detail", async ({ page }) => {
    const basePath = getConsoleBasePath();
    let selectedUser: (typeof consoleUsers)[number] | null = null;
    let selectedRoute = "";
    let selectedResource = "";

    for (const candidate of consoleUsers) {
      const context = await fetchUserContext({
        app: "console",
        email: candidate.email,
        password: demoContext.password ?? "",
      });
      const items = flattenNavigationSections(context.navigation.sections ?? []);
      const workflowRouteHints = [
        "/workflows/requests",
        "/workflows/tasks",
        "/workflows/queue",
      ];
      const requestItem =
        items.find((item) => {
          const href = String(item.href ?? "").toLowerCase();
          return workflowRouteHints.some((hint) => href.includes(hint));
        }) ??
        items.find((item) => {
          const href = String(item.href ?? "").toLowerCase();
          return href.includes("/workflows/") && Boolean(item.resource);
        });

      if (!requestItem?.href || !requestItem.resource) {
        continue;
      }
      selectedUser = candidate;
      selectedRoute = normalizeNavHref(requestItem.href, basePath);
      selectedResource = requestItem.resource;
      break;
    }

    if (!selectedUser) {
      selectedUser = consoleUsers[0] ?? null;
      if (!selectedUser) {
        if (strict) {
          throw new Error("No console demo user available for workflow requests.");
        }
        test.skip(true, "No console demo user available for workflow requests.");
        return;
      }
    }
    if (!selectedRoute) {
      selectedRoute = `${basePath}/workflows/requests`;
    }
    if (!selectedResource) {
      const fallbackContext = await fetchUserContext({
        app: "console",
        email: selectedUser.email,
        password: demoContext.password ?? "",
      });
      const resources = Array.isArray(fallbackContext.readRegistry?.resources)
        ? fallbackContext.readRegistry?.resources
        : [];
      const requestResource =
        resources.find((entry) => entry?.key === "requests") ??
        resources.find((entry) =>
          String(entry?.key ?? "")
            .toLowerCase()
            .includes("request")
        ) ??
        null;
      selectedResource = String(requestResource?.key ?? "").trim();
    }

    await ensureSignedIn({
      page,
      basePath,
      authTestId: "console-auth-required",
      email: selectedUser.email,
      password: demoContext.password ?? "",
      scopeType: selectedUser.scope_type ?? null,
    });

    await page.goto(selectedRoute, {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });
    await expect(
      page.locator(
        '[data-testid="console-requests-ready"], [data-testid="console-requests-error"], [data-testid="console-auth-required"], [data-testid="console-not-found"], [data-testid="console-resource-blocked"]'
      ).first()
    ).toBeVisible();
    await assertNavigationPerformance(page);

    const ready = page.locator('[data-testid="console-requests-ready"]');
    if (!(await ready.isVisible())) {
      return;
    }
    if (!selectedResource) {
      return;
    }

    const sample = await fetchResourceSampleId({
      resourceKey: selectedResource,
      email: selectedUser.email,
      password: demoContext.password ?? "",
    });
    if (!sample.id) {
      return;
    }

    await page.goto(`${selectedRoute}?id=${encodeURIComponent(sample.id)}`, {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });
    await expect(
      page.locator(
        '[data-testid="console-requests-ready"], [data-testid="console-requests-error"], [data-testid="console-auth-required"]'
      ).first()
    ).toBeVisible();
    await assertNavigationPerformance(page);
    const detail = page.locator('[data-testid="console-requests-detail"]');
    if ((await detail.count()) > 0) {
      await expect(detail).toBeVisible();
    }
  });
});
