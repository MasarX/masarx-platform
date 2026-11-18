import { PageHeader, Section, createUiTranslator } from "@masarx/ui";
import { withConsoleConfig } from "../../../../app-context";
import { MarketplacePage, first, unavailable, valueText, type MarketplacePageProps } from "../../_components/marketplace-page";
import { AutomationMarketplaceInstallManageForm } from "../../_components/install-manage-form";
export default withConsoleConfig<MarketplacePageProps>(({ appBasePath }, { searchParams }) => {
  const t = createUiTranslator("ui.automationMarketplace");
  return <MarketplacePage capability="automation_marketplace.read">{async (access, ui) => {
    const id = first(searchParams.install_id);
    const row = id ? await ui.getResource("automation_asset_installs", id) : null;
    if (!id || row?.id !== id) return unavailable();
    const metadata = row.metadata && typeof row.metadata === "object" ? row.metadata as Record<string, unknown> : null;
    return <div className="space-y-6" data-testid="console-automation-marketplace-installs-manage-ready"><PageHeader title={t("manageInstall")} description={t("manageInstallDescription")} /><Section><AutomationMarketplaceInstallManageForm key={`${access.userId}/${id}`} access={access} appBasePath={appBasePath} defaultInstallId={id} defaultStatus={valueText(row.install_status)} defaultCurrentListingVersionId={valueText(row.current_listing_version_id)} defaultInstalledFromListingVersionId={valueText(row.installed_from_listing_version_id)} defaultInstalledResourceType={valueText(row.installed_resource_type)} defaultInstalledResourceId={valueText(row.installed_resource_id)} defaultForkedAt={valueText(row.forked_at)} defaultUpgradeAvailable={typeof row.upgrade_available === "boolean" ? row.upgrade_available : null} defaultPendingPluginVersionId={valueText(metadata?.pending_plugin_version_id)} /></Section></div>;
  }}</MarketplacePage>;
});
