import { describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '@/test/render';
import { ZonesModule } from '../zones';
import * as apiMod from '@/lib/api';

describe('ZonesModule district removal', () => {
  it('removes the district explicitly selected by the operator', async () => {
    const user = userEvent.setup();
    const removeSpy = vi.spyOn(apiMod, 'zone_district_remove_v1').mockResolvedValue({
      ok: true,
      zone_district_id: 'zn_ruh_north:cd_ruh_sulaymaniyah',
      already_processed: false,
      correlation_id: 'cor_zone_district_remove',
    });

    renderWithProviders(<ZonesModule />, {
      capabilities: ['zones.read', 'zones.write'],
    });

    await waitFor(() =>
      expect(screen.getByTestId('zones-side-list')).toBeInTheDocument(),
    );
    const sideList = screen.getByTestId('zones-side-list');
    await user.click(within(sideList).getByLabelText(/Riyadh North/));

    const districtsTab = await screen.findByRole('tab', { name: /Districts/i });
    await user.click(districtsTab);

    const selectedDistrict = await screen.findByRole('radio', {
      name: /cd_ruh_sulaymaniyah/i,
    });
    await user.click(selectedDistrict);
    await user.click(await screen.findByRole('button', { name: /Remove selected/i }));

    await waitFor(() => expect(removeSpy).toHaveBeenCalled());
    expect(removeSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        zone_id: 'zn_ruh_north',
        canonical_district_id: 'cd_ruh_sulaymaniyah',
      }),
    );
  });
});
