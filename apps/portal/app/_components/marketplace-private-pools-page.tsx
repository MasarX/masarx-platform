import { Suspense } from "react";
import {
  LoadingState,
  MarketplacePrivatePoolsPage as UiMarketplacePrivatePoolsPage,
} from "@masarx/ui";

type MarketplacePrivatePoolsPageProps = Parameters<
  typeof UiMarketplacePrivatePoolsPage
>[0];

const MarketplacePrivatePoolsPageInner =
  UiMarketplacePrivatePoolsPage as unknown as (
    props: MarketplacePrivatePoolsPageProps,
  ) => React.JSX.Element;

export function MarketplacePrivatePoolsPage(
  props: MarketplacePrivatePoolsPageProps,
) {
  return (
    <Suspense
      fallback={
        <LoadingState
          variant="page"
          testId="portal-marketplace-private-pools-loading"
        />
      }
    >
      <MarketplacePrivatePoolsPageInner {...props} />
    </Suspense>
  );
}
