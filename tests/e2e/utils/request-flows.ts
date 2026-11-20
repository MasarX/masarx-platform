import { expect, type Page } from "@playwright/test";
import { ensureSignedIn } from "./session";
import {
  assertNavigationPerformance,
  assertWebVitals,
  installWebVitalsObserver,
} from "./performance";
import { assertNoAppErrorReload } from "./error-guards";

async function toggleFirstCollapsibleSection(page: Page, testIdPrefix: string) {
  const prefix = testIdPrefix?.trim();
  const selector = prefix
    ? `[data-testid^="${prefix}-section-"][data-testid$="-details"]`
    : "section > details";
  const sections = page.locator(selector);
  if ((await sections.count()) === 0) return false;
  const section = sections.first();
  const summary = section.locator("summary");
  if ((await summary.count()) === 0) return false;
  const wasOpen = await section.evaluate((node) => (node as HTMLDetailsElement).open);
  await summary.first().click();
  let toggled = false;
  try {
    await expect
      .poll(
        () =>
          section.evaluate((node) => (node as HTMLDetailsElement).open),
        { timeout: 4_000 }
      )
      .not.toBe(wasOpen);
    toggled = true;
  } catch {
    toggled = false;
  }
  if (toggled) {
    await summary.first().click();
  }
  return toggled;
}

export async function runSettingsRequestFlow(params: {
  page: Page;
  basePath: string;
  testIdPrefix: string;
  authTestId: string;
  email: string;
  password: string;
  scopeType?: string | null;
}) {
  const {
    page,
    basePath,
    testIdPrefix,
    authTestId,
    email,
    password,
    scopeType,
  } = params;
  await ensureSignedIn({
    page,
    basePath,
    authTestId,
    email,
    password,
    scopeType,
  });

  await installWebVitalsObserver(page);
  await page.goto(`${basePath}/settings/request`, {
    waitUntil: "domcontentloaded",
    timeout: 60_000,
  });
  const stateReady = page.locator(`[data-testid="${testIdPrefix}-ready"]`);
  const stateBlocked = page.locator(`[data-testid="${testIdPrefix}-blocked"]`);
  const stateBlockedNotice = page.locator(
    `[data-testid="${testIdPrefix}-blocked-notice"]`
  );
  const stateError = page.locator(`[data-testid="${testIdPrefix}-error"]`);
  const form = page.locator(`[data-testid="${testIdPrefix}-form"]`);
  await expect(
    page.locator(
      `[data-testid="${testIdPrefix}-form"], [data-testid="${testIdPrefix}-error"], [data-testid="${testIdPrefix}-blocked"], [data-testid="${testIdPrefix}-blocked-notice"], [data-testid="${authTestId}"]`
      ).first()
    ).toBeVisible();
  await assertNoAppErrorReload(page);
  await assertNavigationPerformance(page);
  await assertWebVitals(page);

  if (await stateError.isVisible()) {
    const errorText = (await stateError.innerText().catch(() => "")).trim();
    throw new Error(
      `Settings request entered error state for ${email}: ${errorText || "unknown error"}`
    );
  }

  if ((await stateBlocked.isVisible()) || (await stateBlockedNotice.isVisible())) {
    const blockedText = (
      await stateBlocked
        .or(stateBlockedNotice)
        .first()
        .innerText()
        .catch(() => "")
    ).trim();
    throw new Error(
      `Settings request blocked for ${email}: ${blockedText || "blocked"}`
    );
  }

  await expect(stateReady).toBeVisible();
  await expect(form).toBeVisible();

  await toggleFirstCollapsibleSection(page, testIdPrefix);

  const previewForm = page.locator(
    `[data-testid="${testIdPrefix}-preview"]`
  );
  await expect(previewForm).toBeVisible();
  await expect(previewForm.getByTestId(`${testIdPrefix}-preview-category`)).toHaveValue(/\S+/);
  await expect(previewForm.getByTestId(`${testIdPrefix}-preview-scope-type`)).toHaveValue(/\S+/);

  const scopeId = "00000000-0000-0000-0000-000000000000";
  await previewForm.getByTestId(`${testIdPrefix}-preview-scope-id`).fill(scopeId);
  await previewForm.getByTestId(`${testIdPrefix}-preview-submit`).click();
  await expect.poll(() => new URL(page.url()).searchParams.get("scope_id")).toBe(scopeId);
}

export async function runAccessPolicyRequestFlow(params: {
  page: Page;
  basePath: string;
  testIdPrefix: string;
  authTestId: string;
  email: string;
  password: string;
  scopeType?: string | null;
}) {
  const {
    page,
    basePath,
    testIdPrefix,
    authTestId,
    email,
    password,
    scopeType,
  } = params;
  await ensureSignedIn({
    page,
    basePath,
    authTestId,
    email,
    password,
    scopeType,
  });

  await installWebVitalsObserver(page);
  await page.goto(`${basePath}/access-policy/request`, {
    waitUntil: "domcontentloaded",
    timeout: 60_000,
  });
  const stateReady = page.locator(`[data-testid="${testIdPrefix}-ready"]`);
  const stateBlocked = page.locator(`[data-testid="${testIdPrefix}-blocked"]`);
  const stateBlockedNotice = page.locator(
    `[data-testid="${testIdPrefix}-blocked-notice"]`
  );
  const stateError = page.locator(`[data-testid="${testIdPrefix}-error"]`);
  const form = page.locator(`[data-testid="${testIdPrefix}-form"]`);
  await expect(
    page.locator(
      `[data-testid="${testIdPrefix}-form"], [data-testid="${testIdPrefix}-error"], [data-testid="${testIdPrefix}-blocked"], [data-testid="${testIdPrefix}-blocked-notice"], [data-testid="${authTestId}"]`
      ).first()
    ).toBeVisible();
  await assertNoAppErrorReload(page);
  await assertNavigationPerformance(page);
  await assertWebVitals(page);

  if (await stateError.isVisible()) {
    const errorText = (await stateError.innerText().catch(() => "")).trim();
    throw new Error(
      `Access policy request entered error state for ${email}: ${errorText || "unknown error"}`
    );
  }

  if ((await stateBlocked.isVisible()) || (await stateBlockedNotice.isVisible())) {
    const blockedText = (
      await stateBlocked
        .or(stateBlockedNotice)
        .first()
        .innerText()
        .catch(() => "")
    ).trim();
    throw new Error(
      `Access policy request blocked for ${email}: ${blockedText || "blocked"}`
    );
  }

  await expect(stateReady).toBeVisible();
  await expect(form).toBeVisible();

  await toggleFirstCollapsibleSection(page, testIdPrefix);

  await form.getByTestId(`${testIdPrefix}-policy-toggle`).click();
  await form.getByTestId(`${testIdPrefix}-policy-raw`).fill("invalid");
  await expect(form.getByTestId(`${testIdPrefix}-policy-error`)).toBeVisible();
  await expect(form.getByTestId(`${testIdPrefix}-submit`)).toBeDisabled();
}
