import { ResourcePage } from "../../_components/resource-page";
import { withConsoleConfig } from "../../app-context";

type PageProps = {
  searchParams: Record<string, string | string[] | undefined>;
};

export default withConsoleConfig<PageProps>(({ appBasePath }, { searchParams }) => (
  <ResourcePage
    appKey="console"
    resourceKey="marketplace_contracts"
    searchParams={searchParams}
    appBasePath={appBasePath}
    baseHref={`${appBasePath}/marketplace/contracts`}
    testIdPrefix="console-marketplace-contracts"
    description="Inspect marketplace contracts before opening the detailed contract room."
  />
));
