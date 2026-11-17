import { WorkflowRunPage } from "../../../_components/workflow-run-page";
import { withPortalConfig } from "../../../app-context";

type PageProps = {
  params: { run_id: string };
};

export default withPortalConfig<PageProps>(({ appBasePath, t }, { params }) => (
  <WorkflowRunPage
    runId={params.run_id}
    appBasePath={appBasePath}
    t={t}
    includeTraceLink
    testIdPrefix="portal-workflow-run"
  />
));
