import { RouteOperationsWorkspacePage } from "../../../_components/route-operations-workspace-page";
import { portalExceptionWorkspaceDefaults } from "../workspace-config";

type PortalExceptionResourcePageProps = Pick<
  Parameters<typeof RouteOperationsWorkspacePage>[0],
  "appBasePath" | "appKey" | "searchParams"
> & {
  resource: string;
};

export function PortalExceptionResourcePage({
  appBasePath,
  appKey,
  resource,
  searchParams,
}: PortalExceptionResourcePageProps) {
  return (
    <RouteOperationsWorkspacePage
      appBasePath={appBasePath}
      appKey={appKey}
      searchParams={searchParams}
      resourceKey={resource}
      {...portalExceptionWorkspaceDefaults}
    />
  );
}
