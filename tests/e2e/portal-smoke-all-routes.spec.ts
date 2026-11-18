import { test, expect } from "@playwright/test";
import { getPortalBasePath } from "./utils/base-paths";
import {
  buildCoverageRoutes,
  buildPageStateSelector,
} from "./utils/coverage-routes";
import { assertNoAppErrorReload } from "./utils/error-guards";
import {
  assertSingleAppShellSidebar,
} from "./utils/layout-guards";
import {
  captureRuntimeErrors,
} from "./utils/runtime-errors";

/**
 * Portal Smoke Test -- All Routes (Dynamic Discovery)
 *
 * Discovers every Portal route via `buildCoverageRoutes("portal")` and asserts:
 *  - A page-state marker becomes visible (ready | error | auth-required)
 *  - No app-error-reload boundary is rendered
 *  - No unexpected runtime/console errors fire
 *
 * Dynamic routes with path params are excluded here; see portal-core-flows
 * and coverage-routes tests for those.
 */

const portalBasePath = getPortalBasePath();

/** Routes ending with /new typically render without the app shell sidebar. */
function shouldSkipSidebar(routePath: string): boolean {
  return /\/new\/?$/.test(routePath);
}

/** Derive a human-readable test label from a full route path. */
function routeLabel(routePath: string, basePath: string): string {
  const stripped = basePath && routePath.startsWith(basePath)
    ? routePath.slice(basePath.length) || "/"
    : routePath || "/";
  return stripped === "/" ? "/ (dashboard)" : stripped;
}

let discoveredRoutes: string[] | null = null;

test.beforeAll(async () => {
  discoveredRoutes = await buildCoverageRoutes("portal", portalBasePath);
});

test.describe("portal smoke -- all routes", () => {
  test("route discovery returned results", () => {
    expect(
      discoveredRoutes,
      "buildCoverageRoutes('portal') must return a non-empty array"
    ).toBeTruthy();
    expect(discoveredRoutes!.length).toBeGreaterThan(0);
  });

  test("smoke each discovered route", async ({ page }) => {
    const routes = discoveredRoutes ?? [];
    expect(routes.length).toBeGreaterThan(0);
    test.setTimeout(120_000 + routes.length * 90_000);

    for (const fullPath of routes) {
      const label = routeLabel(fullPath, portalBasePath);
      const skipSidebar = shouldSkipSidebar(fullPath);
      const capture = captureRuntimeErrors(page, {
        allowOpaqueLocal503: true,
      });

      try {
        await page.goto(fullPath || "/", {
          waitUntil: "domcontentloaded",
          timeout: 60_000,
        });

        // Wait for any page-state marker to become visible
        const stateLocator = page
          .locator(buildPageStateSelector("portal"))
          .first();
        await expect(stateLocator).toBeVisible({ timeout: 30_000 });

        // No error boundary
        await assertNoAppErrorReload(page);

        // Sidebar should render exactly once (when the shell is present)
        if (!skipSidebar) {
          const sidebar = page.locator(
            '[data-testid="portal-app-shell-sidebar"]'
          );
          if ((await sidebar.count()) > 0) {
            await assertSingleAppShellSidebar(page, "portal");
          }
        }
      } finally {
        capture.dispose();
      }

      // Assert no real page errors (allow common local dev noise)
      const filteredPageErrors = capture.pageErrors.filter(
        (msg) => !msg.includes("Failed to fetch RSC payload")
      );
      expect(
        filteredPageErrors,
        `${label}: unexpected page errors: ${filteredPageErrors.join(" | ")}`
      ).toEqual([]);
    }
  });
});
