import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test, expect } from "@playwright/test";
import { readSpeedBudgets } from "../../scripts/frontend/design-speed-budgets.cjs";

// LCP and INP at p75 for the DESIGN.md speed rows that name this spec (#301).
// Budgets and tolerance come from the table; each screen's runs are written as evidence JSON.
const RUNS = 5;
const VITALS_SCRIPT = join(dirname(require.resolve("web-vitals")), "web-vitals.iife.js");
const EVIDENCE_DIR = process.env.SPEED_EVIDENCE_DIR || join("test-results", "speed-evidence");
// Event Timing does not report interactions under 16 ms, so such a run counts at that floor.
const EVENT_TIMING_FLOOR_MS = 16;

function p75(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil(0.75 * sorted.length) - 1];
}

const budgets = readSpeedBudgets().filter((row) => row.spec === "landing-speed-p75");

test("the speed table names screens for this spec", () => {
  expect(budgets.length).toBeGreaterThan(0);
});

for (const budget of budgets) {
  test(`speed p75: ${budget.screen}`, async ({ page }) => {
    test.setTimeout(120000);
    await page.setViewportSize({ width: 1440, height: 900 });
    // Every run is a cold load: no HTTP or memory cache between runs.
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });
    await page.addInitScript({ path: VITALS_SCRIPT });
    await page.addInitScript(() => {
      const w = window as unknown as {
        __vitals: Record<string, number>;
        webVitals: { onLCP: Function; onINP: Function };
      };
      w.__vitals = {};
      const keep = (metric: { name: string; value: number }) => {
        w.__vitals[metric.name] = metric.value;
      };
      w.webVitals.onLCP(keep, { reportAllChanges: true });
      w.webVitals.onINP(keep, { reportAllChanges: true, durationThreshold: 16 });
    });

    const runs: { lcpMs: number; inpMs: number }[] = [];
    for (let i = 0; i < RUNS; i += 1) {
      await page.goto(`${budget.route}?motion=off`, { waitUntil: "load" });
      const heading = page.locator("h1").first();
      await expect(heading).toBeVisible();
      // LCP stops at the first input, so read it before the journey's interactions.
      await page.waitForFunction(() => (window as any).__vitals.LCP !== undefined);
      const lcpMs = await page.evaluate(() => (window as any).__vitals.LCP as number);

      await page.keyboard.press("Tab");
      await heading.click();
      const reported = await page
        .waitForFunction(() => (window as any).__vitals.INP !== undefined, null, { timeout: 2000 })
        .then(() => true, () => false);
      const inpMs = reported
        ? await page.evaluate(() => (window as any).__vitals.INP as number)
        : EVENT_TIMING_FLOOR_MS;
      runs.push({ lcpMs: Math.round(lcpMs), inpMs: Math.round(inpMs) });
    }

    const result = { lcpMs: p75(runs.map((r) => r.lcpMs)), inpMs: p75(runs.map((r) => r.inpMs)) };
    const limit = {
      lcpMs: Math.round(budget.lcpMs * (1 + budget.toleranceRatio)),
      inpMs: Math.round(budget.inpMs * (1 + budget.toleranceRatio)),
    };
    mkdirSync(EVIDENCE_DIR, { recursive: true });
    writeFileSync(
      join(EVIDENCE_DIR, `speed--${budget.route.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "") || "root"}.json`),
      JSON.stringify(
        {
          screen: budget.screen,
          route: budget.route,
          viewport: "1440x900",
          runs,
          p75: result,
          budget: { lcpMs: budget.lcpMs, inpMs: budget.inpMs, toleranceRatio: budget.toleranceRatio },
          limit,
          measuredAt: new Date().toISOString(),
        },
        null,
        2
      )
    );

    expect(result.lcpMs, `LCP p75 on ${budget.route} (runs ${runs.map((r) => r.lcpMs).join(", ")})`).toBeLessThanOrEqual(limit.lcpMs);
    expect(result.inpMs, `INP p75 on ${budget.route} (runs ${runs.map((r) => r.inpMs).join(", ")})`).toBeLessThanOrEqual(limit.inpMs);
  });
}
