import { expect, type Page } from "@playwright/test";

export async function assertSingleAppShellSidebar(page: Page, appKey: string) {
  await expect(
    page.locator(`[data-testid="${appKey}-app-shell-sidebar"]`)
  ).toHaveCount(1);
}

export function buildAppShellHydrationSelector(appKey: string) {
  return [
    `[data-testid="${appKey}-app-shell-sidebar"]:visible`,
    '[data-testid="navigation-list"]:visible',
    `[data-testid="${appKey}-dashboard-ready"]:visible`,
    `[data-testid="${appKey}-resource-ready"]:visible`,
  ].join(", ");
}

export async function waitForAppShellHydrated(page: Page, appKey: string) {
  const sidebar = page.locator(`[data-testid="${appKey}-app-shell-sidebar"]`);
  const shellSignal = page.locator(buildAppShellHydrationSelector(appKey)).first();
  await expect(shellSignal).toBeVisible({ timeout: 20_000 });

  if ((await sidebar.count()) > 0) {
    await expect(sidebar.locator(":scope > .opacity-0")).toHaveCount(0);
  }
}

export async function waitForDashboardHealthReady(
  page: Page,
  appKey: "console" | "portal",
  email: string,
) {
  const stateHandle = await page.waitForFunction(
    (app) => {
      for (const testId of [
        `${app}-dashboard-error`,
        `${app}-context-unavailable`,
        `${app}-auth-required`,
        `${app}-missing-env`,
      ]) {
        if (document.querySelector(`[data-testid="${testId}"]`)) {
          return `error:${testId}`;
        }
      }
      return document.querySelector(`[data-testid="${app}-dashboard-ready"]`) &&
        document.querySelector(`[data-testid="${app}-dashboard-health"]`)
        ? "ready"
        : false;
    },
    appKey,
    { timeout: 20_000 },
  );
  try {
    const state = await stateHandle.jsonValue();
    if (state !== "ready") {
      throw new Error(`Dashboard readiness failed (${state}).`);
    }
  } finally {
    await stateHandle.dispose();
  }

  const dashboard = page.locator(`[data-testid="${appKey}-dashboard-ready"]`);
  await expect(dashboard).toHaveCount(1, { timeout: 10_000 });
  await expect(dashboard.getByText(email, { exact: true })).toHaveCount(1, {
    timeout: 10_000,
  });
  await expect(
    page.locator(`[data-testid="${appKey}-dashboard-health"]`),
  ).toHaveCount(1, { timeout: 10_000 });
  await waitForAppShellHydrated(page, appKey);
}
