import { test, expect } from '@playwright/test';
import { gotoSurfaceBySidebar } from './fixtures';

// Surface: /operate/shipments (#405 live refresh)
// The browser going offline must show the offline chip and banner, pause
// writes with a visible reason while keeping them focusable, and recover when
// the network returns. The Statusbar mirrors the state without a second live region.
test('Live refresh - Shipments goes offline, pauses writes and recovers', async ({ page, context }) => {
  await gotoSurfaceBySidebar(page, /Shipments/, '/operate/shipments');

  const chip = page.getByTestId('live-chip');
  const statusbar = page.getByTestId('statusbar-realtime');
  const banner = page.getByTestId('stale-banner');
  const create = page.getByRole('button', { name: 'Create shipment', exact: true });

  await expect(chip).toHaveAttribute('data-state', /^(live|polling)$/);
  await expect(chip.getByRole('status')).toHaveCount(1);
  await expect(statusbar).toHaveAttribute('aria-hidden', 'true');
  await expect(banner).toHaveCount(0);
  await expect(create).not.toHaveAttribute('aria-disabled', 'true');

  await context.setOffline(true);

  await expect(chip).toHaveAttribute('data-state', 'offline');
  await expect(chip.getByRole('status')).toHaveText('Offline');
  await expect(statusbar).toContainText('Offline');
  await expect(banner).toContainText('You are offline.');
  await expect(create).toHaveAttribute('aria-disabled', 'true');
  await expect(create).toHaveAccessibleDescription('Reconnect to save');
  await expect(create).toBeEnabled();
  await create.focus();
  await expect(create).toBeFocused();
  await create.click();
  await expect(page.locator('[role="dialog"]')).toHaveCount(0);

  await context.setOffline(false);

  await expect(chip).toHaveAttribute('data-state', /^(live|polling)$/, { timeout: 30_000 });
  await expect(banner).toHaveCount(0);
  await expect(create).not.toHaveAttribute('aria-disabled', 'true');
  await expect(create).not.toHaveAttribute('aria-describedby');
});
