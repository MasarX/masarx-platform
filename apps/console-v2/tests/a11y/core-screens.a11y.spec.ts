import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

// WCAG 2.2 AA axe pass over the Console V2 core screens (#301). Each screen
// runs in every variant below and writes its axe JSON as conformance evidence.
const CORE_SCREENS: Array<[string, string]> = [
  ['Dashboard', '/'],
  ['Shipments', '/operate/shipments'],
  ['Dispatch', '/operate/dispatch'],
  ['Exceptions', '/operate/exceptions'],
  ['Pickups', '/operate/pickups'],
  ['Tracking Map', '/operate/tracking-map'],
  ['COD', '/finance/cod'],
];

const VARIANTS = [
  { id: 'light-en-1440', theme: 'light', locale: 'en', width: 1440, height: 900 },
  { id: 'dark-en-1440', theme: 'dark', locale: 'en', width: 1440, height: 900 },
  { id: 'light-ar-1440', theme: 'light', locale: 'ar', width: 1440, height: 900 },
  { id: 'light-en-390', theme: 'light', locale: 'en', width: 390, height: 844 },
] as const;

const WCAG22_AA_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
const EVIDENCE_DIR = process.env.A11Y_EVIDENCE_DIR || join('test-results', 'a11y-evidence');

for (const variant of VARIANTS) {
  for (const [name, route] of CORE_SCREENS) {
    test(`a11y wcag22 ${variant.id}: ${name} (${route})`, async ({ page }) => {
      await page.setViewportSize({ width: variant.width, height: variant.height });
      await page.addInitScript(
        ([theme, locale]) => {
          localStorage.setItem('console-v2.theme', theme);
          localStorage.setItem('console-v2.locale', locale);
        },
        [variant.theme, variant.locale]
      );
      await page.goto(route, { waitUntil: 'load', timeout: 45_000 });
      await page.waitForSelector('main, [role="main"]', { state: 'attached', timeout: 15_000 });
      await expect(page.locator('html')).toHaveAttribute('data-theme', variant.theme);
      await expect(page.locator('html')).toHaveAttribute('lang', variant.locale);
      // Same settle window as console.a11y.spec.ts for late-mounting panels.
      await page.waitForTimeout(1000);

      const results = await new AxeBuilder({ page })
        .withTags(WCAG22_AA_TAGS)
        // Same structural exclusion as console.a11y.spec.ts: the shell's
        // sticky overlays are landmarks already.
        .disableRules(['region'])
        .analyze();

      const slug = `${variant.id}--${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
      mkdirSync(EVIDENCE_DIR, { recursive: true });
      writeFileSync(
        join(EVIDENCE_DIR, `${slug}.json`),
        JSON.stringify(
          {
            screen: name,
            route,
            variant,
            tags: WCAG22_AA_TAGS,
            axeVersion: results.testEngine.version,
            timestamp: results.timestamp,
            violations: results.violations,
            incomplete: results.incomplete.map(({ id, impact, nodes }) => ({ id, impact, nodes: nodes.length })),
            passes: results.passes.map(({ id }) => id),
          },
          null,
          2
        )
      );

      const seriousOrCritical = results.violations
        .filter((v) => v.impact === 'serious' || v.impact === 'critical')
        .map((v) => ({ id: v.id, impact: v.impact, targets: v.nodes.slice(0, 3).map((n) => n.target.join(' ')) }));
      expect(seriousOrCritical, `serious/critical WCAG 2.2 AA violations on ${name} (${variant.id})`).toEqual([]);
    });
  }
}
