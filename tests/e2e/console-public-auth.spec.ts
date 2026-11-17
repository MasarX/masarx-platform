import { getConsoleBasePath } from "./utils/base-paths";
import { registerPublicAuthTests } from "./utils/public-auth";

registerPublicAuthTests("console", getConsoleBasePath());
