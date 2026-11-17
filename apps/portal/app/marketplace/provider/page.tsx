import { MarketplaceProviderWorkboardPage } from "../../_components/marketplace-provider-workboard-page";
import { withPortalConfig } from "../../app-context";

export default withPortalConfig(({ appBasePath }) => (
  <MarketplaceProviderWorkboardPage
    appBasePath={appBasePath}
    baseHref={`${appBasePath}/marketplace/provider`}
    testIdPrefix="portal-marketplace-provider-workboard"
  />
));
