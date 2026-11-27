'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loopbackOrigin, qualificationInputs } = require('./console-v2-auth-qa-fixture.cjs');

const checks = ['liveStartup', 'demoStartup', 'signIn', 'restore', 'refresh', 'signOut', 'mfa', 'startupP75'];
const viewport = { width: 1440, height: 900 };
// Event Timing cannot report durations below this floor.
const eventTimingFloor = 16;

function responseFor(response, origin, pathname, grant) {
  const url = new URL(response.url());
  return response.request().method() === 'POST' && url.origin === origin &&
    url.pathname === pathname && (!grant || url.searchParams.get('grant_type') === grant);
}

function readIdentity(page, api) {
  return page.waitForResponse(response => responseFor(response, api, '/rest/v1/rpc/ui_me_v1'));
}

async function assertIdentity(response, expected) {
  assert(response.ok());
  const { user } = await response.json();
  assert(user?.id && user.id === expected.id && user.email === expected.email);
}

async function dashboard(page) {
  await page.getByRole('banner').waitFor();
  await page.getByRole('navigation', { name: 'Primary', exact: true }).waitFor();
  await page.locator('.dash-grid .dash-widget').first().waitFor();
  const heading = page.locator('h1.page-header__title');
  await heading.waitFor();
  return heading;
}

async function openPage(browser, origins) {
  const context = await browser.newContext({ viewport, reducedMotion: 'reduce', serviceWorkers: 'block' });
  await context.route('**/*', route => (
    origins.includes(new URL(route.request().url()).origin) ? route.continue() : route.abort()
  ));
  const page = await context.newPage();
  page.setDefaultTimeout(12_000);
  page.setDefaultNavigationTimeout(20_000);
  let startupFailure = false;
  page.on('pageerror', () => { startupFailure = true; });
  page.on('response', response => {
    if (response.request().resourceType() === 'script' && response.status() >= 400) startupFailure = true;
  });
  page.on('requestfailed', request => {
    if (request.resourceType() === 'script') startupFailure = true;
  });
  return { page, assertStartup: () => assert(!startupFailure) };
}

async function measureDashboard(page, origin, file, limit) {
  const cdp = await page.context().newCDPSession(page);
  const runs = [];
  try {
    await cdp.send('Network.enable');
    await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
    await page.addInitScript(floor => {
      const vitals = { lcpMs: 0, inpMs: 0, eventTiming: PerformanceObserver.supportedEntryTypes.includes('event') };
      window.__consoleQaVitals = vitals;
      new PerformanceObserver(list => {
        for (const entry of list.getEntries()) vitals.lcpMs = entry.startTime;
      }).observe({ type: 'largest-contentful-paint', buffered: true });
      if (vitals.eventTiming) {
        new PerformanceObserver(list => {
          for (const entry of list.getEntries()) {
            if (entry.interactionId) vitals.inpMs = Math.max(vitals.inpMs, entry.duration);
          }
        }).observe({ type: 'event', buffered: true, durationThreshold: floor });
      }
    }, eventTimingFloor);

    for (let sample = 0; sample < 5; sample++) {
      assert((await page.goto(origin, { waitUntil: 'load' }))?.ok());
      const heading = await dashboard(page);
      assert.equal(new URL(page.url()).pathname, '/');
      const lcp = await page.waitForFunction(() => window.__consoleQaVitals?.lcpMs || false, null, { timeout: 15_000 });
      const lcpMs = Math.round(await lcp.jsonValue());
      assert(await page.evaluate(() => window.__consoleQaVitals.eventTiming && document.visibilityState === 'visible'));
      await page.keyboard.press('Tab');
      await heading.click();
      // A supported Event Timing observer with no reported entry gives the same floor used in Landing.
      await page.waitForFunction(() => window.__consoleQaVitals.inpMs > 0, null, { timeout: 2_000 })
        .catch(error => { if (error.name !== 'TimeoutError') throw error; });
      const inpMs = Math.max(eventTimingFloor, Math.round(await page.evaluate(() => window.__consoleQaVitals.inpMs)));
      assert(Number.isSafeInteger(lcpMs) && lcpMs > 0 && lcpMs <= 480_000);
      assert(Number.isSafeInteger(inpMs) && inpMs <= 480_000);
      runs.push({ lcpMs, inpMs });
    }
  } finally {
    await cdp.detach();
  }
  const p75 = key => runs.map(sample => sample[key]).sort((a, b) => a - b)[3];
  fs.writeFileSync(file, JSON.stringify({ viewport: '1440x900', runs }) + '\n', { flag: 'wx' });
  return p75('lcpMs') <= limit.lcpMs && p75('inpMs') <= limit.inpMs ? 'PASS' : 'FAIL';
}

async function qualification(env, result) {
  const { temp, requireCandidate } = qualificationInputs(env);
  assert.equal(env.E2E_CONSOLE_LIVE, '1');
  assert(!env.SUPABASE_SERVICE_ROLE_KEY && !env.DATABASE_URL);
  const live = loopbackOrigin(JSON.parse(env.QA_LIVE).origin);
  const demo = loopbackOrigin(JSON.parse(env.QA_DEMO).origin);
  const api = loopbackOrigin(env.VITE_SUPABASE_URL);
  assert.equal(new Set([live, demo, api]).size, 3);
  assert.equal(env.VERIFY_BASE, live);
  const email = env.E2E_CONSOLE_AUTH_EMAIL;
  const password = env.E2E_CONSOLE_AUTH_PASSWORD;
  assert(email && password && env.VITE_SUPABASE_ANON_KEY);

  const speedDir = fs.realpathSync(env.SPEED_EVIDENCE_DIR);
  assert.equal(speedDir, path.join(temp, 'speed-evidence'));
  const { readSpeedBudgets } = requireCandidate('./scripts/frontend/design-speed-budgets.cjs');
  const budget = readSpeedBudgets().find(row => row.route === '/' && row.screen.startsWith('Console V2 Dashboard '));
  assert(budget);
  const limit = {
    lcpMs: Math.round(budget.lcpMs * (1 + budget.toleranceRatio)),
    inpMs: Math.round(budget.inpMs * (1 + budget.toleranceRatio)),
  };
  const { chromium } = requireCandidate('@playwright/test');
  const browser = await chromium.launch();
  const exercise = async (name, work) => {
    try {
      result[name] = (await work()) ?? 'PASS';
    } catch {
      result[name] = 'FAIL';
    }
    return result[name] === 'PASS';
  };
  const speed = async (page, origin, mode) => {
    try {
      return await measureDashboard(page, origin, path.join(speedDir, 'speed--dashboard-' + mode + '.json'), limit);
    } catch {
      // The caller can only adjudicate a mode with all five measurements.
      return 'NOT_RUN';
    }
  };
  let demoSpeed = 'NOT_RUN';
  let liveSpeed = 'NOT_RUN';

  // The pinned Console login and callback expose password and magic-link flows without an MFA route.
  result.mfa = 'UNSUPPORTED';
  try {
    await exercise('demoStartup', async () => {
      const { page, assertStartup } = await openPage(browser, [demo]);
      let backendRequest = false;
      page.on('request', request => {
        const url = new URL(request.url());
        if (url.origin === api || /^\/(?:auth|rest)\/v1(?:\/|$)/.test(url.pathname)) backendRequest = true;
      });
      assert((await page.goto(demo))?.ok());
      await dashboard(page);
      assert(!backendRequest);
      assert(!await page.getByTestId('login-module').isVisible());
      assert(!await page.getByTestId('app-guard-unauthenticated').isVisible());
      assertStartup();
      demoSpeed = await speed(page, demo, 'demo');
      assert(!backendRequest);
      assertStartup();
      await page.context().close();
    });

    const { page, assertStartup } = await openPage(browser, [live, api]);
    const guard = page.getByTestId('app-guard-unauthenticated');
    const login = page.getByTestId('login-module');
    if (!await exercise('liveStartup', async () => {
      assert((await page.goto(live))?.ok());
      await guard.waitFor();
      await Promise.all([
        page.waitForURL(new URL('/login', live).href),
        guard.getByRole('button', { name: 'Sign in', exact: true }).click(),
      ]);
      await login.getByTestId('login-form').waitFor();
      assertStartup();
    })) return;

    let expected;
    if (!await exercise('signIn', async () => {
      await login.getByLabel('Email', { exact: true }).fill(email);
      await login.getByLabel('Password', { exact: true }).fill(password);
      const [grant, identity] = await Promise.all([
        page.waitForResponse(response => responseFor(response, api, '/auth/v1/token', 'password')),
        readIdentity(page, api),
        login.getByRole('button', { name: 'Sign in', exact: true }).click(),
      ]);
      assert(grant.ok());
      const { user } = await grant.json();
      assert(user?.id && user.email === email);
      expected = { id: user.id, email };
      await assertIdentity(identity, expected);
      await dashboard(page);
      assertStartup();
    })) return;

    if (await exercise('restore', async () => {
      const [identity] = await Promise.all([readIdentity(page, api), page.reload()]);
      await assertIdentity(identity, expected);
      await dashboard(page);
      assert(!await login.isVisible());
      assertStartup();
    })) {
      await exercise('refresh', async () => {
        await page.bringToFront();
        const timeout = 240_000;
        const refresh = page.waitForResponse(response =>
          responseFor(response, api, '/auth/v1/token', 'refresh_token'), { timeout }).catch(error => {
          if (error.name !== 'TimeoutError') throw error;
          return null;
        }).then(async grant => {
          if (grant === null) return null;
          assert(grant.ok());
          const { user, access_token: accessToken } = await grant.json();
          assert(user?.id === expected.id && typeof accessToken === 'string' && accessToken);
          return accessToken;
        });
        const [grant, identity] = await Promise.allSettled([
          refresh,
          page.waitForResponse(async response => {
            if (!responseFor(response, api, '/rest/v1/rpc/ui_me_v1')) return false;
            const accessToken = await refresh;
            return accessToken !== null &&
              await response.request().headerValue('authorization') === 'Bearer ' + accessToken;
          }, { timeout }),
        ]);
        if (grant.status === 'fulfilled' && grant.value === null) {
          result.refreshReason = 'REFRESH_NOT_OBSERVED';
          return 'NOT_RUN';
        }
        assert(grant.status === 'fulfilled' && identity.status === 'fulfilled');
        await assertIdentity(identity.value, expected);
        await dashboard(page);
        assertStartup();
      });
      liveSpeed = await speed(page, live, 'live');
    }

    await exercise('signOut', async () => {
      await page.locator('.user-btn').click();
      const [logout] = await Promise.all([
        page.waitForResponse(response => responseFor(response, api, '/auth/v1/logout')),
        page.waitForURL(new URL('/login', live).href),
        page.getByTestId('user-menu-drawer').getByRole('button', { name: 'Sign out', exact: true }).click(),
      ]);
      assert(logout.ok());
      assert(await page.evaluate(() => localStorage.getItem('masarx-console-v2-auth') === null));
      assert((await page.goto(live))?.ok());
      await guard.waitFor();
      assert(!await page.getByRole('banner').isVisible());
    });
  } finally {
    const measured = [liveSpeed, demoSpeed];
    result.startupP75 = measured.includes('FAIL') ? 'FAIL' : measured.includes('NOT_RUN') ? 'NOT_RUN' : 'PASS';
    try {
      await browser.close();
    } catch {
      if (result.signOut === 'PASS') result.signOut = 'FAIL';
    }
  }
}

const result = { ...Object.fromEntries(checks.map(name => [name, 'NOT_RUN'])), refreshReason: null };
qualification(process.env, result).catch(() => {
  // The caller records case statuses. Errors can contain session-bearing details.
}).finally(() => {
  process.stdout.write(JSON.stringify(result) + '\n');
});
