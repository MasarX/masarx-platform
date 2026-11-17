import { ManualReviewQueuePage } from "../../_components/manual-review-queue-page";
import { withConsoleConfig } from "../../app-context";

type PageProps = {
  searchParams: Record<string, string | string[] | undefined>;
};

export default withConsoleConfig<PageProps>(({ appKey, appBasePath }, { searchParams }) => (
    <ManualReviewQueuePage
      searchParams={searchParams}
      appKey={appKey}
      appBasePath={appBasePath}
      baseHref={`${appBasePath}/workflows/tasks`}
      testIdPrefix="console-manual-review-tasks"
      defaultAssignedToCurrentUser
    />
));
