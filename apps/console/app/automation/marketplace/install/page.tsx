import { PageHeader, Section, createUiTranslator } from "@masarx/ui";
import { withConsoleConfig } from "../../../app-context";
import { MarketplacePage, first, type MarketplacePageProps } from "../_components/marketplace-page";
import { AutomationMarketplaceInstallForm } from "../_components/install-form";
export default withConsoleConfig<MarketplacePageProps>(({ appBasePath }, { searchParams }) => {
  const t = createUiTranslator("ui.automationMarketplace");
  return <MarketplacePage capability="automation_marketplace.install">{access => <div className="space-y-6" data-testid="console-automation-marketplace-install-ready"><PageHeader title={t("installTitle")} description={t("installDescription")} /><Section><AutomationMarketplaceInstallForm key={`${access.userId}/${first(searchParams.listing_version_id)}/${first(searchParams.target_scope_id)}`} access={access} appBasePath={appBasePath} defaultListingVersionId={first(searchParams.listing_version_id)} defaultTargetScopeType={first(searchParams.target_scope_type)} defaultTargetScopeId={first(searchParams.target_scope_id)} /></Section></div>}</MarketplacePage>;
});
