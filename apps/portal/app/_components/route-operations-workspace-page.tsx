import { Suspense } from "react";
import {
  LoadingState,
  RouteOperationsWorkspacePage as UiRouteOperationsWorkspacePage,
} from "@masarx/ui";

type RouteOperationsWorkspacePageProps = Parameters<
  typeof UiRouteOperationsWorkspacePage
>[0];
const RouteOperationsWorkspacePageInner =
  UiRouteOperationsWorkspacePage as unknown as (
    props: RouteOperationsWorkspacePageProps
  ) => JSX.Element;

export function RouteOperationsWorkspacePage(
  props: RouteOperationsWorkspacePageProps
) {
  return (
    <Suspense
      fallback={
        <LoadingState
          variant="page"
          testId="portal-route-operations-loading"
        />
      }
    >
      <RouteOperationsWorkspacePageInner {...props} />
    </Suspense>
  );
}
