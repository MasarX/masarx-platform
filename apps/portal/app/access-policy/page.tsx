import { AccessPolicyPage } from "../_components/access-policy-page";
import { withPortalConfig } from "../app-context";

export default withPortalConfig(({ appName, appBasePath }) => (
    <AccessPolicyPage
      appLabel={appName}
      testIdPrefix="portal-access-policy"
      requestHref={`${appBasePath}/access-policy/request`}
      requestCapability="access_policy.request"
    />
));
