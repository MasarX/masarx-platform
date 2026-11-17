/* eslint-disable no-console */
const fs = require("fs");
const path = require("path");

function isTruthy(value) {
  return /^(1|true|yes)$/i.test(String(value ?? "").trim());
}

function normalizeArg(value) {
  if (!value) return null;
  const trimmed = String(value).trim();
  if (!trimmed) return null;
  return trimmed;
}

function resolveTargets(argv) {
  const args = argv.map(normalizeArg).filter(Boolean);
  if (args.length > 0) return args;
  return ["apps/console", "apps/portal"];
}

function rmrf(targetPath) {
  try {
    fs.rmSync(targetPath, { recursive: true, force: true });
    return true;
  } catch (error) {
    if (isTruthy(process.env.E2E_FORCE_CLEAN_VERBOSE)) {
      console.warn(`[e2e] failed to remove ${targetPath}:`, error);
    }
    return false;
  }
}

function clearNextCache(target) {
  const appRoot = path.resolve(process.cwd(), target);
  const nextDir = path.join(appRoot, ".next");
  if (!fs.existsSync(nextDir)) return { target, cleared: false };
  const cleared = rmrf(nextDir);
  return { target, cleared };
}

function main() {
  const targets = resolveTargets(process.argv.slice(2));
  const results = targets.map(clearNextCache);
  const cleared = results.filter((entry) => entry.cleared).map((entry) => entry.target);

  if (cleared.length > 0) {
    console.log(`[e2e] cleared Next cache for: ${cleared.join(", ")}`);
  } else if (isTruthy(process.env.E2E_FORCE_CLEAN_VERBOSE)) {
    console.log("[e2e] no Next cache directories to clear");
  }
}

main();

