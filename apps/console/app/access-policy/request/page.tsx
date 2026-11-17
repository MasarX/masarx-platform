import { AccessPolicyRequestPage } from "../../_components/access-policy-request-page";
import { withConsoleConfig } from "../../app-context";

export default withConsoleConfig(({ appName, appBasePath }) => (
    <AccessPolicyRequestPage
      appLabel={appName}
      testIdPrefix="console-access-policy-request"
      returnHref={`${appBasePath}/access-policy`}
    />
));
