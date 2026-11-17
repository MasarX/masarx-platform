import { RouteOperationsWorkspacePage } from "../../../_components/route-operations-workspace-page";
import { withConsoleConfig } from "../../../app-context";

type PageProps = {
  searchParams: Record<string, string | string[] | undefined>;
  params: { resource: string };
};

export default withConsoleConfig<PageProps>(
  ({ appBasePath, appKey }, { searchParams, params }) => (
    <RouteOperationsWorkspacePage
      appBasePath={appBasePath}
      appKey={appKey}
      searchParams={searchParams}
      resourceKey={params.resource}
      sectionId="operations"
      resourceSelector="exceptions"
      workspacePathSegment="exceptions"
      i18nNamespace="ui.exceptionInbox"
      testIdPrefix="console-exception-inbox"
    />
  )
);
