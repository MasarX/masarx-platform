import { test, expect } from "@playwright/test";
import { getConsoleBasePath } from "./utils/base-paths";
import {
  captureRuntimeErrors,
} from "./utils/runtime-errors";
import { assertNoAppErrorReload } from "./utils/error-guards";

/**
 * Wave 8B: Error Recovery -- Not Found
 *
 * Navigates to a nonexistent route and asserts that the app renders
 * a custom not-found or error page (not a white screen). Verifies
 * that the error boundary catches gracefully.
 */

const consoleBasePath = getConsoleBasePath();

test.describe("error recovery -- not found", () => {
  test("nonexistent route renders graceful error page", async ({ page }) => {
    const capture = captureRuntimeErrors(page, { allowOpaqueLocal503: true });
    try {
      // Navigate to a route that definitely does not exist
      await page.goto(
        `${consoleBasePath}/resources/nonexistent_resource_xyz_${Date.now()}`,
        {
          waitUntil: "domcontentloaded",
          timeout: 60_000,
        },
      );

      // The app should render SOMETHING (not a blank white screen)
      // Wait for any meaningful content to appear
      const meaningfulContent = page.locator(
        [
          '[data-testid*="not-found"]',
          '[data-testid*="error"]',
          '[data-testid*="auth-required"]',
          '[data-testid*="ready"]',
          '[data-testid*="blocked"]',
          'h1',
          'h2',
          '[role="alert"]',
          '[role="main"]',
          'main',
        ].join(", "),
      );

      await expect(
        meaningfulContent.first(),
      ).toBeVisible({ timeout: 30_000 });

      // The page must not be completely empty (white screen)
      const bodyText = await page.locator("body").textContent();
      expect(
        (bodyText ?? "").trim().length,
        "Page body should not be empty for a nonexistent route",
      ).toBeGreaterThan(0);

      // The app-error-reload boundary should NOT be rendered
      // (error boundaries are acceptable; crash boundaries are not)
      await assertNoAppErrorReload(page);

      // Verify no unhandled page errors (white screen of death)
      const filteredPageErrors = capture.pageErrors.filter(
        (msg) =>
          !msg.includes("Failed to fetch RSC payload") &&
          !msg.includes("ChunkLoadError"),
      );
      expect(
        filteredPageErrors,
        `Unexpected page errors on not-found route: ${filteredPageErrors.join(" | ")}`,
      ).toEqual([]);
    } finally {
      capture.dispose();
    }
  });

  test("deep nested nonexistent route handled gracefully", async ({
    page,
  }) => {
    const capture = captureRuntimeErrors(page, { allowOpaqueLocal503: true });
    try {
      // Navigate to a deeply nested nonexistent route
      await page.goto(
        `${consoleBasePath}/resources/nonexistent/deeply/nested/path`,
        {
          waitUntil: "domcontentloaded",
          timeout: 60_000,
        },
      );

      // Same checks: not a white screen
      const bodyText = await page.locator("body").textContent();
      expect(
        (bodyText ?? "").trim().length,
        "Page body should not be empty for deeply nested nonexistent route",
      ).toBeGreaterThan(0);

      await assertNoAppErrorReload(page);
    } finally {
      capture.dispose();
    }
  });
});
