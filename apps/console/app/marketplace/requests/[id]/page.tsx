import { MarketplaceRequestWorkspacePage } from "../../../_components/marketplace-request-workspace-page";
import { withConsoleConfig } from "../../../app-context";

type PageProps = {
  params: { id: string };
};

export default withConsoleConfig<PageProps>(({ appBasePath }, { params }) => (
  <MarketplaceRequestWorkspacePage
    appBasePath={appBasePath}
    requestsHref={`${appBasePath}/marketplace/requests`}
    requestId={params.id}
    testIdPrefix="console-marketplace-request-workspace"
    actionSourcePrefix="console.marketplace.request_workspace"
  />
));
