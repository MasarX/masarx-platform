import { Suspense } from "react";
import {
  LoadingState,
  MarketplaceParticipantRequestsPage as UiMarketplaceParticipantRequestsPage,
} from "@masarx/ui";

type MarketplaceParticipantRequestsPageProps = Parameters<
  typeof UiMarketplaceParticipantRequestsPage
>[0];

const MarketplaceParticipantRequestsPageInner =
  UiMarketplaceParticipantRequestsPage as unknown as (
    props: MarketplaceParticipantRequestsPageProps,
  ) => JSX.Element;

export function MarketplaceParticipantRequestsPage(
  props: MarketplaceParticipantRequestsPageProps,
) {
  return (
    <Suspense
      fallback={
        <LoadingState
          variant="page"
          testId="console-marketplace-participant-requests-loading"
        />
      }
    >
      <MarketplaceParticipantRequestsPageInner {...props} />
    </Suspense>
  );
}
