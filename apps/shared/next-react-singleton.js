const path = require("path");

function applyReactSingletonAlias(config, { appDir, isServer }) {
  const workspaceRoot = path.resolve(appDir, "../..");
  const resolveFromWorkspace = (request) =>
    require.resolve(request, { paths: [workspaceRoot] });

  const resolveNextCompiled = (subpath) =>
    resolveFromWorkspace(`next/dist/compiled/${subpath}`);

  config.resolve.symlinks = false;
  config.resolve.alias = {
    ...(config.resolve.alias || {}),
    "react$": resolveNextCompiled("react"),
    "react-dom$": resolveNextCompiled("react-dom"),
    "react/jsx-runtime$": resolveNextCompiled("react/jsx-runtime"),
    "react/jsx-dev-runtime$": resolveNextCompiled("react/jsx-dev-runtime"),
    "react-dom/client$": resolveNextCompiled("react-dom/client"),
    "react-dom/server$": resolveNextCompiled("react-dom/server"),
    ...(isServer ? { canvas: false } : {})
  };

  return config;
}

module.exports = { applyReactSingletonAlias };
