import { getPortalBasePath } from "./utils/base-paths";
import { registerPublicAuthTests } from "./utils/public-auth";

registerPublicAuthTests("portal", getPortalBasePath());
