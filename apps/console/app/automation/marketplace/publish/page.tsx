import { PageHeader, Section, createUiTranslator } from "@masarx/ui";
import { withConsoleConfig } from "../../../app-context";
import { MarketplacePage, first, type MarketplacePageProps } from "../_components/marketplace-page";
import { AutomationMarketplacePublishForm } from "../_components/publish-form";
export default withConsoleConfig<MarketplacePageProps>(({ appBasePath }, { searchParams }) => {
  const t = createUiTranslator("ui.automationMarketplace");
  return <MarketplacePage capability="automation_marketplace.publish">{access => <div className="space-y-6" data-testid="console-automation-marketplace-publish-ready"><PageHeader title={t("publish")} description={t("publishDescription")} /><Section><AutomationMarketplacePublishForm key={`${access.userId}/${first(searchParams.listing_id)}/${first(searchParams.source_id)}`} access={access} appBasePath={appBasePath} defaultListingId={first(searchParams.listing_id)} defaultAssetKind={first(searchParams.asset_kind)} defaultSourceId={first(searchParams.source_id)} defaultTitle={first(searchParams.title)} defaultSummary={first(searchParams.summary)} defaultVisibility={first(searchParams.visibility)} /></Section></div>}</MarketplacePage>;
});
