import { AccessPolicyPage } from "../_components/access-policy-page";
import { withConsoleConfig } from "../app-context";

export default withConsoleConfig(({ appName, appBasePath }) => (
    <AccessPolicyPage
      appLabel={appName}
      testIdPrefix="console-access-policy"
      requestHref={`${appBasePath}/access-policy/request`}
      requestCapability="access_policy.request"
    />
));
