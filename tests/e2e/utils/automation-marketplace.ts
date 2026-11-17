import fs from "fs";
import path from "path";
import { expect, type Page } from "@playwright/test";
import en from "../../../packages/config/messages/en.json";
import ar from "../../../packages/config/messages/ar.json";
import { createWorkflowTemplateDraftViaUi, ensureWorkflowTemplateFlowHasStep, toggleWorkflowTemplateFlowStepEnabledAndVerifyPersistence } from "./workflow-studio";
import { assertE2EMutationsAllowed } from "./mutations";
import { appendMutationManifestEntry } from "./mutation-manifest";

const locale = process.env.NEXT_PUBLIC_LOCALE || "en";
if (locale !== "en" && locale !== "ar") throw new Error("Marketplace E2E locale must be en or ar.");
export const marketplaceText = (locale === "ar" ? ar : en).ui.automationMarketplace;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function resolveDemoMarketplaceScopeIds() {
  const manifestPath = process.env.DEMO_ACCOUNTS_PATH ?? path.join(process.cwd(), "tmp", "demo-accounts.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as { organization?: { id?: string } };
  const organizationId = manifest.organization?.id ?? "";
  if (!UUID.test(organizationId)) throw new Error("A freshly provisioned demo manifest with organization.id is required for marketplace fixtures.");
  return { organizationId };
}

export function buildMarketplaceManifest(overrides: Record<string, unknown> = {}) {
  return { display: { title: "Synthetic marketplace proof", summary: "Synthetic test fixture" }, docs: {}, variable_schema: { keys: ["channel"] }, connection_requirements: { bindings: [] }, dependency_requirements: { required_assets: [] }, capability_requirements: [], install_constraints: { allowed_scope_placeholders: [], allowed_target_scope_types: ["tenant", "client", "sender"] }, egress_profile: {}, compatibility: {}, artifact_hash: "", ...overrides };
}

export async function publishWorkflowListingViaUi({ page, basePath, visibility, titlePrefix, manifest = buildMarketplaceManifest() }: { page: Page; basePath: string; visibility: "private" | "tenant_shared" | "marketplace_public"; titlePrefix: string; manifest?: Record<string, unknown> }) {
  assertE2EMutationsAllowed({ label: "automation-marketplace:publish", details: "Creates a synthetic listing through native publication/review actions." });
  const { templateId } = await createWorkflowTemplateDraftViaUi({ page, basePath, testIdPrefix: "console", namePrefix: titlePrefix });
  await ensureWorkflowTemplateFlowHasStep({ page, testIdPrefix: "console" });
  await page.goto(`${basePath}/automation/marketplace/publish?asset_kind=workflow_template&source_id=${encodeURIComponent(templateId)}`);
  const main = page.getByRole("main");
  const form = main.getByTestId("automation-marketplace-publish-form");
  await expect(form).toBeVisible();
  await form.getByLabel(marketplaceText.visibility, { exact: true }).selectOption(visibility);
  await form.getByLabel(marketplaceText.listingTitle, { exact: true }).fill(`${titlePrefix}_${Date.now()}`);
  await form.getByLabel(marketplaceText.manifest, { exact: true }).fill(JSON.stringify(manifest));
  await form.getByRole("button", { name: marketplaceText.createListing, exact: true }).click();
  await expect(page).toHaveURL(visibility === "marketplace_public" ? /\/reviews\?id=/ : /\/marketplace\/[0-9a-f-]+$/i, { timeout: 120_000 });
  if (visibility === "marketplace_public") {
    await expect(main.getByTestId("console-automation-marketplace-review-status")).toContainText(marketplaceText.options.pending);
    const reviewId = new URL(page.url()).searchParams.get("id")!;
    const listingVersionId = (await main.getByTestId("console-automation-marketplace-review-listing-version").textContent())?.trim() ?? "";
    expect(UUID.test(reviewId)).toBe(true); expect(UUID.test(listingVersionId)).toBe(true);
    appendMutationManifestEntry({ kind: "unknown", id: reviewId, label: "automation marketplace review", metadata: { listing_version_id: listingVersionId } });
    return { templateId, listingId: null, reviewId, listingVersionId };
  }
  const listingId = decodeURIComponent(new URL(page.url()).pathname.split("/").pop()!);
  expect(UUID.test(listingId)).toBe(true);
  const installHref = await main.getByRole("link", { name: marketplaceText.installCopy, exact: true }).getAttribute("href");
  const listingVersionId = new URL(installHref!, page.url()).searchParams.get("listing_version_id")!;
  expect(UUID.test(listingVersionId)).toBe(true);
  appendMutationManifestEntry({ kind: "unknown", id: listingId, label: "automation marketplace listing" });
  return { templateId, listingId, reviewId: null, listingVersionId };
}

export async function installCopyViaUi(page: Page, basePath: string, versionId: string, organizationId: string, connectionBindings: Record<string, unknown> = {}) {
  assertE2EMutationsAllowed({ label: "automation-marketplace:install", details: "Installs a synthetic isolated draft copy with explicit variables." });
  await page.goto(`${basePath}/automation/marketplace/install?listing_version_id=${encodeURIComponent(versionId)}`);
  const main = page.getByRole("main");
  const form = main.getByTestId("automation-marketplace-install-form");
  await expect(form).toBeVisible();
  await form.getByLabel(marketplaceText.targetScopeId, { exact: true }).fill(organizationId);
  await form.getByLabel(marketplaceText.variables, { exact: true }).fill(JSON.stringify({ channel: "synthetic-test" }));
  await form.getByLabel(marketplaceText.bindings, { exact: true }).fill(JSON.stringify(connectionBindings));
  await form.getByRole("button", { name: marketplaceText.installCopy, exact: true }).click();
  await expect(page).toHaveURL(/\/installs\/manage\?install_id=/, { timeout: 120_000 });
  const installId = new URL(page.url()).searchParams.get("install_id")!;
  expect(UUID.test(installId)).toBe(true);
  const installed = main.getByTestId("automation-marketplace-install-manage-form");
  await expect(installed.getByTestId("automation-marketplace-install-current-version")).toHaveText(versionId);
  await page.reload();
  await expect(installed.getByTestId("automation-marketplace-install-current-version")).toHaveText(versionId);
  appendMutationManifestEntry({ kind: "unknown", id: installId, label: "automation marketplace installed copy" });
  return installId;
}

export async function decideReviewViaUi(page: Page, basePath: string, reviewId: string, decision: "approved" | "rejected") {
  assertE2EMutationsAllowed({ label: "automation-marketplace:review", details: "Applies a native review decision and confirms persisted readback after reload." });
  await page.goto(`${basePath}/automation/marketplace/reviews/decide?review_id=${encodeURIComponent(reviewId)}`);
  const main = page.getByRole("main");
  const form = main.getByTestId("automation-marketplace-review-decision-form");
  await expect(form).toBeVisible();
  await form.getByLabel(marketplaceText.decision, { exact: true }).selectOption(decision);
  await form.getByRole("button", { name: marketplaceText.applyDecision, exact: true }).click();
  await expect(page).toHaveURL(/\/reviews\?id=/);
  await expect(main.getByTestId("console-automation-marketplace-review-status")).toContainText(marketplaceText.options[decision]);
  await page.reload();
  await expect(main.getByTestId("console-automation-marketplace-review-status")).toContainText(marketplaceText.options[decision]);
}

export async function publicReviewInstallProof(page: Page, basePath: string, organizationId: string) {
  const listing = await publishWorkflowListingViaUi({ page, basePath, visibility: "marketplace_public", titlePrefix: "synthetic_marketplace_review", manifest: buildMarketplaceManifest({ variable_schema: { keys: ["channel"] } }) });
  await decideReviewViaUi(page, basePath, listing.reviewId!, "approved");
  await installCopyViaUi(page, basePath, listing.listingVersionId, organizationId);
}

export async function createNextWorkflowListingVersion(page: Page, basePath: string, listingId: string, templateId: string) {
  assertE2EMutationsAllowed({ label: "automation-marketplace:append-version", details: "Edits a synthetic workflow and creates/publishes its next immutable version through native UI actions, never direct table DML." });
  await page.goto(`${basePath}/workflows/templates/${encodeURIComponent(templateId)}`);
  await toggleWorkflowTemplateFlowStepEnabledAndVerifyPersistence({ page, testIdPrefix: "console" });
  await page.goto(`${basePath}/automation/marketplace/publish?listing_id=${encodeURIComponent(listingId)}&asset_kind=workflow_template&source_id=${encodeURIComponent(templateId)}&visibility=tenant_shared`);
  const main = page.getByRole("main");
  const form = main.getByTestId("automation-marketplace-publish-form");
  await expect(form).toBeVisible();
  await form.getByLabel(marketplaceText.manifest, { exact: true }).fill(JSON.stringify(buildMarketplaceManifest()));
  await form.getByRole("button", { name: marketplaceText.createListing, exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/marketplace/${listingId}$`), { timeout: 120_000 });
  const href = await main.getByRole("link", { name: marketplaceText.installCopy, exact: true }).getAttribute("href");
  const versionId = new URL(href!, page.url()).searchParams.get("listing_version_id")!;
  expect(UUID.test(versionId)).toBe(true);
  return versionId;
}
