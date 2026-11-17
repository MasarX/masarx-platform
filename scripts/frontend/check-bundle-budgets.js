const fs = require("fs");
const path = require("path");

const repoRoot = path.resolve(__dirname, "..", "..");
const budgetsPath = path.join(
  repoRoot,
  "config",
  "tooling",
  "bundle-budgets.json"
);

const args = process.argv.slice(2);
const isWrite = args.includes("--write");
const appArgIndex = args.findIndex((arg) => arg === "--app");
const appArg =
  appArgIndex >= 0 ? args[appArgIndex + 1] : args.find((arg) => arg.startsWith("--app="));
const appFilter = appArg?.startsWith("--app=") ? appArg.split("=")[1] : appArg;

const defaultApps = {
  console: { root: "apps/console" },
  portal: { root: "apps/portal" }
};

const loadBudgets = () => {
  if (!fs.existsSync(budgetsPath)) {
    return { generatedAt: null, apps: { ...defaultApps } };
  }
  const raw = fs.readFileSync(budgetsPath, "utf8");
  const parsed = JSON.parse(raw);
  return {
    generatedAt: parsed.generatedAt ?? null,
    apps: { ...defaultApps, ...(parsed.apps ?? {}) }
  };
};

const formatBytes = (bytes) => {
  if (!Number.isFinite(bytes)) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  return `${(kb / 1024).toFixed(2)} MB`;
};

const getManifest = (appRoot) => {
  const appManifestPath = path.join(
    repoRoot,
    appRoot,
    ".next",
    "app-build-manifest.json"
  );
  if (fs.existsSync(appManifestPath)) {
    return JSON.parse(fs.readFileSync(appManifestPath, "utf8"));
  }
  const manifestPath = path.join(repoRoot, appRoot, ".next", "build-manifest.json");
  if (!fs.existsSync(manifestPath)) {
    throw new Error(
      `Missing build manifest: ${manifestPath}. Run build or analyze first.`
    );
  }
  return JSON.parse(fs.readFileSync(manifestPath, "utf8"));
};

const getRouteMap = (appRoot) => {
  const routeMapPath = path.join(
    repoRoot,
    appRoot,
    ".next",
    "app-path-routes-manifest.json"
  );
  if (!fs.existsSync(routeMapPath)) return null;
  return JSON.parse(fs.readFileSync(routeMapPath, "utf8"));
};

const getRouteSizes = (appRoot, manifest, routeMap) => {
  const pages = manifest.pages ?? {};
  const sharedFiles = new Set([
    ...(pages["/layout"] ?? []),
    ...(pages["/_app"] ?? []),
    ...(pages["/_error"] ?? [])
  ]);
  const routeSizes = {};
  const missingFiles = new Set();

  Object.entries(pages).forEach(([route, files]) => {
    if (routeMap && !routeMap[route]) return;
    const publicRoute = routeMap ? routeMap[route] : route;
    if (publicRoute.startsWith("/_")) return;
    const assetList = Array.isArray(files) ? files : [];
    const assets = new Set([...sharedFiles, ...assetList]);
    let total = 0;
    assets.forEach((file) => {
      if (!file.endsWith(".js") && !file.endsWith(".css")) return;
      const filePath = path.join(repoRoot, appRoot, ".next", file);
      if (!fs.existsSync(filePath)) {
        missingFiles.add(filePath);
        return;
      }
      total += fs.statSync(filePath).size;
    });
    routeSizes[publicRoute] = total;
  });

  return { routeSizes, missingFiles };
};

const updateBudgets = (budgets) => {
  const next = { generatedAt: new Date().toISOString(), apps: {} };
  Object.entries(budgets.apps).forEach(([appName, appConfig]) => {
    const manifest = getManifest(appConfig.root);
    const routeMap = getRouteMap(appConfig.root);
    const { routeSizes } = getRouteSizes(appConfig.root, manifest, routeMap);
    const routes = Object.entries(routeSizes)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([route, size]) => ({
        route,
        maxBytes: Math.ceil(size * 1.1),
        currentBytes: size
      }));
    const maxRouteSize = routes.reduce(
      (max, route) => Math.max(max, route.maxBytes),
      0
    );
    next.apps[appName] = {
      root: appConfig.root,
      defaultMaxBytes: Math.ceil(maxRouteSize * 1.1),
      routes
    };
  });
  fs.mkdirSync(path.dirname(budgetsPath), { recursive: true });
  fs.writeFileSync(budgetsPath, JSON.stringify(next, null, 2));
  return next;
};

const checkBudgets = (budgets) => {
  let hasFailure = false;
  const failures = [];

  Object.entries(budgets.apps).forEach(([appName, appConfig]) => {
    if (appFilter && appName !== appFilter) return;
    const manifest = getManifest(appConfig.root);
    const routeMap = getRouteMap(appConfig.root);
    const { routeSizes, missingFiles } = getRouteSizes(
      appConfig.root,
      manifest,
      routeMap
    );

    if (missingFiles.size > 0) {
      missingFiles.forEach((file) => {
        failures.push(`[${appName}] missing asset ${file}`);
      });
      hasFailure = true;
    }

    const routes = Array.isArray(appConfig.routes) ? appConfig.routes : [];
    const defaultMax = appConfig.defaultMaxBytes ?? 0;

    Object.entries(routeSizes).forEach(([route, size]) => {
      const entry = routes.find((item) => item.route === route);
      const limit = entry?.maxBytes ?? defaultMax;
      const limitLabel = entry?.maxBytes ? "route budget" : "default budget";
      if (!limit) {
        failures.push(`[${appName}] no budget set for ${route}`);
        hasFailure = true;
        return;
      }
      if (size > limit) {
        failures.push(
          `[${appName}] ${route} is ${formatBytes(size)} (limit ${formatBytes(
            limit
          )}, ${limitLabel})`
        );
        hasFailure = true;
      } else {
        console.log(
          `[${appName}] ${route} OK: ${formatBytes(size)} <= ${formatBytes(limit)}`
        );
      }
    });
  });

  if (failures.length > 0) {
    console.error("\nBundle budget failures:");
    failures.forEach((failure) => console.error(`- ${failure}`));
  }

  if (hasFailure) {
    process.exitCode = 1;
  }
};

try {
  const budgets = loadBudgets();

  if (isWrite) {
    const updated = updateBudgets(budgets);
    console.log(`Bundle budgets written to ${budgetsPath}`);
    Object.entries(updated.apps).forEach(([appName, appConfig]) => {
      console.log(
        `[${appName}] default budget ${formatBytes(appConfig.defaultMaxBytes)}`
      );
    });
  } else {
    checkBudgets(budgets);
  }
} catch (error) {
  const message =
    error && typeof error === "object" && "message" in error
      ? String(error.message)
      : String(error);
  console.error(`Bundle budget check failed: ${message}`);
  process.exitCode = 1;
}
