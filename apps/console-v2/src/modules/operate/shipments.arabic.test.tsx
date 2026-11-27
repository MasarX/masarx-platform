// shipments.arabic.test.tsx: the Shipments workbench renders its own copy in Arabic; shipment records stay as data.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '@/test/render';
import { findUntranslated } from '@/test/helpers/untranslated';
import { ShipmentsModule, compactReferenceToken, resolveShipmentListColumns } from '@/modules/operate/shipments';
import { englishT } from '@/lib/i18n';
import { getConsoleCatalog, translateCatalog } from '@/lib/i18n-catalog';
import ar from '@/lib/seed-raw/i18n/areas/ar/shipments';

describe('ShipmentsModule in Arabic', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    localStorage.removeItem('demo-v2.view.shipments');
    window.history.pushState(null, '', '/operate/shipments');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders the page header and header actions in Arabic', () => {
    renderWithProviders(<ShipmentsModule />, { locale: 'ar', capabilities: ['all'] });
    const heading = screen.getByRole('heading', { level: 1 });
    expect(heading.textContent).toContain(ar.shipments.page.titlePlain);
    expect(screen.getByText(ar.shipments.page.shipmentData)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: new RegExp(ar.shipments.page.createShipment) })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: new RegExp(ar.shipments.page.importShipments) })).toBeInTheDocument();
    expect(findUntranslated(document.querySelector('.page-header__title-block')!)).toEqual([]);
  });

  it('labels the drawer tabs and footer actions in Arabic', async () => {
    const user = userEvent.setup();
    renderWithProviders(<ShipmentsModule />, { locale: 'ar', capabilities: ['all'] });
    let row: HTMLTableRowElement | null = null;
    await waitFor(() => {
      row = document.querySelector<HTMLTableRowElement>('tr[aria-label]');
      expect(row).not.toBeNull();
    });
    await user.click(row!);
    await waitFor(() => {
      expect(document.querySelectorAll('.rail-tab').length).toBe(14);
    });
    expect(findUntranslated(document.querySelector('.rail-tabs')!)).toEqual([]);
    expect(document.querySelector('.rail-tabs')?.textContent).toContain(ar.shipments.common.cod);
    await waitFor(() => {
      expect(document.querySelector('.drawer__footer')).not.toBeNull();
    });
    const footer = document.querySelector('.drawer__footer')!;
    expect(footer.textContent).toContain(ar.shipments.routing.refreshRouting);
    expect(footer.textContent).toContain(ar.shipments.common.previewCancel);
    expect(footer.textContent).toContain(ar.shipments.common.amend);
  });

  it('keeps English defaults for helpers called outside React', () => {
    expect(englishT('shipments.page.titlePlain')).toBe('operations workbench');
    expect(compactReferenceToken('cor_9817')).toBe('Reference #9817');
    const arabic = getConsoleCatalog('ar');
    expect(compactReferenceToken('cor_9817', undefined, (key) => translateCatalog(arabic, key)))
      .toBe(`${ar.shipments.common.reference} #9817`);
    expect(resolveShipmentListColumns(undefined)[0]?.label).toBe('Tracking');
  });
});
