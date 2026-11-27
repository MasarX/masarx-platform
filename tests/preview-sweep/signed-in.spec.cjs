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
        const portalMarkers = app === 'portal' ? {
          error: 'portal-resource-error',
          denied: 'portal-resource-blocked',
        } : {};

        async function check(state, code, run, page) {
          try {
            return await run();
          } catch (error) {
            console.log('\nSWEEP-FAIL', app, locale, theme, size, state, code);
            if (code === 'marker' && error instanceof Error) {
              console.log('SWEEP-ERROR ' + error.message.replaceAll('\n', '\nSWEEP-ERROR '));
              const markerTestId = portalMarkers[state];
              if (page && markerTestId && error.message.includes('resolved to 2 elements')) {
                const openingTag = /^[ \t]*([12])\) <([a-z][a-z0-9]{0,15})(?=[ \t/>])((?:[^<>"'\r\n]|"[^"\r\n]*"|'[^'\r\n]*')*)>/gm;
                for (const [, index, tag, attributes] of error.message.matchAll(openingTag)) {
                  const names = Array.from(attributes.matchAll(/\s+([^\s=]+)(?:=(?:"[^"]*"|'[^']*'|[^\s]+))?/g),
                    ([, name]) => name);
                  const hiddenAttr = names.includes('hidden');
                  const styleAttr = names.includes('style');
                  console.log('\nSWEEP-PAIR', app, locale, theme, size, state, index, tag,
                    hiddenAttr ? 'hidden' : '-', styleAttr ? 'style' : '-');
                }
                const snapshot = await page.evaluate(testId => {
                  const ancestorTestId = /^(portal-resource-(blocked|error|ready|shipment-search)|portal-app-shell-sidebar|portal-app-shell-main|route-(loading|error)-page)$/;
                  const markers = Array.from(document.querySelectorAll(`[data-testid="${testId}"]`), element => {
                    const chain = [];
                    for (let parent = element.parentElement; parent; parent = parent.parentElement) {
                      const parentTestId = parent.getAttribute('data-testid');
                      if (ancestorTestId.test(parentTestId)) chain.push(parentTestId);
                      else if (/^[SBP]:/.test(parent.id)) chain.push('seg');
                      else if (parent.hasAttribute('hidden')) chain.push('hidden');
                      else if (getComputedStyle(parent).display === 'none') chain.push('none');
                      else if (parent.localName === 'template') chain.push('template');
                      else if (parent === document.body) chain.push('body');
                    }
                    return `${element.checkVisibility() ? 'visible' : 'hidden'}:${chain.join('>') || 'root'}`;
                  });

                  const boundaryTokens = new Map([['$', 'c'], ['$?', 'p'], ['$!', 'x'], ['/$', 'e']]);
                  const walker = document.createTreeWalker(document, NodeFilter.SHOW_COMMENT);
                  const boundaries = [];
                  while (boundaries.length < 40 && walker.nextNode()) {
                    const token = boundaryTokens.get(walker.currentNode.data);
                    if (token) boundaries.push(token);
                  }
                  return { markers, boundaries, segments: document.querySelectorAll('[id^="S:"]').length };
                }, markerTestId).catch(() => null);
                if (snapshot) {
                  const { markers, boundaries, segments } = snapshot;
                  console.log('\nSWEEP-MARKERS', app, locale, theme, size, state, `count=${markers.length}`, ...markers);
                  console.log('\nSWEEP-BOUNDARIES', app, locale, theme, size, state, boundaries.join(',') || 'none', `segs=${segments}`);
                }
              }
            }
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
          const markerTestId = portalMarkers[state];
          let documentResponse;
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
            if (markerTestId) {
              const shipmentsURL = new URL(path, baseURL).href;
              page.on('response', response => {
                if (response.url() !== shipmentsURL) return;
                const request = response.request();
                if (request.isNavigationRequest() && request.frame() === page.mainFrame()) {
                  documentResponse = response;
                }
              });
            }
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
            if (documentResponse) {
              // Reading the stream here keeps its completion out of the marker assertion's timing.
              const html = await documentResponse.text().catch(() => null);
              if (html !== null) {
                const marker = `data-testid="${markerTestId}"`;
                const markerCount = html.split(marker).length - 1;
                const streamTokens = new RegExp(String.raw`<template id="(B:\d+)"|<div hidden id="(S:\d+)"|\$RC\("B:(\d+)","S:(\d+)"\)|${marker}`, 'g');
                const order = Array.from(html.matchAll(streamTokens)).slice(0, 40)
                  .map(([, boundary, segment, target, source]) => boundary ?? segment ?? (target ? `RC:${target}:${source}` : 'M'));
                console.log('\nSWEEP-SSR', app, locale, theme, size, state, markerCount, order.join(',') || 'none');
              }
            }
            account.dispose();
            await check(state, 'close-context', () => context.close());
          }
        }

        async function screenshot(page, state, container, marker = container.locator(
          v2 ? 'h3.state__title' : ':scope > p:first-child',
        )) {
          checkpoint(state);
          await check(state, 'marker', () => expect(container).toBeVisible(), page);
          await check(state, 'marker-in-view', async () => {
            await marker.scrollIntoViewIfNeeded();
            const [vw, vh, x, y, width, height, ratio] = await container.evaluate(element => new Promise(resolve => {
              const observer = new IntersectionObserver(([entry]) => {
                observer.disconnect();
                const { x, y, width, height } = entry.boundingClientRect;
                resolve([window.innerWidth, window.innerHeight, x, y, width, height, entry.intersectionRatio]);
              });
              observer.observe(element);
            }));
            console.log('\nSWEEP-GEOM', app, locale, theme, size, state, vw, vh,
              ...[x, y, width, height].map(value => value.toFixed(3)), ratio.toFixed(9));
            await expect(marker).toBeInViewport({ ratio: 1 });
          });
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
          const loading = v2 ? main.locator('.state--loading') : main.getByTestId('route-loading-page');
          await screenshot(page, 'loading', loading, v2 ? undefined : loading.getByTestId('loading-state-header'));
          release();
          if (v2) {
            await screenshot(page, 'empty', main.locator('.state--empty'));
          } else {
            const emptyMessage = /No records returned for this resource\./;
            const empty = main.getByTestId(app + '-resource-ready').getByRole('status').filter({
              hasText: emptyMessage,
            });
            await screenshot(page, 'empty', empty, empty.getByText(emptyMessage));
          }
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
