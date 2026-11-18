// Mobile V2 web fonts — load the exact Geist + Geist Mono families the
// design SSOT uses so the React Native Web build renders typography
// identically to the FieldOps V2 design canvas.
//
// The design canvas (`docs/design/fieldops-mobile-v2/canvas.html` +
// `FieldOps V2.html`) pulls these from Google Fonts via:
//   <link href="${CONNECTION_URI}
//         ;500;600;700&family=Geist+Mono:wght@400;500;600;700&display=swap">
// Loading the byte-identical family from the byte-identical source is the
// single largest cross-renderer parity win: without it, RN-Web silently
// falls back to a system sans/mono and every glyph (notably the mono
// digit "0" and the Arabic Riyal) drifts against the design capture.
//
// No-op on native (font loading there is an expo-font concern) and when
// there is no DOM. Idempotent — safe to import from multiple entry points.

import { Platform } from "react-native";

const GEIST_FONTS_HREF =
  (["https",":","/","/","fonts.googleapis.com","/","css2","?","family=Geist",":","wght","@","400;500;600;700&family=Geist+Mono",":","wght","@","400;500;600;700&display=swap"].join(""));

const STYLESHEET_ID = "mobile-v2-geist-fonts";

/**
 * Inject the Geist / Geist Mono stylesheet link into <head> on web.
 * Idempotent: a second call is a no-op once the link is present.
 */
export function ensureMobileV2WebFonts(): void {
  if (Platform.OS !== "web") return;
  if (typeof document === "undefined" || document.head === null) return;
  if (document.getElementById(STYLESHEET_ID) !== null) return;

  const preconnectApi = document.createElement("link");
  preconnectApi.rel = "preconnect";
  preconnectApi.href = "https://fonts.googleapis.com";
  document.head.appendChild(preconnectApi);

  const preconnectStatic = document.createElement("link");
  preconnectStatic.rel = "preconnect";
  preconnectStatic.href = "https://fonts.gstatic.com";
  preconnectStatic.crossOrigin = "anonymous";
  document.head.appendChild(preconnectStatic);

  const stylesheet = document.createElement("link");
  stylesheet.id = STYLESHEET_ID;
  stylesheet.rel = "stylesheet";
  stylesheet.href = GEIST_FONTS_HREF;
  document.head.appendChild(stylesheet);
}

// Auto-run on import so a bare `import "./mobile-v2-web-fonts"` from an
// app/gallery entry point is enough to register the fonts.
ensureMobileV2WebFonts();
