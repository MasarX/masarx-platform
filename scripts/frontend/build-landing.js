#!/usr/bin/env node
/* eslint-disable no-console */
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { loadEnv } = require("../utils/load-env");
const { parseFlagArgs } = require("../utils/cli-args");

let esbuild;
try {
  esbuild = require("esbuild");
} catch {
  // esbuild not installed; assets will be served unminified.
}

loadEnv();

function minify(source, loader) {
  if (!esbuild) return source;
  try {
    return esbuild.transformSync(source, { loader, minify: true }).code;
  } catch {
    return source;
  }
}

function sha8(input) {
  return crypto.createHash("sha256").update(input).digest("hex").slice(0, 8);
}

function normalizeAbsoluteUrl(value) {
  const trimmed = String(value ?? "").trim();
  if (!trimmed) return "";
  const parsed = new URL(trimmed);
  const normalized = String(parsed.origin + parsed.pathname);
  return normalized.length > 1 ? normalized.replace(/\/+$/g, "") : normalized;
}

function normalizePathOrAbsoluteUrl(value) {
  const trimmed = String(value ?? "").trim();
  if (!trimmed) return "";
  if (trimmed.startsWith("/")) {
    return trimmed.length > 1 ? trimmed.replace(/\/+$/g, "") : trimmed;
  }
  return normalizeAbsoluteUrl(trimmed);
}

function normalizeContactEndpoint(value) {
  return normalizePathOrAbsoluteUrl(value);
}

function endpointPathname(value) {
  const trimmed = String(value ?? "").trim();
  if (!trimmed) return "";
  try {
    const parsed = trimmed.startsWith("/")
      ? new URL(trimmed, "https://landing.local")
      : new URL(trimmed);
    return parsed.pathname.replace(/\/+$/g, "");
  } catch {
    return trimmed.split(/[?#]/)[0].replace(/\/+$/g, "");
  }
}

function isMarketingLeadIntakeEndpoint(value) {
  return /(^|\/)marketing-lead-intake$/.test(endpointPathname(value));
}

function isTenantSignupIntakeEndpoint(value) {
  return /(^|\/)tenant-signup-intake$/.test(endpointPathname(value));
}

function isMarketingLeadClientsEndpoint(value) {
  return /(^|\/)marketing-lead-intake\/clients$/.test(endpointPathname(value));
}

function isLocalSiteUrl(value) {
  const trimmed = String(value ?? "").trim();
  if (!trimmed) return false;
  try {
    const hostname = new URL(trimmed).hostname.toLowerCase();
    return (
      hostname === "localhost" ||
      hostname.endsWith(".localhost") ||
      hostname === "127.0.0.1" ||
      hostname === "[::1]" ||
      hostname === "::1"
    );
  } catch {
    return false;
  }
}

function isLocalLandingContactEndpoint(value) {
  return endpointPathname(value) === "/__landing-contact";
}

function isLocalTenantSignupEndpoint(value) {
  return endpointPathname(value) === "/__tenant-signup";
}

function validateLandingRuntimeEndpoints({
  siteUrl,
  contactEndpoint,
  tenantSignupEndpoint,
}) {
  const allowLocalPreviewMocks = isLocalSiteUrl(siteUrl);

  if (!contactEndpoint) {
    throw new Error(
      "LANDING_CONTACT_ENDPOINT is required for landing builds and must point to the marketing-lead-intake intake endpoint (.../marketing-lead-intake)."
    );
  }

  if (!tenantSignupEndpoint) {
    throw new Error(
      "LANDING_TENANT_SIGNUP_ENDPOINT is required for landing builds and must point to the tenant-signup-intake intake endpoint (.../tenant-signup-intake)."
    );
  }

  if (
    !isMarketingLeadIntakeEndpoint(contactEndpoint) &&
    !(allowLocalPreviewMocks && isLocalLandingContactEndpoint(contactEndpoint))
  ) {
    throw new Error(
      "LANDING_CONTACT_ENDPOINT must point to the marketing-lead-intake intake endpoint (.../marketing-lead-intake)."
    );
  }

  if (
    !isTenantSignupIntakeEndpoint(tenantSignupEndpoint) &&
    !(allowLocalPreviewMocks && isLocalTenantSignupEndpoint(tenantSignupEndpoint))
  ) {
    throw new Error(
      "LANDING_TENANT_SIGNUP_ENDPOINT must point to the tenant-signup-intake intake endpoint (.../tenant-signup-intake)."
    );
  }

  if (contactEndpoint === tenantSignupEndpoint) {
    throw new Error(
      "LANDING_TENANT_SIGNUP_ENDPOINT must point to tenant-signup-intake and must not reuse LANDING_CONTACT_ENDPOINT."
    );
  }
}

function appendEndpointPath(value, segment) {
  const trimmed = String(value ?? "").trim();
  const leaf = String(segment || "").replace(/^\/+/, "");
  if (!trimmed || !leaf) return "";
  if (trimmed.startsWith("/")) {
    return `${trimmed.split(/[?#]/)[0].replace(/\/+$/g, "")}/${leaf}`;
  }
  const parsed = new URL(trimmed);
  parsed.pathname = `${parsed.pathname.replace(/\/+$/g, "")}/${leaf}`;
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString();
}

function resolveLandingClientsEndpoint(rawClientsEndpoint, contactEndpoint) {
  const explicit = normalizePathOrAbsoluteUrl(rawClientsEndpoint);
  if (explicit) {
    if (!isMarketingLeadClientsEndpoint(explicit)) {
      throw new Error(
        "LANDING_CLIENTS_ENDPOINT must point to the marketing-lead-intake clients feed (.../marketing-lead-intake/clients)."
      );
    }
    return explicit;
  }

  if (!isMarketingLeadIntakeEndpoint(contactEndpoint)) return "";
  return appendEndpointPath(contactEndpoint, "clients");
}

function normalizeBasePath(value) {
  const trimmed = String(value ?? "").trim();
  if (!trimmed || trimmed === "/") return "/";
  const withLeading = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  return withLeading.replace(/\/+$/g, "");
}

function resolveAssetBasePath(siteUrl) {
  if (!siteUrl) return "/";
  try {
    const parsed = new URL(siteUrl);
    return normalizeBasePath(parsed.pathname || "/");
  } catch {
    return "/";
  }
}

function joinUrlPath(basePath, fileName) {
  const base = normalizeBasePath(basePath);
  const leaf = String(fileName || "").replace(/^\/+/, "");
  if (!leaf) return base;
  return base === "/" ? `/${leaf}` : `${base}/${leaf}`;
}

function readText(filePath) {
  return fs.readFileSync(filePath, "utf8");
}

function writeFile(filePath, contents) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, contents);
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escapeAttr(value) {
  return escapeHtml(value).replace(/"/g, "&quot;");
}

function setTagAttribute(tagSource, attrName, attrValue) {
  const value = escapeAttr(attrValue);
  const attrPattern = new RegExp(`\\s${attrName}="[^"]*"`, "i");
  if (attrPattern.test(tagSource)) {
    return tagSource.replace(attrPattern, ` ${attrName}="${value}"`);
  }
  return tagSource.replace(/\s*(\/?>)\s*$/, ` ${attrName}="${value}"$1`);
}

function extractLandingConfig(contentSource) {
  const sandbox = { window: {} };
  vm.createContext(sandbox);
  vm.runInContext(contentSource, sandbox, { filename: "landing-content.js" });
  const cfg = sandbox.window.MASARX_LANDING;
  if (!cfg || typeof cfg !== "object") {
    throw new Error("Landing content did not set window.MASARX_LANDING");
  }
  return cfg;
}

function resolveI18nText(i18n, key, lang) {
  const entry = i18n && i18n[key];
  if (!entry || typeof entry !== "object") return "";
  const raw = entry[lang] ?? entry.en ?? "";
  return String(raw);
}

function applyStaticI18n(html, i18n, lang) {
  let out = html;

  out = out.replace(
    /(<([a-zA-Z0-9]+)[^>]*\sdata-i18n="([^"]+)"[^>]*>)([\s\S]*?)(<\/\2>)/g,
    (match, open, tagName, key, inner, close) => {
      const value = resolveI18nText(i18n, key, lang);
      if (!value) return match;
      return `${open}${escapeHtml(value)}${close}`;
    }
  );

  out = out.replace(
    /<meta[^>]*\sdata-i18n-meta="([^"]+)"[^>]*>/g,
    (match, key) => {
      const value = resolveI18nText(i18n, key, lang);
      if (!value) return match;
      return setTagAttribute(match, "content", value);
    }
  );

  out = out.replace(
    /<([a-zA-Z0-9]+)[^>]*\sdata-i18n-placeholder="([^"]+)"[^>]*>/g,
    (match, tagName, key) => {
      const value = resolveI18nText(i18n, key, lang);
      if (!value) return match;
      return setTagAttribute(match, "placeholder", value);
    }
  );

  out = out.replace(
    /<([a-zA-Z0-9]+)[^>]*\sdata-i18n-aria="([^"]+)"[^>]*>/g,
    (match, tagName, key) => {
      const value = resolveI18nText(i18n, key, lang);
      if (!value) return match;
      return setTagAttribute(match, "aria-label", value);
    }
  );

  return out;
}

function copyDir(srcDir, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  const entries = fs.readdirSync(srcDir, { withFileTypes: true });
  for (const entry of entries) {
    const src = path.join(srcDir, entry.name);
    const dest = path.join(destDir, entry.name);
    if (entry.isDirectory()) {
      copyDir(src, dest);
      continue;
    }
    if (entry.isFile()) {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(src, dest);
    }
  }
}

function patchHtml(html, patch) {
  let out = html;

  // Inline scripts/event handlers break strict CSP. Keep the runtime JS responsible for behavior.
  out = out.replace(
    /<script>\s*document\.documentElement\.classList\.add\('js'\);\s*<\/script>\s*/m,
    ""
  );

  // Brand assets are copied into {assetBasePath}/brand for publishing.
  // Use absolute pathing so localized routes (e.g. /ar/) resolve shared assets.
  const brandBase = `${joinUrlPath(patch.assetBasePath, "brand")}/`;
  out = out.replace(/\.\.\/brand\//g, brandBase);


  // Runtime-configured docs link.
  out = out.replace(
    /href="\.\.\/\.\.\/README\.md"/g,
    'href="#" data-runtime-href="docsUrl"'
  );

  const cssHref = joinUrlPath(patch.assetBasePath, patch.cssFile);
  const extraCssTags = [];
  if (patch.leafletCssFile) {
    const leafletCssHref = joinUrlPath(patch.assetBasePath, patch.leafletCssFile);
    extraCssTags.push(
      `    <link rel="preload" href="${leafletCssHref}" as="style" />`,
      `    <link rel="stylesheet" href="${leafletCssHref}" />`
    );
  }
  out = out.replace(
    /<link rel="stylesheet" href="\.\/app\.css"\s*\/>/g,
    [
      `<link rel="preload" href="${cssHref}" as="style" />`,
      `    <link rel="stylesheet" href="${cssHref}" />`,
      ...extraCssTags,
    ].join("\n")
  );

  // Replace script asset names and inject runtime config. Add defer for non-blocking load.
  const scriptTags = [
    `<script defer src="${joinUrlPath(patch.assetBasePath, patch.runtimeFile)}"></script>`,
  ];
  if (patch.lottieFile) {
    scriptTags.push(`<script defer src="${joinUrlPath(patch.assetBasePath, patch.lottieFile)}"></script>`);
  }
  if (patch.leafletFile) {
    scriptTags.push(`<script defer src="${joinUrlPath(patch.assetBasePath, patch.leafletFile)}"></script>`);
  }
  scriptTags.push(
    `<script defer src="${joinUrlPath(patch.assetBasePath, patch.contentFile)}"></script>`,
    `<script defer src="${joinUrlPath(patch.assetBasePath, patch.appFile)}"></script>`
  );
  out = out.replace(
    /<script src="\.\/content\.js"><\/script>\s*<script src="\.\/app\.js"><\/script>/g,
    scriptTags.join("\n")
  );
  out = out.replace(
    /<script src="\.\/([^"]+)"><\/script>/g,
    (match, scriptFile) => `<script defer src="${joinUrlPath(patch.assetBasePath, scriptFile)}"></script>`
  );

  // OG / Twitter image: use absolute raster URL for social sharing.
  if (patch.siteUrl) {
    const ogImageUrl = `${patch.siteUrl}/brand/masarx-og.png`;
    out = out.replace(
      /(<meta\s+property="og:image"\s+content=")[^"]*(")/,
      `$1${escapeAttr(ogImageUrl)}$2`
    );
    out = out.replace(
      /(<meta\s+name="twitter:image"\s+content=")[^"]*(")/,
      `$1${escapeAttr(ogImageUrl)}$2`
    );
  }

  // Theme color meta tags.
  const headInserts = [
    `  <meta name="theme-color" content="#070c16" media="(prefers-color-scheme: dark)" />`,
    `  <meta name="theme-color" content="#f7f7ff" media="(prefers-color-scheme: light)" />`,
    `  <link rel="apple-touch-icon" href="${joinUrlPath(patch.assetBasePath, "brand/apple-touch-icon.png")}" />`,
    `  <link rel="manifest" href="${joinUrlPath(patch.assetBasePath, "manifest.json")}" />`,
    `  <link rel="dns-prefetch" href="https://challenges.cloudflare.com" />`,
    `  <link rel="preconnect" href="https://challenges.cloudflare.com" crossorigin />`,
  ];

  if (patch.siteUrl) {
    const alternateEnUrl = patch.alternateEnUrl || `${patch.siteUrl}/`;
    const alternateArUrl = patch.alternateArUrl || `${patch.siteUrl}/ar/`;
    const alternateDefaultUrl = patch.alternateDefaultUrl || alternateEnUrl;
    headInserts.push(
      `  <link rel="canonical" href="${patch.canonicalUrl}" />`,
      `  <link rel="alternate" hreflang="en" href="${alternateEnUrl}" />`,
      `  <link rel="alternate" hreflang="ar" href="${alternateArUrl}" />`,
      `  <link rel="alternate" hreflang="x-default" href="${alternateDefaultUrl}" />`
    );
  }

  out = out.replace(/<\/head>/, headInserts.join("\n") + "\n</head>");

  // JSON-LD structured data (Organization + WebSite schema).
  if (patch.siteUrl) {
    const jsonLd = [
      {
        "@context": "https://schema.org",
        "@type": "Organization",
        name: "MasarX",
        url: patch.siteUrl,
        logo: `${patch.siteUrl}/brand/masarx-og.png`,
      },
      {
        "@context": "https://schema.org",
        "@type": "WebSite",
        name: "MasarX",
        url: patch.siteUrl,
      },
    ];
    out = out.replace(
      /<\/head>/,
      `  <script type="application/ld+json">${JSON.stringify(jsonLd)}</script>\n</head>`
    );
  }

  return out;
}

function buildHeaders({
  contactEndpoint,
  tenantSignupEndpoint,
  driverSignupEndpoint,
  driverApplicationStatusEndpoint,
  driverApplicationDocumentsEndpoint,
  clientsEndpoint,
  trackingEndpoint,
  cspReportUri,
  mapTileUrl,
}) {
  const connectOrigins = new Set(["'self'", "https://challenges.cloudflare.com"]);
  const connectCandidates = [
    contactEndpoint,
    tenantSignupEndpoint,
    driverSignupEndpoint,
    driverApplicationStatusEndpoint,
    driverApplicationDocumentsEndpoint,
    clientsEndpoint,
    trackingEndpoint,
  ];
  connectCandidates.forEach((candidate) => {
    if (typeof candidate !== "string" || !candidate.startsWith("http")) return;
    try {
      connectOrigins.add(new URL(candidate).origin);
    } catch {
      // ignore; validated elsewhere
    }
  });

  const imgOrigins = new Set(["'self'", "data:", "blob:"]);
  if (typeof mapTileUrl === "string" && mapTileUrl.trim()) {
    try {
      imgOrigins.add(new URL(mapTileUrl).origin);
    } catch {
      // ignore; invalid tile URL is handled at runtime
    }
  }

  const cspDirectives = [
    "default-src 'self'",
    "base-uri 'self'",
    "frame-ancestors 'none'",
    "object-src 'none'",
    `img-src ${[...imgOrigins].join(" ")}`,
    "font-src 'self' data:",
    "style-src 'self'",
    "script-src 'self' https://challenges.cloudflare.com",
    "frame-src https://challenges.cloudflare.com",
    `connect-src ${[...connectOrigins].join(" ")}`,
    "upgrade-insecure-requests",
  ];

  if (cspReportUri) {
    cspDirectives.push(`report-uri ${cspReportUri}`);
  }

  const csp = cspDirectives.join("; ");

  return [
    "/*",
    "  Cache-Control: public, max-age=0, must-revalidate, stale-while-revalidate=60",
    "  X-Content-Type-Options: nosniff",
    "  X-Frame-Options: DENY",
    "  Referrer-Policy: strict-origin-when-cross-origin",
    "  Permissions-Policy: camera=(), microphone=(), geolocation=(self)",
    "  Strict-Transport-Security: max-age=63072000; includeSubDomains; preload",
    "  Cross-Origin-Opener-Policy: same-origin",
    "  Cross-Origin-Embedder-Policy: credentialless",
    `  Content-Security-Policy: ${csp}`,
    "",
    "/*.css",
    "  Cache-Control: public, max-age=31536000, immutable",
    "",
    "/*.js",
    "  Cache-Control: public, max-age=31536000, immutable",
    "",
    "/brand/*",
    "  Cache-Control: public, max-age=604800",
    "",
  ].join("\n");
}

function buildRedirects() {
  return [
    "/ar /ar/ 301",
    "/drivers/status/* /drivers/status/index.html 200",
    "/ar/drivers/status/* /ar/drivers/status/index.html 200",
    "/track /track/ 301",
    "/ar/track /ar/track/ 301",
    "",
  ].join("\n");
}

function writeLandingAliases(outDir, html, segments = []) {
  if (!Array.isArray(segments) || !segments.length) return;
  writeFile(path.join(outDir, ...segments, "index.html"), html);
}

function buildRobotsTxt(siteUrl) {
  const lines = ["User-agent: *", "Allow: /"];
  if (siteUrl) {
    lines.push(`Sitemap: ${siteUrl}/sitemap.xml`);
  }
  lines.push("");
  return lines.join("\n");
}

function buildSitemapXml(siteUrl) {
  const urls = [`${siteUrl}/`, `${siteUrl}/ar/`, `${siteUrl}/track/`, `${siteUrl}/ar/track/`];
  const lastmod = new Date().toISOString().split("T")[0];
  return [
    "<?xml version=\"1.0\" encoding=\"UTF-8\"?>",
    "<urlset xmlns=\"http://www.sitemaps.org/schemas/sitemap/0.9\">",
    ...urls.map((loc) => `  <url><loc>${loc}</loc><lastmod>${lastmod}</lastmod></url>`),
    "</urlset>",
    "",
  ].join("\n");
}

function build404Page({ cssFile, assetBasePath, siteUrl }) {
  const homeUrl = siteUrl ? `${siteUrl}/` : "/";
  const cssHref = joinUrlPath(assetBasePath, cssFile);
  const faviconHref = joinUrlPath(assetBasePath, "brand/masarx-favicon.svg");
  const markHref = joinUrlPath(assetBasePath, "brand/masarx-mark-a.svg");

  return [
    '<!doctype html>',
    '<html lang="en" dir="ltr" data-variant="ai" data-theme="dark" data-motion="off">',
    '  <head>',
    '    <meta charset="utf-8" />',
    '    <meta name="viewport" content="width=device-width, initial-scale=1" />',
    '    <meta name="color-scheme" content="light dark" />',
    '    <title>Page not found - MasarX</title>',
    `    <link rel="icon" href="${faviconHref}" />`,
    `    <link rel="stylesheet" href="${cssHref}" />`,
    '  </head>',
    '  <body>',
    '    <header class="header">',
    '      <div class="container">',
    '        <div class="header-row">',
    `          <a class="brand" href="${escapeAttr(homeUrl)}" aria-label="MasarX">`,
    `            <img class="brand-mark" src="${markHref}" alt="" />`,
    '            <span class="brand-name">MasarX</span>',
    '          </a>',
    '        </div>',
    '      </div>',
    '    </header>',
    '    <main id="main">',
    '      <section class="hero not-found">',
    '        <div class="container">',
    '          <h1>Page not found</h1>',
    '          <p>The page you are looking for does not exist or has been moved.</p>',
    '          <div class="not-found-actions">',
    `            <a class="btn btn-primary" href="${escapeAttr(homeUrl)}">Back to home</a>`,
    '          </div>',
    '        </div>',
    '      </section>',
    '    </main>',
    '    <footer class="footer">',
    '      <div class="container">',
    '        <div class="footer-row">',
    '          <div><strong>MasarX</strong></div>',
    '        </div>',
    '      </div>',
    '    </footer>',
    '  </body>',
    '</html>',
    '',
  ].join("\n");
}

function main() {
  const args = parseFlagArgs(process.argv.slice(2));
  const repoRoot = process.cwd();
  const outDir = path.resolve(repoRoot, String(args.out || "dist/landing"));

  const srcDir = path.join(repoRoot, "docs", "marketing", "landing-v2");
  const brandDir = path.join(repoRoot, "docs", "marketing", "brand");

  if (!fs.existsSync(srcDir)) {
    throw new Error(`Missing landing source directory: ${srcDir}`);
  }
  if (!fs.existsSync(brandDir)) {
    throw new Error(`Missing brand source directory: ${brandDir}`);
  }

  const siteUrl = normalizeAbsoluteUrl(process.env.LANDING_SITE_URL);
  const assetBasePath = resolveAssetBasePath(siteUrl);
  const docsUrl = normalizeAbsoluteUrl(process.env.LANDING_DOCS_URL);
  const appUrl = normalizeAbsoluteUrl(process.env.LANDING_APP_URL);
  const contactEndpoint = normalizeContactEndpoint(process.env.LANDING_CONTACT_ENDPOINT);
  const tenantSignupEndpoint = normalizeContactEndpoint(
    process.env.LANDING_TENANT_SIGNUP_ENDPOINT
  );
  const driverSignupEntryKey = String(process.env.LANDING_DRIVER_SIGNUP_ENTRY_ID || "").trim();
  const driverSignupEndpoint = normalizeContactEndpoint(
    process.env.LANDING_DRIVER_SIGNUP_ENDPOINT
  );
  const driverApplicationStatusEndpoint = normalizeContactEndpoint(
    process.env.LANDING_DRIVER_APPLICATION_STATUS_ENDPOINT ||
      process.env.LANDING_DRIVER_STATUS_ENDPOINT
  );
  const driverApplicationDocumentsEndpoint = normalizeContactEndpoint(process.env.LANDING_DRIVER_APPLICATION_DOCUMENTS_ENDPOINT);
  const trackingEndpoint = normalizeContactEndpoint(process.env.LANDING_TRACKING_ENDPOINT);
  const clientsEndpoint = resolveLandingClientsEndpoint(
    process.env.LANDING_CLIENTS_ENDPOINT,
    contactEndpoint
  );
  validateLandingRuntimeEndpoints({
    siteUrl,
    contactEndpoint,
    tenantSignupEndpoint,
  });
  const turnstileSiteKey = String(process.env.LANDING_TURNSTILE_SITE_KEY || "").trim();
  const supabaseAnonKey = String(
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY || "",
  ).trim();
  const cspReportUri = String(process.env.LANDING_CSP_REPORT_URI || "").trim();
  const mapTileUrl = String(process.env.LANDING_MAP_TILE_URL || "https://tile.openstreetmap.org/{z}/{x}/{y}.png").trim();
  const mapTileAttribution = String(
    process.env.LANDING_MAP_TILE_ATTRIBUTION || '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
  ).trim();
  const mapDefaultLat = Number.parseFloat(String(process.env.LANDING_MAP_DEFAULT_LAT || "24.7136"));
  const mapDefaultLng = Number.parseFloat(String(process.env.LANDING_MAP_DEFAULT_LNG || "46.6753"));
  const mapDefaultZoom = Number.parseInt(String(process.env.LANDING_MAP_DEFAULT_ZOOM || "11"), 10);
  const mapLocateZoom = Number.parseInt(String(process.env.LANDING_MAP_LOCATE_ZOOM || "16"), 10);
  const mapMaxZoom = Number.parseInt(String(process.env.LANDING_MAP_MAX_ZOOM || "19"), 10);

  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });

  copyDir(brandDir, path.join(outDir, "brand"));

  const cssSource = readText(path.join(srcDir, "app.css"));
  const appSource = readText(path.join(srcDir, "app.js"));
  const contentSource = readText(path.join(srcDir, "content.js"));
  const landingCfg = extractLandingConfig(contentSource);
  const landingI18n = landingCfg.i18n || {};
  const leafletCssPath = path.join(repoRoot, "node_modules", "leaflet", "dist", "leaflet.css");
  const leafletJsPath = path.join(repoRoot, "node_modules", "leaflet", "dist", "leaflet.js");

  // Read lottie-web light build
  const lottiePath = path.join(repoRoot, "node_modules/lottie-web/build/player/lottie_light.min.js");
  const lottieSrc = fs.existsSync(lottiePath) ? readText(lottiePath) : "";
  const lottieFile = lottieSrc ? `lottie.${sha8(lottieSrc)}.js` : "";
  if (lottieSrc) writeFile(path.join(outDir, lottieFile), lottieSrc);
  const leafletCssSrc = fs.existsSync(leafletCssPath) ? readText(leafletCssPath) : "";
  const leafletJsSrc = fs.existsSync(leafletJsPath) ? readText(leafletJsPath) : "";
  const leafletCssFile = leafletCssSrc ? `leaflet.${sha8(leafletCssSrc)}.css` : "";
  const leafletFile = leafletJsSrc ? `leaflet.${sha8(leafletJsSrc)}.js` : "";
  if (leafletCssSrc) writeFile(path.join(outDir, leafletCssFile), leafletCssSrc);
  if (leafletJsSrc) writeFile(path.join(outDir, leafletFile), leafletJsSrc);

  const runtimeSource =
    `/* generated by scripts/frontend/build-landing.js */\n` +
    `window.MASARX_RUNTIME = ${JSON.stringify({
      siteUrl,
      docsUrl,
      appUrl,
      contactEndpoint,
      tenantSignupEndpoint,
      driverSignupEndpoint,
      driverSignupEntryKey,
      driverApplicationStatusEndpoint,
      driverApplicationDocumentsEndpoint,
      trackingEndpoint,
      trackingEndpoint,
      clientsEndpoint,
      turnstileSiteKey,
      supabaseAnonKey,
      mapTileUrl,
      mapTileAttribution,
      mapDefaultLat: Number.isFinite(mapDefaultLat) ? mapDefaultLat : 24.7136,
      mapDefaultLng: Number.isFinite(mapDefaultLng) ? mapDefaultLng : 46.6753,
      mapDefaultZoom: Number.isFinite(mapDefaultZoom) ? mapDefaultZoom : 11,
      mapLocateZoom: Number.isFinite(mapLocateZoom) ? mapLocateZoom : 16,
      mapMaxZoom: Number.isFinite(mapMaxZoom) ? mapMaxZoom : 19,
    })};\n`;

  const cssOut = minify(cssSource, "css");
  const appOut = minify(appSource, "js");
  const contentOut = minify(contentSource, "js");

  const cssFile = `app.${sha8(cssOut)}.css`;
  const appFile = `app.${sha8(appOut)}.js`;
  const contentFile = `content.${sha8(contentOut)}.js`;
  const runtimeFile = `runtime.${sha8(runtimeSource)}.js`;

  writeFile(path.join(outDir, cssFile), cssOut);
  writeFile(path.join(outDir, appFile), appOut);
  writeFile(path.join(outDir, contentFile), contentOut);
  writeFile(path.join(outDir, runtimeFile), runtimeSource);

  const htmlSource = readText(path.join(srcDir, "index.html"));
  const trackHtmlSource = readText(path.join(srcDir, "track.html"));
  const enHtml = applyStaticI18n(
    patchHtml(htmlSource, {
      siteUrl,
      canonicalUrl: siteUrl ? `${siteUrl}/` : "",
      alternateEnUrl: siteUrl ? `${siteUrl}/` : "",
      alternateArUrl: siteUrl ? `${siteUrl}/ar/` : "",
      alternateDefaultUrl: siteUrl ? `${siteUrl}/` : "",
      cssFile,
      contentFile,
      appFile,
      runtimeFile,
      lottieFile,
      assetBasePath,
    }),
    landingI18n,
    "en"
  );

  const arHtml = applyStaticI18n(
    patchHtml(htmlSource, {
      siteUrl,
      canonicalUrl: siteUrl ? `${siteUrl}/ar/` : "",
      alternateEnUrl: siteUrl ? `${siteUrl}/` : "",
      alternateArUrl: siteUrl ? `${siteUrl}/ar/` : "",
      alternateDefaultUrl: siteUrl ? `${siteUrl}/` : "",
      cssFile,
      contentFile,
      appFile,
      runtimeFile,
      lottieFile,
      assetBasePath,
    }).replace(
      /<html lang="en" dir="ltr"/,
      '<html lang="ar" dir="rtl"'
    ),
    landingI18n,
    "ar"
  );

  const enTrackHtml = applyStaticI18n(
    patchHtml(trackHtmlSource, {
      siteUrl,
      canonicalUrl: siteUrl ? `${siteUrl}/track/` : "",
      alternateEnUrl: siteUrl ? `${siteUrl}/track/` : "",
      alternateArUrl: siteUrl ? `${siteUrl}/ar/track/` : "",
      alternateDefaultUrl: siteUrl ? `${siteUrl}/track/` : "",
      cssFile,
      contentFile,
      appFile,
      runtimeFile,
      lottieFile,
      leafletCssFile,
      leafletFile,
      assetBasePath,
    }),
    landingI18n,
    "en"
  );

  const arTrackHtml = applyStaticI18n(
    patchHtml(trackHtmlSource, {
      siteUrl,
      canonicalUrl: siteUrl ? `${siteUrl}/ar/track/` : "",
      alternateEnUrl: siteUrl ? `${siteUrl}/track/` : "",
      alternateArUrl: siteUrl ? `${siteUrl}/ar/track/` : "",
      alternateDefaultUrl: siteUrl ? `${siteUrl}/track/` : "",
      cssFile,
      contentFile,
      appFile,
      runtimeFile,
      lottieFile,
      leafletCssFile,
      leafletFile,
      assetBasePath,
    }).replace(
      /<html lang="en" dir="ltr"/,
      '<html lang="ar" dir="rtl"'
    ),
    landingI18n,
    "ar"
  );

  writeFile(path.join(outDir, "index.html"), enHtml);
  writeFile(path.join(outDir, "ar", "index.html"), arHtml);
  writeFile(path.join(outDir, "track", "index.html"), enTrackHtml);
  writeFile(path.join(outDir, "ar", "track", "index.html"), arTrackHtml);

  const aliasSegments = [
    ["drivers"],
    ["drivers", "apply"],
    ["drivers", "status"],
  ];
  aliasSegments.forEach((segments) => writeLandingAliases(outDir, enHtml, segments));
  aliasSegments.forEach((segments) => writeLandingAliases(outDir, arHtml, ["ar", ...segments]));

  writeFile(
    path.join(outDir, "_headers"),
    buildHeaders({
      contactEndpoint,
      tenantSignupEndpoint,
      driverSignupEndpoint,
      driverApplicationStatusEndpoint,
      driverApplicationDocumentsEndpoint,
      trackingEndpoint,
      clientsEndpoint,
      cspReportUri,
      mapTileUrl,
      mapTileUrl,
    })
  );
  writeFile(path.join(outDir, "_redirects"), buildRedirects());
  writeFile(path.join(outDir, "robots.txt"), buildRobotsTxt(siteUrl));
  if (siteUrl) {
    writeFile(path.join(outDir, "sitemap.xml"), buildSitemapXml(siteUrl));
  }

  // 404 page (branded, matches landing design).
  const notFoundHtml = build404Page({
    cssFile,
    assetBasePath,
    siteUrl,
  });
  writeFile(path.join(outDir, "404.html"), notFoundHtml);

  // Web app manifest.
  const manifest = {
    name: "MasarX",
    short_name: "MasarX",
    description: "Last-mile delivery operations platform",
    start_url: "/",
    display: "browser",
    theme_color: "#070c16",
    background_color: "#070c16",
    icons: [
      { src: joinUrlPath(assetBasePath, "brand/apple-touch-icon.png"), sizes: "180x180", type: "image/png" },
    ],
  };
  writeFile(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");

  console.log(`[landing] Built -> ${path.relative(repoRoot, outDir)}`);
  if (esbuild) {
    console.log("[landing] Assets minified with esbuild.");
  } else {
    console.log("[landing] Note: esbuild not found; assets are not minified. Run: npm install -D esbuild");
  }
  if (!siteUrl) {
    console.log("[landing] Note: LANDING_SITE_URL is unset; skipping sitemap.xml canonical URLs.");
  }

  // Build output size report.
  const sizeReport = [
    { label: "app.css", raw: cssSource.length, out: cssOut.length, file: cssFile },
    { label: "app.js", raw: appSource.length, out: appOut.length, file: appFile },
    { label: "content.js", raw: contentSource.length, out: contentOut.length, file: contentFile },
    { label: "runtime.js", raw: runtimeSource.length, out: runtimeSource.length, file: runtimeFile },
  ];
  if (lottieSrc) {
    sizeReport.push({ label: "lottie.js", raw: lottieSrc.length, out: lottieSrc.length, file: lottieFile });
  }
  if (leafletCssSrc) {
    sizeReport.push({ label: "leaflet.css", raw: leafletCssSrc.length, out: leafletCssSrc.length, file: leafletCssFile });
  }
  if (leafletJsSrc) {
    sizeReport.push({ label: "leaflet.js", raw: leafletJsSrc.length, out: leafletJsSrc.length, file: leafletFile });
  }

  let totalRaw = 0;
  let totalOut = 0;
  console.log("[landing] Asset size report:");
  sizeReport.forEach(({ label, raw, out }) => {
    const saved = raw > 0 ? Math.round((1 - out / raw) * 100) : 0;
    const rawKb = (raw / 1024).toFixed(1);
    const outKb = (out / 1024).toFixed(1);
    console.log(`  ${label}: ${rawKb} KB -> ${outKb} KB (${saved}% saved)`);
    totalRaw += raw;
    totalOut += out;
  });

  const totalSaved = totalRaw > 0 ? Math.round((1 - totalOut / totalRaw) * 100) : 0;
  console.log(`  Total: ${(totalRaw / 1024).toFixed(1)} KB -> ${(totalOut / 1024).toFixed(1)} KB (${totalSaved}% saved)`);
}

main();
