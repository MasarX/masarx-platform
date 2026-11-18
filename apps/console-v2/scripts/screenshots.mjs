// screenshots.mjs — Playwright screenshot capture for all routes (and a few priority interaction states).
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const BASE = process.env.VERIFY_BASE || 'http://localhost:5175';
const OUT = process.argv[2] || './__screenshots__';
mkdirSync(OUT, { recursive: true });

const ROUTES = [
  ['dashboard', '/'],
  ['op-shipments', '/operate/shipments'],
  ['op-route-plans', '/operate/route-plans'],
  ['op-dispatch', '/operate/dispatch'],
  ['op-exceptions', '/operate/exceptions'],
  ['op-pickups', '/operate/pickups'],
  ['op-tracking-map', '/operate/tracking-map'],
  ['finance-settlements', '/finance/settlements'],
  ['finance-cod', '/finance/cod'],
  ['wf-templates', '/workflows/templates'],
  ['wf-runs', '/workflows/runs'],
  ['wf-bindings', '/workflows/bindings'],
  ['wf-review-queue', '/workflows/review-queue'],
  ['int-mapping', '/integrations/mapping'],
  ['platform-config', '/platform/config'],
  ['insights-decisions', '/insights/decisions'],
  ['customers-clients', '/customers/clients'],
];

(async () => {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 980 }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();

  for (const [name, route] of ROUTES) {
    await page.goto(`${BASE}${route}`, { waitUntil: 'load' });
    await page.waitForTimeout(900);
    await page.screenshot({ path: join(OUT, `${name}.png`), fullPage: false });
    process.stdout.write(`✓ ${name}\n`);
  }
  await browser.close();
})();
