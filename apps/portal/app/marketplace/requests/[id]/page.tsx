import { MarketplaceRequestWorkspacePage } from "../../../_components/marketplace-request-workspace-page";
import { withPortalConfig } from "../../../app-context";

type PageProps = {
  params: { id: string };
};

export default withPortalConfig<PageProps>(({ appBasePath }, { params }) => (
  <MarketplaceRequestWorkspacePage
    appBasePath={appBasePath}
    requestsHref={`${appBasePath}/marketplace/requests`}
    requestId={params.id}
    testIdPrefix="portal-marketplace-request-workspace"
  />
));
