import { withConsoleConfig } from "../../../app-context";
import { MarketplacePage, MarketplaceResourcePage, type MarketplacePageProps } from "../_components/marketplace-page";
export default withConsoleConfig<MarketplacePageProps>(({ appKey, appBasePath }, { searchParams }) => <MarketplacePage capability="automation_marketplace.read">{access => <MarketplaceResourcePage appKey={appKey} appBasePath={appBasePath} access={access} kind="installs" searchParams={searchParams} />}</MarketplacePage>);
