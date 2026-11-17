import { ResourcePage } from "../../_components/resource-page";
import { withConsoleConfig } from "../../app-context";

type PageProps = {
  searchParams: Record<string, string | string[] | undefined>;
};

export default withConsoleConfig<PageProps>(({ appBasePath }, { searchParams }) => (
  <ResourcePage
    appKey="console"
    resourceKey="marketplace_settlement_batches"
    searchParams={{ ...searchParams, scope_type: "marketplace_contract" }}
    appBasePath={appBasePath}
    baseHref={`${appBasePath}/marketplace/settlements`}
    testIdPrefix="console-marketplace-settlements"
    description="Inspect contract-scoped marketplace settlement batches and posted finance records."
  />
));
