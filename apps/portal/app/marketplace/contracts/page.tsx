import { ResourcePage } from "../../_components/resource-page";
import { withPortalConfig } from "../../app-context";

type PageProps = {
  searchParams: Record<string, string | string[] | undefined>;
};

export default withPortalConfig<PageProps>(({ appBasePath }, { searchParams }) => (
  <ResourcePage
    appKey="portal"
    resourceKey="marketplace_contracts"
    searchParams={searchParams}
    appBasePath={appBasePath}
    baseHref={`${appBasePath}/marketplace/contracts`}
    testIdPrefix="portal-marketplace-contracts"
    description="Review awarded marketplace contracts, commercial modes, and execution state."
  />
));
