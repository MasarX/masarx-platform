// branches.arabic.test.tsx: the branches page, KPI strip and drawer tabs render their own copy in Arabic; seeded branch values stay as data.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '@/test/render';
import { findUntranslated } from '@/test/helpers/untranslated';
import { englishT } from '@/lib/i18n';
import ar from '@/lib/seed-raw/i18n/areas/ar/customers-network';
import { BranchesModule } from './branches';

describe('BranchesModule in Arabic', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    window.history.pushState(null, '', '/network/branches');
  });

  it('renders the header, KPI strip and drawer tabs in Arabic', async () => {
    const user = userEvent.setup();
    const { container } = renderWithProviders(<BranchesModule />, { locale: 'ar', capabilities: ['all'] });
    await screen.findByTestId('branches-grid');
    const chrome = [
      ...container.querySelectorAll('.page-header__title-block, .page-header__actions, .kpi-strip'),
    ];
    expect(chrome.length).toBe(3);
    expect(chrome.flatMap((element) => findUntranslated(element))).toEqual([]);
    expect(within(container.querySelector('.kpi-strip') as HTMLElement).getByText(ar.branches.kpi.utilization)).toBeInTheDocument();
    expect(screen.getByText(ar.branches.sourceChip)).toBeInTheDocument();

    await user.click(await screen.findByTestId('branch-card-hub_ruh_n'));
    const tablist = await screen.findByRole('tablist', { name: ar.branches.drawer.tabsLabel });
    expect(within(tablist).getByRole('tab', { name: ar.branches.tabs.coverage })).toBeInTheDocument();
    expect(findUntranslated(tablist)).toEqual([]);
  });

  it('keeps the English strings the trunk tests assert', () => {
    expect(englishT('branches.drawer.tabsLabel')).toBe('Branch drawer tabs');
    expect(englishT('branches.kpi.utilization')).toBe('Capacity utilization');
    expect(englishT('branches.window.dialogTitle')).toBe('Coverage window - {name}');
    expect(ar.branches.tabs.zones).toBe('المناطق');
    expect(ar.branches.create.title).toBe('فرع جديد');
  });
});
