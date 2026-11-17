import { WorkflowBindingsPage } from "../../_components/workflow-bindings-page";
import { withConsoleConfig } from "../../app-context";

type PageProps = {
  searchParams: Record<string, string | string[] | undefined>;
};

export default withConsoleConfig<PageProps>(({ appKey, appBasePath }, { searchParams }) => (
  <WorkflowBindingsPage
    appKey={appKey}
    appBasePath={appBasePath}
    searchParams={searchParams}
    baseHref={`${appBasePath}/workflows/bindings`}
    testIdPrefix="console-workflow-bindings"
  />
));
