import { WorkflowOverlapExplorerPage } from "../../_components/workflow-overlap-explorer-page";
import { withPortalConfig } from "../../app-context";

type PageProps = {
  searchParams: Record<string, string | string[] | undefined>;
};

export default withPortalConfig<PageProps>(({ appBasePath }, { searchParams }) => (
  <WorkflowOverlapExplorerPage
    appBasePath={appBasePath}
    searchParams={searchParams}
    testIdPrefix="portal-workflow-overlaps"
  />
));
