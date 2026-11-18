const fs = require("fs");
const path = require("path");

// Measure unique, uncompressed JS/CSS files referenced by each public page's
// client graph and shared runtime. Deferred references may be included; this is
// not a measurement of compressed transfer size or actual network first load.
// Modern App Router graphs exclude nomodule-only legacy browser polyfills.
const measurement = "uncompressed-route-referenced-js-css";

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

const normalizeAsset = (file) => {
  if (typeof file !== "string") return null;
  const normalized = file.replace(/^\/?_next\//, "");
  return /\.(js|css)$/.test(normalized) ? normalized : null;
};

const getManifest = (appRoot) => {
  const nextRoot = path.join(repoRoot, appRoot, ".next");
  const buildIdPath = path.join(nextRoot, "BUILD_ID");
  if (!fs.existsSync(buildIdPath) || !fs.readFileSync(buildIdPath, "utf8").trim()) {
    throw new Error(`Missing production BUILD_ID: ${buildIdPath}. Run build first.`);
  }
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
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const routeMap = getRouteMap(appRoot);
  const pageRoutes = Object.entries(routeMap ?? {}).filter(
    ([route, publicRoute]) => route.endsWith("/page") &&
      typeof publicRoute === "string" && !publicRoute.startsWith("/_")
  );
  if (pageRoutes.length === 0) return manifest;

  // Next 16 no longer emits app-build-manifest.json. Its top-level build
  // manifest can have no page entries; use each App Router client graph instead.
  const pages = {};
  pageRoutes.forEach(([route]) => {
    const clientManifestPath = path.join(
      nextRoot, "server", "app", `${route.slice(1)}_client-reference-manifest.js`
    );
    if (!fs.existsSync(clientManifestPath)) {
      throw new Error(`Missing client reference manifest: ${clientManifestPath}`);
    }
    const source = fs.readFileSync(clientManifestPath, "utf8");
    // Read the generated JSON assignment without executing a build artifact.
    const assignment = source.match(
      /(?:globalThis|self)\.__RSC_MANIFEST\s*\[\s*("(?:\\.|[^"\\])*")\s*\]\s*=\s*([\s\S]*?);?\s*$/
    );
    if (!assignment || JSON.parse(assignment[1]) !== route) {
      throw new Error(`Invalid client reference manifest: ${clientManifestPath}`);
    }
    const clientManifest = JSON.parse(assignment[2]);
    const references = [];
    Object.values(clientManifest.entryJSFiles ?? {}).forEach((files) => {
      if (!Array.isArray(files) || files.some((file) => typeof file !== "string")) {
        throw new Error(`Invalid JS entries: ${clientManifestPath}`);
      }
      references.push(...files);
    });
    Object.values(clientManifest.entryCSSFiles ?? {}).forEach((files) => {
      if (!Array.isArray(files)) throw new Error(`Invalid CSS entries: ${clientManifestPath}`);
      files.forEach((file) => {
        const cssPath = typeof file === "string" ? file : file?.path;
        if (typeof cssPath !== "string") throw new Error(`Invalid CSS asset: ${clientManifestPath}`);
        references.push(cssPath);
      });
    });
    Object.values(clientManifest.clientModules ?? {}).forEach((module) => {
      if (!Array.isArray(module.chunks)) throw new Error(`Invalid client chunks: ${clientManifestPath}`);
      // Webpack graphs can interleave chunk IDs with filenames.
      references.push(...module.chunks);
    });
    const routeReferences = references.map(normalizeAsset).filter(Boolean);
    if (routeReferences.length === 0) {
      throw new Error(`No client JS/CSS asset evidence for ${route}: ${clientManifestPath}`);
    }
    const runtimeFiles = manifest.rootMainFilesTree?.[route] || manifest.rootMainFiles || [];
    if (!Array.isArray(runtimeFiles) || runtimeFiles.length === 0) {
      throw new Error(`Missing shared runtime asset evidence for ${route}: ${manifestPath}`);
    }
    const runtimeAssets = runtimeFiles.map(normalizeAsset).filter(Boolean);
    if (runtimeAssets.length === 0) {
      throw new Error(`Missing shared runtime asset evidence for ${route}: ${manifestPath}`);
    }
    pages[route] = [...runtimeAssets, ...routeReferences];
  });
  return { ...manifest, pages };
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
  const routeAssets = new Map();
  const missingFiles = new Set();

  Object.entries(pages).forEach(([route, files]) => {
    if (routeMap && !routeMap[route]) return;
    const publicRoute = routeMap ? routeMap[route] : route;
    if (publicRoute.startsWith("/_")) return;
    if (!Array.isArray(files)) throw new Error(`Invalid asset list for ${route}`);
    const assets = routeAssets.get(publicRoute) ?? new Set();
    [...sharedFiles, ...files].forEach((file) => {
      const asset = normalizeAsset(file);
      if (asset) assets.add(asset);
    });
    routeAssets.set(publicRoute, assets);
  });

  if (routeAssets.size === 0) {
    throw new Error(`No public page route evidence for ${appRoot}. Run a production build first.`);
  }
  const routeSizes = {};
  routeAssets.forEach((assets, publicRoute) => {
    if (assets.size === 0) throw new Error(`No JS/CSS asset evidence for ${publicRoute}`);
    let total = 0;
    assets.forEach((file) => {
      const nextRoot = path.resolve(repoRoot, appRoot, ".next");
      const filePath = path.resolve(nextRoot, file);
      if (!filePath.startsWith(`${nextRoot}${path.sep}`)) {
        throw new Error(`Asset path escapes build directory: ${file}`);
      }
      if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
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
  const next = {
    generatedAt: new Date().toISOString(),
    measurement,
    description: "Deduplicated raw bytes of route-referenced JS/CSS and shared runtime, including deferred references; not compressed transfer bytes or actual first-load requests. Modern App Router graphs exclude nomodule-only polyfills.",
    apps: { ...budgets.apps },
  };
  Object.entries(budgets.apps).forEach(([appName, appConfig]) => {
    if (appFilter && appName !== appFilter) return;
    const manifest = getManifest(appConfig.root);
    const routeMap = getRouteMap(appConfig.root);
    const { routeSizes, missingFiles } = getRouteSizes(appConfig.root, manifest, routeMap);
    if (missingFiles.size > 0) {
      throw new Error(`[${appName}] missing asset ${Array.from(missingFiles).join(", ")}`);
    }
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
  if ((appArgIndex >= 0 && !appFilter) ||
      (appFilter && !Object.prototype.hasOwnProperty.call(budgets.apps, appFilter))) {
    throw new Error(`Unknown or missing app: ${appFilter ?? ""}`);
  }

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
