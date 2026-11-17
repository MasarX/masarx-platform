import { RouteOperationsWorkspacePage } from "../../../_components/route-operations-workspace-page";
import { withPortalConfig } from "../../../app-context";

type PageProps = {
  searchParams: Record<string, string | string[] | undefined>;
  params: { resource: string };
};

export default withPortalConfig<PageProps>(
  ({ appBasePath, appKey }, { searchParams, params }) => (
    <RouteOperationsWorkspacePage
      appBasePath={appBasePath}
      appKey={appKey}
      searchParams={searchParams}
      resourceKey={params.resource}
      sectionId="operations"
      testIdPrefix="portal-route-operations"
    />
  )
);
