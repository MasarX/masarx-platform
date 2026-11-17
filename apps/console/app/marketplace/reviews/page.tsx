import { MarketplaceParticipantRequestsPage } from "../../_components/marketplace-participant-requests-page";
import { withConsoleConfig } from "../../app-context";

type PageProps = {
  searchParams: Record<string, string | string[] | undefined>;
};

export default withConsoleConfig<PageProps>(({ appBasePath }, { searchParams }) => (
  <MarketplaceParticipantRequestsPage
    appKey="console"
    searchParams={searchParams}
    appBasePath={appBasePath}
    baseHref={`${appBasePath}/marketplace/reviews`}
    testIdPrefix="console-marketplace-reviews"
  />
));
