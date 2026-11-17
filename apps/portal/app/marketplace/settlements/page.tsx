import { ResourcePage } from "../../_components/resource-page";
import { withPortalConfig } from "../../app-context";

type PageProps = {
  searchParams: Record<string, string | string[] | undefined>;
};

export default withPortalConfig<PageProps>(({ appBasePath }, { searchParams }) => (
  <ResourcePage
    appKey="portal"
    resourceKey="marketplace_settlement_batches"
    searchParams={{ ...searchParams, scope_type: "marketplace_contract" }}
    appBasePath={appBasePath}
    baseHref={`${appBasePath}/marketplace/settlements`}
    testIdPrefix="portal-marketplace-settlements"
    description="Internal marketplace settlements stay attached to contract-scoped batches."
  />
));
