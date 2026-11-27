// pickups.arabic.test.tsx: the pickups queue renders its own copy in Arabic; seeded record values stay as data (#302).
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '@/test/render';
import { findUntranslated } from '@/test/helpers/untranslated';
import { englishT } from '@/lib/i18n';
import * as toastStore from '@/components/toastStore';
import ar from '@/lib/seed-raw/i18n/areas/ar/operate-queues';
import { PickupsModule } from '@/modules/operate/pickups';

// Header title, header actions, tabs and table headers are module copy; table cells hold seeded data.
// The scope pill is a shared component outside this slice, so the pills row is not checked.
const chrome = () => [...document.querySelectorAll('.page-header__title-block, .page-header__actions, .tabs, .dt__table thead')];

describe('PickupsModule in Arabic', () => {
  beforeEach(() => toastStore.clearToasts());
  afterEach(() => toastStore.clearToasts());

  it('renders the header, tabs and table headers in Arabic', async () => {
    const user = userEvent.setup();
    renderWithProviders(<PickupsModule />, { locale: 'ar', capabilities: ['all'] });
    // Same readiness wait as the trunk lifecycle test, in the Arabic loading copy.
    await waitFor(() => {
      expect(screen.queryByText(/جارٍ التحميل/)).not.toBeInTheDocument();
      expect(document.querySelectorAll('.dt__table tbody tr').length).toBeGreaterThan(0);
    }, { timeout: 3000 });
    expect(screen.getByText(ar.pickups.policyConfigured)).toBeInTheDocument();
    expect(chrome().length).toBeGreaterThan(0);
    expect(chrome().flatMap((element) => findUntranslated(element))).toEqual([]);

    await user.click(screen.getByText(ar.pickups.tabs.waves));
    await waitFor(() => {
      expect(document.querySelector('.dt__table thead')?.textContent ?? '').toContain(ar.pickups.columns.hub);
    }, { timeout: 3000 });
    expect(chrome().flatMap((element) => findUntranslated(element))).toEqual([]);
  });

  it('keeps the English copy the queue showed before', () => {
    expect(englishT('pickups.tabs.requests')).toBe('Requests');
    expect(englishT('pickups.failures.retryStatus')).toBe('Pickup retry status');
    expect(englishT('pickups.actions.failure_retry')).toBe('Retry failed pickup');
    expect(englishT('pickups.toast.waveFailed')).toBe('Pickup wave could not be created. Try again.');
    expect(ar.pickups.tabs.failures).toBe('الإخفاقات');
    expect(ar.pickups.reschedule.apply).toBe('تطبيق إعادة الجدولة');
  });
});
