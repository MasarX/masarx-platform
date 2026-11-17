import { RouteOperationsWorkspacePage } from "../../_components/route-operations-workspace-page";
import { withConsoleConfig } from "../../app-context";

type PageProps = {
  searchParams: Record<string, string | string[] | undefined>;
};

export default withConsoleConfig<PageProps>(
  ({ appBasePath, appKey }, { searchParams }) => (
    <RouteOperationsWorkspacePage
      appBasePath={appBasePath}
      appKey={appKey}
      searchParams={searchParams}
      sectionId="operations"
      testIdPrefix="console-route-operations"
    />
  )
);
