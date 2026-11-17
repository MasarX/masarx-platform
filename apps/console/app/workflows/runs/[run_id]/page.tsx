import { WorkflowRunPage } from "../../../_components/workflow-run-page";
import { withConsoleConfig } from "../../../app-context";

type PageProps = {
  params: { run_id: string };
};

export default withConsoleConfig<PageProps>(({ appBasePath, t }, { params }) => (
  <WorkflowRunPage
    runId={params.run_id}
    appBasePath={appBasePath}
    t={t}
    includeTraceLink
    testIdPrefix="console-workflow-run"
  />
));
