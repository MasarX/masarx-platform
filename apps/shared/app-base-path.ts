import path from "path";
import { resolveSafeAppBasePath } from "../../packages/ui/src/url-guard";

export function resolveAppBasePath(appDir: string) {
  const configured = process.env.NEXT_PUBLIC_APP_BASE_PATH;
  if (configured) {
    const safeConfigured = resolveSafeAppBasePath(configured);
    if (safeConfigured !== null) {
      return safeConfigured;
    }
  }
  // Dedicated-host console/portal surfaces are root-served by contract.
  // Keep support for explicit NEXT_PUBLIC_APP_BASE_PATH overrides only.
  const appName = path.basename(appDir).toLowerCase();
  if (appName === "console" || appName === "portal") {
    return "";
  }
  return "";
}
