function resolveBundleAnalyzer() {
  const enabled = process.env.ANALYZE === "true";
  if (!enabled) return (config) => config;

  // Only require when enabled so production builds are not coupled to an
  // optional dev-only dependency.
  // eslint-disable-next-line global-require
  return require("@next/bundle-analyzer")({ enabled });
}

module.exports = { resolveBundleAnalyzer };

