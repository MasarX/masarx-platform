import path from "path";
import { fileURLToPath } from "url";
import type { Metadata } from "next";
import "@fontsource/inter/400.css";
import "@fontsource/inter/500.css";
import "@fontsource/inter/600.css";
import "@fontsource/inter/700.css";
import "@fontsource/noto-sans-arabic/400.css";
import "@fontsource/noto-sans-arabic/500.css";
import "@fontsource/noto-sans-arabic/600.css";
import "@fontsource/noto-sans-arabic/700.css";
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/500.css";
import {
  createAppMetadata,
  createRootLayout,
} from "../../shared/app-layout";
import { resolveAppBasePath } from "../../shared/app-base-path";
import { loadMessages } from "../i18n/index";
import "./globals.css";

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const appBasePath = resolveAppBasePath(appDir);

export async function generateMetadata(): Promise<Metadata> {
  return createAppMetadata({
    appKey: "portal",
    appBasePath,
    loadMessages,
  });
}

const RootLayout = createRootLayout({
  appKey: "portal",
  appBasePath,
  loadMessages,
  testIdPrefix: "portal",
  authMode: "optional",
});

export default RootLayout;
