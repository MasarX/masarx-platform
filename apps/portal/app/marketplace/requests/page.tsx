import { ResourcePage } from "../../_components/resource-page";
import { withPortalConfig } from "../../app-context";

type PageProps = {
  searchParams: Record<string, string | string[] | undefined>;
};

export default withPortalConfig<PageProps>(({ appBasePath }, { searchParams }) => (
  <ResourcePage
    appKey="portal"
    resourceKey="marketplace_requests"
    searchParams={searchParams}
    appBasePath={appBasePath}
    baseHref={`${appBasePath}/marketplace/requests`}
    testIdPrefix="portal-marketplace-requests"
    description="Track draft, published, awarded, and in-execution marketplace demand."
  />
));
