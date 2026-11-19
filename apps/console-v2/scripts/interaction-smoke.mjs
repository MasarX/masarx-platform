// interaction-smoke.mjs — verifies the production console actually responds to user input.
// Tests: row click → drawer opens, theme toggle, language toggle, palette open, sidebar pin.
import { chromium } from 'playwright';

const BASE = process.env.VERIFY_BASE || 'http://localhost:5175';
const results = [];
const log = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  process.stdout.write(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}\n`);
};

(async () => {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });

  // 1. Dashboard renders KPI strip
  await page.goto(`${BASE}/`, { waitUntil: 'load' });
  await page.waitForTimeout(800);
  log('Dashboard renders', (await page.locator('.kpi').count()) >= 4, `${await page.locator('.kpi').count()} KPI cards`);

  // 2. Sidebar nav has all 9 domains
  const navItems = await page.locator('.sidenav .nav-item, .sidenav .nav-domain').count();
  log('Sidebar nav populated', navItems >= 5, `${navItems} nav items rendered`);

  // 3. Shipments page → table renders → row click opens drawer
  //
  // Drawer-open robustness (W15 close-out fix): the previous test used a
  // bare `waitForTimeout(500)` after the row click and counted `.drawer`
  // synchronously. That races React hydration on a freshly-compiled dev
  // server (the click can land before the row's onClick handler is wired
  // up, and Radix's `Dialog.Portal` mount + the `.is-open`
  // `requestAnimationFrame` deferral in `Drawer.tsx` add another frame on
  // top). Fix: (a) wait for the table body itself to be interactable, then
  // (b) actively wait for `.drawer` to appear with a generous budget
  // (`DRAWER_OPEN_TIMEOUT_MS`, default 5 s) so cold-compile latency cannot
  // flake the assertion. The downstream Esc-close path uses the same
  // active-wait pattern instead of a fixed timeout.
  const DRAWER_OPEN_TIMEOUT_MS = Number(process.env.SMOKE_DRAWER_OPEN_TIMEOUT_MS || 5000);
  const DRAWER_CLOSE_TIMEOUT_MS = Number(process.env.SMOKE_DRAWER_CLOSE_TIMEOUT_MS || 3000);
  await page.goto(`${BASE}/operate/shipments`, { waitUntil: 'load' });
  await page.waitForTimeout(800);
  // Wait for at least one row to actually be present (interactable) before
  // we click — avoids racing the hydration that wires the onRowClick
  // handler.
  await page.waitForSelector('.dt__table tbody tr', { timeout: DRAWER_OPEN_TIMEOUT_MS }).catch(() => {});
  const shipmentRows = await page.locator('.dt__table tbody tr').count();
  log('Shipments table renders', shipmentRows >= 5, `${shipmentRows} rows`);

  await page.locator('.dt__table tbody tr').first().click();
  // Active wait for the drawer instead of a fixed `waitForTimeout` — the
  // drawer is rendered through Radix `Dialog.Portal` and its `.is-open`
  // class is gated on a `requestAnimationFrame`, so the first frame after
  // click can briefly miss the selector. waitForSelector resolves as soon
  // as it appears.
  const drawerEl = await page.waitForSelector('.drawer', { timeout: DRAWER_OPEN_TIMEOUT_MS }).catch(() => null);
  const drawerOpen = drawerEl ? 1 : 0;
  log('Row click opens drawer', drawerOpen > 0, drawerOpen ? 'drawer visible' : 'drawer not found');

  // 4. Drawer close button works
  await page.keyboard.press('Escape');
  // Active wait for drawer detachment (Radix unmounts on Dialog close);
  // guard with a bounded timeout so a stale drawer does not silently pass.
  let drawerClosed = false;
  try {
    await page.waitForSelector('.drawer', { state: 'detached', timeout: DRAWER_CLOSE_TIMEOUT_MS });
    drawerClosed = true;
  } catch {
    drawerClosed = (await page.locator('.drawer').count()) === 0;
  }
  log('Esc closes drawer', drawerClosed);

  // 5. Theme toggle works
  const startTheme = await page.evaluate(() => document.documentElement.dataset.theme);
  const themeBtn = page.locator('#btn-theme, [aria-label*="theme" i], [title*="theme" i]').first();
  if (await themeBtn.count()) {
    await themeBtn.click();
    await page.waitForTimeout(300);
    const newTheme = await page.evaluate(() => document.documentElement.dataset.theme);
    log('Theme toggle', startTheme !== newTheme, `${startTheme} → ${newTheme}`);
    // restore
    await themeBtn.click();
    await page.waitForTimeout(200);
  } else {
    log('Theme toggle', false, 'button not found');
  }

  // 6. Language toggle (RTL switch)
  const startLang = await page.evaluate(() => document.documentElement.lang);
  const startDir = await page.evaluate(() => document.documentElement.dir);
  const langBtn = page.locator('#btn-lang, [aria-label*="language" i], [aria-label*="locale" i]').first();
  if (await langBtn.count()) {
    await langBtn.click();
    await page.waitForTimeout(300);
    const newLang = await page.evaluate(() => document.documentElement.lang);
    const newDir = await page.evaluate(() => document.documentElement.dir);
    log('Locale toggle', startLang !== newLang, `${startLang}/${startDir} → ${newLang}/${newDir}`);
    // restore
    await langBtn.click();
    await page.waitForTimeout(200);
  } else {
    log('Locale toggle', false, 'button not found');
  }

  // 7. Workflow Studio: bezier graph renders
  await page.goto(`${BASE}/workflows/templates`, { waitUntil: 'load' });
  await page.waitForTimeout(900);
  const wfNodes = await page.locator('.wf-node, .wf-tpl-card').count();
  log('Workflow Studio nodes', wfNodes >= 3, `${wfNodes} cards/nodes`);

  // 8. Review Queue: SLA rings render
  await page.goto(`${BASE}/workflows/review-queue`, { waitUntil: 'load' });
  await page.waitForTimeout(800);
  const taskRows = await page.locator('.wf-rq-row, [class*="rq-row"]').count();
  log('Review queue rows', taskRows >= 1, `${taskRows} task rows`);

  // 9. Settings page: scope ladder visualizer
  await page.goto(`${BASE}/platform/config`, { waitUntil: 'load' });
  await page.waitForTimeout(800);
  const ladderSteps = await page.locator('.ladder__step, [class*="ladder"]').count();
  log('Scope ladder visualizer', ladderSteps >= 1, `${ladderSteps} ladder elements`);

  // 10. Status bar evidence heartbeat (should be live)
  await page.goto(`${BASE}/`, { waitUntil: 'load' });
  await page.waitForTimeout(800);
  const evidenceText = await page.locator('.status-evidence, [class*="evidence"]').first().textContent().catch(() => '');
  log('Statusbar evidence heartbeat', !!evidenceText, evidenceText?.slice(0, 60) || 'no text');

  // 11. CLAIM-B · Route Plans page renders DataTable rows.
  await page.goto(`${BASE}/operate/route-plans`, { waitUntil: 'load' });
  await page.waitForTimeout(800);
  const planRows = await page.locator('.dt__table tbody tr').count();
  log('Route Plans table renders', planRows >= 3, `${planRows} plan rows`);

  // 12. CLAIM-B · Row click opens lifecycle stepper drawer with Apply action.
  await page.locator('.dt__table tbody tr').first().click();
  // Active-wait for the drawer to mount (same hydration race as the
  // Shipments smoke above) before we look for the Apply button.
  await page.waitForSelector('.drawer', { timeout: DRAWER_OPEN_TIMEOUT_MS }).catch(() => {});
  const planDrawerHasApply = await page.locator('.drawer__footer button', { hasText: /Apply/ }).count();
  log('Route Plans drawer Apply action', planDrawerHasApply >= 1, `${planDrawerHasApply} Apply buttons`);
  await page.keyboard.press('Escape');
  await page.waitForSelector('.drawer', { state: 'detached', timeout: DRAWER_CLOSE_TIMEOUT_MS }).catch(() => {});

  // 13. CLAIM-B · Dispatch canvas renders 3 panes + KPI strip.
  await page.goto(`${BASE}/operate/dispatch`, { waitUntil: 'load' });
  await page.waitForTimeout(800);
  const dispatchPanes = await page.locator('.pane').count();
  log('Dispatch 3-pane layout', dispatchPanes === 3, `${dispatchPanes} panes`);
  const dispatchRuns = await page.locator('.run-row').count();
  log('Dispatch runs pane populated', dispatchRuns >= 3, `${dispatchRuns} runs`);

  // 14. CLAIM-B · Tracking map renders SVG canvas + clustering pill.
  await page.goto(`${BASE}/operate/tracking-map`, { waitUntil: 'load' });
  await page.waitForTimeout(800);
  const mapCanvas = await page.locator('.map-canvas svg').count();
  log('Tracking map SVG canvas', mapCanvas >= 1, mapCanvas ? `${mapCanvas} svg layers present` : 'svg missing');
  const mapPill = await page.locator('text=Clustering policy').count();
  log('Tracking map clustering pill', mapPill >= 1, `${mapPill} pills`);

  // 15. Basket operations page renders KPI strip and row drawer.
  await page.goto(`${BASE}/operate/baskets`, { waitUntil: 'load' });
  await page.waitForTimeout(800);
  const basketKpis = await page.locator('[data-testid="baskets-kpi-strip"] .kpi').count();
  log('Baskets KPI strip', basketKpis >= 4, `${basketKpis} KPI cards`);
  await page.locator('.dt__table tbody tr').first().click();
  await page.waitForSelector('[data-testid="baskets-drawer"]', { timeout: DRAWER_OPEN_TIMEOUT_MS }).catch(() => {});
  const basketsDrawer = await page.locator('[data-testid="baskets-drawer"]').count();
  log('Baskets row opens drawer', basketsDrawer >= 1, `${basketsDrawer} drawers`);
  await page.keyboard.press('Escape');
  await page.waitForSelector('.drawer', { state: 'detached', timeout: DRAWER_CLOSE_TIMEOUT_MS }).catch(() => {});

  // 16. Driver applications intake review queue renders the KPI strip.
  await page.goto(`${BASE}/operate/fleet/driver-applications`, { waitUntil: 'load' });
  await page.waitForTimeout(800);
  const driverApplicationKpis = await page.locator('.kpi').count();
  log('Driver applications queue renders', driverApplicationKpis >= 4, `${driverApplicationKpis} KPI cards`);

  // 17. Onboarding readiness page renders readiness proof.
  await page.goto(`${BASE}/platform/onboarding-readiness`, { waitUntil: 'load' });
  await page.waitForTimeout(800);
  const readinessProof = await page.locator('[data-testid="onboarding-readiness-status"]').count();
  log('Onboarding readiness proof', readinessProof >= 1, `${readinessProof} proof chips`);

  // 18. Release proof governance page renders proof KPI strip.
  await page.goto(`${BASE}/platform/release-proof`, { waitUntil: 'load' });
  await page.waitForTimeout(800);
  const releaseProofKpis = await page.locator('[data-testid="release-proof-kpis"] .kpi').count();
  log('Release proof governance renders', releaseProofKpis >= 4, `${releaseProofKpis} KPI cards`);

  // 19. CLAIM-LIFECYCLE-LINK · Reschedule modal renders the live slot picker.
  //     Open Shipments → click first row → click "Reschedule…" → set date →
  //     verify window chips render.
  await page.goto(`${BASE}/operate/shipments`, { waitUntil: 'load' });
  await page.waitForTimeout(800);
  await page.locator('.dt__table tbody tr').first().click();
  // Active-wait for the drawer footer rather than a fixed 400 ms timeout
  // — Reschedule lives in the footer and the same Radix Portal +
  // requestAnimationFrame deferral applies.
  await page.waitForSelector('.drawer__footer', { timeout: DRAWER_OPEN_TIMEOUT_MS }).catch(() => {});
  const rescheduleBtn = page.locator('.drawer__footer button', { hasText: /Reschedule/ }).first();
  if (await rescheduleBtn.count()) {
    await rescheduleBtn.click();
    await page.waitForTimeout(300);
    const dateInput = page.locator('[data-testid="reschedule-date"]');
    const dateVisible = await dateInput.count();
    if (dateVisible) {
      // Real Chromium accepts page.fill for type="date" — use it (most
      // reliable across React-controlled inputs).
      await dateInput.fill('2026-04-26');
      await page.waitForTimeout(500);
      let windowChips = await page.locator('[data-testid^="reschedule-window-win_"]').count();
      if (windowChips === 0) {
        // Fallback: synthesize change events explicitly.
        await dateInput.evaluate((el) => {
          const input = el;
          const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
          setter.call(input, '2026-04-26');
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new Event('change', { bubbles: true }));
        });
        await page.waitForTimeout(500);
        windowChips = await page.locator('[data-testid^="reschedule-window-win_"]').count();
      }
      log('Reschedule modal slot picker', windowChips >= 2, `${windowChips} window chips for 2026-04-26`);
    } else {
      log('Reschedule modal slot picker', false, 'date input not found');
    }
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);
  } else {
    log('Reschedule modal slot picker', false, 'Reschedule button not found in drawer footer');
  }

  // Final: zero JS errors collected during all interactions
  log('No JS errors during interactions', errs.length === 0, errs.length ? `${errs.length}: ${errs[0]?.slice(0, 80)}` : '');

  await browser.close();
  const pass = results.filter((r) => r.ok).length;
  const fail = results.length - pass;
  console.log('\n──────────────────────────────────────');
  console.log(`PASS: ${pass} / ${results.length}`);
  if (fail) {
    console.log(`FAIL: ${fail}`);
    results.filter((r) => !r.ok).forEach((r) => console.log(`  · ${r.name}${r.detail ? ' — ' + r.detail : ''}`));
    process.exit(1);
  }
})();
