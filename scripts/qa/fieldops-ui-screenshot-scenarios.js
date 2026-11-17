const path = require("path");

const BASE_QUERY = Object.freeze({
  capture: "true",
  role: "driver",
  theme: "light",
});

const SUPPORTED_PLATFORMS = Object.freeze(["android", "ios"]);

function normalizePlatform(value) {
  const platform = String(value || "")
    .trim()
    .toLowerCase();
  return SUPPORTED_PLATFORMS.includes(platform) ? platform : null;
}

function withBaseQuery(platform, overrides) {
  const resolvedPlatform = normalizePlatform(platform) || "android";
  return Object.freeze({ ...BASE_QUERY, platform: resolvedPlatform, ...(overrides || {}) });
}

const VERSION_C_SCENARIO_VARIANTS = Object.freeze([
  Object.freeze({ key: "home-light", query: Object.freeze({ view: "tasks" }) }),
  Object.freeze({ key: "home-dark", query: Object.freeze({ theme: "dark", view: "tasks" }) }),
  Object.freeze({ key: "drawer-open", query: Object.freeze({ drawer: "open", view: "tasks" }) }),
  Object.freeze({ key: "route-overview", query: Object.freeze({ view: "route", routeView: "orders_map" }) }),
  Object.freeze({ key: "scan", query: Object.freeze({ view: "scan", scanInput: "scanner" }) }),
  Object.freeze({ key: "more-operations", query: Object.freeze({ view: "more" }) }),
  Object.freeze({ key: "more", query: Object.freeze({ view: "more", diagnostics: "true" }) }),
  Object.freeze({ key: "task-detail", query: Object.freeze({ view: "task_detail", taskId: "task_1" }) }),
  Object.freeze({
    key: "task-detail-collapsed",
    query: Object.freeze({ view: "task_detail", taskId: "task_1", details: "collapsed" }),
  }),
]);

function createFieldopsScenarioSet(platform) {
  const resolvedPlatform = normalizePlatform(platform);
  if (!resolvedPlatform) {
    throw new Error(`Unsupported platform for FieldOps screenshot scenarios: ${platform}`);
  }
  return Object.freeze(
    VERSION_C_SCENARIO_VARIANTS.map((variant) =>
      Object.freeze({
        platform: resolvedPlatform,
        name: `C-${resolvedPlatform}-${variant.key}`,
        query: withBaseQuery(resolvedPlatform, variant.query),
      })
    )
  );
}

const DEFAULT_FIELDOPS_UI_SCENARIOS = Object.freeze(
  SUPPORTED_PLATFORMS.flatMap((platform) => createFieldopsScenarioSet(platform))
);

function buildSelftestQuery(platform) {
  return Object.freeze(
    withBaseQuery(platform, {
      selftest: "true",
      view: "tasks",
    })
  );
}

const DEFAULT_SELFTEST_QUERY = buildSelftestQuery("android");

const DEFAULT_CAPTURE_PLATFORMS = Object.freeze([...SUPPORTED_PLATFORMS]);

function parsePlatformList(value) {
  if (Array.isArray(value)) {
    const resolved = value.map((item) => normalizePlatform(item)).filter(Boolean);
    return Object.freeze(Array.from(new Set(resolved)));
  }
  const input = String(value || "")
    .split(",")
    .map((item) => normalizePlatform(item))
    .filter(Boolean);
  return Object.freeze(Array.from(new Set(input)));
}

const DEFAULT_SELFTEST_QUERY_IOS = Object.freeze(
  withBaseQuery("ios", {
    selftest: "true",
    view: "tasks",
  })
);

function formatDateYmd(date = new Date()) {
  const d = date instanceof Date ? date : new Date(date);
  const year = d.getUTCFullYear();
  const month = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function defaultOutputDir(date = new Date()) {
  return path.join(
    "docs",
    "ops",
    "evidence",
    formatDateYmd(date),
    "mobile-fieldops",
    "ui-screenshots-version-c",
  );
}

function buildScenarioUrl(baseUrl, query) {
  const root = String(baseUrl || "").replace(/\/+$/g, "");
  const params = new URLSearchParams(query || {});
  return `${root}/version-c.html?${params.toString()}`;
}

module.exports = {
  BASE_QUERY,
  DEFAULT_CAPTURE_PLATFORMS,
  DEFAULT_FIELDOPS_UI_SCENARIOS,
  DEFAULT_SELFTEST_QUERY,
  DEFAULT_SELFTEST_QUERY_IOS,
  SUPPORTED_PLATFORMS,
  VERSION_C_SCENARIO_VARIANTS,
  buildSelftestQuery,
  buildScenarioUrl,
  createFieldopsScenarioSet,
  defaultOutputDir,
  formatDateYmd,
  normalizePlatform,
  parsePlatformList,
};
