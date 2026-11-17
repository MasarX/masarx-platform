import path from "path";
import { fileURLToPath } from "url";
import type { ReactNode } from "react";
import {
  createAppContext,
  createConfigGuardedPage,
  type DefaultPageProps,
  type AppContextWithConfig,
} from "../../shared/app-layout";
import { resolveAppBasePath } from "../../shared/app-base-path";
import { loadMessages } from "../i18n";

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const appBasePath = resolveAppBasePath(appDir);

export async function getConsoleAppContext() {
  return createAppContext({
    appKey: "console",
    appBasePath,
    loadMessages,
  });
}

export function withConsoleConfig<P = DefaultPageProps>(
  render: (context: AppContextWithConfig, props: P) => ReactNode | Promise<ReactNode>
) {
  return createConfigGuardedPage<P>({ loadContext: getConsoleAppContext, render });
}
