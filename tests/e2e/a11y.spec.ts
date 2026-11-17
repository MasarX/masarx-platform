import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { getConsoleBaseUrl, getPortalBaseUrl } from "./utils/base-urls";

const consoleBaseUrl = getConsoleBaseUrl();
const portalBaseUrl = getPortalBaseUrl();

async function expectReady(page: import("@playwright/test").Page, selector: string) {
  await expect(page.locator(selector)).toBeVisible();
}

async function runA11y(page: import("@playwright/test").Page) {
  const results = await new AxeBuilder({ page }).analyze();
  expect(results.violations).toEqual([]);
}

test("console dashboard meets a11y baseline", async ({ page }) => {
  await page.goto(consoleBaseUrl);
  await expectReady(
    page,
    '[data-testid="console-dashboard-ready"], [data-testid="console-dashboard-error"], [data-testid="console-auth-required"], [data-testid="console-missing-env"]'
  );
  await runA11y(page);
});

test("console access policy meets a11y baseline", async ({ page }) => {
  await page.goto(`${consoleBaseUrl}/access-policy`);
  await expectReady(
    page,
    '[data-testid="console-access-policy-ready"], [data-testid="console-access-policy-error"], [data-testid="console-auth-required"], [data-testid="console-missing-env"]'
  );
  await runA11y(page);
});

test("console access overview meets a11y baseline", async ({ page }) => {
  await page.goto(`${consoleBaseUrl}/access`);
  await expectReady(
    page,
    '[data-testid="console-access-ready"], [data-testid="console-access-error"], [data-testid="console-auth-required"], [data-testid="console-missing-env"]'
  );
  await runA11y(page);
});

test("console access policy request meets a11y baseline", async ({ page }) => {
  await page.goto(`${consoleBaseUrl}/access-policy/request`);
  await expectReady(
    page,
    '[data-testid="console-access-policy-request-form"], [data-testid="console-access-policy-request-blocked"], [data-testid="console-access-policy-request-error"], [data-testid="console-auth-required"], [data-testid="console-missing-env"]'
  );
  await runA11y(page);
});

test("console commands meets a11y baseline", async ({ page }) => {
  await page.goto(`${consoleBaseUrl}/commands`);
  await expectReady(
    page,
    '[data-testid="console-commands-ready"], [data-testid="console-commands-error"], [data-testid="console-auth-required"], [data-testid="console-missing-env"]'
  );
  await runA11y(page);
});

test("console workflow queue meets a11y baseline", async ({ page }) => {
  await page.goto(`${consoleBaseUrl}/workflows/queue`);
  await expectReady(
    page,
    '[data-testid="console-manual-review-queue-ready"], [data-testid="console-manual-review-queue-error"], [data-testid="console-auth-required"], [data-testid="console-missing-env"]'
  );
  await runA11y(page);
});

test("console workflow tasks meets a11y baseline", async ({ page }) => {
  await page.goto(`${consoleBaseUrl}/workflows/tasks`);
  await expectReady(
    page,
    '[data-testid="console-manual-review-tasks-ready"], [data-testid="console-manual-review-tasks-error"], [data-testid="console-auth-required"], [data-testid="console-missing-env"]'
  );
  await runA11y(page);
});

test("console settings request meets a11y baseline", async ({ page }) => {
  await page.goto(`${consoleBaseUrl}/settings/request`);
  await expectReady(
    page,
    '[data-testid="console-settings-request-form"], [data-testid="console-settings-request-blocked"], [data-testid="console-settings-request-error"], [data-testid="console-auth-required"], [data-testid="console-missing-env"]'
  );
  await runA11y(page);
});

test("console provider auth meets a11y baseline", async ({ page }) => {
  await page.goto(`${consoleBaseUrl}/integrations/provider-auth`);
  await expectReady(
    page,
    '[data-testid="console-provider-auth-ready"], [data-testid="console-provider-auth-error"], [data-testid="console-auth-required"], [data-testid="console-missing-env"]'
  );
  await runA11y(page);
});

test("console domain events meets a11y baseline", async ({ page }) => {
  await page.goto(`${consoleBaseUrl}/observability/domain-events`);
  await expectReady(
    page,
    '[data-testid="console-domain-events-ready"], [data-testid="console-domain-events-error"], [data-testid="console-auth-required"], [data-testid="console-missing-env"]'
  );
  await runA11y(page);
});

test("portal dashboard meets a11y baseline", async ({ page }) => {
  await page.goto(portalBaseUrl);
  await expectReady(
    page,
    '[data-testid="portal-dashboard-ready"], [data-testid="portal-dashboard-error"], [data-testid="portal-auth-required"], [data-testid="portal-missing-env"]'
  );
  await runA11y(page);
});

test("portal access policy request meets a11y baseline", async ({ page }) => {
  await page.goto(`${portalBaseUrl}/access-policy/request`);
  await expectReady(
    page,
    '[data-testid="portal-access-policy-request-form"], [data-testid="portal-access-policy-request-blocked"], [data-testid="portal-access-policy-request-error"], [data-testid="portal-auth-required"], [data-testid="portal-missing-env"]'
  );
  await runA11y(page);
});

test("portal access policy meets a11y baseline", async ({ page }) => {
  await page.goto(`${portalBaseUrl}/access-policy`);
  await expectReady(
    page,
    '[data-testid="portal-access-policy-ready"], [data-testid="portal-access-policy-error"], [data-testid="portal-auth-required"], [data-testid="portal-missing-env"]'
  );
  await runA11y(page);
});

test("portal access overview meets a11y baseline", async ({ page }) => {
  await page.goto(`${portalBaseUrl}/access`);
  await expectReady(
    page,
    '[data-testid="portal-access-ready"], [data-testid="portal-access-error"], [data-testid="portal-auth-required"], [data-testid="portal-missing-env"]'
  );
  await runA11y(page);
});

test("portal tracking meets a11y baseline", async ({ page }) => {
  await page.goto(`${portalBaseUrl}/tracking`);
  await expectReady(
    page,
    '[data-testid="portal-tracking-form"], [data-testid="portal-tracking-error"], [data-testid="portal-auth-required"], [data-testid="portal-missing-env"]'
  );
  await runA11y(page);
});

test("portal commands meets a11y baseline", async ({ page }) => {
  await page.goto(`${portalBaseUrl}/commands`);
  await expectReady(
    page,
    '[data-testid="portal-commands-ready"], [data-testid="portal-commands-error"], [data-testid="portal-auth-required"], [data-testid="portal-missing-env"]'
  );
  await runA11y(page);
});

test("portal settings request meets a11y baseline", async ({ page }) => {
  await page.goto(`${portalBaseUrl}/settings/request`);
  await expectReady(
    page,
    '[data-testid="portal-settings-request-form"], [data-testid="portal-settings-request-blocked"], [data-testid="portal-settings-request-error"], [data-testid="portal-auth-required"], [data-testid="portal-missing-env"]'
  );
  await runA11y(page);
});

test("portal help meets a11y baseline", async ({ page }) => {
  await page.goto(`${portalBaseUrl}/help`);
  await expectReady(
    page,
    '[data-testid="portal-help-ready"], [data-testid="portal-auth-required"], [data-testid="portal-missing-env"]'
  );
  await runA11y(page);
});

test("portal workflow queue meets a11y baseline", async ({ page }) => {
  await page.goto(`${portalBaseUrl}/workflows/queue`);
  await expectReady(
    page,
    '[data-testid="portal-manual-review-queue-ready"], [data-testid="portal-manual-review-queue-error"], [data-testid="portal-auth-required"], [data-testid="portal-missing-env"]'
  );
  await runA11y(page);
});

test("portal workflow tasks meets a11y baseline", async ({ page }) => {
  await page.goto(`${portalBaseUrl}/workflows/tasks`);
  await expectReady(
    page,
    '[data-testid="portal-manual-review-tasks-ready"], [data-testid="portal-manual-review-tasks-error"], [data-testid="portal-auth-required"], [data-testid="portal-missing-env"]'
  );
  await runA11y(page);
});
