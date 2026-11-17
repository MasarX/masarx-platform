import { ResourcePage } from "../../_components/resource-page";
import { withConsoleConfig } from "../../app-context";

type PageProps = {
  searchParams: Record<string, string | string[] | undefined>;
};

export default withConsoleConfig<PageProps>(({ appBasePath }, { searchParams }) => (
  <ResourcePage
    appKey="console"
    resourceKey="marketplace_participants"
    searchParams={searchParams}
    appBasePath={appBasePath}
    baseHref={`${appBasePath}/marketplace/participants`}
    testIdPrefix="console-marketplace-participants"
    description="Inspect approved marketplace participants, listing posture, and compliance state."
  />
));
