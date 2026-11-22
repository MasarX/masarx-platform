import { ResourcePage } from "../../_components/resource-page";
import { withConsoleConfig } from "../../app-context";

type PageProps = {
  searchParams: Record<string, string | string[] | undefined>;
};

export default withConsoleConfig<PageProps>(({ appBasePath }, { searchParams }) => (
  <ResourcePage
    appKey="console"
    resourceKey="marketplace_requests"
    searchParams={searchParams}
    appBasePath={appBasePath}
    baseHref={`${appBasePath}/marketplace/requests`}
    testIdPrefix="console-marketplace-requests"
    description="Track draft, published, awarded, and in-execution marketplace demand."
  />
));
