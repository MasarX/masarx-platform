import { ResourcePage } from "../../_components/resource-page";
import { withPortalConfig } from "../../app-context";

type PageProps = {
  searchParams: Record<string, string | string[] | undefined>;
};

export default withPortalConfig<PageProps>(({ appKey, appBasePath }, { searchParams }) => (
  <ResourcePage
    appKey={appKey}
    resourceKey="workflow_runs"
    searchParams={searchParams}
    appBasePath={appBasePath}
    baseHref={`${appBasePath}/workflows/runs`}
    testIdPrefix="portal-workflow-runs"
  />
));
