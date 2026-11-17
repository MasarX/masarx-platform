import { RouteOperationsWorkspacePage } from "../../_components/route-operations-workspace-page";
import { withPortalConfig } from "../../app-context";

type PageProps = {
  searchParams: Record<string, string | string[] | undefined>;
};

export default withPortalConfig<PageProps>(
  ({ appBasePath, appKey }, { searchParams }) => (
    <RouteOperationsWorkspacePage
      appBasePath={appBasePath}
      appKey={appKey}
      searchParams={searchParams}
      sectionId="operations"
      testIdPrefix="portal-route-operations"
    />
  )
);
