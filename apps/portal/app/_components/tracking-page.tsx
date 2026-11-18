import { Suspense } from "react";
import { LoadingState, TrackingPage as UiTrackingPage } from "@masarx/ui";

type TrackingPageProps = Parameters<typeof UiTrackingPage>[0];
const TrackingPageInner = UiTrackingPage as unknown as (
  props: TrackingPageProps
) => React.JSX.Element;

export function TrackingPage(props: TrackingPageProps) {
  return (
    <Suspense
      fallback={
        <LoadingState variant="page" testId="portal-tracking-loading" />
      }
    >
      <TrackingPageInner {...props} />
    </Suspense>
  );
}
