import dynamic from "next/dynamic";
import { LoadingState } from "@masarx/ui";
import { withConsoleConfig } from "../../../app-context";

const WorkflowTemplateStudioPage = dynamic(
  () => import("@masarx/ui").then((mod) => ({ default: mod.WorkflowTemplateStudioPage })),
  { loading: () => <LoadingState variant="page" /> }
);

type PageProps = {
  params: { template_id: string };
};

export default withConsoleConfig<PageProps>(({ appBasePath }, { params }) => (
  <WorkflowTemplateStudioPage
    templateId={params.template_id}
    appBasePath={appBasePath}
    testIdPrefix="console-workflow-template-studio"
  />
));

