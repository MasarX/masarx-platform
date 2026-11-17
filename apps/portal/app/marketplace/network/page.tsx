import { ResourcePage } from "../../_components/resource-page";
import { withPortalConfig } from "../../app-context";

type PageProps = {
  searchParams: Record<string, string | string[] | undefined>;
};

export default withPortalConfig<PageProps>(({ appBasePath }, { searchParams }) => (
  <ResourcePage
    appKey="portal"
    resourceKey="marketplace_participants"
    searchParams={searchParams}
    appBasePath={appBasePath}
    baseHref={`${appBasePath}/marketplace/network`}
    testIdPrefix="portal-marketplace-network"
    description="Manage the tenant network, freelancer profiles, and curated supply visibility."
  />
));
