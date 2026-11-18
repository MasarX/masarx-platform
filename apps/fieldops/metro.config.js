const fs = require("fs");
const path = require("path");
const { getDefaultConfig } = require("expo/metro-config");

let getSentryExpoConfig = null;
try {
  ({ getSentryExpoConfig } = require("@sentry/react-native/metro"));
} catch {
  // Sentry is optional in local/dev contexts; Metro should still start without it.
}

// Monorepo-safe Metro config:
// - Keep React/ReactDOM pinned to FieldOps versions (RN 0.83 uses React 19.2).
// - Avoid accidentally resolving the web bundle against the Next.js workspaces (React 18),
//   which breaks rendering due to React 19 elements using `react.transitional.element`.
const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, "../..");

function resolveExistingRealPath(targetPath) {
  try {
    if (!fs.existsSync(targetPath)) {
      return null;
    }
    return fs.realpathSync.native?.(targetPath) ?? fs.realpathSync(targetPath);
  } catch {
    return null;
  }
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function pathBlockPattern(targetPath) {
  const resolvedPath = resolveExistingRealPath(targetPath) ?? path.resolve(targetPath);
  const normalizedSegments = resolvedPath.replace(/\\/g, "/").split("/");
  const separator = "[\\\\/]";
  const pattern = normalizedSegments.map(escapeRegExp).join(separator);
  return new RegExp(`^${pattern}(?:${separator}.*)?$`);
}

function resolvePackageDir(fromDir, pkgName) {
  try {
    // Resolve against explicit roots to avoid accidental dependency drift.
    const pkgJson = require.resolve(`${pkgName}/package.json`, { paths: [fromDir] });
    return path.dirname(pkgJson);
  } catch {
    return null;
  }
}

const config =
  typeof getSentryExpoConfig === "function"
    ? getSentryExpoConfig(projectRoot)
    : getDefaultConfig(projectRoot);

const workspaceRootRealPath = resolveExistingRealPath(workspaceRoot) ?? path.resolve(workspaceRoot);
const projectRootRealPath = resolveExistingRealPath(projectRoot) ?? path.resolve(projectRoot);
const workspaceAppsRootRealPath =
  resolveExistingRealPath(path.resolve(workspaceRoot, "apps")) ??
  path.resolve(workspaceRoot, "apps");
const workspacePackageRoots = ["api", "auth", "config", "mobile-core", "ui"]
  .map((packageName) => path.resolve(workspaceRoot, "packages", packageName))
  .filter((packagePath) => resolveExistingRealPath(packagePath));
const nestedWorktreeRoots = fs.readdirSync(workspaceRoot, { withFileTypes: true })
  .filter(entry => entry.isDirectory() && entry.name.startsWith("."))
  .map(entry => path.resolve(workspaceRoot, entry.name, "worktrees"));
const watchFolders = new Set([...(config.watchFolders || []), ...workspacePackageRoots]);
for (const nodeModulesPath of [
  path.resolve(projectRoot, "node_modules"),
  path.resolve(workspaceRoot, "node_modules"),
]) {
  const resolvedNodeModulesPath = resolveExistingRealPath(nodeModulesPath);
  if (resolvedNodeModulesPath) {
    watchFolders.add(resolvedNodeModulesPath);
  }
}
config.watchFolders = Array.from(watchFolders).filter((folderPath) => {
  const resolvedFolderPath = resolveExistingRealPath(folderPath) ?? path.resolve(folderPath);
  if (resolvedFolderPath === workspaceRootRealPath) return false;
  if (
    resolvedFolderPath !== projectRootRealPath &&
    resolvedFolderPath.startsWith(`${workspaceAppsRootRealPath}${path.sep}`)
  ) {
    return false;
  }
  return true;
});
config.resolver = config.resolver || {};
config.resolver.enableGlobalPackages = true;
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, "node_modules"),
  path.resolve(workspaceRoot, "node_modules"),
];
const reactDir =
  resolvePackageDir(projectRoot, "react") ??
  resolvePackageDir(workspaceRoot, "react") ??
  path.resolve(projectRoot, "node_modules", "react");
const reactDomDir =
  resolvePackageDir(projectRoot, "react-dom") ??
  resolvePackageDir(workspaceRoot, "react-dom") ??
  path.resolve(projectRoot, "node_modules", "react-dom");
const reactNativeDir =
  resolvePackageDir(projectRoot, "react-native") ??
  resolvePackageDir(workspaceRoot, "react-native") ??
  path.resolve(projectRoot, "node_modules", "react-native");
const expoDir =
  resolvePackageDir(projectRoot, "expo") ??
  path.resolve(projectRoot, "node_modules", "expo");
config.resolver.nodeModulesPaths = Array.from(
  new Set([
    ...config.resolver.nodeModulesPaths,
    path.resolve(reactNativeDir, "node_modules"),
    path.resolve(expoDir, "node_modules"),
  ])
);
const blockedRuntimeDirs = [
  path.resolve(workspaceRoot, "node_modules", "react"),
  path.resolve(workspaceRoot, "node_modules", "react-dom"),
  path.resolve(workspaceRoot, "node_modules", "react-native"),
].filter((candidatePath) => {
  const candidateRealPath = resolveExistingRealPath(candidatePath);
  if (!candidateRealPath) return false;
  return ![reactDir, reactDomDir, reactNativeDir]
    .map((runtimePath) => resolveExistingRealPath(runtimePath))
    .includes(candidateRealPath);
});
config.resolver.blockList = [
  ...(Array.isArray(config.resolver.blockList)
    ? config.resolver.blockList
    : config.resolver.blockList
      ? [config.resolver.blockList]
      : []),
  /(^|[\\/])node_modules[\\/]\.package-lock\.json$/,
  ...nestedWorktreeRoots.map(pathBlockPattern),
  ...blockedRuntimeDirs.map(pathBlockPattern),
];

// expo-sqlite uses wa-sqlite on web, which imports a `.wasm` binary.
// Ensure Metro treats `.wasm` as an asset so web bundling doesn't fail.
config.resolver.assetExts = Array.from(
  new Set([...(config.resolver.assetExts || []), "wasm"])
);

const reactNativeWebDir =
  resolvePackageDir(projectRoot, "react-native-web") ??
  resolvePackageDir(workspaceRoot, "react-native-web") ??
  path.resolve(projectRoot, "node_modules", "react-native-web");

config.resolver.extraNodeModules = {
  ...(config.resolver.extraNodeModules || {}),
  react: reactDir,
  "react-dom": reactDomDir,
  "react-native": reactNativeDir,
  "react-native-web": reactNativeWebDir,
};

function resolveFieldOpsRuntimeModule(moduleName) {
  if (
    moduleName === "react" ||
    moduleName.startsWith("react/") ||
    moduleName === "react-dom" ||
    moduleName.startsWith("react-dom/") ||
    moduleName === "react-native" ||
    moduleName.startsWith("react-native/")
  ) {
    return require.resolve(moduleName, { paths: [projectRoot] });
  }
  return null;
}

const priorResolveRequest = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => {
  const fieldOpsRuntimeFile = resolveFieldOpsRuntimeModule(moduleName);
  if (fieldOpsRuntimeFile) {
    return { type: "sourceFile", filePath: fieldOpsRuntimeFile };
  }
  if (typeof priorResolveRequest === "function") {
    return priorResolveRequest(context, moduleName, platform);
  }
  return context.resolveRequest(context, moduleName, platform);
};

// Prevent Metro from crawling upwards and resolving hoisted React 18 from the monorepo root.
config.resolver.disableHierarchicalLookup = true;

// expo-sqlite web uses wa-sqlite which requires SharedArrayBuffer support.
// Enable COOP/COEP headers for local Metro hosting to avoid "cannot create file" failures.
config.server = config.server || {};
const priorEnhanceMiddleware = config.server.enhanceMiddleware;
config.server.enhanceMiddleware = (middleware, server) => {
  const next = priorEnhanceMiddleware ? priorEnhanceMiddleware(middleware, server) : middleware;
  return (req, res, nextMiddleware) => {
    if (
      process.env.FIELDOPS_ANDROID_METRO_PLAIN_BUNDLE === "1" &&
      typeof req.url === "string" &&
      req.url.includes(".bundle") &&
      typeof req.headers.accept === "string" &&
      req.headers.accept.includes("multipart/mixed")
    ) {
      req.headers.accept = req.headers.accept
        .split(",")
        .map((value) => value.trim())
        .filter((value) => value && value !== "multipart/mixed")
        .join(",") || "*/*";
    }
    res.setHeader("Cross-Origin-Embedder-Policy", "credentialless");
    res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
    return next(req, res, nextMiddleware);
  };
};

module.exports = config;
