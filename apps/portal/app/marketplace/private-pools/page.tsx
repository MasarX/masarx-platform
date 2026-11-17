import { MarketplacePrivatePoolsPage } from "../../_components/marketplace-private-pools-page";
import { withPortalConfig } from "../../app-context";

export default withPortalConfig(({ appBasePath }) => (
  <MarketplacePrivatePoolsPage
    appBasePath={appBasePath}
    testIdPrefix="portal-marketplace-private-pools"
  />
));
