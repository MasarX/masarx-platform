import { test, expect, type Locator } from '@playwright/test';

// WCAG 2.2 AA 2.5.8: the compact icon buttons are at least 24 by 24 CSS px (#301).
// `.dt-group-menu` gets the same size but renders only when a table passes group actions.
const MIN = 24;

async function expectTargets(targets: Locator, label: string) {
  await expect(targets.first()).toBeVisible();
  const boxes = await targets.evaluateAll((nodes) =>
    nodes.map((node) => {
      const { width, height } = node.getBoundingClientRect();
      return { width, height };
    })
  );
  expect(boxes.length, `${label} targets`).toBeGreaterThan(0);
  for (const box of boxes) {
    expect(box.width, `${label} width`).toBeGreaterThanOrEqual(MIN);
    expect(box.height, `${label} height`).toBeGreaterThanOrEqual(MIN);
  }
}

test('target size: table row actions', async ({ page }) => {
  await page.goto('/operate/shipments', { waitUntil: 'load', timeout: 45_000 });
  await expectTargets(page.locator('.dt__table .dt-row-actions .icon-btn'), 'row action');
});

test('target size: dashboard widget edit actions', async ({ page }) => {
  await page.goto('/', { waitUntil: 'load', timeout: 45_000 });
  await page.getByTitle('Toggle edit mode').click();
  await expectTargets(page.locator('.dash-widget__edit-actions .icon-btn'), 'widget edit action');
});
