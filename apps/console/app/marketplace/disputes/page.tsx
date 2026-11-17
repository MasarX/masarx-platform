import { ResourcePage } from "../../_components/resource-page";
import { withConsoleConfig } from "../../app-context";

type PageProps = {
  searchParams: Record<string, string | string[] | undefined>;
};

export default withConsoleConfig<PageProps>(({ appBasePath }, { searchParams }) => (
  <ResourcePage
    appKey="console"
    resourceKey="marketplace_disputes"
    searchParams={searchParams}
    appBasePath={appBasePath}
    baseHref={`${appBasePath}/marketplace/disputes`}
    testIdPrefix="console-marketplace-disputes"
    description="Resolve marketplace commercial and execution disputes through the platform queue."
  />
));
