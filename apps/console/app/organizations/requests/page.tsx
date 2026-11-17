import { TenantSignupRequestsPage } from "../../_components/tenant-signup-requests-page";
import { withConsoleConfig } from "../../app-context";

type PageProps = {
  searchParams: Record<string, string | string[] | undefined>;
};

export default withConsoleConfig<PageProps>(({ appBasePath }, { searchParams }) => (
  <TenantSignupRequestsPage
    appKey="console"
    searchParams={searchParams}
    appBasePath={appBasePath}
    baseHref={`${appBasePath}/organizations/requests`}
    testIdPrefix="console-organization-requests"
  />
));
