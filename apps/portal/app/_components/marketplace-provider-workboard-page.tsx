import { Suspense } from "react";
import {
  LoadingState,
  MarketplaceProviderWorkboardPage as UiMarketplaceProviderWorkboardPage,
} from "@masarx/ui";

type MarketplaceProviderWorkboardPageProps = Parameters<
  typeof UiMarketplaceProviderWorkboardPage
>[0];

const MarketplaceProviderWorkboardPageInner =
  UiMarketplaceProviderWorkboardPage as unknown as (
    props: MarketplaceProviderWorkboardPageProps,
  ) => JSX.Element;

export function MarketplaceProviderWorkboardPage(
  props: MarketplaceProviderWorkboardPageProps,
) {
  return (
    <Suspense
      fallback={
        <LoadingState
          variant="page"
          testId="portal-marketplace-provider-workboard-loading"
        />
      }
    >
      <MarketplaceProviderWorkboardPageInner {...props} />
    </Suspense>
  );
}
