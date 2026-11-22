import { Suspense } from "react";
import {
  LoadingState,
  MarketplaceRequestWorkspacePage as UiMarketplaceRequestWorkspacePage,
} from "@masarx/ui";

type MarketplaceRequestWorkspacePageProps = Parameters<
  typeof UiMarketplaceRequestWorkspacePage
>[0];

const MarketplaceRequestWorkspacePageInner =
  UiMarketplaceRequestWorkspacePage as unknown as (
    props: MarketplaceRequestWorkspacePageProps,
  ) => React.JSX.Element;

export function MarketplaceRequestWorkspacePage(
  props: MarketplaceRequestWorkspacePageProps,
) {
  return (
    <Suspense
      fallback={
        <LoadingState
          variant="page"
          testId="console-marketplace-request-workspace-loading"
        />
      }
    >
      <MarketplaceRequestWorkspacePageInner {...props} />
    </Suspense>
  );
}
