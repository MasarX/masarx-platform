import { writeFileSync } from "node:fs";
import { errors, expect, test, type Page } from "@playwright/test";

const RUNS = 5;
const VIEWPORT = { width: 1440, height: 900 };
const EVENT_TIMING_FLOOR_MS = 16;
// shortcut: draft bounds from #301, replace with DESIGN.md rows and parser when #390 lands
const LIMIT = { lcpMs: 2750, inpMs: 220 };

type Metrics = { lcpMs: number; inpMs: number };
type Observations = { lcpMs: number; inpMs: number; trustedClick: boolean; clickMeasured: boolean };
type SpeedWindow = Window & { speedObservations: Observations };

function p75(values: number[]): number {
  return [...values].sort((a, b) => a - b)[Math.ceil(0.75 * values.length) - 1];
}

export function measureSpeed(
  screen: string,
  route: string,
  ready: (page: Page) => Promise<void>,
) {
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
        await ready(page);
        const heading = page.getByRole("main").getByRole("heading", { level: 1 }).first();
        await expect(heading).toBeVisible();
        await page.waitForFunction(() => (window as SpeedWindow).speedObservations.lcpMs > 0);

        await page.keyboard.press("Tab");
        await heading.click();
        // Chromium only reports interactions at or above the Event Timing floor.
        await page.waitForFunction(() => (window as SpeedWindow).speedObservations.clickMeasured,
          null, { timeout: 2000 }).catch((error: unknown) => {
          if (!(error instanceof errors.TimeoutError)) throw error;
        });
        const { lcpMs, inpMs, trustedClick } = await page.evaluate(() => (window as SpeedWindow).speedObservations);
        expect(trustedClick, `trusted click on ${route} run ${i + 1}`).toBe(true);
        runs.push({ lcpMs: Math.round(lcpMs), inpMs: inpMs || EVENT_TIMING_FLOOR_MS });
      } finally {
        await context.close();
      }
    }

    const result = { lcpMs: p75(runs.map(run => run.lcpMs)), inpMs: p75(runs.map(run => run.inpMs)) };
    const evidence = JSON.stringify({ screen, route, viewport: VIEWPORT, runs, p75: result, limit: LIMIT });
    writeFileSync(testInfo.outputPath("speed-p75.json"), evidence + "\n");
    console.log(evidence);
    expect.soft(result.lcpMs, `LCP p75 on ${screen}`).toBeLessThanOrEqual(LIMIT.lcpMs);
    expect(result.inpMs, `INP p75 on ${screen}`).toBeLessThanOrEqual(LIMIT.inpMs);
  });
}
