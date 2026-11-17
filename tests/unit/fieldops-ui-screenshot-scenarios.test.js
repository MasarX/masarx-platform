const path = require("path");
const {
  DEFAULT_FIELDOPS_UI_SCENARIOS,
  DEFAULT_CAPTURE_PLATFORMS,
  DEFAULT_SELFTEST_QUERY,
  DEFAULT_SELFTEST_QUERY_IOS,
  BASE_QUERY,
  SUPPORTED_PLATFORMS,
  buildSelftestQuery,
  buildScenarioUrl,
  createFieldopsScenarioSet,
  defaultOutputDir,
  formatDateYmd,
  parsePlatformList,
} = require("../../scripts/qa/fieldops-ui-screenshot-scenarios");

describe("fieldops ui screenshot scenarios", () => {
  test("supports deterministic cross-platform capture set", () => {
    expect(SUPPORTED_PLATFORMS).toEqual(["android", "ios"]);
    expect(DEFAULT_CAPTURE_PLATFORMS).toEqual(["android", "ios"]);
  });

  test("defines deterministic version-c scenario set per platform", () => {
    const androidNames = createFieldopsScenarioSet("android").map((scenario) => scenario.name);
    const iosNames = createFieldopsScenarioSet("ios").map((scenario) => scenario.name);
    expect(androidNames).toEqual([
      "C-android-home-light",
      "C-android-home-dark",
      "C-android-drawer-open",
      "C-android-route-overview",
      "C-android-scan",
      "C-android-more-operations",
      "C-android-more",
      "C-android-task-detail",
      "C-android-task-detail-collapsed",
    ]);
    expect(iosNames).toEqual([
      "C-ios-home-light",
      "C-ios-home-dark",
      "C-ios-drawer-open",
      "C-ios-route-overview",
      "C-ios-scan",
      "C-ios-more-operations",
      "C-ios-more",
      "C-ios-task-detail",
      "C-ios-task-detail-collapsed",
    ]);
  });

  test("default scenario set includes both android and ios variants", () => {
    const names = DEFAULT_FIELDOPS_UI_SCENARIOS.map((scenario) => scenario.name).sort();
    expect(names).toHaveLength(18);
    expect(names).toEqual([
      "C-android-drawer-open",
      "C-android-home-dark",
      "C-android-home-light",
      "C-android-more",
      "C-android-more-operations",
      "C-android-route-overview",
      "C-android-scan",
      "C-android-task-detail-collapsed",
      "C-android-task-detail",
      "C-ios-drawer-open",
      "C-ios-home-dark",
      "C-ios-home-light",
      "C-ios-more",
      "C-ios-more-operations",
      "C-ios-route-overview",
      "C-ios-scan",
      "C-ios-task-detail-collapsed",
      "C-ios-task-detail",
    ].sort());
  });

  test("applies capture defaults to every scenario", () => {
    for (const scenario of DEFAULT_FIELDOPS_UI_SCENARIOS) {
      expect(scenario.query.capture).toBe(BASE_QUERY.capture);
      expect(scenario.query.role).toBe(BASE_QUERY.role);
      expect(scenario.query.platform).toBe(scenario.platform);
    }
  });

  test("builds version-c URLs with encoded params", () => {
    const url = buildScenarioUrl("http://127.0.0.1:4179/", {
      capture: "true",
      view: "task_detail",
      taskId: "task_1",
    });
    expect(url).toBe(
      "http://127.0.0.1:4179/version-c.html?capture=true&view=task_detail&taskId=task_1",
    );
  });

  test("computes evidence output directory by UTC day", () => {
    const output = defaultOutputDir(new Date("2026-02-06T23:59:59.000Z"));
    expect(output).toBe(
      path.join(
        "docs",
        "ops",
        "evidence",
        "2026-02-06",
        "mobile-fieldops",
        "ui-screenshots-version-c",
      ),
    );
    expect(formatDateYmd(new Date("2026-02-06T00:00:00.000Z"))).toBe("2026-02-06");
  });

  test("selftest query keeps capture mode enabled", () => {
    expect(DEFAULT_SELFTEST_QUERY.capture).toBe("true");
    expect(DEFAULT_SELFTEST_QUERY.platform).toBe("android");
    expect(DEFAULT_SELFTEST_QUERY_IOS.platform).toBe("ios");
    expect(DEFAULT_SELFTEST_QUERY.selftest).toBe("true");
    expect(DEFAULT_SELFTEST_QUERY.view).toBe("tasks");
    expect(buildSelftestQuery("ios")).toEqual(DEFAULT_SELFTEST_QUERY_IOS);
  });

  test("parsePlatformList normalizes and de-duplicates values", () => {
    expect(parsePlatformList("android,ios,ANDROID,invalid")).toEqual(["android", "ios"]);
    expect(parsePlatformList(["ios", "ios", "android"])).toEqual(["ios", "android"]);
  });
});
