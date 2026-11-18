/**
 * Bundle Report Generator
 *
 * Runs `next build` for the console app, parses the build output for page sizes,
 * and writes a JSON report to docs/ops/evidence/bundle-report.json.
 * Flags any page exceeding a configurable gzip threshold (default: 500 KB).
 *
 * Usage:
 *   node scripts/qa/bundle-report.js [--threshold <bytes>] [--app <console|portal>]
 *
 * Options:
 *   --threshold  Maximum gzip size in bytes before a page is flagged (default: 512000)
 *   --app        Which app to analyze (default: console)
 *   --out        Output path for the JSON report (default: docs/ops/evidence/bundle-report.json)
 */

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const repoRoot = path.resolve(__dirname, "..", "..");

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);

function getArg(name, fallback) {
  const idx = args.findIndex((a) => a === `--${name}`);
  if (idx >= 0 && idx + 1 < args.length) return args[idx + 1];
  const eq = args.find((a) => a.startsWith(`--${name}=`));
  if (eq) return eq.split("=").slice(1).join("=");
  return fallback;
}

const appName = getArg("app", "console");
const thresholdBytes = Number(getArg("threshold", "512000"));
const outPath = path.resolve(
  repoRoot,
  getArg("out", "docs/ops/evidence/bundle-report.json")
);

const appRoot = path.join(repoRoot, "apps", appName);

if (!fs.existsSync(appRoot)) {
  console.error(`App directory not found: ${appRoot}`);
  process.exitCode = 1;
  process.exit();
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  return `${(kb / 1024).toFixed(2)} MB`;
}

// ---------------------------------------------------------------------------
// Build manifest parsing (reuses the same approach as check-bundle-budgets.js)
// ---------------------------------------------------------------------------

function loadManifest() {
  const appManifestPath = path.join(appRoot, ".next", "app-build-manifest.json");
  if (fs.existsSync(appManifestPath)) {
    return JSON.parse(fs.readFileSync(appManifestPath, "utf8"));
  }
  const buildManifestPath = path.join(appRoot, ".next", "build-manifest.json");
  if (fs.existsSync(buildManifestPath)) {
    return JSON.parse(fs.readFileSync(buildManifestPath, "utf8"));
  }
  return null;
}

function loadRouteMap() {
  const routeMapPath = path.join(appRoot, ".next", "app-path-routes-manifest.json");
  if (!fs.existsSync(routeMapPath)) return null;
  return JSON.parse(fs.readFileSync(routeMapPath, "utf8"));
}

function collectRouteSizes(manifest, routeMap) {
  const pages = manifest.pages ?? {};
  const sharedFiles = new Set([
    ...(pages["/layout"] ?? []),
    ...(pages["/_app"] ?? []),
    ...(pages["/_error"] ?? []),
  ]);

  const routes = [];

  for (const [route, files] of Object.entries(pages)) {
    if (routeMap && !routeMap[route]) continue;
    const publicRoute = routeMap ? routeMap[route] : route;
    if (publicRoute.startsWith("/_")) continue;

    const assets = new Set([...sharedFiles, ...(Array.isArray(files) ? files : [])]);
    let totalBytes = 0;
    let fileCount = 0;

    for (const file of assets) {
      if (!file.endsWith(".js") && !file.endsWith(".css")) continue;
      const filePath = path.join(appRoot, ".next", file);
      if (!fs.existsSync(filePath)) continue;
      totalBytes += fs.statSync(filePath).size;
      fileCount += 1;
    }

    routes.push({
      route: publicRoute,
      sizeBytes: totalBytes,
      sizeFormatted: formatBytes(totalBytes),
      fileCount,
      overThreshold: totalBytes > thresholdBytes,
    });
  }

  routes.sort((a, b) => b.sizeBytes - a.sizeBytes);
  return routes;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  console.log(`Building ${appName} app...`);

  // Check if a recent build exists; if not, run the build
  const manifest = loadManifest();
  if (!manifest) {
    console.log(`No existing build found. Running next build for ${appName}...`);
    try {
      execSync(`npm run build --prefix "${appRoot}"`, {
        cwd: repoRoot,
        stdio: "inherit",
        env: { ...process.env, NODE_ENV: "production" },
      });
    } catch {
      console.error("Build failed. Cannot generate bundle report.");
      process.exitCode = 1;
      return;
    }
  } else {
    console.log("Using existing build output.");
  }

  const finalManifest = loadManifest();
  if (!finalManifest) {
    console.error("Build manifest not found after build.");
    process.exitCode = 1;
    return;
  }

  const routeMap = loadRouteMap();
  const routes = collectRouteSizes(finalManifest, routeMap);
  const flagged = routes.filter((r) => r.overThreshold);

  const report = {
    generatedAt: new Date().toISOString(),
    app: appName,
    thresholdBytes,
    thresholdFormatted: formatBytes(thresholdBytes),
    totalRoutes: routes.length,
    flaggedRoutes: flagged.length,
    routes,
  };

  // Write report
  const outDir = path.dirname(outPath);
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
  console.log(`\nBundle report written to ${outPath}`);

  // Summary
  console.log(`\nSummary (${appName}):`);
  console.log(`  Total routes:   ${routes.length}`);
  console.log(`  Threshold:      ${formatBytes(thresholdBytes)}`);
  console.log(`  Flagged routes: ${flagged.length}`);

  if (flagged.length > 0) {
    console.log("\nFlagged routes (over threshold):");
    for (const r of flagged) {
      console.log(`  ${r.route}: ${r.sizeFormatted}`);
    }
    process.exitCode = 1;
  } else {
    console.log("\nAll routes within budget.");
  }
}

main();
