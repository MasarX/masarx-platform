import { ResourcePage } from "../../_components/resource-page";
import { withPortalConfig } from "../../app-context";

type PageProps = {
  searchParams: Record<string, string | string[] | undefined>;
};

export default withPortalConfig<PageProps>(({ appBasePath }, { searchParams }) => (
  <ResourcePage
    appKey="portal"
    resourceKey="marketplace_work_packages"
    searchParams={searchParams}
    appBasePath={appBasePath}
    baseHref={`${appBasePath}/marketplace/work-packages`}
    testIdPrefix="portal-marketplace-work-packages"
    description="Monitor awarded marketplace work as contract-scoped work packages."
  />
));
