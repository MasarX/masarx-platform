import { Suspense } from "react";
import {
  LoadingState,
  ManualReviewQueuePage as UiManualReviewQueuePage,
} from "@masarx/ui";

type ManualReviewQueuePageProps = Parameters<
  typeof UiManualReviewQueuePage
>[0];
const ManualReviewQueuePageInner = UiManualReviewQueuePage as unknown as (
  props: ManualReviewQueuePageProps
) => React.JSX.Element;

export function ManualReviewQueuePage(props: ManualReviewQueuePageProps) {
  return (
    <Suspense
      fallback={
        <LoadingState
          variant="page"
          testId="console-manual-review-loading"
        />
      }
    >
      <ManualReviewQueuePageInner {...props} />
    </Suspense>
  );
}
