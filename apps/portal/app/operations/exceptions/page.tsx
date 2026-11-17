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
      resourceSelector="exceptions"
      workspacePathSegment="exceptions"
      i18nNamespace="ui.exceptionInbox"
      testIdPrefix="portal-exception-inbox"
    />
  )
);
