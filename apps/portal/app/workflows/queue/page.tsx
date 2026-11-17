import { ManualReviewQueuePage } from "../../_components/manual-review-queue-page";
import { withPortalConfig } from "../../app-context";

type PageProps = {
  searchParams: Record<string, string | string[] | undefined>;
};

export default withPortalConfig<PageProps>(({ appKey, appBasePath }, { searchParams }) => (
    <ManualReviewQueuePage
      searchParams={searchParams}
      appKey={appKey}
      appBasePath={appBasePath}
      baseHref={`${appBasePath}/workflows/queue`}
      testIdPrefix="portal-manual-review-queue"
    />
));
