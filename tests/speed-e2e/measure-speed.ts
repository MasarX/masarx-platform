import { writeFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { readSpeedBudgets } from "../../scripts/frontend/design-speed-budgets.cjs";

const RUNS = 5;
const VIEWPORT = { width: 1440, height: 900 };
const EVENT_TIMING_FLOOR_MS = 16;
const EVENT_TIMING_WINDOW_MS = 2000;

type Metrics = { lcpMs: number; inpMs: number };
type Budget = Metrics & { screen: string; route: string; toleranceRatio: number; spec: string | null };
type Observations = { lcpMs: number; inpMs: number; trustedClick: boolean; clickMeasured: boolean };
type SpeedWindow = Window & { speedObservations: Observations };

function p75(values: number[]): number {
  return [...values].sort((a, b) => a - b)[Math.ceil(0.75 * values.length) - 1];
}

export function measureSpeed(
  spec: string,
  routes: string[],
  ready: (page: Page, route: string) => Promise<void>,
) {
  const rows: Budget[] = readSpeedBudgets();
  const budgets = rows.filter((row) => row.spec === spec);
  expect(budgets.map((budget) => budget.route).sort(), spec + " routes in DESIGN.md")
    .toEqual([...routes].sort());
  for (const budget of budgets) {
    measureRoute(budget, ready);
  }
}

function measureRoute(
  { screen, route, lcpMs, inpMs, toleranceRatio }: Budget,
  ready: (page: Page, route: string) => Promise<void>,
) {
  const budget = { lcpMs, inpMs, toleranceRatio };
  const limit = {
    lcpMs: Math.round(lcpMs * (1 + toleranceRatio)),
    inpMs: Math.round(inpMs * (1 + toleranceRatio)),
  };
  test(`speed p75: ${screen}`, async ({ browser, baseURL }, testInfo) => {
    const runs: Metrics[] = [];
    for (let i = 0; i < RUNS; i += 1) {
      const context = await browser.newContext({
        baseURL,
        viewport: VIEWPORT,
        reducedMotion: "reduce",
        serviceWorkers: "block",
        proxy: testInfo.project.use.proxy,
      });
      try {
        const page = await context.newPage();
        const cdp = await context.newCDPSession(page);
        await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });
        await page.addInitScript((floorMs) => {
          const observations: Observations = { lcpMs: 0, inpMs: 0, trustedClick: false, clickMeasured: false };
          (window as SpeedWindow).speedObservations = observations;
          new PerformanceObserver((list) => {
            for (const entry of list.getEntries()) observations.lcpMs = entry.startTime;
          }).observe({ type: "largest-contentful-paint", buffered: true });
          new PerformanceObserver((list) => {
            for (const entry of list.getEntries() as PerformanceEventTiming[]) {
              if (!entry.interactionId) continue;
              observations.inpMs = Math.max(observations.inpMs, entry.duration);
              if (entry.name === "click") observations.clickMeasured = true;
            }
          }).observe({ type: "event", buffered: true, durationThreshold: floorMs } as PerformanceObserverInit);
          document.addEventListener("click", (event) => {
            observations.trustedClick ||= event.isTrusted;
          }, { capture: true });
        }, EVENT_TIMING_FLOOR_MS);

        const response = await page.goto(route, { waitUntil: "load" });
        expect(response?.ok(), `HTTP response for ${route}`).toBe(true);
        await expect(page).toHaveURL(new URL(route, baseURL).href);
        expect(await page.evaluate(() => PerformanceObserver.supportedEntryTypes))
          .toEqual(expect.arrayContaining(["largest-contentful-paint", "event"]));
        await ready(page, route);
        const heading = page.getByRole("main").getByRole("heading", { level: 1 }).first();
        await expect(heading).toBeVisible();
        await page.waitForFunction(() => (window as SpeedWindow).speedObservations.lcpMs > 0);

        await page.keyboard.press("Tab");
        await heading.click();
        // Chromium omits sub-floor entries, so a sample can finish without a click entry.
        const deadline = await page.evaluate((windowMs) => performance.now() + windowMs, EVENT_TIMING_WINDOW_MS);
        await page.waitForFunction((until) =>
          (window as SpeedWindow).speedObservations.clickMeasured || performance.now() >= until, deadline);
        const { lcpMs, inpMs, trustedClick } = await page.evaluate(() => (window as SpeedWindow).speedObservations);
        expect(trustedClick, `trusted click on ${route} run ${i + 1}`).toBe(true);
        runs.push({ lcpMs: Math.round(lcpMs), inpMs: inpMs || EVENT_TIMING_FLOOR_MS });
      } finally {
        await context.close();
      }
    }

    const result = { lcpMs: p75(runs.map(run => run.lcpMs)), inpMs: p75(runs.map(run => run.inpMs)) };
    const passed = result.lcpMs <= limit.lcpMs && result.inpMs <= limit.inpMs;
    const summary = {
      screen, route, viewport: VIEWPORT, sampleCount: runs.length, p75: result, budget, limit,
      status: passed ? "PASS" : "FAIL",
    };
    console.log(JSON.stringify(summary));
    writeFileSync(testInfo.outputPath("speed-p75.json"), JSON.stringify({ ...summary, runs }) + "\n");
    expect.soft(result.lcpMs, `LCP p75 on ${screen}`).toBeLessThanOrEqual(limit.lcpMs);
    expect(result.inpMs, `INP p75 on ${screen}`).toBeLessThanOrEqual(limit.inpMs);
  });
}
