import { test, expect } from '@playwright/test';
import {
  expectToastWithRpc,
  gotoSurfaceBySidebar,
  settle,
  waitForLiveResourceList,
  waitForLiveRpc,
} from './fixtures';

test('Lifecycle edge - Tenant signup reject path uses canonical review seam', async ({ page }) => {
  await gotoSurfaceBySidebar(page, /Organizations/i, '/platform/organizations');

  await page.locator('[data-testid="signup-status-pending"]').click();
  await settle(page, 200);

  const signupTable = page.locator('.dt__table tbody').nth(1);
  const rejectableRow = signupTable.locator('tr', { hasText: /Jazira Couriers/i }).first();
  await expect(rejectableRow, 'Expected a pending signup row with reject action coverage').toBeVisible();
  await rejectableRow.click();
  await settle(page, 300);

  const drawer = page.locator('[data-testid="org-signup-drawer"]');
  await expect(drawer).toBeVisible();
  const rejectButton = drawer.locator('button', { hasText: /^Reject$/ }).first();
  await expect(rejectButton, 'Reject must be capability-gated but enabled for seeded super_admin').not.toBeDisabled();
  await rejectButton.click();

  const rejectForm = page.locator('[data-testid="tenant-signup-reject-form"]');
  await expect(rejectForm, 'Reject opens the required reason form').toBeVisible();
  await rejectForm.getByLabel(/^Reason$/).fill('Lifecycle edge rejection proof.');
  await rejectForm.locator('button', { hasText: /Reject request/i }).click();

  await expectToastWithRpc(page, 'tenant-signup-review');
  await expect(page.locator('.toast', { hasText: /rejected/i }).first()).toBeAttached();
  await expect(drawer).toContainText('Lifecycle edge rejection proof.');
  await expect(drawer.locator('button', { hasText: /^Reject$/ }).first()).toBeDisabled();
});

test('Lifecycle edge - Basket UI rejects invalid local inputs before RPC submission', async ({ page }) => {
  await gotoSurfaceBySidebar(page, /Basket policy/i, '/operate/baskets');

  await page.locator('button', { hasText: /^New basket$/ }).click();
  const createModal = page.locator('[data-testid="basket-create-modal"]');
  await expect(createModal).toBeVisible();
  await createModal.getByLabel('Basket capacity').fill('0');
  await createModal.locator('button', { hasText: /^Create basket$/ }).click();
  await expect(createModal.locator('[role="status"]')).toContainText(/Capacity must be a positive number/i);
  await expect(page.locator('.toast', { hasText: /basket_create_v1/i })).toHaveCount(0);

  await page.keyboard.press('Escape');
  await settle(page, 200);

  await page.locator('button', { hasText: /^Basket policy$/ }).click();
  const policyModal = page.locator('[data-testid="basket-policy-modal"]');
  await expect(policyModal).toBeVisible();
  await policyModal.getByLabel('Priority bands').fill('urgent | not-a-score |');
  await policyModal.locator('button', { hasText: /^Preview$/ }).click();
  await expect(policyModal.locator('[role="status"]')).toContainText(/Invalid basket policy values/i);
  await expect(policyModal.locator('[role="status"]')).toContainText(/invalid minimum score/i);
  await expect(page.locator('.toast', { hasText: /request_settings_change_v1/i })).toHaveCount(0);
});

test('Lifecycle edge - Provider credential editor rejects invalid JSON before live upsert', async ({
  page,
}) => {
  await gotoSurfaceBySidebar(page, /Credentials/i, '/integrations/credentials');

  await page.locator('button', { hasText: /^New credential$/ }).click();
  const form = page.locator('[data-testid="provider-auth-config-form"]');
  await expect(form).toBeVisible();
  await form.locator('textarea[name="credentials"]').fill('["not-an-object"]');
  await page.locator('button[aria-label="Save credential"]').click();

  await expect(page.locator('.toast', { hasText: /Credentials JSON/i }).first()).toBeAttached();
  await expect(page.locator('.toast', { hasText: /ui_upsert_provider_auth_config_v1 - created/i })).toHaveCount(0);
});

test('Lifecycle edge @live-readiness - Release proof and onboarding readiness expose zero-gap governance paths', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error' && !/\[vite\]|\[HMR\]/i.test(message.text())) {
      errors.push(message.text());
    }
  });

  const readinessRpc = waitForLiveRpc(page, 'ui_get_onboarding_readiness_v1');
  await gotoSurfaceBySidebar(page, /Onboarding readiness/i, '/platform/onboarding-readiness');
  await readinessRpc;
  await expect(page.locator('[data-testid="onboarding-readiness-status"]')).toBeVisible();
  await expect(page.getByText('Settings defaults', { exact: true }).last()).toBeVisible();
  await expect(page.getByText('Workflow bindings', { exact: true }).last()).toBeVisible();
  await expect(page.getByText('Integration plugins', { exact: true }).last()).toBeVisible();

  const releaseProofRead = waitForLiveResourceList(page, 'release_deploy_proof_governance');
  await gotoSurfaceBySidebar(page, /Release proof/i, '/platform/release-proof');
  await releaseProofRead;
  await expect(page.locator('[data-testid="release-proof-kpis"]')).toBeVisible();
  await expect(page.locator('main')).toContainText(/Evidence gaps/i);

  expect(errors, `Unexpected lifecycle edge browser errors:\n${errors.join('\n')}`).toHaveLength(0);
});

test('Lifecycle edge @live-readiness - API Gateway shipment tester seeds payload from route policy', async ({
  page,
}) => {
  const routeRead = waitForLiveResourceList(page, 'api_routes');
  await gotoSurfaceBySidebar(page, /API gateway/i, '/insights/api-gateway');
  await routeRead;

  await page.locator('button', { hasText: /^Test shipment API$/ }).click();
  const form = page.locator('[data-testid="api-gateway-shipment-test-form"]');
  await expect(form).toBeVisible();
  await expect(form.getByLabel('Request payload')).toHaveValue(/API Gateway Recipient/);
  await expect(form.getByLabel('Request payload')).toHaveValue(/Riyadh/);
});
