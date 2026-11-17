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
