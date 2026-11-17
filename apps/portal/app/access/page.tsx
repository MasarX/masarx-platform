import { AccessPage } from "../_components/access-page";
import { withPortalConfig } from "../app-context";

export default withPortalConfig(({ appName }) => (
  <AccessPage appLabel={appName} testIdPrefix="portal-access" />
));
