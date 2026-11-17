import path from "path";
import { fileURLToPath } from "url";
import { createNotFoundPage } from "../../shared/app-fallbacks";
import { resolveAppBasePath } from "../../shared/app-base-path";
import { loadMessages } from "../i18n";

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const appBasePath = resolveAppBasePath(appDir);

export default createNotFoundPage({
  appKey: "console",
  appBasePath,
  loadMessages,
});
