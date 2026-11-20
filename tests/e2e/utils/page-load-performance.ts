import { expect, test, type Locator, type Page } from "@playwright/test";
import { expectSignedIn, signInWithPassword } from "./auth";
import { getConsoleBaseUrl, getPortalBaseUrl } from "./base-urls";
import { loadDemoContext } from "./demo-accounts";
import { isStrictE2EEnv } from "./env";
import { enforceDemoContext } from "./app-test-factory";
import { discoverResourcePath } from "./navigation";
import {
  assertNavigationPerformance,
  assertWebVitals,
  installWebVitalsObserver,
} from "./performance";

const LCP_MAX_MS = Number(process.env.PERF_LCP_MAX_MS || "2500");
const CLS_MAX = Number(process.env.PERF_CLS_MAX || "0.1");
const RESOURCE_LIST_LIMIT = Number(process.env.PERF_RESOURCE_LIST_LIMIT || "10");

const demoContext = loadDemoContext();
const strict = isStrictE2EEnv();
const STRICT_PAGE_LOAD_MAX_MS = Number(process.env.PERF_PAGE_LOAD_MAX_MS || "3000");
const LOCAL_PAGE_LOAD_MAX_MS = Number(
  process.env.PERF_LOCAL_PAGE_LOAD_MAX_MS || process.env.PERF_PAGE_LOAD_MAX_MS || "6000",
);
const PAGE_LOAD_MAX_MS =
  strict || process.env.CI === "true" ? STRICT_PAGE_LOAD_MAX_MS : LOCAL_PAGE_LOAD_MAX_MS;
const warmRouteEnv = process.env.PERF_WARM_ROUTE_BEFORE_MEASURE;
// Measure steady-state route performance, not first-hit dev/serverless bootstrap.
const WARM_ROUTE_BEFORE_MEASURE =
  typeof warmRouteEnv === "string"
    ? warmRouteEnv !== "false"
    : true;

type PageTarget = {
  label: string;
  href: string;
  readySelector: string;
};

type PageLoadConfig = {
  label: "console" | "portal";
  baseUrl: () => string;
  authTestId: string;
  scopeTypes: string[];
  getResourcePath: () => Promise<string>;
  targets: (baseUrl: string, resourcePath: string) => PageTarget[];
};

async function expectAnyLocatorVisible(locator: Locator) {
  await expect
    .poll(async () => {
      const count = await locator.count();
      for (let index = 0; index < count; index += 1) {
        if (await locator.nth(index).isVisible()) return true;
      }
      return false;
    })
    .toBe(true);
}

async function warmLocalRouteAssets(page: Page) {
  await page.waitForLoadState("load", { timeout: 60_000 }).catch(() => null);
  await page
    .evaluate(async () => {
      await (document.fonts?.ready ?? Promise.resolve());
    })
    .catch(() => null);
}

function withResourceListLimit(path: string) {
  if (!Number.isFinite(RESOURCE_LIST_LIMIT) || RESOURCE_LIST_LIMIT <= 0) {
    return path;
  }
  const [pathname, query = ""] = path.split("?");
  const params = new URLSearchParams(query);
  params.set("limit", String(Math.floor(RESOURCE_LIST_LIMIT)));
  const serialized = params.toString();
  return serialized ? `${pathname}?${serialized}` : pathname;
}

function definePageLoadPerformanceTests(config: PageLoadConfig) {
  test.describe(`${config.label} page load performance`, () => {
    const scopedUsers = demoContext.users.filter((user) =>
      config.scopeTypes.includes(user.scope_type ?? ""),
    );

    test.beforeAll(() => enforceDemoContext(config.label, scopedUsers));

    const user = scopedUsers[0];

    const baseUrl = config.baseUrl();
    const targetLabels = ["dashboard", "resource list"] as const;

    for (const targetLabel of targetLabels) {
      test(`${config.label} ${targetLabel} loads within ${PAGE_LOAD_MAX_MS}ms`, async ({
        page,
      }) => {
        if (!user?.email || !demoContext.password) {
          throw new Error("A scoped performance test account is required.");
        }
        const resourcePath = targetLabel === "resource list"
          ? await config.getResourcePath()
          : "/resources/shipments";
        const targets = config.targets(baseUrl, resourcePath);
        const target = targets.find((entry) => entry.label === targetLabel);
        if (!target) throw new Error("Missing page load target: " + targetLabel);
        test.setTimeout(120_000);

        await page.goto(baseUrl);
        const authGate = page.locator(`[data-testid="${config.authTestId}"]`);
        if (await authGate.isVisible()) {
          await signInWithPassword(page, user.email, demoContext.password || "");
        }
        await expectSignedIn(page, user.email, user.scope_type);

        if (WARM_ROUTE_BEFORE_MEASURE) {
          await page.goto(target.href, {
            waitUntil: "domcontentloaded",
            timeout: 60_000,
          });
          await expectAnyLocatorVisible(page.locator(target.readySelector));
          await warmLocalRouteAssets(page);
        }

        await installWebVitalsObserver(page);

        const startTime = Date.now();
        if (WARM_ROUTE_BEFORE_MEASURE) {
          await page.reload({ waitUntil: "domcontentloaded", timeout: 60_000 });
        } else {
          await page.goto(target.href, {
            waitUntil: "domcontentloaded",
            timeout: 60_000,
          });
        }
        await expectAnyLocatorVisible(page.locator(target.readySelector));
        const loadTime = Date.now() - startTime;

        expect(
          loadTime,
          `${config.label} ${target.label} page load (${loadTime}ms) should be under ${PAGE_LOAD_MAX_MS}ms`,
        ).toBeLessThanOrEqual(PAGE_LOAD_MAX_MS);

        const navMetrics = await assertNavigationPerformance(page);
        const vitals = await assertWebVitals(page);

        if (vitals.lcp !== null) {
          expect(
            vitals.lcp,
            `${config.label} ${target.label} LCP (${vitals.lcp}ms) should be under ${LCP_MAX_MS}ms`,
          ).toBeLessThanOrEqual(LCP_MAX_MS);
        }
        expect(
          vitals.cls,
          `${config.label} ${target.label} CLS (${vitals.cls}) should be under ${CLS_MAX}`,
        ).toBeLessThanOrEqual(CLS_MAX);

        console.log(
          `[perf] ${config.label}/${target.label}: load=${loadTime}ms` +
            ` nav=${navMetrics.duration ?? "N/A"}ms` +
            ` ttfb=${navMetrics.ttfb ?? "N/A"}ms` +
            ` lcp=${vitals.lcp ?? "N/A"}ms` +
            ` cls=${vitals.cls}` +
            ` fcp=${vitals.fcp ?? "N/A"}ms`,
        );
      });
    }
  });
}

export function defineConsolePageLoadPerformanceTests() {
  const getResourcePath = async () =>
    (await discoverResourcePath("console")) ?? "/resources/shipments";

  definePageLoadPerformanceTests({
    label: "console",
    baseUrl: getConsoleBaseUrl,
    authTestId: "console-auth-required",
    scopeTypes: ["platform", "tenant"],
    getResourcePath,
    targets: (baseUrl, resourcePath) => [
      {
        label: "dashboard",
        href: baseUrl,
        readySelector: '[data-testid="console-dashboard-ready"]',
      },
      {
        label: "resource list",
        href: `${baseUrl}${withResourceListLimit(resourcePath)}`,
        readySelector: '[data-testid="console-resource-ready"]',
      },
    ],
  });
}

export function definePortalPageLoadPerformanceTests() {
  const getResourcePath = async () =>
    (await discoverResourcePath("portal")) ?? "/resources/shipments";

  definePageLoadPerformanceTests({
    label: "portal",
    baseUrl: getPortalBaseUrl,
    authTestId: "portal-auth-required",
    scopeTypes: ["client", "sender"],
    getResourcePath,
    targets: (baseUrl, resourcePath) => [
      {
        label: "dashboard",
        href: baseUrl,
        readySelector: '[data-testid="portal-dashboard-ready"]',
      },
      {
        label: "resource list",
        href: `${baseUrl}${withResourceListLimit(resourcePath)}`,
        readySelector: '[data-testid="portal-resource-ready"]',
      },
    ],
  });
}
