import { MarketplaceRequestCreatePage } from "../../../_components/marketplace-request-create-page";
import { withPortalConfig } from "../../../app-context";

export default withPortalConfig(({ appBasePath }) => (
  <MarketplaceRequestCreatePage
    appBasePath={appBasePath}
    requestsHref={`${appBasePath}/marketplace/requests`}
    testIdPrefix="portal-marketplace-request-create"
  />
));
