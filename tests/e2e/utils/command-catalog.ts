import { expect, type Locator, type Page } from "@playwright/test";
import { ensureSignedIn } from "./session";

async function selectFirstNonEmptyOption(select: Locator) {
  const values = await select.locator("option").evaluateAll((options) =>
    options.map((option) => option.getAttribute("value") || "")
  );
  const nextValue = values.find((value) => value.trim().length > 0);
  if (nextValue) {
    await select.selectOption(nextValue);
    return true;
  }
  return false;
}

async function anyVisible(locator: Locator) {
  const count = await locator.count();
  for (let index = 0; index < count; index += 1) {
    if (await locator.nth(index).isVisible()) return true;
  }
  return false;
}

export async function runCommandCatalogFilters(params: {
  page: Page;
  basePath: string;
  testIdPrefix: string;
  authTestId: string;
  email: string;
  password: string;
  scopeType?: string | null;
}) {
  const { page, basePath, testIdPrefix, authTestId, email, password, scopeType } = params;
  await ensureSignedIn({ page, basePath, authTestId, email, password, scopeType });

  await page.goto(`${basePath}/commands`, {
    waitUntil: "domcontentloaded",
    timeout: 60_000,
  });

  const ready = page.locator(`[data-testid="${testIdPrefix}-commands-ready"]`);
  const state = page.locator(
    `[data-testid="${testIdPrefix}-commands-ready"], [data-testid="${testIdPrefix}-commands-error"], [data-testid="${authTestId}"]`
  );
  await expect.poll(() => anyVisible(state)).toBe(true);
  if (!(await anyVisible(ready))) return;

  const searchInput = page.locator(
    `[data-testid="${testIdPrefix}-commands-filter-search"]`
  );
  if ((await searchInput.count()) > 0) {
    await searchInput.first().fill("workflow");
    await expect
      .poll(() => page.url(), { timeout: 30_000 })
      .toContain("q=workflow");
  }

  const categorySelect = page.locator(
    `[data-testid="${testIdPrefix}-commands-filter-category"]`
  );
  if ((await categorySelect.count()) > 0) {
    if (await selectFirstNonEmptyOption(categorySelect.first())) {
      await expect
        .poll(() => page.url(), { timeout: 30_000 })
        .toContain("category=");
    }
  }

  const capabilitySelect = page.locator(
    `[data-testid="${testIdPrefix}-commands-filter-capability"]`
  );
  if ((await capabilitySelect.count()) > 0) {
    if (await selectFirstNonEmptyOption(capabilitySelect.first())) {
      await expect
        .poll(() => page.url(), { timeout: 30_000 })
        .toContain("capability=");
    }
  }

  const accessSelect = page.locator(
    `[data-testid="${testIdPrefix}-commands-filter-access"]`
  );
  if ((await accessSelect.count()) > 0) {
    await accessSelect.first().selectOption("allowed");
    await expect
      .poll(() => page.url(), { timeout: 30_000 })
      .toContain("access=allowed");
  }
}
