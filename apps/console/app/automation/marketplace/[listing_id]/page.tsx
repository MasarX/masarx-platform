import { withConsoleConfig } from "../../../app-context";
import { MarketplacePage, MarketplaceResourcePage, type MarketplacePageProps } from "../_components/marketplace-page";
type Props = MarketplacePageProps & { params: { listing_id: string } };
export default withConsoleConfig<Props>(({ appKey, appBasePath }, { params, searchParams }) => <MarketplacePage capability="automation_marketplace.read">{access => <MarketplaceResourcePage appKey={appKey} appBasePath={appBasePath} access={access} kind="listings" listingId={params.listing_id} searchParams={searchParams} />}</MarketplacePage>);
