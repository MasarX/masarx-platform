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
  if ((await previewForm.count()) > 0) {
    await expect(previewForm).toBeVisible();
  }

  const scopeIdInput = previewForm.locator(
    `[data-testid="${testIdPrefix}-preview-scope-id"]`
  );
  if ((await scopeIdInput.count()) > 0) {
    await scopeIdInput.first().fill("00000000-0000-0000-0000-000000000000");
  }

  const previewSubmit = previewForm.locator(
    `[data-testid="${testIdPrefix}-preview-submit"]`
  );
  if ((await previewSubmit.count()) > 0) {
    await previewSubmit.first().click();
    await expect.poll(() => page.url()).toContain("scope_id=");
  }
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

  const toggle = page.locator(
    `[data-testid="${testIdPrefix}-policy-toggle"]`
  );
  if ((await toggle.count()) > 0) {
    await toggle.first().click();
  }

  const rawInput = page.locator(
    `[data-testid="${testIdPrefix}-policy-raw"]`
  );
  if ((await rawInput.count()) > 0) {
    await rawInput.first().fill("invalid");
  }

  const rawError = page.locator(
    `[data-testid="${testIdPrefix}-policy-error"]`
  );
  if ((await rawError.count()) > 0) {
    await expect(rawError).toBeVisible();
  }

  const submit = page.locator(
    `[data-testid="${testIdPrefix}-submit"]`
  );
  if ((await submit.count()) > 0) {
    await expect(submit).toBeDisabled();
  }
}
