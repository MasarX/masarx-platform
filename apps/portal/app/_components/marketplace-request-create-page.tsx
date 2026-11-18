import { Suspense } from "react";
import {
  LoadingState,
  MarketplaceRequestCreatePage as UiMarketplaceRequestCreatePage,
} from "@masarx/ui";

type MarketplaceRequestCreatePageProps = Parameters<
  typeof UiMarketplaceRequestCreatePage
>[0];

const MarketplaceRequestCreatePageInner =
  UiMarketplaceRequestCreatePage as unknown as (
    props: MarketplaceRequestCreatePageProps,
  ) => React.JSX.Element;

export function MarketplaceRequestCreatePage(
  props: MarketplaceRequestCreatePageProps,
) {
  return (
    <Suspense
      fallback={
        <LoadingState
          variant="page"
          testId="portal-marketplace-request-create-loading"
        />
      }
    >
      <MarketplaceRequestCreatePageInner {...props} />
    </Suspense>
  );
}
