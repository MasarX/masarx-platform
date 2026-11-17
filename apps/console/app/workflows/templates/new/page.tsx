import { WorkflowTemplateCreatePage } from "../../../_components/workflow-template-create-page";
import { withConsoleConfig } from "../../../app-context";

export default withConsoleConfig(({ appBasePath }) => (
  <WorkflowTemplateCreatePage
    appBasePath={appBasePath}
    testIdPrefix="console-workflow-template-create"
  />
));
