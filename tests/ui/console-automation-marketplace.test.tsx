import * as React from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import en from "../../packages/config/messages/en.json";
import ar from "../../packages/config/messages/ar.json";

let mockLocale = "en";
const mockPush = jest.fn();
const mockRefresh = jest.fn();
const mockToast = jest.fn();
jest.mock("next/navigation", () => ({ useRouter: () => ({ push: mockPush, refresh: mockRefresh }) }));
jest.mock("@masarx/config", () => ({ ...jest.requireActual("@masarx/config"), getPublicConfig: () => ({ locale: mockLocale }) }));
jest.mock("@masarx/api", () => ({ ...jest.requireActual("@masarx/api"), createUiClient: jest.fn() }));
jest.mock("@masarx/ui", () => ({
  ...jest.requireActual("../../packages/ui/src/url-guard"),
  ...jest.requireActual("../../packages/ui/src/button"),
  ...jest.requireActual("../../packages/ui/src/input"),
  ...jest.requireActual("../../packages/ui/src/textarea"),
  ...jest.requireActual("../../packages/ui/src/checkbox"),
  ...jest.requireActual("../../packages/ui/src/i18n"),
  ...jest.requireActual("../../packages/ui/src/capabilities"),
  useToast: () => ({ toast: mockToast }),
}));
import { createUiClient } from "@masarx/api";
import { AutomationMarketplacePublishForm } from "../../apps/console/app/automation/marketplace/_components/publish-form";
import { AutomationMarketplaceInstallForm } from "../../apps/console/app/automation/marketplace/_components/install-form";
import { AutomationMarketplaceInstallManageForm } from "../../apps/console/app/automation/marketplace/_components/install-manage-form";
import { AutomationMarketplaceReviewDecisionForm } from "../../apps/console/app/automation/marketplace/_components/review-decision-form";
import { AutomationMarketplaceConnectionForm } from "../../apps/console/app/automation/marketplace/_components/connection-form";

const access = { userId: "synthetic-user", scopeKey: "//", capabilities: ["read", "publish", "review", "install", "upgrade", "manage_connections"].map(capability => `automation_marketplace.${capability}`) };
const props = { appBasePath: "/console", access };
const strings = en.ui.automationMarketplace;
const methods = ["me", "getResource", "createAutomationAssetListing", "publishAutomationAssetVersion", "submitAutomationAssetReview", "decideAutomationAssetReview", "installAutomationAsset", "previewAutomationAssetUpgrade", "applyAutomationAssetUpgrade", "forkAutomationAssetInstall", "bindIntegrationConnectionInstall", "upsertIntegrationConnection", "testIntegrationConnection", "rotateIntegrationConnection", "revokeIntegrationConnection", "rpc"] as const;
let ui: Record<typeof methods[number], jest.Mock>;
const submit = (name: string) => fireEvent.submit(screen.getByTestId(`automation-marketplace-${name}-form`));
const confirmed = async () => waitFor(() => expect(mockToast).toHaveBeenCalledWith(expect.objectContaining({ tone: "success" })));
const failed = async () => { await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument()); expect(mockPush).not.toHaveBeenCalled(); expect(mockToast).not.toHaveBeenCalledWith(expect.objectContaining({ tone: "success" })); };

beforeEach(() => {
  jest.clearAllMocks(); mockLocale = "en";
  ui = Object.fromEntries(methods.map(name => [name, jest.fn()])) as typeof ui;
  ui.me.mockResolvedValue({ user: { id: access.userId }, capabilities: access.capabilities });
  (createUiClient as jest.Mock).mockReturnValue(ui);
});

function publication(visibility = "private") {
  let status = "draft";
  ui.createAutomationAssetListing.mockResolvedValue({ ok: true, listing_id: "listing", listing_version_id: "version" });
  ui.publishAutomationAssetVersion.mockImplementation(async () => { status = "approved"; return { ok: true, listing_id: "listing", listing_version_id: "version" }; });
  ui.submitAutomationAssetReview.mockImplementation(async () => { status = "submitted"; return { ok: true, listing_id: "listing", listing_version_id: "version", review_id: "review" }; });
  ui.getResource.mockImplementation(async (resource: string, id: string) => resource === "automation_asset_reviews" ? { id, listing_version_id: "version", review_status: "pending" } : resource === "automation_asset_listings" ? { id, latest_listing_version_id: "version", publication_status: status, visibility } : { id, listing_id: "listing", publication_status: status });
  return <AutomationMarketplacePublishForm {...props} defaultSourceId="source" defaultVisibility={visibility} />;
}

test.each(["private", "tenant_shared", "marketplace_public"])("publishes %s only after canonical lifecycle readbacks", async visibility => {
  render(publication(visibility)); submit("publish"); await confirmed();
  expect(mockPush).toHaveBeenCalledWith(visibility === "marketplace_public" ? "/console/automation/marketplace/reviews?id=review&detail_open=1" : "/console/automation/marketplace/listing");
  expect(ui.getResource).toHaveBeenCalledWith("automation_asset_listing_versions", "version");
  expect(ui.publishAutomationAssetVersion).toHaveBeenCalledTimes(visibility === "marketplace_public" ? 0 : 1);
  expect(ui.submitAutomationAssetReview).toHaveBeenCalledTimes(visibility === "marketplace_public" ? 1 : 0);
});

test.each(["createAutomationAssetListing", "publishAutomationAssetVersion", "submitAutomationAssetReview"] as const)("rejects false ok from %s even with identifiers", async method => {
  const node = publication(method === "submitAutomationAssetReview" ? "marketplace_public" : "private");
  ui[method].mockResolvedValue({ ok: false, listing_id: "listing", listing_version_id: "version", review_id: "review" });
  render(node); submit("publish"); await failed();
});

test("does not announce success when canonical publication state disagrees", async () => {
  const node = publication(); ui.getResource.mockResolvedValue({ id: "listing", latest_listing_version_id: "different", publication_status: "draft" });
  render(node); submit("publish"); await failed(); expect(ui.publishAutomationAssetVersion).not.toHaveBeenCalled();
});

test("rejects non-object JSON without echoing its contents", async () => {
  render(publication()); fireEvent.change(screen.getByLabelText(strings.manifest), { target: { value: '["synthetic-secret"]' } });
  submit("publish"); await failed(); expect(ui.createAutomationAssetListing).not.toHaveBeenCalled(); expect(screen.queryByText("synthetic-secret")).not.toBeInTheDocument();
});

test("disables actions without the page capability and rechecks identity before mutations", async () => {
  const { unmount } = render(<AutomationMarketplacePublishForm {...props} access={{ userId: access.userId, capabilities: [] }} defaultSourceId="source" />);
  expect(screen.getByRole("button", { name: strings.createListing })).toBeDisabled(); unmount();
  render(publication()); ui.me.mockResolvedValue({ user: { id: "other-user" }, capabilities: ["*"] }); submit("publish"); await failed(); expect(ui.createAutomationAssetListing).not.toHaveBeenCalled();
});

test("blocks unsafe app destinations", () => {
  render(<AutomationMarketplacePublishForm {...props} appBasePath="//untrusted.example" defaultSourceId="source" />);
  expect(screen.getByRole("button", { name: strings.createListing })).toBeDisabled();
});
test("does not mutate after the same user's native scope changes", async () => {
  render(publication()); ui.me.mockResolvedValue({ user: { id: access.userId }, capabilities: access.capabilities, org: { id: "different-tenant" } });
  submit("publish"); await failed(); expect(ui.createAutomationAssetListing).not.toHaveBeenCalled();
});

test("suppresses duplicate submissions and stale completion after identity props change", async () => {
  let resolve!: (value: unknown) => void;
  const node = publication(); ui.createAutomationAssetListing.mockReturnValue(new Promise(done => { resolve = done; }));
  const { rerender } = render(node); submit("publish"); submit("publish");
  await waitFor(() => expect(ui.createAutomationAssetListing).toHaveBeenCalledTimes(1));
  rerender(<AutomationMarketplacePublishForm {...props} defaultSourceId="different-source" />);
  await act(async () => resolve({ ok: true, listing_id: "listing", listing_version_id: "version" }));
  expect(ui.getResource).not.toHaveBeenCalled(); expect(mockPush).not.toHaveBeenCalled(); expect(mockToast).not.toHaveBeenCalled();
});

test("keeps entered data and gives translated reload guidance for unconfirmed transport outcome", async () => {
  render(publication()); ui.createAutomationAssetListing.mockRejectedValue({ code: "rpc_outcome_unconfirmed", message: "bearer synthetic-private-value" });
  fireEvent.change(screen.getByLabelText(strings.listingTitle), { target: { value: "Keep this title" } }); submit("publish"); await failed();
  expect(screen.getByRole("alert")).toHaveTextContent(strings.outcomeUnconfirmed); expect(screen.getByLabelText(strings.listingTitle)).toHaveValue("Keep this title"); expect(document.body.textContent).not.toContain("synthetic-private-value");
});

function install(activated = false) {
  ui.installAutomationAsset.mockResolvedValue({ ok: true, install_id: "install", activation_result: { activated } });
  ui.getResource.mockResolvedValue({ id: "install", install_status: "installed", installed_from_listing_version_id: "version", target_scope_type: "tenant", target_scope_id: "scope", metadata: { activation_result: { activated } } });
  return <AutomationMarketplaceInstallForm {...props} defaultListingVersionId="version" defaultTargetScopeId="scope" />;
}

test.each(["en", "ar"])("explains the secret-execution deferral at the activation control in %s", locale => {
  mockLocale = locale;
  const copy = (locale === "ar" ? ar : en).ui.automationMarketplace;
  render(install());
  const activation = screen.getByLabelText(copy.activate);
  expect(activation).not.toBeChecked();
  expect(activation).toHaveAccessibleDescription(copy.activationHint);
  expect(copy.activationHint).toContain(locale === "ar" ? "إصدار لاحق" : "a later release");
});
test("installs a copy with installer variables and bindings without claiming activation", async () => {
  render(install()); fireEvent.change(screen.getByLabelText(strings.variables), { target: { value: '{"synthetic_key":"value"}' } }); submit("install"); await confirmed();
  expect(ui.installAutomationAsset).toHaveBeenCalledWith(expect.objectContaining({ variableValues: { synthetic_key: "value" }, connectionBindings: {}, activate: false }));
});
test("rejects false install results", async () => { const node = install(); ui.installAutomationAsset.mockResolvedValue({ ok: false, install_id: "install" }); render(node); submit("install"); await failed(); });
test("does not claim requested activation without a confirmed activation result", async () => { render(install()); fireEvent.click(screen.getByLabelText(strings.activate)); submit("install"); await failed(); });

test.each([true, false])("requested activation requires both result and canonical confirmation (persisted=%s)", async persisted => {
  const node = install(true);
  if (!persisted) ui.getResource.mockResolvedValue({ id: "install", install_status: "installed", installed_from_listing_version_id: "version", target_scope_type: "tenant", target_scope_id: "scope", metadata: { activation_result: { activated: false } } });
  render(node); fireEvent.click(screen.getByLabelText(strings.activate)); submit("install");
  if (persisted) await confirmed(); else await failed();
});

test("activation policy failure preserves installer data without success, navigation or raw diagnostics", async () => {
  render(install());
  ui.installAutomationAsset.mockRejectedValue({ code: "23514", message: "synthetic-private-activation-detail" });
  fireEvent.change(screen.getByLabelText(strings.variables), { target: { value: '{"channel":"keep-entered-value"}' } });
  fireEvent.click(screen.getByLabelText(strings.activate)); submit("install"); await failed();
  expect(ui.installAutomationAsset).toHaveBeenCalledWith(expect.objectContaining({ activate: true }));
  expect(screen.getByLabelText(strings.variables)).toHaveValue('{"channel":"keep-entered-value"}');
  expect(screen.getByText(strings.activationHint)).toBeInTheDocument();
  expect(document.body.textContent).not.toContain("synthetic-private-activation-detail");
});

test.each(["approved", "rejected"])("verifies review %s across review, version and listing", async decision => {
  ui.decideAutomationAssetReview.mockResolvedValue({ ok: true, review_id: "review" });
  ui.getResource.mockImplementation(async (_resource: string, id: string) => ({ id, review_status: decision, listing_version_id: "version", listing_id: "listing", latest_listing_version_id: "version", publication_status: decision }));
  render(<AutomationMarketplaceReviewDecisionForm {...props} defaultReviewId="review" />);
  fireEvent.change(screen.getByLabelText(strings.decision), { target: { value: decision } }); submit("review-decision"); await confirmed();
  expect(ui.getResource).toHaveBeenCalledWith("automation_asset_listings", "listing");
});

test("requires a fresh matching preview before manual upgrade", async () => {
  let current = "v1";
  ui.previewAutomationAssetUpgrade.mockResolvedValue({ ok: true, install_id: "install", current_listing_version_id: "v1", target_listing_version_id: "v2", has_changes: true, forked: false });
  ui.applyAutomationAssetUpgrade.mockImplementation(async () => { current = "v2"; return { ok: true, install_id: "install" }; });
  ui.getResource.mockImplementation(async (_resource: string, id: string) => ({ id, current_listing_version_id: current, install_status: "installed", publication_status: "approved", installed_resource_type: "workflow_template" }));
  render(<AutomationMarketplaceInstallManageForm {...props} defaultInstallId="install" />);
  expect(screen.getByRole("button", { name: strings.applyUpgrade })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: strings.previewUpgrade })); await confirmed();
  fireEvent.change(screen.getByLabelText(strings.targetVersion), { target: { value: "v2" } }); expect(screen.getByRole("button", { name: strings.applyUpgrade })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: strings.previewUpgrade })); await waitFor(() => expect(ui.previewAutomationAssetUpgrade).toHaveBeenCalledTimes(2));
  await waitFor(() => expect(screen.getByRole("button", { name: strings.applyUpgrade })).toBeEnabled());
  fireEvent.click(screen.getByRole("button", { name: strings.applyUpgrade })); await waitFor(() => expect(ui.applyAutomationAssetUpgrade).toHaveBeenCalledWith({ installId: "install", targetListingVersionId: "v2" }));
  await waitFor(() => expect(mockRefresh).toHaveBeenCalled());
});

test("fork success needs persisted fork status and timestamp", async () => {
  ui.forkAutomationAssetInstall.mockResolvedValue({ ok: true, install_id: "install" }); ui.getResource.mockResolvedValue({ id: "install", install_status: "installed" });
  render(<AutomationMarketplaceInstallManageForm {...props} defaultInstallId="install" />); fireEvent.click(screen.getByRole("button", { name: strings.markForked })); await failed();
});

test.each([true, false])("plugin upgrade is a staged copy only after canonical staged-version proof (matching=%s)", async matching => {
  let current = "v1";
  ui.previewAutomationAssetUpgrade.mockResolvedValue({ ok: true, install_id: "install", current_listing_version_id: "v1", target_listing_version_id: "v2", has_changes: true, forked: false });
  ui.applyAutomationAssetUpgrade.mockImplementation(async () => { current = "v2"; return { ok: true, install_id: "install", runtime_activated: false, staged_plugin_version_id: "staged" }; });
  ui.getResource.mockImplementation(async (resource: string, id: string) => resource === "integration_plugin_versions" ? { id, plugin_id: matching ? "plugin" : "different-plugin", status: "approved" } : resource === "automation_asset_listing_versions" ? { id, publication_status: "approved" } : { id, current_listing_version_id: current, install_status: "installed", installed_resource_type: "integration_plugin", installed_resource_id: "plugin", metadata: { pending_plugin_version_id: "staged" } });
  render(<AutomationMarketplaceInstallManageForm {...props} defaultInstallId="install" defaultInstalledResourceType="integration_plugin" defaultInstalledResourceId="plugin" defaultPendingPluginVersionId="staged" />);
  expect(screen.getByRole("link", { name: strings.openStagedVersion })).toHaveAttribute("href", "/console/integrations/plugins/plugin/versions/staged");
  fireEvent.click(screen.getByRole("button", { name: strings.previewUpgrade }));
  await waitFor(() => expect(screen.getByRole("button", { name: strings.applyUpgrade })).toBeEnabled());
  mockToast.mockClear(); fireEvent.click(screen.getByRole("button", { name: strings.applyUpgrade }));
  if (matching) {
    await confirmed(); expect(mockToast).toHaveBeenCalledWith(expect.objectContaining({ title: strings.upgradeCopied }));
    expect(mockToast).not.toHaveBeenCalledWith(expect.objectContaining({ title: strings.upgradeApplied }));
  } else await failed();
});

test.each([true, false])("unchanged binding confirmation requires ok=%s and matching canonical readback", async ok => {
  ui.bindIntegrationConnectionInstall.mockResolvedValue({ ok, binding_id: "binding", install_id: "install", connection_id: "connection" });
  ui.getResource.mockResolvedValue({ id: "binding", install_id: "install", connection_id: "connection", binding_key: "synthetic_provider" });
  render(<AutomationMarketplaceInstallManageForm {...props} defaultInstallId="install" />);
  fireEvent.change(screen.getByLabelText(strings.bindingKey), { target: { value: "synthetic_provider" } }); fireEvent.change(screen.getByLabelText(strings.connectionId), { target: { value: "connection" } });
  fireEvent.submit(screen.getByRole("button", { name: strings.bindConnection }).closest("form")!);
  if (ok) { await confirmed(); expect(ui.getResource).toHaveBeenCalledWith("automation_asset_install_bindings", "binding"); } else await failed();
});

test.each(["en", "ar"])("materialized binding-change refusal gives %s fresh-copy guidance without optimistic success", async locale => {
  mockLocale = locale;
  const copy = locale === "ar" ? ar.ui.automationMarketplace : strings;
  ui.bindIntegrationConnectionInstall.mockRejectedValue({ code: "23514", message: "synthetic-private-binding-detail" });
  render(<AutomationMarketplaceInstallManageForm {...props} defaultInstallId="install" defaultInstalledResourceType="workflow_template" defaultInstalledResourceId="copied-workflow" />);
  fireEvent.change(screen.getByLabelText(copy.bindingKey), { target: { value: "synthetic_provider" } });
  fireEvent.change(screen.getByLabelText(copy.connectionId), { target: { value: "different-connection" } });
  fireEvent.submit(screen.getByRole("button", { name: copy.bindConnection }).closest("form")!); await failed();
  expect(screen.getByText(copy.bindingCopyHint)).toBeInTheDocument();
  expect(screen.getByLabelText(copy.connectionId)).toHaveValue("different-connection");
  expect(ui.getResource).not.toHaveBeenCalled(); expect(mockRefresh).not.toHaveBeenCalled();
  expect(document.body.textContent).not.toContain("synthetic-private-binding-detail");
});

function connection() {
  ui.upsertIntegrationConnection.mockResolvedValue({ ok: true, connection_id: "connection", status: "ready", generated_secret: "synthetic-one-time-secret" });
  ui.getResource.mockResolvedValue({ id: "connection", status: "ready", owner_scope_type: "tenant", owner_scope_id: "scope", provider_key: "synthetic-provider" });
  return <AutomationMarketplaceConnectionForm {...props} defaultOwnerScopeId="scope" defaultProviderKey="synthetic-provider" />;
}
test("shows generated secret masked once, preserves omitted JSON and never stores raw metadata", async () => {
  render(connection()); fireEvent.click(screen.getByLabelText(strings.generateSecret)); submit("connection"); await confirmed();
  expect(ui.upsertIntegrationConnection).toHaveBeenCalledWith(expect.objectContaining({ config: null, oauthMetadata: null, metadata: null, generateSecret: true }));
  const secret = screen.getByLabelText(strings.shownOnce); expect(secret).toHaveAttribute("type", "password"); expect(document.body.textContent).not.toContain("synthetic-one-time-secret");
  fireEvent.click(screen.getByRole("button", { name: strings.showSecret })); expect(secret).toHaveAttribute("type", "text");
  fireEvent.click(screen.getByRole("button", { name: strings.dismissSecret })); expect(screen.queryByLabelText(strings.shownOnce)).not.toBeInTheDocument();
  expect(localStorage.length).toBe(0);
});
test("does not expose generated secret if canonical save readback fails", async () => {
  const node = connection(); ui.getResource.mockResolvedValue(null); render(node); submit("connection"); await failed(); expect(screen.queryByLabelText(strings.shownOnce)).not.toBeInTheDocument();
});
test("test, rotate and revoke never silently resave unrelated connection fields", async () => {
  ui.testIntegrationConnection.mockResolvedValue({ ok: true, connection_id: "connection", status: "ready", test_kind: "credential_presence", remote_verified: false, credential_generation: 1, last_tested_credential_generation: 1 });
  ui.rotateIntegrationConnection.mockResolvedValue({ ok: true, connection_id: "connection", status: "ready" });
  ui.revokeIntegrationConnection.mockResolvedValue({ ok: true, connection_id: "connection", status: "revoked" });
  ui.getResource.mockResolvedValue({ id: "connection", status: "ready", credential_generation: 1, last_tested_credential_generation: 1, last_tested_at: "2026-10-19T10:00:00Z", last_rotated_at: "2026-10-19T10:01:00Z" });
  render(<AutomationMarketplaceConnectionForm {...props} defaultConnectionId="connection" />);
  fireEvent.click(screen.getByRole("button", { name: strings.testConnection })); await confirmed();
  ui.getResource.mockResolvedValue({ id: "connection", status: "ready", last_tested_at: "2026-10-19T10:00:00Z", last_rotated_at: "2026-10-19T10:03:00Z" });
  fireEvent.click(screen.getByRole("button", { name: strings.rotateConnection })); await waitFor(() => expect(ui.rotateIntegrationConnection).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(screen.getByRole("button", { name: strings.revokeConnection })).toBeEnabled());
  ui.getResource.mockResolvedValue({ id: "connection", status: "revoked", revoked_at: "2026-10-19T10:02:00Z" });
  fireEvent.click(screen.getByRole("button", { name: strings.revokeConnection })); await waitFor(() => expect(screen.getByRole("button", { name: strings.revokeConnection })).toBeDisabled());
  expect(ui.upsertIntegrationConnection).not.toHaveBeenCalled();
});

test.each(["current", "rotated", "unsafe", "remote"])("local credential check reports only current safe generation proof (%s)", async proof => {
  ui.testIntegrationConnection.mockResolvedValue({ ok: true, connection_id: "connection", status: "ready", test_kind: "credential_presence", remote_verified: proof === "remote", credential_generation: 2, last_tested_credential_generation: 2 });
  ui.getResource.mockResolvedValue({ id: "connection", status: "ready", last_tested_at: "2026-10-19T10:00:00Z", credential_generation: proof === "unsafe" ? Number.MAX_SAFE_INTEGER + 1 : proof === "rotated" ? 3 : 2, last_tested_credential_generation: proof === "unsafe" ? Number.MAX_SAFE_INTEGER + 1 : 2 });
  render(<AutomationMarketplaceConnectionForm {...props} defaultConnectionId="connection" />);
  expect(screen.getByText(strings.localCheckHint)).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: strings.testConnection }));
  if (proof === "current") { await confirmed(); expect(mockToast).toHaveBeenCalledWith(expect.objectContaining({ title: strings.connectionTested })); } else await failed();
});
test("unconfigured OAuth has no active authorization control or metadata-driven enablement", () => {
  render(<AutomationMarketplaceConnectionForm {...props} defaultConnectionId="connection" defaultAuthType="oauth2_authorization_code_pkce" />);
  expect(screen.getByTestId("automation-marketplace-oauth-unavailable")).toHaveTextContent(strings.oauthUnavailable);
  expect(screen.queryByRole("button", { name: /start oauth/i })).not.toBeInTheDocument();
});
test("Arabic forms use translated action, field, unavailable and error copy", async () => {
  mockLocale = "ar"; render(<AutomationMarketplaceConnectionForm {...props} defaultAuthType="oauth2_authorization_code_pkce" defaultOwnerScopeId="scope" defaultProviderKey="provider" />);
  expect(screen.getByLabelText(ar.ui.automationMarketplace.ownerScopeId)).toBeInTheDocument();
  expect(screen.getByRole("button", { name: ar.ui.automationMarketplace.saveConnection })).toBeInTheDocument();
  expect(screen.getByText(ar.ui.automationMarketplace.localCheckHint)).toBeInTheDocument();
  ui.upsertIntegrationConnection.mockRejectedValue(new Error("private diagnostic")); submit("connection"); await failed();
  expect(screen.getByRole("alert")).toHaveTextContent(ar.ui.automationMarketplace.actionFailed); expect(document.body.textContent).not.toContain("private diagnostic");
});
test("marketplace locale keys and placeholders stay aligned", () => {
  const flatten = (node: Record<string, unknown>, prefix = ""): Record<string, string> => Object.fromEntries(Object.entries(node).flatMap(([key, value]) => typeof value === "string" ? [[prefix + key, value]] : Object.entries(flatten(value as Record<string, unknown>, `${prefix}${key}.`))));
  const english = flatten(en.ui.automationMarketplace), arabic = flatten(ar.ui.automationMarketplace);
  expect(Object.keys(arabic).sort()).toEqual(Object.keys(english).sort());
  for (const key of Object.keys(english)) { expect(arabic[key]!.match(/\{[^}]+\}/g) || []).toEqual(english[key]!.match(/\{[^}]+\}/g) || []); expect(arabic[key]).not.toBe(english[key]); }
});

test.each(["draft", "rejected", "submitted", "approved"])("appended public version verifies canonical %s root transitions and preserves only approved roots", async prior => {
  let status = "draft", created = false;
  const transitions: string[] = [];
  ui.createAutomationAssetListing.mockImplementation(async () => { created = true; return { ok: true, listing_id: "listing", listing_version_id: "new-version" }; });
  ui.submitAutomationAssetReview.mockImplementation(async () => { status = "submitted"; return { ok: true, listing_version_id: "new-version", review_id: "review" }; });
  ui.getResource.mockImplementation(async (resource: string, id: string) => {
    if (resource === "automation_asset_listings") {
      const root = !created || prior === "approved" ? { latest_listing_version_id: "old-version", publication_status: prior } : { latest_listing_version_id: "new-version", publication_status: status };
      transitions.push(`${root.latest_listing_version_id}/${root.publication_status}`);
      return { id, asset_kind: "workflow_template", visibility: "marketplace_public", ...root };
    }
    return resource === "automation_asset_reviews" ? { id, listing_version_id: "new-version", review_status: "pending" } : { id, listing_id: "listing", publication_status: status };
  });
  render(<AutomationMarketplacePublishForm {...props} defaultListingId="listing" defaultSourceId="source" defaultVisibility="marketplace_public" />); submit("publish"); await confirmed();
  expect(ui.createAutomationAssetListing).toHaveBeenCalledWith(expect.objectContaining({ listingId: "listing" }));
  expect(ui.publishAutomationAssetVersion).not.toHaveBeenCalled();
  expect(transitions).toEqual(prior === "approved" ? ["old-version/approved", "old-version/approved", "old-version/approved"] : [`old-version/${prior}`, "new-version/draft", "new-version/submitted"]);
});

test.each(["draft", "rejected", "submitted"])("does not accept an unchanged %s root after append", async prior => {
  ui.createAutomationAssetListing.mockResolvedValue({ ok: true, listing_id: "listing", listing_version_id: "new-version" });
  ui.getResource.mockResolvedValue({ id: "listing", asset_kind: "workflow_template", latest_listing_version_id: "old-version", publication_status: prior, visibility: "marketplace_public" });
  render(<AutomationMarketplacePublishForm {...props} defaultListingId="listing" defaultSourceId="source" defaultVisibility="marketplace_public" />); submit("publish"); await failed();
  expect(ui.submitAutomationAssetReview).not.toHaveBeenCalled();
});

test.each(["draft", "rejected", "submitted"])("does not accept a stale submitted root pointer after appending to %s", async prior => {
  let created = false, submitted = false;
  ui.createAutomationAssetListing.mockImplementation(async () => { created = true; return { ok: true, listing_id: "listing", listing_version_id: "new-version" }; });
  ui.submitAutomationAssetReview.mockImplementation(async () => { submitted = true; return { ok: true, listing_version_id: "new-version", review_id: "review" }; });
  ui.getResource.mockImplementation(async (resource: string, id: string) => resource === "automation_asset_listings" ? { id, asset_kind: "workflow_template", latest_listing_version_id: !created || submitted ? "old-version" : "new-version", publication_status: !created ? prior : submitted ? "submitted" : "draft", visibility: "marketplace_public" } : resource === "automation_asset_reviews" ? { id, listing_version_id: "new-version", review_status: "pending" } : { id, listing_id: "listing", publication_status: "draft" });
  render(<AutomationMarketplacePublishForm {...props} defaultListingId="listing" defaultSourceId="source" defaultVisibility="marketplace_public" />); submit("publish"); await failed();
  expect(ui.submitAutomationAssetReview).toHaveBeenCalledTimes(1);
});

test("upgrade availability follows refreshed canonical props and does not turn missing evidence into No", () => {
  const { rerender } = render(<AutomationMarketplaceInstallManageForm {...props} defaultInstallId="install" />);
  expect(screen.getByTestId("automation-marketplace-install-upgrade-available")).toHaveTextContent(strings.unknown);
  rerender(<AutomationMarketplaceInstallManageForm {...props} defaultInstallId="install" defaultUpgradeAvailable={false} />);
  expect(screen.getByTestId("automation-marketplace-install-upgrade-available")).toHaveTextContent(strings.no);
  rerender(<AutomationMarketplaceInstallManageForm {...props} defaultInstallId="install" defaultUpgradeAvailable />);
  expect(screen.getByTestId("automation-marketplace-install-upgrade-available")).toHaveTextContent(strings.yes);
});

test("rejected appended review does not pretend the prior approved current version was rejected", async () => {
  ui.decideAutomationAssetReview.mockResolvedValue({ ok: true, review_id: "review" });
  ui.getResource.mockImplementation(async (resource: string, id: string) => resource === "automation_asset_listings" ? { id, latest_listing_version_id: "old-version", publication_status: "approved" } : { id, review_status: "rejected", listing_version_id: "new-version", listing_id: "listing", publication_status: "rejected" });
  render(<AutomationMarketplaceReviewDecisionForm {...props} defaultReviewId="review" />); fireEvent.change(screen.getByLabelText(strings.decision), { target: { value: "rejected" } }); submit("review-decision"); await confirmed();
});

test("configured OAuth controls recheck native configuration and never trust their initial prop alone", async () => {
  ui.rpc.mockResolvedValue({ configured: false });
  render(<AutomationMarketplaceConnectionForm {...props} defaultConnectionId="connection" defaultAuthType="oauth2_authorization_code_pkce" defaultOauthConfigured />);
  fireEvent.click(screen.getByRole("button", { name: strings.startOauth })); await failed();
  expect(ui.rpc).toHaveBeenCalledWith("integration_connection_oauth_context_v1", { p_connection_id: "connection" });
  expect(screen.getByTestId("automation-marketplace-oauth-unavailable")).toBeInTheDocument();
});

test("configured OAuth refresh posts JSON and requires canonical ready state", async () => {
  ui.rpc.mockResolvedValue({ configured: true, connection_id: "connection", provider_binding: { authorization_url: "https://identity.example/authorize" } });
  const originalFetch = global.fetch;
  const fetchMock = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true, connection_id: "connection", status: "refreshed" }) });
  global.fetch = fetchMock;
  ui.getResource.mockResolvedValue({ id: "connection", status: "ready" });
  try {
    render(<AutomationMarketplaceConnectionForm {...props} defaultConnectionId="connection" defaultAuthType="oauth2_authorization_code_pkce" defaultOauthConfigured />);
    fireEvent.click(screen.getByRole("button", { name: strings.refreshOauth })); await confirmed();
    expect(fetchMock).toHaveBeenCalledWith("/console/api/automation-marketplace/oauth/refresh", expect.objectContaining({ method: "POST", credentials: "same-origin", redirect: "error", body: JSON.stringify({ connection_id: "connection" }), headers: { "Content-Type": "application/json", Accept: "application/json" } }));
  } finally { global.fetch = originalFetch; }
});

test("OAuth start rejects a response URL outside the native trusted authorization endpoint", async () => {
  ui.rpc.mockResolvedValue({ configured: true, connection_id: "connection", provider_binding: { authorization_url: "https://identity.example/authorize" } });
  const originalFetch = global.fetch;
  global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true, authorization_url: "https://untrusted.example/authorize" }) });
  try { render(<AutomationMarketplaceConnectionForm {...props} defaultConnectionId="connection" defaultAuthType="oauth2_authorization_code_pkce" defaultOauthConfigured />); fireEvent.click(screen.getByRole("button", { name: strings.startOauth })); await failed(); } finally { global.fetch = originalFetch; }
});

test.each([true, false])("OAuth refresh handles only canonical confirmed reauthorization without success or retry (confirmed=%s)", async confirmedReauth => {
  ui.rpc.mockResolvedValue({ configured: true, connection_id: "connection", provider_binding: { authorization_url: "https://identity.example/authorize" } });
  ui.getResource.mockResolvedValue({ id: "connection", status: "reauth_required" });
  const originalFetch = global.fetch;
  const fetchMock = jest.fn().mockResolvedValue({ ok: false, status: 409, json: async () => confirmedReauth ? { ok: false, connection_id: "connection", status: "reauth_required" } : { error: "oauth_completion_unconfirmed" } });
  global.fetch = fetchMock;
  try {
    render(<AutomationMarketplaceConnectionForm {...props} defaultConnectionId="connection" defaultStatus="ready" defaultAuthType="oauth2_authorization_code_pkce" defaultOauthConfigured />);
    fireEvent.click(screen.getByRole("button", { name: strings.refreshOauth })); await failed();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    if (confirmedReauth) {
      expect(ui.getResource).toHaveBeenCalledWith("integration_connections", "connection");
      expect(screen.getByTestId("automation-marketplace-connection-status")).toHaveTextContent(strings.options.reauth_required);
      expect(screen.getByRole("alert")).toHaveTextContent(strings.oauthReauthRequired);
      expect(mockRefresh).toHaveBeenCalledTimes(1);
    } else {
      expect(ui.getResource).not.toHaveBeenCalled(); expect(mockRefresh).not.toHaveBeenCalled();
      expect(screen.getByRole("alert")).toHaveTextContent(strings.actionFailed);
    }
  } finally { global.fetch = originalFetch; }
});
