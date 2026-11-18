import { expect, test, type Page } from "@playwright/test";
import { loadDemoContext } from "./utils/demo-accounts";
import { getConsoleBasePath } from "./utils/base-paths";
import { isStrictE2EEnv } from "./utils/env";
import { ensureSignedIn } from "./utils/session";
import { runWithRuntimeErrors } from "./utils/runtime-errors";
import { assertE2EMutationsAllowed } from "./utils/mutations";
import { appendMutationManifestEntry } from "./utils/mutation-manifest";
import { marketplaceText as t, buildMarketplaceManifest, createNextWorkflowListingVersion, decideReviewViaUi, installCopyViaUi, publicReviewInstallProof, publishWorkflowListingViaUi, resolveDemoMarketplaceScopeIds } from "./utils/automation-marketplace";

async function signIn(page: Page) {
  const demo = loadDemoContext();
  if (!demo.available && !isStrictE2EEnv()) test.skip(true, demo.reason);
  const user = demo.users.find(entry => entry.user_type === "super_admin");
  if (!demo.available || !user || !demo.password) throw new Error("Marketplace completion requires an authorized freshly provisioned super-admin fixture.");
  const basePath = getConsoleBasePath();
  const { organizationId } = await resolveDemoMarketplaceScopeIds();
  await ensureSignedIn({ page, basePath, authTestId: "console-auth-required", email: user.email, password: demo.password, scopeType: user.scope_type ?? null });
  return { basePath, organizationId };
}

test("marketplace public submission, approval and installed copy survive reload", async ({ page }) => {
  const { basePath, organizationId } = await signIn(page);
  await runWithRuntimeErrors(page, { label: "automation-marketplace-public-review" }, () => publicReviewInstallProof(page, basePath, organizationId));
});

test("marketplace rejects a public review and does not claim a successful install", async ({ page }) => {
  const { basePath, organizationId } = await signIn(page);
  assertE2EMutationsAllowed({ label: "automation-marketplace:rejected-install", details: "Attempts an install of a rejected synthetic listing and verifies no success navigation." });
  const listing = await publishWorkflowListingViaUi({ page, basePath, visibility: "marketplace_public", titlePrefix: "synthetic_marketplace_rejected" });
  await decideReviewViaUi(page, basePath, listing.reviewId!, "rejected");
  await page.goto(`${basePath}/automation/marketplace/install?listing_version_id=${encodeURIComponent(listing.listingVersionId)}`);
  const form = page.getByRole("main").getByTestId("automation-marketplace-install-form");
  await expect(form).toBeVisible();
  await form.getByLabel(t.targetScopeId, { exact: true }).fill(organizationId);
  await form.getByRole("button", { name: t.installCopy, exact: true }).click();
  await expect(form.getByRole("alert")).toHaveText(t.actionFailed);
  await expect(page).toHaveURL(/\/marketplace\/install\?/);
});

test("connection secrets stay show-once and materialized copies refuse rebinding while existing bindings persist", async ({ page }) => {
  const { basePath, organizationId } = await signIn(page);
  assertE2EMutationsAllowed({ label: "automation-marketplace:connection-lifecycle", details: "Creates, tests, rotates and revokes an installer-owned synthetic connection through UI actions." });
  const main = page.getByRole("main");
  const form = main.getByTestId("automation-marketplace-connection-form");
  const installed = main.getByTestId("automation-marketplace-install-manage-form");
  await page.goto(`${basePath}/automation/marketplace/connections/manage`);
  await expect(form).toBeVisible();
  await form.getByLabel(t.ownerScopeId, { exact: true }).fill(organizationId);
  await form.getByLabel(t.providerKey, { exact: true }).fill(`synthetic_inbound_${Date.now()}`);
  await form.getByLabel(t.authType, { exact: true }).selectOption("hmac_shared_secret");
  await form.getByLabel(t.secretStorage, { exact: true }).selectOption("hash_only");
  await form.getByLabel(t.generateSecret, { exact: true }).check();
  await form.getByRole("button", { name: t.saveConnection, exact: true }).click();
  const secretField = form.getByLabel(t.shownOnce, { exact: true });
  await expect(secretField).toHaveAttribute("type", "password");
  await form.getByRole("button", { name: t.showSecret, exact: true }).click();
  const firstSecret = await secretField.inputValue();
  expect(Boolean(firstSecret)).toBe(true);
  const connectionId = (await form.getByTestId("automation-marketplace-connection-id").textContent())!.trim();
  appendMutationManifestEntry({ kind: "unknown", id: connectionId, label: "automation marketplace connection" });
  await form.getByRole("link", { name: t.openSavedConnection, exact: true }).click();
  await expect(form).toBeVisible();
  await expect(form.getByTestId("automation-marketplace-connection-generated-secret")).toHaveCount(0);
  await form.getByRole("button", { name: t.testConnection, exact: true }).click();
  await expect(form.getByTestId("automation-marketplace-connection-status")).toHaveText(t.options.ready);
  await form.getByLabel(t.generateSecret, { exact: true }).check();
  await form.getByRole("button", { name: t.rotateConnection, exact: true }).click();
  await expect(secretField).toHaveAttribute("type", "password");
  await form.getByRole("button", { name: t.showSecret, exact: true }).click();
  const rotatedSecret = await secretField.inputValue();
  expect(Boolean(rotatedSecret) && rotatedSecret !== firstSecret).toBe(true);
  await page.goto(`${basePath}/automation/marketplace/connections/manage`);
  await expect(form).toBeVisible();
  await form.getByLabel(t.ownerScopeId, { exact: true }).fill(organizationId);
  await form.getByLabel(t.providerKey, { exact: true }).fill(`synthetic_rebind_${Date.now()}`);
  await form.getByLabel(t.authType, { exact: true }).selectOption("hmac_shared_secret");
  await form.getByLabel(t.secretStorage, { exact: true }).selectOption("hash_only");
  await form.getByLabel(t.generateSecret, { exact: true }).check();
  await form.getByRole("button", { name: t.saveConnection, exact: true }).click();
  await expect(form.getByLabel(t.shownOnce, { exact: true })).toHaveAttribute("type", "password");
  const secondConnectionId = (await form.getByTestId("automation-marketplace-connection-id").textContent())!.trim();
  appendMutationManifestEntry({ kind: "unknown", id: secondConnectionId, label: "automation marketplace rebind connection" });
  await form.getByRole("link", { name: t.openSavedConnection, exact: true }).click();
  await form.getByRole("button", { name: t.testConnection, exact: true }).click();
  await expect(form.getByTestId("automation-marketplace-connection-status")).toHaveText(t.options.ready);
  const listing = await publishWorkflowListingViaUi({ page, basePath, visibility: "tenant_shared", titlePrefix: "synthetic_marketplace_binding", manifest: buildMarketplaceManifest({ connection_requirements: { bindings: [{ key: "synthetic_provider" }] } }) });
  const installId = await installCopyViaUi(page, basePath, listing.listingVersionId, organizationId, { synthetic_provider: { connection_id: connectionId } });
  await installed.getByLabel(t.bindingKey, { exact: true }).fill("synthetic_provider");
  await installed.getByLabel(t.connectionId, { exact: true }).fill(secondConnectionId);
  await installed.getByRole("button", { name: t.bindConnection, exact: true }).click();
  await expect(installed.getByRole("alert")).toHaveText(t.actionFailed);
  await expect(installed.getByText(t.bindingCopyHint, { exact: true })).toBeVisible();
  await expect(installed.getByRole("status").filter({ hasText: t.bindingSaved })).toHaveCount(0);
  await installed.getByLabel(t.connectionId, { exact: true }).fill(connectionId);
  const bindingReadback = page.waitForResponse(response => {
    if (!response.url().endsWith("/rpc/ui_get_resource_v1")) return false;
    try { return response.request().postDataJSON().p_resource === "automation_asset_install_bindings"; } catch { return false; }
  });
  await installed.getByRole("button", { name: t.bindConnection, exact: true }).click();
  const binding = await (await bindingReadback).json();
  expect(binding.install_id === installId && binding.connection_id === connectionId && binding.binding_key === "synthetic_provider").toBe(true);
  await expect(installed.getByRole("status").filter({ hasText: t.bindingSaved })).toBeVisible();
  await page.goto(`${basePath}/automation/marketplace/connections/manage?connection_id=${encodeURIComponent(connectionId)}`);
  await form.getByRole("button", { name: t.revokeConnection, exact: true }).click();
  await expect(form.getByTestId("automation-marketplace-connection-status")).toHaveText(t.options.revoked);
  await page.reload();
  await expect(form.getByTestId("automation-marketplace-connection-status")).toHaveText(t.options.revoked);
  await expect(form.getByTestId("automation-marketplace-connection-generated-secret")).toHaveCount(0);
});

test("unconfigured OAuth cannot be enabled by provider-controlled metadata", async ({ page }) => {
  const { basePath, organizationId } = await signIn(page);
  assertE2EMutationsAllowed({ label: "automation-marketplace:oauth-default-denial", details: "Creates a synthetic unconfigured OAuth connection; no production stub or arbitrary issuer is enabled." });
  await page.goto(`${basePath}/automation/marketplace/connections/manage`);
  const form = page.getByRole("main").getByTestId("automation-marketplace-connection-form");
  await expect(form).toBeVisible();
  await form.getByLabel(t.ownerScopeId, { exact: true }).fill(organizationId);
  await form.getByLabel(t.providerKey, { exact: true }).fill(`synthetic_unconfigured_${Date.now()}`);
  await form.getByLabel(t.authType, { exact: true }).selectOption("oauth2_authorization_code_pkce");
  await form.getByLabel(t.oauthMetadata, { exact: true }).fill(JSON.stringify({ authorization_url: "https://untrusted.invalid/authorize", configured: true }));
  await form.getByRole("button", { name: t.saveConnection, exact: true }).click();
  await form.getByRole("link", { name: t.openSavedConnection, exact: true }).click();
  await expect(form.getByTestId("automation-marketplace-oauth-unavailable")).toBeVisible();
  await expect(form.getByRole("button", { name: t.startOauth, exact: true })).toHaveCount(0);
});

test("native version append feeds manual upgrade and fork isolation without direct table writes", async ({ page }) => {
  test.slow();
  const { basePath, organizationId } = await signIn(page);
  assertE2EMutationsAllowed({ label: "automation-marketplace:upgrade-fork", details: "Publishes a new immutable version via the native listingId flow, then manually upgrades and forks its synthetic installed copy." });
  const listing = await publishWorkflowListingViaUi({ page, basePath, visibility: "tenant_shared", titlePrefix: "synthetic_marketplace_upgrade" });
  const installId = await installCopyViaUi(page, basePath, listing.listingVersionId, organizationId);
  const nextVersionId = await createNextWorkflowListingVersion(page, basePath, listing.listingId!, listing.templateId);
  expect(nextVersionId !== listing.listingVersionId).toBe(true);
  await page.goto(`${basePath}/automation/marketplace/installs/manage?install_id=${encodeURIComponent(installId)}`);
  const form = page.getByRole("main").getByTestId("automation-marketplace-install-manage-form");
  await expect(form).toBeVisible();
  await expect(form.getByRole("button", { name: t.applyUpgrade, exact: true })).toBeDisabled();
  await form.getByLabel(t.targetVersion, { exact: true }).fill(nextVersionId);
  await form.getByRole("button", { name: t.previewUpgrade, exact: true }).click();
  await expect(form.getByTestId("automation-marketplace-upgrade-preview")).toContainText(nextVersionId);
  await form.getByRole("button", { name: t.applyUpgrade, exact: true }).click();
  await expect(form.getByTestId("automation-marketplace-install-current-version")).toHaveText(nextVersionId);
  await page.reload();
  await expect(form.getByTestId("automation-marketplace-install-current-version")).toHaveText(nextVersionId);
  await form.getByRole("button", { name: t.markForked, exact: true }).click();
  await expect(form.getByRole("status").filter({ hasText: t.forked })).toBeVisible();
  await page.reload();
  await form.getByRole("button", { name: t.previewUpgrade, exact: true }).click();
  await expect(form.getByTestId("automation-marketplace-upgrade-preview")).toBeVisible();
  await expect(form.getByRole("button", { name: t.applyUpgrade, exact: true })).toBeDisabled();
});
