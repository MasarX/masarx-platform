// baskets.arabic.test.tsx: the basket page renders its own copy in Arabic; zone names and basket types stay as data.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '@/test/render';
import { findUntranslated } from '@/test/helpers/untranslated';
import { BasketsModule } from '@/modules/operate/baskets';
import { clearToasts } from '@/components/toastStore';
import { englishT } from '@/lib/i18n';
import ar from '@/lib/seed-raw/i18n/areas/ar/operate-queues';

function lookup(catalog: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((node, part) => (node as Record<string, unknown> | undefined)?.[part], catalog);
}

describe('BasketsModule in Arabic', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    window.history.pushState(null, '', '/operate/baskets');
    clearToasts();
  });

  afterEach(() => {
    clearToasts();
    vi.restoreAllMocks();
  });

  it('renders the header, KPI strip, table headers and drawer chrome in Arabic', async () => {
    const user = userEvent.setup();
    renderWithProviders(<BasketsModule />, { locale: 'ar', capabilities: ['all'] });

    const kpis = await screen.findByTestId('baskets-kpi-strip');
    const basketCell = await screen.findByText(/Riyadh North - 3\/50/);
    expect(within(kpis).getByText('إجمالي السلال')).toBeInTheDocument();

    const page = screen.getByTestId('baskets-page');
    const chrome = [...page.querySelectorAll('.page-header, [data-testid="baskets-kpi-strip"], thead')];
    expect(chrome.length).toBeGreaterThan(2);
    expect(chrome.flatMap((element) => findUntranslated(element))).toEqual([]);

    await user.click(basketCell.closest('tr')!);
    const drawer = await screen.findByTestId('baskets-drawer');
    expect(await within(drawer).findByText('عناصر السلة')).toBeInTheDocument();
    const drawerChrome = [...drawer.querySelectorAll('.section-eyebrow, thead')];
    expect(drawerChrome.length).toBeGreaterThan(0);
    expect(drawerChrome.flatMap((element) => findUntranslated(element))).toEqual([]);
  });

  it('keeps the English copy and reads Arabic from the catalog', () => {
    expect(englishT('baskets.kpi.total')).toBe('Total baskets');
    expect(englishT('baskets.transition.moved')).toBe('Basket moved to {state}');
    expect(englishT('baskets.values.unzoned')).toBe('Unzoned');
    expect(lookup(ar, 'baskets.kpi.total')).toBe('إجمالي السلال');
    expect(lookup(ar, 'baskets.drawer.items')).toBe('عناصر السلة');
    expect(lookup(ar, 'baskets.transition.moved')).toBe('نُقلت السلة إلى {state}');
  });
});
