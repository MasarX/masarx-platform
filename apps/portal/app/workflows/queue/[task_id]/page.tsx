import { ManualReviewQueuePage } from "../../../_components/manual-review-queue-page";
import { withPortalConfig } from "../../../app-context";

type PageProps = {
  params: {
    task_id?: string;
  };
};

export default withPortalConfig<PageProps>(({ appBasePath }, { params }) => {
  const id = params?.task_id ? String(params.task_id) : undefined;
  return (
    <ManualReviewQueuePage
      searchParams={id ? { id } : {}}
      appKey="portal"
      appBasePath={appBasePath}
      baseHref={`${appBasePath}/workflows/queue`}
      testIdPrefix="portal-manual-review-queue"
    />
  );
});
