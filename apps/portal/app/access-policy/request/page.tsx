import { AccessPolicyRequestPage } from "../../_components/access-policy-request-page";
import { withPortalConfig } from "../../app-context";

export default withPortalConfig(({ appName, appBasePath }) => (
    <AccessPolicyRequestPage
      appLabel={appName}
      testIdPrefix="portal-access-policy-request"
      returnHref={`${appBasePath}/access-policy`}
    />
));
