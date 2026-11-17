const path = require("path");
const { loadPublicEnv } = require("../../scripts/utils/load-public-env");
const { buildStaticSecurityHeaders } = require("../shared/security-headers");
const { resolveBundleAnalyzer } = require("../shared/next-bundle-analyzer");
const { applyReactSingletonAlias } = require("../shared/next-react-singleton");
const { resolveAllowedDevOrigins } = require("../shared/next-dev-origins");

loadPublicEnv({ appDir: __dirname });

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
  outputFileTracingRoot: monorepoRoot,
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
  webpack(config, options) {
    return applyReactSingletonAlias(config, {
      appDir: __dirname,
      isServer: options.isServer
    });
  },
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

module.exports = withBundleAnalyzer(withNextIntl(nextConfig));
