import { expect, type Page } from "@playwright/test";

export async function assertNoAppErrorReload(page: Page) {
  await expect(page.locator('[data-testid="app-error-reload"]')).toHaveCount(0);
}
