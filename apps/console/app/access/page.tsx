import { AccessPage } from "../_components/access-page";
import { withConsoleConfig } from "../app-context";

export default withConsoleConfig(({ appName }) => (
  <AccessPage appLabel={appName} testIdPrefix="console-access" />
));
