import "react-native-url-polyfill/auto";

import { registerRootComponent } from "expo";
import * as React from "react";
import { LogBox, Platform } from "react-native";

import App from "./App";
import { MobileV2PreviewScreen } from "./src/mobile-v2-preview-screen";
import {
  MobileV2PreviewGallery,
  isMobileV2GalleryRequested,
} from "./src/mobile-v2-preview-gallery";

if (Platform.OS !== "web") {
  LogBox.ignoreAllLogs(true);
}

// Web-only V2 design preview gate. Reachable via `?v2=preview` so the design
// system + shell can be audited live in browser without modifying the V1
// SignInScreen or any production surface. The optional `&gallery=1` flag
// switches to the screen gallery used by the design audit. Native builds
// always boot the V1 App entry; production web builds also boot V1 since
// this gate requires an explicit query parameter.
function isV2PreviewRequested(): boolean {
  if (Platform.OS !== "web") return false;
  if (typeof window === "undefined" || typeof window.location === "undefined") return false;
  try {
    const url = new URL(window.location.href);
    return url.searchParams.get("v2") === "preview";
  } catch {
    return false;
  }
}

function FieldOpsRoot(): React.ReactElement {
  if (isV2PreviewRequested()) {
    if (isMobileV2GalleryRequested()) {
      return React.createElement(MobileV2PreviewGallery);
    }
    return React.createElement(MobileV2PreviewScreen);
  }
  return React.createElement(App);
}

registerRootComponent(FieldOpsRoot);
