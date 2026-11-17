import { ManualReviewQueuePage } from "../../../_components/manual-review-queue-page";
import { withConsoleConfig } from "../../../app-context";

type PageProps = {
  params: {
    task_id?: string;
  };
};

export default withConsoleConfig<PageProps>(({ appBasePath }, { params }) => {
  const id = params?.task_id ? String(params.task_id) : undefined;
  return (
    <ManualReviewQueuePage
      searchParams={id ? { id } : {}}
      appKey="console"
      appBasePath={appBasePath}
      baseHref={`${appBasePath}/workflows/queue`}
      testIdPrefix="console-manual-review-queue"
    />
  );
});
