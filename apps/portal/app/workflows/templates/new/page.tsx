import { WorkflowTemplateCreatePage } from "../../../_components/workflow-template-create-page";
import { withPortalConfig } from "../../../app-context";

export default withPortalConfig(({ appBasePath }) => (
  <WorkflowTemplateCreatePage
    appBasePath={appBasePath}
    testIdPrefix="portal-workflow-template-create"
  />
));
