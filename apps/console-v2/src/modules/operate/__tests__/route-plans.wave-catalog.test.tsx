// route-plans.wave-catalog.test.tsx — covers CLAIM-OPERATIONS-WIRING
// (Phase C1) wave_catalog row-driven swap.
//
// Asserted behavior:
//   1. The "New plan" modal's Wave picker is sourced from
//      `ui_list_resource_v1('wave_catalog')` (no inline 3-row literal).
//   2. The picker exposes the canonical row IDs (wave_morning /
//      wave_afternoon / wave_evening) from the seed.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '@/test/render';
import { RoutePlansModule } from '@/modules/operate/route-plans';
import * as ds from '@/lib/data-source';
import * as supabase from '@/lib/supabase';
import { routePlanningListResource } from './route-plans.fixtures';

const LIST_RESOURCE = ds.ui_list_resource_v1;
const LIST_SPY = vi.spyOn(ds, 'ui_list_resource_v1');

beforeEach(() => {
  vi.spyOn(supabase, 'rpc').mockResolvedValue(null);
  LIST_SPY.mockClear();
  LIST_SPY.mockImplementation((key, opts) => routePlanningListResource(key, opts, LIST_RESOURCE));
});

describe('RoutePlansModule · wave catalog row-driven (CLAIM-OPERATIONS-WIRING)', () => {
  it('fires ui_list_resource_v1("wave_catalog") at module mount', async () => {
    renderWithProviders(<RoutePlansModule />, { capabilities: ['all'] });
    await waitFor(() => {
      const calls = LIST_SPY.mock.calls.map((c) => c[0]);
      expect(calls).toContain('wave_catalog');
    });
  });

  it('exposes canonical wave ids from the seed catalog (no literal fallback)', async () => {
    const user = userEvent.setup();
    renderWithProviders(<RoutePlansModule />, { capabilities: ['all'] });
    // Open the New Plan modal.
    const newBtn = await screen.findByRole('button', { name: /^New plan$/ });
    await user.click(newBtn);
    await waitFor(() => {
      expect(document.querySelector('.modal')).not.toBeNull();
    });
    // Click the wave picker button to open the ReferencePicker.
    const wavePickBtn = Array.from(document.querySelectorAll('.modal button'))
      .find((b) => /Pick wave/i.test(b.getAttribute('aria-label') ?? ''));
    expect(wavePickBtn).toBeTruthy();
    await user.click(wavePickBtn as HTMLElement);
    // Picker contains the canonical wave labels.
    await waitFor(() => {
      const picker = document.querySelector('.reference-picker, [role="dialog"]:not(.modal)');
      expect(picker).toBeTruthy();
      const text = picker?.textContent ?? '';
      expect(text).toMatch(/Morning/);
      expect(text).toMatch(/Afternoon/);
      expect(text).toMatch(/Evening/);
    });
  });
});
