import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '@/test/render';
import { UserDevicesList } from './UserDevicesList';
import * as api from '@/lib/api';
import { clearToasts, getToasts } from './toastStore';

describe('components/UserDevicesList', () => {
  beforeEach(() => {
    clearToasts();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    clearToasts();
  });

  it('shows a denied state when user_devices.read is missing', () => {
    renderWithProviders(<UserDevicesList userId="usr_dr_khalid" />, {
      capabilities: [],
    });
    expect(screen.getByTestId('user-devices-list')).toBeInTheDocument();
    expect(screen.getByText(/Device Access permission required/i)).toBeInTheDocument();
  });

  it('filters by user_id and revokes through ui_execute_user_device_revoke_v1 with a reason', async () => {
    const user = userEvent.setup();
    let revoked = false;
    const realList = api.ui_list_resource_v1;
    vi.spyOn(api, 'ui_list_resource_v1').mockImplementation(async (resource, opts) => {
      const result = await realList(resource, opts);
      if (resource !== 'user_device_summary') return result;
      return {
        ...result,
        rows: result.rows.map((row) =>
          row.id === 'dev_4441' && revoked
            ? {
                ...row,
                revoked_at: '2026-05-10T00:00:00.000Z',
                revoked_reason: 'Lost phone',
                is_revoked: true,
                push_token_cleared: true,
              }
            : row,
        ),
      };
    });
    const spy = vi.spyOn(api, 'ui_execute_user_device_revoke_v1').mockImplementation(async () => {
      revoked = true;
      return {
        ok: true,
        action_key: 'user_devices.revoke',
        resource_key: 'user_devices',
        status: 'revoked',
        device_id: 'AND-3F21-9911',
        revoked_at: '2026-05-10T00:00:00.000Z',
        count: 1,
        items: [{ id: 'dev_4441', status: 'revoked', revoked_at: '2026-05-10T00:00:00.000Z' }],
      };
    });

    renderWithProviders(<UserDevicesList userId="usr_dr_khalid" />, {
      capabilities: ['user_devices.read', 'user_devices.write'],
    });

    const row = await screen.findByTestId('user-devices-list-item-dev_4441');
    expect(row).toHaveTextContent('AND-3F21-9911');
    expect(row).toHaveTextContent('android');

    await user.click(within(row).getByRole('button', { name: /Revoke device AND-3F21-9911/i }));
    const form = await screen.findByTestId('user-devices-revoke-form-dev_4441');
    await user.type(within(form).getByLabelText(/Revocation reason/i), 'Lost phone');
    await user.click(within(form).getByRole('button', { name: /Confirm revoke/i }));

    await waitFor(() => {
      expect(spy).toHaveBeenCalledWith('dev_4441', 'Lost phone');
    });
    await waitFor(() => {
      expect(getToasts().map((toast) => toast.message).join('\n')).toMatch(/Device revoked - AND-3F21-9911/i);
    });
    const updatedRow = await screen.findByTestId('user-devices-list-item-dev_4441');
    expect(await within(updatedRow).findByTestId('user-devices-revoked-state-dev_4441')).toHaveTextContent(
      /Reason: Lost phone/i,
    );
    expect(within(updatedRow).getByText(/Push token cleared/i)).toBeInTheDocument();
    expect(within(updatedRow).getByRole('button', { name: /Revoked/i })).toBeDisabled();
    expect(within(updatedRow).queryByRole('button', { name: /Revoke device AND-3F21-9911/i })).not.toBeInTheDocument();
  });
});
