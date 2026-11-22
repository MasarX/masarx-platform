import { MarketplaceRequestCreatePage } from "../../../_components/marketplace-request-create-page";
import { withConsoleConfig } from "../../../app-context";

export default withConsoleConfig(({ appBasePath }) => (
  <MarketplaceRequestCreatePage
    appBasePath={appBasePath}
    requestsHref={`${appBasePath}/marketplace/requests`}
    testIdPrefix="console-marketplace-request-create"
    actionSource="console.marketplace.request_create"
  />
));
