// arabic-render.test.tsx: shared components render their own copy in Arabic; only test data stays Latin.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { renderWithProviders } from '@/test/render';
import { findUntranslated } from '@/test/helpers/untranslated';
import * as api from '@/lib/api';
import { DataTable, type DataTableColumn } from './DataTable';
import { Drawer } from './Drawer';
import { SessionsList } from './SessionsList';
import { UserDevicesList } from './UserDevicesList';

interface Row extends Record<string, unknown> {
  id: string;
  awb: string;
  status: string;
}

const COLUMNS: Array<DataTableColumn<Row>> = [
  { key: 'awb', label: 'رقم الشحنة', mono: true },
  { key: 'status', label: 'الحالة', type: 'select' },
];
const ROWS: Row[] = [
  { id: 'row_1', awb: 'AWB-001', status: 'in_transit' },
  { id: 'row_2', awb: 'AWB-002', status: 'delivered' },
];

afterEach(() => {
  vi.restoreAllMocks();
});

describe('shared components in Arabic', () => {
  it('DataTable toolbar, headers and pager', () => {
    renderWithProviders(<DataTable<Row> columns={COLUMNS} rows={ROWS} />, { locale: 'ar' });
    expect(screen.getByText('AWB-001')).toBeInTheDocument();
    expect(findUntranslated(document.body, ['AWB-001', 'AWB-002', 'in_transit', 'delivered'])).toEqual([]);
  });

  it('DataTable empty state', () => {
    renderWithProviders(<DataTable<Row> columns={COLUMNS} rows={[]} />, { locale: 'ar' });
    expect(findUntranslated()).toEqual([]);
  });

  it('Drawer chrome', () => {
    renderWithProviders(
      <Drawer open title="تفاصيل" onClose={() => {}}>
        <p>محتوى</p>
      </Drawer>,
      { locale: 'ar' },
    );
    expect(screen.getByText('محتوى')).toBeInTheDocument();
    expect(findUntranslated()).toEqual([]);
  });

  it('SessionsList rows', async () => {
    vi.spyOn(api, 'ui_list_user_sessions_v1').mockResolvedValue({
      rows: [
        {
          id: 'ssn_test_0001',
          user_id: 'usr_test_0001',
          user_email: 'operator@example.test',
          user_agent: 'Test Agent',
          ip: '192.0.2.10',
          aal: 'aal2',
          updated_at: '2026-01-01T00:00:00.000Z',
          is_current: true,
        },
      ],
      total: 1,
      page: 0,
      page_size: 50,
    });
    renderWithProviders(<SessionsList userId="usr_test_0001" />, {
      locale: 'ar',
      capabilities: ['users.read', 'users.manage'],
    });
    await screen.findByTestId('sessions-list-item-ssn_test_0001');
    expect(
      findUntranslated(document.body, ['operator@example.test', 'Test Agent', 'ssn_test_0001', 'usr_test_0001']),
    ).toEqual([]);
  });

  it('SessionsList denied state', () => {
    renderWithProviders(<SessionsList userId="usr_test_0001" />, { locale: 'ar', capabilities: [] });
    expect(screen.getByTestId('sessions-list')).toBeInTheDocument();
    expect(findUntranslated()).toEqual([]);
  });

  it('UserDevicesList denied state', async () => {
    renderWithProviders(<UserDevicesList userId="usr_test_0001" />, { locale: 'ar', capabilities: [] });
    await waitFor(() => expect(screen.getByTestId('user-devices-list')).toBeInTheDocument());
    expect(findUntranslated()).toEqual([]);
  });

  it('UserDevicesList rows', async () => {
    renderWithProviders(<UserDevicesList userId="usr_dr_khalid" />, {
      locale: 'ar',
      capabilities: ['user_devices.read', 'user_devices.write'],
    });
    await screen.findByTestId('user-devices-list-item-dev_4441');
    const list = screen.getByTestId('user-devices-list');
    const data = [...list.querySelectorAll('.mono')].map((element) => element.textContent ?? '');
    expect(findUntranslated(list, data)).toEqual([]);
  });
});
