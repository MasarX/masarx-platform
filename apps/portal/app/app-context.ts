import path from "path";
import { fileURLToPath } from "url";
import type { ReactNode } from "react";
import {
  createAppViewContext,
  createConfigGuardedPage,
  type DefaultPageProps,
  type AppContextWithConfig,
  type AppAuthMode,
} from "../../shared/app-layout";
import { resolveAppBasePath } from "../../shared/app-base-path";
import { loadMessages } from "../i18n";

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const appBasePath = resolveAppBasePath(appDir);

export async function getPortalAppContext() {
  return createAppViewContext({
    appKey: "portal",
    appBasePath,
    loadMessages,
  });
}

export function withPortalConfig<P = DefaultPageProps>(
  render: (context: AppContextWithConfig, props: P) => ReactNode | Promise<ReactNode>,
  options?: { authMode?: AppAuthMode; testIdPrefix?: string }
) {
  return createConfigGuardedPage<P>({
    loadContext: getPortalAppContext,
    render,
    authMode: options?.authMode ?? "required",
    testIdPrefix: options?.testIdPrefix ?? "portal",
  });
}
