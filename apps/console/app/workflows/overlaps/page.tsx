import { WorkflowOverlapExplorerPage } from "../../_components/workflow-overlap-explorer-page";
import { withConsoleConfig } from "../../app-context";

type PageProps = {
  searchParams: Record<string, string | string[] | undefined>;
};

export default withConsoleConfig<PageProps>(({ appBasePath }, { searchParams }) => (
  <WorkflowOverlapExplorerPage
    appBasePath={appBasePath}
    searchParams={searchParams}
    testIdPrefix="console-workflow-overlaps"
  />
));
