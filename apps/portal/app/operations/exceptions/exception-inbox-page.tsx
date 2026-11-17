import { RouteOperationsWorkspacePage } from "../../_components/route-operations-workspace-page";
import { portalExceptionWorkspaceDefaults } from "./workspace-config";

type PortalExceptionInboxPageProps = Pick<
  Parameters<typeof RouteOperationsWorkspacePage>[0],
  "appBasePath" | "appKey" | "searchParams"
>;

export function PortalExceptionInboxPage({
  appBasePath,
  appKey,
  searchParams,
}: PortalExceptionInboxPageProps) {
  return (
    <RouteOperationsWorkspacePage
      appBasePath={appBasePath}
      appKey={appKey}
      searchParams={searchParams}
      {...portalExceptionWorkspaceDefaults}
    />
  );
}
