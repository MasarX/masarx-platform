// dispatch.arabic.test.tsx: the Dispatch canvas renders its own copy in Arabic; seeded record values stay as data.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { renderWithProviders } from '@/test/render';
import { findUntranslated } from '@/test/helpers/untranslated';
import { DispatchModule } from '@/modules/operate/dispatch';
import { englishT } from '@/lib/i18n';
import { ar } from '@/lib/seed-raw/i18n/areas/dispatch';

beforeEach(() => {
  window.history.pushState(null, '', '/operate/dispatch');
});

afterEach(() => {
  vi.restoreAllMocks();
  window.history.pushState(null, '', '/operate/dispatch');
});

describe('DispatchModule in Arabic', () => {
  it('renders the pane titles, stop table headers and header actions in Arabic', async () => {
    renderWithProviders(<DispatchModule />, { locale: 'ar', capabilities: ['all'] });
    await waitFor(() => expect(document.querySelector('.run-row.is-active')).not.toBeNull());
    const stopsPane = () => document.querySelector('#dispatch-pane-stops-title')!.closest('.pane')!;
    await waitFor(() => expect(stopsPane().querySelector('thead')).not.toBeNull());

    expect(screen.getByText(ar.dispatch.stops.title)).toBeInTheDocument();
    expect(screen.getByText(ar.dispatch.insight.title)).toBeInTheDocument();
    expect(screen.queryByText('Stop sequence')).toBeNull();

    const chrome = [
      ...document.querySelectorAll(
        '#dispatch-pane-runs-title, #dispatch-pane-stops-title, #dispatch-pane-insights-title, .page-header__actions, [data-testid="departure-gate-hint"]',
      ),
      ...stopsPane().querySelectorAll('thead'),
    ];
    expect(chrome.length).toBeGreaterThan(4);
    expect(chrome.flatMap((element) => findUntranslated(element))).toEqual([]);
  });

  it('keeps the English strings the trunk tests assert', () => {
    expect(englishT('dispatch.stops.title')).toBe('Stop sequence');
    expect(englishT('dispatch.actions.confirmDeparture')).toBe('Confirm departure');
    expect(englishT('dispatch.stops.closeStop')).toBe('Close stop');
    expect(englishT('dispatch.toast.loadScanFailed')).toBe('Load scan could not be recorded. Try again.');
    expect(ar.dispatch.stops.title).not.toBe(englishT('dispatch.stops.title'));
  });
});
