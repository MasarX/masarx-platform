// LiveStatus.test.tsx — #405 live-refresh pieces in EN and AR: chip states,
// stale banner and label, the new-rows strip, paused writes and the conflict toast.
import { describe, it, expect, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '../test/render';
import type { LiveConnection, LiveState } from '@/lib/live-connection';
import { Button } from './Button';
import { ConflictToast, LiveChip, NewRowsStrip, StaleBanner, StaleLabel, useWritePause } from './LiveStatus';

const syncedAt = Date.UTC(2026, 10, 24, 9, 5);
const make = (state: LiveState): LiveConnection => ({ state, syncedAt, pollMs: 30_000, retry: vi.fn() });

const LABELS: Record<'en' | 'ar', Record<LiveState, string>> = {
  en: {
    syncing: 'Syncing',
    live: 'Live',
    reconnecting: 'Reconnecting',
    offline: 'Offline',
    polling: 'Auto-refresh',
    'not-configured': 'Live refresh not configured',
  },
  ar: {
    syncing: 'جارٍ المزامنة',
    live: 'مباشر',
    reconnecting: 'جارٍ إعادة الاتصال',
    offline: 'غير متصل',
    polling: 'تحديث تلقائي',
    'not-configured': 'التحديث المباشر غير مهيأ',
  },
};
const RETRY = { en: 'Retry', ar: 'إعادة المحاولة' };
const STATES: LiveState[] = ['syncing', 'live', 'reconnecting', 'offline', 'polling', 'not-configured'];

describe.each(['en', 'ar'] as const)('LiveChip (%s)', (locale) => {
  it.each(STATES)('%s: one status region with the state label', (state) => {
    renderWithProviders(<LiveChip live={make(state)} />, { locale });
    const chip = screen.getByTestId('live-chip');
    expect(chip).toHaveAttribute('data-state', state);
    const regions = within(chip).getAllByRole('status');
    expect(regions).toHaveLength(1);
    expect(regions[0]).toHaveTextContent(new RegExp(`^${LABELS[locale][state]}$`));
    const retry = within(chip).queryByRole('button', { name: RETRY[locale] });
    if (state === 'reconnecting' || state === 'offline') expect(retry).toBeInTheDocument();
    else expect(retry).toBeNull();
    if (state === 'live') {
      const label = chip.querySelector('[title]');
      expect(label).toHaveAttribute('title', expect.stringMatching(locale === 'ar' ? /^متصل\. آخر تغيير قبل / : /^Connected\. Last change /));
      expect(label?.getAttribute('title')).not.toContain('{age}');
      expect(label?.querySelector('bdi')).toBeInTheDocument();
    }
    if (state === 'not-configured') {
      expect(chip.querySelector('.chip--danger')).toHaveAttribute(
        'title', expect.stringContaining('ui_presentation_policy.live_refresh'),
      );
      expect(within(chip).getByRole('button', { name: locale === 'ar' ? 'تحديث' : 'Refresh' })).toBeInTheDocument();
    }
  });

  it('offline shows the data time in an isolated bdi and retries on click', async () => {
    const live = make('offline');
    renderWithProviders(<LiveChip live={live} />, { locale });
    const chip = screen.getByTestId('live-chip');
    expect(chip.querySelector('bdi')?.textContent).toMatch(/\d|[٠-٩]/);
    await userEvent.setup().click(within(chip).getByRole('button', { name: RETRY[locale] }));
    expect(live.retry).toHaveBeenCalledTimes(1);
  });
});

describe('StaleBanner and StaleLabel', () => {
  it.each(['syncing', 'live', 'polling', 'not-configured'] as const)('render nothing while %s', (state) => {
    renderWithProviders(
      <>
        <StaleBanner live={make(state)} />
        <StaleLabel live={make(state)} />
      </>,
      { locale: 'en' },
    );
    expect(screen.queryByTestId('stale-banner')).toBeNull();
    expect(screen.queryByText(/Data from/)).toBeNull();
  });

  it('reconnecting: paused banner, not a live region', () => {
    renderWithProviders(<StaleBanner live={make('reconnecting')} />, { locale: 'en' });
    const banner = screen.getByTestId('stale-banner');
    expect(banner).toHaveTextContent(/^Live updates are paused\. Data shown is from .+ and may be out of date\.$/);
    expect(banner).not.toHaveClass('stale-banner--danger');
    expect(banner).not.toHaveAttribute('role');
    expect(banner).not.toHaveAttribute('aria-live');
    expect(banner.querySelector('bdi')).not.toBeNull();
  });

  it('offline: danger banner and data label in EN', () => {
    renderWithProviders(
      <>
        <StaleBanner live={make('offline')} />
        <StaleLabel live={make('offline')} />
      </>,
      { locale: 'en' },
    );
    const banner = screen.getByTestId('stale-banner');
    expect(banner).toHaveClass('stale-banner--danger');
    expect(banner).toHaveTextContent(/^You are offline\. Showing data from .+\. Edits are paused until you reconnect\.$/);
    expect(screen.getByText(/^Data from/)).toHaveClass('stale-label');
  });

  it('offline: danger banner and data label in AR', () => {
    renderWithProviders(
      <>
        <StaleBanner live={make('offline')} />
        <StaleLabel live={make('offline')} />
      </>,
      { locale: 'ar' },
    );
    expect(screen.getByTestId('stale-banner')).toHaveTextContent(/^أنت غير متصل\. البيانات المعروضة من .+\./);
    expect(screen.getByText(/^البيانات من/)).toHaveClass('stale-label');
  });
});

describe('NewRowsStrip', () => {
  it('keeps an empty status region mounted when there is nothing new', () => {
    renderWithProviders(<NewRowsStrip count={0} path="live.newRuns" onShow={vi.fn()} />);
    const strip = screen.getByTestId('new-rows');
    expect(strip).toHaveClass('new-rows--empty');
    expect(within(strip).getByRole('status')).toHaveTextContent(/^$/);
    expect(within(strip).queryByRole('button')).toBeNull();
  });

  it.each<[number, string]>([
    [1, '1 new run'],
    [3, '3 new runs'],
  ])('EN %i: "%s" and Show', async (count, text) => {
    const onShow = vi.fn();
    renderWithProviders(<NewRowsStrip count={count} path="live.newRuns" onShow={onShow} />, { locale: 'en' });
    const strip = screen.getByTestId('new-rows');
    expect(within(strip).getByRole('status')).toHaveTextContent(new RegExp(`^${text}$`));
    await userEvent.setup().click(within(strip).getByRole('button', { name: 'Show' }));
    expect(onShow).toHaveBeenCalledTimes(1);
  });

  it.each<[number, RegExp]>([
    [1, /^شحنة جديدة واحدة$/],
    [2, /^شحنتان جديدتان$/],
    [3, /شحنات جديدة$/],
  ])('AR %i uses the Arabic plural category', (count, text) => {
    renderWithProviders(<NewRowsStrip count={count} path="live.newShipments" onShow={vi.fn()} />, { locale: 'ar' });
    const strip = screen.getByTestId('new-rows');
    expect(within(strip).getByRole('status')).toHaveTextContent(text);
    expect(within(strip).getByRole('button', { name: 'عرض' })).toBeInTheDocument();
  });
});

function WriteHarness({ state, onClick }: { state: LiveState; onClick: () => void }) {
  const pause = useWritePause(make(state));
  return (
    <div>
      <Button label="Create shipment" pausedReasonId={pause.reasonId} onClick={onClick} />
      {pause.reason}
    </div>
  );
}

describe('useWritePause', () => {
  it('offline: the write stays focusable, is aria-disabled, explains why and does nothing', async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    renderWithProviders(<WriteHarness state="offline" onClick={onClick} />, { capabilities: ['all'], locale: 'en' });
    const btn = screen.getByRole('button', { name: 'Create shipment' });
    expect(btn).not.toBeDisabled();
    expect(btn).toHaveAttribute('aria-disabled', 'true');
    expect(btn).toHaveAccessibleDescription('Reconnect to save');
    await user.tab();
    expect(btn).toHaveFocus();
    await user.click(btn);
    await user.keyboard('{Enter}');
    expect(onClick).not.toHaveBeenCalled();
  });

  it('offline in AR: the reason comes from the Arabic catalog', () => {
    renderWithProviders(<WriteHarness state="offline" onClick={vi.fn()} />, { capabilities: ['all'], locale: 'ar' });
    expect(screen.getByRole('button', { name: 'Create shipment' })).toHaveAccessibleDescription('أعد الاتصال للحفظ');
  });

  it.each(['live', 'reconnecting', 'polling'] as const)('%s: writes are not paused', async (state) => {
    const onClick = vi.fn();
    renderWithProviders(<WriteHarness state={state} onClick={onClick} />, { capabilities: ['all'], locale: 'en' });
    const btn = screen.getByRole('button', { name: 'Create shipment' });
    expect(btn).not.toHaveAttribute('aria-disabled');
    expect(btn).not.toHaveAttribute('aria-describedby');
    expect(screen.queryByText('Reconnect to save')).toBeNull();
    await userEvent.setup().click(btn);
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});

describe.each([
  ['en', 'Review change', 'Keep editing', /^Someone else updated it\./],
  ['ar', 'مراجعة التغيير', 'متابعة التحرير', /^حدّثها شخص آخر\./],
] as const)('ConflictToast (%s)', (locale, review, keep, body) => {
  it('is an alert with review and keep actions', async () => {
    const user = userEvent.setup();
    const onReview = vi.fn();
    const onKeep = vi.fn();
    renderWithProviders(<ConflictToast title="Stop changed" onReview={onReview} onKeep={onKeep} />, { locale });
    const toast = screen.getByRole('alert');
    expect(toast).toHaveAttribute('data-testid', 'conflict-toast');
    expect(within(toast).getByText(body)).toBeInTheDocument();
    await user.click(within(toast).getByRole('button', { name: review }));
    await user.click(within(toast).getByRole('button', { name: keep }));
    expect(onReview).toHaveBeenCalledTimes(1);
    expect(onKeep).toHaveBeenCalledTimes(1);
  });
});
