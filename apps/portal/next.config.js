const path = require("path");
const { PHASE_DEVELOPMENT_SERVER, PHASE_PRODUCTION_BUILD } = require("next/constants");
const { availableParallelism } = require("node:os");
const { loadPublicEnv } = require("../../scripts/utils/load-public-env");
const { buildStaticSecurityHeaders } = require("../shared/security-headers");
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
  async headers() {
    return [
      {
        source: "/:path*",
        headers: securityHeaders
      }
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
