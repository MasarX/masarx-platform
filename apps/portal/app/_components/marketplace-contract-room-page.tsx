import { Suspense } from "react";
import {
  LoadingState,
  MarketplaceContractRoomPage as UiMarketplaceContractRoomPage,
} from "@masarx/ui";

type MarketplaceContractRoomPageProps = Parameters<
  typeof UiMarketplaceContractRoomPage
>[0];

const MarketplaceContractRoomPageInner =
  UiMarketplaceContractRoomPage as unknown as (
    props: MarketplaceContractRoomPageProps,
  ) => JSX.Element;

export function MarketplaceContractRoomPage(
  props: MarketplaceContractRoomPageProps,
) {
  return (
    <Suspense
      fallback={
        <LoadingState
          variant="page"
          testId="portal-marketplace-contract-room-loading"
        />
      }
    >
      <MarketplaceContractRoomPageInner {...props} />
    </Suspense>
  );
}
