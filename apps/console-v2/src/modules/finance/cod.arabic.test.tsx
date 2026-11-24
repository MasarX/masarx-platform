// cod.arabic.test.tsx: COD reconciliation renders its own copy in Arabic; tracking numbers, ids and amounts stay as data (#302).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '@/test/render';
import { findUntranslated } from '@/test/helpers/untranslated';
import * as api from '@/lib/api';
import { englishT } from '@/lib/i18n';
import { ar } from '@/lib/seed-raw/i18n/areas/finance';
import { CodModule } from './cod';

// Same data seams as the trunk cod.test.tsx setup.
beforeEach(() => {
  localStorage.removeItem('demo-v2.view.cod');
  const realCompleteList = api.ui_list_resource_complete;
  vi.spyOn(api, 'ui_list_resource_complete').mockImplementation(async (resource, opts) => {
    if (resource === 'settlement_batches') return { rows: [], total: 0 };
    if (resource === 'workflow_run_directory') return { rows: [], total: 0 };
    if (resource !== 'cod_entries') return realCompleteList(resource, opts);
    return {
      rows: [
        {
          id: 'cod_1',
          organization_id: 'org_rashed',
          subject_id: 'shipment_cod_1',
          currency: 'SAR',
          collected_at: '2026-05-15T05:26:47.233Z',
          created_at: '2026-05-15T05:26:47.322Z',
          metadata: {
            tracking: 'COD-READBACK-SHIPMENT',
            expected: 240,
            collected: 240,
            remitted: 0,
            discrepancy: 0,
            status: 'collected',
            branch_id: 'branch_riyadh',
            driver_user_id: 'driver_user_1',
            settlement_context_ready: true,
          },
        },
      ],
      total: 1,
    };
  });
  vi.spyOn(api, 'compute_cod_payment_collection_summary_v1').mockResolvedValue({
    scope: { organization_id: 'org_rashed' },
    expected: 450,
    collected: 430,
    remitted: 190,
    variance: -20,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

// The scope pill is a shared component outside this slice, so only module chips are checked in the pills row.
const chrome = () => [
  ...document.querySelectorAll('.page-header__title-block, .page-header__pills .chip, .kpi-strip, .dt__table thead'),
];

describe('CodModule in Arabic', () => {
  it('renders the header, KPIs, table headers and row actions in Arabic', async () => {
    const user = userEvent.setup();
    renderWithProviders(<CodModule />, {
      locale: 'ar',
      capabilities: ['all'],
      identity: { capabilities: ['all'], user: { organization_id: 'org_rashed' } },
    });
    expect(await screen.findByText('COD-READBACK-SHIPMENT')).toBeInTheDocument();
    expect(screen.getByText(ar.cod.pills.seam)).toBeInTheDocument();
    expect(screen.getByText(ar.cod.kpi.variance)).toBeInTheDocument();
    expect(chrome().length).toBeGreaterThan(2);
    expect(chrome().flatMap((element) => findUntranslated(element))).toEqual([]);

    await user.click(document.querySelector('.dt-row-actions button') as Element);
    const options = await screen.findAllByRole('option');
    expect(options.map((option) => option.textContent ?? '').join(' ')).toContain(ar.cod.actions.recordCashierCount);
    expect(options.flatMap((option) => findUntranslated(option))).toEqual([]);
  });

  it('keeps the English copy and reads Arabic from the catalog', () => {
    expect(englishT('cod.reasons.bulkNoSettlement')).toBe('No selected COD rows need a settlement workflow.');
    expect(englishT('cod.reasons.contextMissingDriver')).toBe('COD settlement workflow requires shipment driver context.');
    expect(englishT('cod.context.scopeValue')).toBe('Driver shift COD settlement');
    expect(englishT('cod.actions.startSettlement')).toBe('Start COD settlement');
    expect(ar.cod.actions.startSettlement).toBe('بدء تسوية الدفع عند الاستلام');
    expect(ar.cod.columns.tracking).toBe('رقم التتبع');
  });
});
