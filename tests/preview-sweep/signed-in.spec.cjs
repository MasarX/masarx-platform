'use strict';

const { test, expect } = require('@playwright/test');
const { mkdir } = require('node:fs/promises');
const { join } = require('node:path');
const { appOrigins, loopback, origin, ports, startFixture } = require('../../scripts/ci-hosted/preview-sweep-fixture.cjs');

const locale = process.env.SWEEP_LOCALE;
const output = join(process.env.RUNNER_TEMP, 'signed-in-previews');
const allowedOrigins = new Set([...appOrigins, origin(ports.fixture)]);
const viewports = {
  desktop: { width: 1440, height: 900 },
  phone: { width: 390, height: 844 },
};
let fixture;

test.beforeAll(async () => {
  await mkdir(output, { recursive: true });
  fixture = await startFixture();
});
test.afterAll(async () => fixture?.close());

for (const app of ['console', 'console-v2', 'portal']) {
  for (const theme of ['light', 'dark']) {
    for (const [size, viewport] of Object.entries(viewports)) {
      test([app, locale, theme, size].join(' '), async ({ browser }) => {
        const v2 = app === 'console-v2';
        const baseURL = origin(ports[app]);
        const path = v2 ? '/operate/shipments' : '/resources/shipments';
        const reader = app === 'portal' ? 'sender_user' : 'dispatcher';
        const checkpoint = stage => console.log('\nSWEEP', app, locale, theme, size, stage);

        async function check(state, code, run) {
          try {
            return await run();
          } catch (error) {
            console.log('\nSWEEP-FAIL', app, locale, theme, size, state, code);
            throw error;
          }
        }

        async function withPage(role, state, capture) {
          checkpoint('session');
          const account = await check(state, 'new-session', () => fixture.session(role, state));
          const context = await check(state, 'new-context', () => browser.newContext({
            baseURL, viewport, colorScheme: theme, reducedMotion: 'reduce',
            locale, deviceScaleFactor: 1, hasTouch: size === 'phone', serviceWorkers: 'block',
          }));
          try {
            await check(state, 'route-guard', () => context.route('**/*', route =>
              allowedOrigins.has(new URL(route.request().url()).origin) ? route.continue() : route.abort()));
            if (!v2) {
              await check(state, 'session-cookie', () => context.addCookies([{
                url: baseURL, name: 'sb-' + loopback.split('.')[0] + '-auth-token',
                value: 'base64-' + Buffer.from(JSON.stringify(account.session)).toString('base64url'),
              }]));
            }
            if (v2) {
              await check(state, 'init-session', () => context.addInitScript(({ locale, theme, session }) => {
                localStorage.setItem('masarx-console-v2-auth', JSON.stringify(session));
                localStorage.setItem('console-v2.locale', locale);
                localStorage.setItem('masarx-ui-theme', theme);
              }, { locale, theme, session: account.session }));
            }
            const page = await check(state, 'new-page', () => context.newPage());
            if (!v2 && state === 'empty') {
              // Hydrate the signed-in shell before triggering the route's streaming loading state.
              await check(state, 'open-shell', () => page.goto('/'));
              await check(state, 'shell-theme', () => expect(page.locator('html')).toHaveAttribute('data-theme', theme));
              if (size === 'phone') {
                await check(state, 'open-mobile-menu', () => page.getByTestId(app + '-app-shell-mobile-open').click());
              }
              await check(state, 'follow-route-link', () => page.locator('nav a[href="' + path + '"]:visible').first().click());
              if (size === 'phone') await check(state, 'close-mobile-menu', () => page.keyboard.press('Escape'));
            } else {
              await check(state, 'open-route', () => page.goto(path, { waitUntil: 'domcontentloaded' }));
            }
            if (!v2) {
              await check(state, 'signed-in', () => expect(page.getByTestId('ui-context-strip-signed-in')).toBeVisible());
            }
            await capture(page, account.release);
          } finally {
            account.dispose();
            await check(state, 'close-context', () => context.close());
          }
        }

        async function screenshot(page, state, marker) {
          checkpoint(state);
          await check(state, 'marker', () => expect(marker).toBeVisible());
          const root = page.locator('html');
          await check(state, 'language', () => expect(root).toHaveAttribute('lang', locale));
          await check(state, 'direction', () => expect(root).toHaveAttribute('dir', locale === 'ar' ? 'rtl' : 'ltr'));
          await check(state, 'theme', () => expect(root).toHaveAttribute('data-theme', theme));
          await check(state, 'screenshot', () => page.screenshot({
            path: join(output, [app, locale, theme, size, state].join('-') + '.png'),
            animations: 'disabled',
            mask: ['signed-in', 'org', 'scope'].map(key => page.getByTestId('ui-context-strip-' + key)),
            maskColor: '#777777',
            style: 'nextjs-portal { display: none }',
          }));
        }

        await withPage(reader, 'empty', async (page, release) => {
          const main = page.getByRole('main');
          await screenshot(page, 'loading', v2 ? main.locator('.state--loading') : main.getByTestId('route-loading-page'));
          release();
          await screenshot(page, 'empty', v2 ? main.locator('.state--empty') :
            main.getByTestId(app + '-resource-ready').getByText(/No records returned for this resource\./));
        });
        await withPage(reader, 'error', page => screenshot(page, 'error',
          page.getByTestId(v2 ? 'app-guard-metadata-error' : app + '-resource-error')));
        await withPage('finance_viewer', 'denied', page => screenshot(page, 'denied',
          v2 ? page.getByRole('main').locator('.state--denied') : page.getByTestId(app + '-resource-blocked')));
        checkpoint('complete');
      });
    }
  }
}
