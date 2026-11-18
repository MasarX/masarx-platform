const path = require("path");
const { PHASE_DEVELOPMENT_SERVER, PHASE_PRODUCTION_BUILD } = require("next/constants");
const { availableParallelism } = require("node:os");
const { loadPublicEnv } = require("../../scripts/utils/load-public-env");
const { buildStaticSecurityHeaders, buildSecurityHeaders } = require("../shared/security-headers");
const { isFieldopsDevHosting } = require("../../scripts/ops/vercel/fieldops-dev-hosting");
const { resolveBundleAnalyzer } = require("../shared/next-bundle-analyzer");
const { resolveAllowedDevOrigins } = require("../shared/next-dev-origins");

loadPublicEnv({ appDir: __dirname, initialEnv: require("@next/env").initialEnv });

const withBundleAnalyzer = resolveBundleAnalyzer();
const createNextIntlPlugin = require("next-intl/plugin");
const withNextIntl = createNextIntlPlugin("./i18n/request.ts");
const monorepoRoot = path.resolve(__dirname, "../..");

const publicEnv = {
  NEXT_PUBLIC_APP_NAME: process.env.NEXT_PUBLIC_APP_NAME,
  NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
  NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  NEXT_PUBLIC_AUTH_METHODS: process.env.NEXT_PUBLIC_AUTH_METHODS,
  NEXT_PUBLIC_LOCALE: process.env.NEXT_PUBLIC_LOCALE
};
const securityHeaders = buildStaticSecurityHeaders();
const fieldopsDevHosting = isFieldopsDevHosting({ env: process.env, workspace: "@masarx/console" });
const fieldopsHeaders = fieldopsDevHosting ? buildSecurityHeaders({
  supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL,
  nodeEnv: "production",
}).map((header) => header.key === "Permissions-Policy"
  ? { ...header, value: "camera=(self), microphone=(), geolocation=(self)" }
  : header) : [];

/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: { cpus: availableParallelism() },
  outputFileTracingRoot: monorepoRoot,
  serverExternalPackages: ["exceljs", "jszip"],
  allowedDevOrigins: resolveAllowedDevOrigins(),
  turbopack: {
    root: monorepoRoot
  },
  reactStrictMode: true,
  transpilePackages: [
    "@masarx/ui",
    "@masarx/api",
    "@masarx/auth",
    "@masarx/config"
  ],
  env: publicEnv,
  ...(fieldopsDevHosting ? {
    // Preserve Next's canonical redirects except the directory used by the PWA scope.
    skipTrailingSlashRedirect: true,
    async redirects() {
      return [
        // Next permits an optional final slash; anchor the parameter to avoid redirecting /fieldops/ to itself.
        { source: "/:path(fieldops$)", destination: "/fieldops/", permanent: false },
        { source: "/:path((?!fieldops/$).+)/", destination: "/:path", permanent: true },
      ];
    },
    async rewrites() {
      return { beforeFiles: [{ source: "/fieldops/", destination: "/fieldops/index.html" }] };
    },
  } : {}),
  async headers() {
    return [
      {
        source: "/:path*",
        headers: securityHeaders
      },
      ...(fieldopsDevHosting ? [{
        source: "/fieldops/:path*",
        headers: [...fieldopsHeaders, { key: "Cache-Control", value: "public, max-age=0, must-revalidate" }],
      }] : [])
    ];
  }
};

const wrappedConfig = withBundleAnalyzer(withNextIntl(nextConfig));
module.exports = async (phase, context) => {
  if (phase === PHASE_DEVELOPMENT_SERVER || phase === PHASE_PRODUCTION_BUILD) {
    require("../../scripts/frontend/prepare-map-worker").prepareMapWorker(__dirname);
  }
  return typeof wrappedConfig === "function" ? wrappedConfig(phase, context) : wrappedConfig;
};
