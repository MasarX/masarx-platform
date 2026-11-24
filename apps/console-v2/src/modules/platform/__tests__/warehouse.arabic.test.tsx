// warehouse.arabic.test.tsx: the warehouse page renders its own copy in Arabic (issue #302).
import { beforeEach, describe, expect, it } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithProviders } from '@/test/render';
import { findUntranslated } from '@/test/helpers/untranslated';
import { WarehouseModule } from '@/modules/platform/warehouse';
import { englishT } from '@/lib/i18n';
import { ar } from '@/lib/seed-raw/i18n/areas/platform-warehouse';

function lookup(catalog: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((node, part) => (node as Record<string, unknown> | undefined)?.[part], catalog);
}

describe('WarehouseModule in Arabic', () => {
  beforeEach(() => {
    window.history.pushState(null, '', '/platform/warehouse');
  });

  it('renders the page copy in Arabic', async () => {
    renderWithProviders(<WarehouseModule />, { locale: 'ar' });

    const [title] = await screen.findAllByText(ar.platformWarehouse.warehouseModule.titleAccent);
    expect(findUntranslated(title)).toEqual([]);
    const [copy] = await screen.findAllByText(ar.platformWarehouse.warehouseModule.transferWorkflowScanSequence);
    expect(findUntranslated(copy)).toEqual([]);
  });

  it('shows the denied state in Arabic', async () => {
    renderWithProviders(<WarehouseModule />, { locale: 'ar', capabilities: ['billing.read'] });
    expect(await screen.findByText(ar.platformWarehouse.warehouseModule.youDoNotHave)).toBeInTheDocument();
  });

  it('keeps the English copy and reads Arabic from the catalog', () => {
    expect(englishT('platformWarehouse.warehouseModule.titlePlain')).toBe('transfers');
    expect(englishT('platformWarehouse.warehouseModule.transferBoard')).toBe('Transfer board');
    expect(lookup(ar, 'platformWarehouse.warehouseModule.titleAccent')).toMatch(/[\u0600-\u06FF]/);
  });
});
