import { WorkflowBindingsPage } from "../../_components/workflow-bindings-page";
import { withPortalConfig } from "../../app-context";

type PageProps = {
  searchParams: Record<string, string | string[] | undefined>;
};

export default withPortalConfig<PageProps>(({ appKey, appBasePath }, { searchParams }) => (
  <WorkflowBindingsPage
    appKey={appKey}
    appBasePath={appBasePath}
    searchParams={searchParams}
    baseHref={`${appBasePath}/workflows/bindings`}
    testIdPrefix="portal-workflow-bindings"
  />
));
